import { db, getMode } from "../db/index.js";
import { generateText } from "../core/textLlm.js";
import { fetchThreads, type ThreadContext } from "./inbox.js";
import { sendThreadReply, sendMessage } from "./outreach.js";
import { firstMessage, followupMessage , converseStep } from "./personalize.js";
import { GovernorBlocked } from "../core/safetyGovernor.js";
import { markRepliedByName, markDeclinedByName, messagedAwaitingFollowup, type Contact } from "./crm.js";
import { promptKontext, saubern } from "../context.js";
import { events } from "../core/events.js";

/**
 * DM-Entwürfe: Inbox lesen → Gemini-Draft → als 'pending' speichern.
 * Erzeugt NUR Entwürfe, sendet nichts. Der Versand läuft separat über den
 * Governor (modules/outreach.ts / Freigabe-Schritt).
 * Der Standpunkt (wer Sinan ist) kommt zentral aus context.ts (PERSONA).
 */
export type Draft = {
  id: number;
  kind: string;
  thread_url: string;
  participant: string;
  incoming: string;
  draft: string;
  status: string;
  created_at: string;
  sent_at: string | null;
};

/** Gemini erzeugt Sinans nächste Antwort aus dem Thread-Verlauf. */
export async function replyDraft(ctx: ThreadContext): Promise<string> {
  const transcript = ctx.messages.map((m) => `${m.sender || "?"}: ${m.text}`).join("\n");
  const prompt = `Du bist Sinan und antwortest auf eine LinkedIn-Direktnachricht.
${promptKontext()}
Bisheriger Verlauf (chronologisch, Format "Name: Text"):
${transcript}

Schreibe Sinans nächste Antwort an ${ctx.participant}. Gehe konkret auf die letzte Nachricht ein.
Gib NUR den Nachrichtentext aus, ohne Anführungszeichen, ohne Signatur.`;
  return saubern(await generateText(prompt));
}

/**
 * Erzeugt einen Erstnachricht-Entwurf (kind='first') für einen frisch angenommenen
 * Kontakt. thread_url = Profil-URL (Versand läuft über sendMessage, nicht über einen Thread).
 * Idempotent: nur ein offener First-Message-Entwurf pro Kontakt.
 */
export async function createFirstMessageDraft(c: Contact): Promise<boolean> {
  const exists = db
    .prepare(
      "SELECT 1 FROM drafts WHERE thread_url=? AND kind='first' AND status IN ('pending','approved','sent') LIMIT 1",
    )
    .get(c.profile_url);
  if (exists) return false;
  const text = await firstMessage(c).catch((e: Error) => {
    console.error(`[first] ⚠ KI-Fehler (Entwurf) fuer ${c.full_name}: ${e.message.split("\n")[0].slice(0, 90)}`);
    return "";
  });
  if (!text) return false;
  const info = db
    .prepare("INSERT INTO drafts(kind, thread_url, participant, incoming, draft) VALUES('first',?,?,?,?)")
    .run(c.profile_url, c.full_name ?? null, "", text);
  events.emit("draft:new", getDraft(Number(info.lastInsertRowid)));
  return true;
}

/**
 * Follow-up-Entwurf für einen angeschriebenen, aber unbeantworteten Kontakt (kind='followup').
 * Idempotent: nur ein offener Follow-up-Entwurf pro Kontakt.
 */
export async function createFollowupDraft(c: Contact): Promise<boolean> {
  const exists = db
    .prepare(
      "SELECT 1 FROM drafts WHERE thread_url=? AND kind='followup' AND status IN ('pending','approved','sent') LIMIT 1",
    )
    .get(c.profile_url);
  if (exists) return false;
  const text = await followupMessage(c).catch(() => "");
  if (!text) return false;
  const info = db
    .prepare("INSERT INTO drafts(kind, thread_url, participant, incoming, draft) VALUES('followup',?,?,?,?)")
    .run(c.profile_url, c.full_name ?? null, "", text);
  events.emit("draft:new", getDraft(Number(info.lastInsertRowid)));
  return true;
}

/** Erzeugt Follow-up-Entwürfe für Kontakte, die seit >= `days` Tagen nicht geantwortet haben. */
export async function generateFollowups(days = 4, limit = 5): Promise<number> {
  const candidates = messagedAwaitingFollowup(days, limit);
  const auto = getMode() === "full"; // im Vollautomatik-Modus direkt senden
  let done = 0;
  for (const c of candidates) {
    if (auto) {
      const text = await followupMessage(c).catch(() => "");
      if (!text) continue;
      try {
        await sendMessage(c.profile_url, text);
        done++;
      } catch (e) {
        if (!(e instanceof GovernorBlocked)) console.error("[followup] Sendefehler → Entwurf:", (e as Error)?.message);
        if (await createFollowupDraft(c).catch(() => false)) done++;
      }
    } else if (await createFollowupDraft(c).catch(() => false)) done++;
  }
  if (candidates.length) console.info(`[followup] ${done} ${auto ? "auto-gesendet" : "Entwürfe"}`);
  return done;
}

/**
 * Legt einen Thread-Antwort-Entwurf zur Freigabe an (z.B. Autopilot-Eskalation).
 * Idempotent: nur ein offener Draft pro Thread.
 */
export function queueReplyDraft(threadUrl: string, participant: string, incoming: string, text: string) {
  if (hasOpenDraft(threadUrl)) return;
  const info = db
    .prepare("INSERT INTO drafts(kind, thread_url, participant, incoming, draft) VALUES('message',?,?,?,?)")
    .run(threadUrl, participant, incoming, text);
  events.emit("draft:new", getDraft(Number(info.lastInsertRowid)));
}

/**
 * Liefert die Erstnachricht modus-abhängig: manual → Entwurf, semi/full → automatisch senden
 * (governor-gedrosselt). Bei Sendefehler Fallback als Entwurf, damit nichts verloren geht.
 */
export async function deliverFirstMessage(c: Contact): Promise<void> {
  if (getMode() === "manual") {
    await createFirstMessageDraft(c);
    return;
  }
  // KI-Ausfall NICHT verschlucken: sonst sieht es fuer den Nutzer so aus, als tue der Bot
  // nichts. Real passiert 2026-07-16: Gemini lieferte 503, der Bot ging wortlos weiter.
  // Der Kontakt bleibt 'accepted' und wird beim naechsten stuendlichen Lauf neu versucht.
  const text = await firstMessage(c).catch((e: Error) => {
    console.error(`[first] ⚠ KI konnte keinen Text schreiben fuer ${c.full_name}: ${e.message.split("\n")[0].slice(0, 90)}`);
    return "";
  });
  if (!text) {
    console.info(`[first] ${c.full_name} bleibt offen, naechster Versuch in max. 1 Stunde.`);
    return;
  }
  try {
    await sendMessage(c.profile_url, text); // setzt Status 'messaged' bei Erfolg
    console.info(`[first] ✅ Erstnachricht auto-gesendet an ${c.full_name}`);
  } catch (e) {
    if (!(e instanceof GovernorBlocked)) console.error("[first] Sendefehler → Entwurf:", (e as Error)?.message);
    const info = db
      .prepare("INSERT INTO drafts(kind, thread_url, participant, incoming, draft) VALUES('first',?,?,?,?)")
      .run(c.profile_url, c.full_name ?? null, "", text);
    events.emit("draft:new", getDraft(Number(info.lastInsertRowid)));
  }
}

/** Existiert schon ein offener (noch nicht gesendeter) Draft für diesen Thread? */
/**
 * Schon bearbeitet? Zwei Fälle zählen:
 *  1. Es liegt ein offener Entwurf für den Thread (pending/approved) – nicht doppelt schreiben.
 *  2. Für GENAU DIESE eingegangene Nachricht wurde schon mal ein Entwurf VERWORFEN – dann
 *     will Sinan darauf nicht antworten, also nicht ungefragt einen neuen erzeugen.
 *
 * Punkt 2 war ein Loch: 'discarded' fehlte in der Prüfung. Bei 2 Läufen/Tag nur nervig, ab
 * stündlicher Prüfung ein Ärgernis mit Kosten – jeder weggeworfene Entwurf käme stündlich
 * zurück und verbrennt jedes Mal einen KI-Aufruf. Der Vergleich läuft über `incoming`:
 * schreibt die Person etwas NEUES, entsteht wieder ein Entwurf. Genau so soll es sein.
 */
function hasOpenDraft(threadUrl: string, incoming?: string): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM drafts
        WHERE thread_url = ?
          AND ( status IN ('pending','approved')
                OR (status = 'discarded' AND incoming IS ?) )
        LIMIT 1`,
    )
    .get(threadUrl, incoming ?? null);
}

export function pendingDrafts(): Draft[] {
  return db.prepare("SELECT * FROM drafts WHERE status='pending' ORDER BY created_at DESC").all() as Draft[];
}

export function getDraft(id: number): Draft | undefined {
  return db.prepare("SELECT * FROM drafts WHERE id=?").get(id) as Draft | undefined;
}

export function setDraftStatus(id: number, status: string) {
  db.prepare("UPDATE drafts SET status=? WHERE id=?").run(status, id);
}

/**
 * Sendet einen freigegebenen Entwurf über den Governor in seinen Thread.
 * NUR auf explizite Freigabe des Nutzers aufrufen – das ist eine sendende Aktion.
 * Rückgabe: {ok} oder {ok:false, reason} wenn der Governor blockt / Fehler.
 */
export async function sendDraft(id: number): Promise<{ ok: boolean; reason?: string }> {
  const d = getDraft(id);
  if (!d) return { ok: false, reason: "Entwurf nicht gefunden" };
  if (d.status === "sent") return { ok: false, reason: "Bereits gesendet" };
  if (!d.thread_url) return { ok: false, reason: "Kein Ziel (Thread/Profil)" };
  try {
    // 'first'/'followup' = Nachricht an einen Kontakt (über Profil), 'message' = Thread-Antwort.
    if (d.kind === "first" || d.kind === "followup") await sendMessage(d.thread_url, d.draft);
    else await sendThreadReply(d.thread_url, d.draft);
    db.prepare("UPDATE drafts SET status='sent', sent_at=datetime('now') WHERE id=?").run(id);
    return { ok: true };
  } catch (e) {
    if (e instanceof GovernorBlocked) return { ok: false, reason: e.message };
    throw e;
  }
}

/**
 * Liest die Inbox und erzeugt für jeden antwort-fälligen Thread einen pending-Draft.
 * Antwort-fällig = die letzte Nachricht stammt vom Gegenüber (oder Thread ist ungelesen).
 * Idempotent: pro Thread nur ein offener Draft.
 */
export async function generateInboxDrafts(max = 6, onlyUnread = false): Promise<number> {
  const threads = await fetchThreads(max, onlyUnread);
  let created = 0;
  let replies = 0;
  for (const t of threads) {
    const last = t.messages[t.messages.length - 1];
    const needsReply = last ? (last.sender ? last.sender === t.participant : t.unread) : false;
    if (!needsReply) continue;
    if (hasOpenDraft(t.threadUrl, t.lastIncoming)) continue;

    /**
     * EIN KI-Aufruf liefert Einordnung + Antwort + Zusammenfassung + Strategie.
     * Vorher lief hier ein stumpfes "schreib halt eine Antwort" und JEDE Antwort galt als
     * Hot Lead – auch ein höfliches Nein ("danke der Nachfrage, viel Erfolg"). Real passiert
     * bei Maximilian Müller: als Hot Lead gezählt UND eine Nachfass-Frage entworfen, obwohl
     * er das Gespräch klar geschlossen hatte. Die Intelligenz dafür lag ungenutzt im
     * Autopilot herum. Kostet keinen Aufruf extra.
     */
    const step = await converseStep(t.messages, t.participant).catch((e) => {
      console.error(`[drafts] ⚠ KI-Fehler bei ${t.participant}: ${String(e?.message ?? e).slice(0, 80)}`);
      return null;
    });
    if (!step || !step.reply) continue;

    // Hot Lead NUR bei echtem Interesse. Ein höfliches Abwinken ist KEIN heißer Lead –
    // sonst verfälscht es die Pipeline und Sinan ruft die Falschen an.
    const echtesInteresse = step.intent === "meeting" || step.intent === "positive";
    if (echtesInteresse && markRepliedByName(t.participant)) replies++;
    if (step.intent === "objection") markDeclinedByName(t.participant);

    const info = db
      .prepare("INSERT INTO drafts(kind, thread_url, participant, incoming, draft) VALUES('message',?,?,?,?)")
      .run(t.threadUrl, t.participant, t.lastIncoming, step.reply);
    const d = getDraft(Number(info.lastInsertRowid));
    created++;

    // Heikle Fälle (Absage/Einwand) NICHT als normalen Entwurf durchwinken, sondern mit
    // Kontext an Sinan eskalieren: Zusammenfassung, Vorschlag, Strategie. Er entscheidet.
    if (step.intent === "objection" || step.intent === "meeting") {
      events.emit("lead:eskalation", {
        draft: d,
        participant: t.participant,
        intent: step.intent,
        zusammenfassung: step.zusammenfassung,
        strategie: step.strategie,
        threadUrl: t.threadUrl,
        contact: step.contact,
      });
    } else {
      events.emit("draft:new", d);
    }
  }
  console.info(`[drafts] ${created} neue Entwürfe, ${replies} Hot Lead(s) (Antwort erkannt)`);
  return created;
}
