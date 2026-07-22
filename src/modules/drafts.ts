import { db, getMode } from "../db/index.js";
import { generateText } from "../core/textLlm.js";
import { fetchThreads, type ThreadContext } from "./inbox.js";
import { sendThreadReply, sendMessage, sendComment } from "./outreach.js";
import { firstMessage, followupMessage , converseStep } from "./personalize.js";
import { GovernorBlocked } from "../core/safetyGovernor.js";
import { istPlausibleNachricht, UnsichereNachricht } from "../core/nachrichtCheck.js";
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
  intent: string | null;
  ki_original: string | null;
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
  const chk = istPlausibleNachricht(text);
  if (!chk.ok) {
    console.error(`[sicherheit] Erstnachricht-Entwurf fuer ${c.full_name} verworfen (${chk.grund}) – KI-Ausgabe unbrauchbar, kein Entwurf angelegt.`);
    return false;
  }
  const info = db
    .prepare("INSERT INTO drafts(kind, thread_url, participant, incoming, draft, ki_original, intent) VALUES('first',?,?,?,?,?,'first')")
    .run(c.profile_url, c.full_name ?? null, "", text, text);
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
  const chkF = istPlausibleNachricht(text);
  if (!chkF.ok) {
    console.error(`[sicherheit] Follow-up-Entwurf fuer ${c.full_name} verworfen (${chkF.grund}).`);
    return false;
  }
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
export function queueReplyDraft(threadUrl: string, participant: string, incoming: string, text: string, intent?: string) {
  if (hasOpenDraft(threadUrl)) return;
  // ki_original bleibt fuer immer stehen: der Vergleich mit dem, was Sinan am Ende wirklich
  // sendet, ist der ehrlichste Qualitaetsmassstab fuer die KI.
  const info = db
    .prepare("INSERT INTO drafts(kind, thread_url, participant, incoming, draft, ki_original, intent) VALUES('message',?,?,?,?,?,?)")
    .run(threadUrl, participant, incoming, text, text, intent ?? null);
  events.emit("draft:new", getDraft(Number(info.lastInsertRowid)));
}

/**
 * Liefert die Erstnachricht modus-abhängig: manual → Entwurf, semi/full → automatisch senden
 * (governor-gedrosselt). Bei Sendefehler Fallback als Entwurf, damit nichts verloren geht.
 */
export async function deliverFirstMessage(c: Contact): Promise<void> {
  // DUPLIKAT-SPERRE: wurde diese Person schon angeschrieben (oder hat geantwortet/ist zu)?
  // Dann NIE eine zweite Erstnachricht – weder als Entwurf noch als Versand.
  const st = db.prepare("SELECT status, messaged_at FROM contacts WHERE profile_url=?").get(c.profile_url) as
    | { status?: string; messaged_at?: string }
    | undefined;
  if (st && (st.messaged_at || ["messaged", "replied", "closed"].includes(st.status ?? ""))) {
    console.info(`[sicherheit] ${c.full_name ?? c.profile_url} bereits angeschrieben (${st.status}) – Erstnachricht übersprungen (kein Duplikat).`);
    return;
  }
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
  // Auto-Versand (semi/full): Kauderwelsch NIE senden. Lieber offen lassen und neu versuchen.
  const chkD = istPlausibleNachricht(text);
  if (!chkD.ok) {
    console.error(`[sicherheit] Erstnachricht fuer ${c.full_name} NICHT gesendet (${chkD.grund}) – KI-Ausgabe unbrauchbar, naechster Versuch spaeter.`);
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
 * FREIGABE-WORKFLOW (Sinans Wunsch): Der Nutzer entscheidet nur genehmigen/ablehnen, das
 * SENDEN macht die Engine beim nächsten Lauf (governor-gedrosselt). Kein Direktversand mehr
 * aus dem Dashboard-Prozess – ein Ort weniger, an dem etwas schiefgeht.
 *
 * Genehmigen: Status 'approved'. `sendApprovedDrafts` (Engine-Cron) holt sie und sendet.
 * Optionaler `text` übernimmt eine letzte Bearbeitung vor der Freigabe.
 */
export function approveDraft(id: number, text?: string): boolean {
  const d = getDraft(id);
  if (!d || d.status === "sent") return false;
  if (typeof text === "string" && text.trim()) db.prepare("UPDATE drafts SET draft=? WHERE id=?").run(text.trim(), id);
  setDraftStatus(id, "approved");
  return true;
}

/** Wie viele Entwürfe warten aktuell freigegeben auf den nächsten Versand? (Dashboard-Anzeige) */
export function approvedCount(): number {
  return (db.prepare("SELECT COUNT(*) n FROM drafts WHERE status='approved'").get() as { n: number }).n;
}

/**
 * Ablehnen: verwirft den Entwurf UND erzeugt sofort einen neuen (andere Formulierung).
 * Genau das hat Sinan verlangt: "wenn ich sie ablehne will ich, dass ein neuer Entwurf kommt."
 * Der neue Entwurf ist wieder 'pending' und landet als Karte + Event im Dashboard.
 */
export async function rejectDraft(id: number): Promise<{ ok: boolean; regenerated: boolean }> {
  const d = getDraft(id);
  if (!d) return { ok: false, regenerated: false };
  setDraftStatus(id, "discarded");
  const neu = await regenerateText(d).catch((e) => {
    console.error("[reject] Neu-Generierung fehlgeschlagen:", String((e as Error)?.message ?? e).slice(0, 90));
    return "";
  });
  if (!neu) return { ok: true, regenerated: false };
  const info = db
    .prepare("INSERT INTO drafts(kind, thread_url, participant, incoming, draft, ki_original, intent) VALUES(?,?,?,?,?,?,?)")
    .run(d.kind, d.thread_url, d.participant, d.incoming, neu, neu, d.intent ?? null);
  events.emit("draft:new", getDraft(Number(info.lastInsertRowid)));
  return { ok: true, regenerated: true };
}

/** Erzeugt für einen abgelehnten Entwurf einen frischen Text (kind-abhängig, "anders formulieren"). */
async function regenerateText(d: Draft): Promise<string> {
  const avoid = d.draft ? `\n\nFormuliere es DEUTLICH anders als dieser abgelehnte Entwurf (Sinan mochte ihn nicht):\n"${d.draft}"` : "";
  if (d.kind === "first" || d.kind === "followup") {
    // Für den richtigen Winkel den Kontakt holen; sonst generischer Fallback.
    const c = db.prepare("SELECT * FROM contacts WHERE profile_url=?").get(d.thread_url) as Contact | undefined;
    if (c) return d.kind === "first" ? firstMessage(c) : followupMessage(c);
  }
  if (d.kind === "comment") {
    return saubern(await generateText(
      `Du bist Sinan und kommentierst diesen fremden LinkedIn-Post:\n"${d.incoming}"\n${promptKontext()}\n` +
      `Schreibe einen kurzen, echten Kommentar (1-2 Sätze), kein Pitch, keine Eigenwerbung.${avoid}\nNur der Kommentar.`,
    ));
  }
  // 'message' = Thread-Antwort (und Fallback für first/followup ohne Kontakt).
  return saubern(await generateText(
    `Du bist Sinan und antwortest ${d.participant || "jemandem"} auf eine LinkedIn-Nachricht.\n${promptKontext()}\n` +
    `Letzte Nachricht von ${d.participant || "der Person"}:\n"${d.incoming}"\n` +
    `Schreibe Sinans Antwort, konkret auf die Nachricht.${avoid}\nNur der Nachrichtentext.`,
  ));
}

/**
 * Engine-Routine: sendet freigegebene ('approved') Entwürfe nacheinander über den Governor.
 * Bei Governor-Block (Cap/Arbeitszeit/Wochenende) wird ABGEBROCHEN – die restlichen bleiben
 * 'approved' und kommen beim nächsten Lauf dran. So sendet der Bot Nachrichten nie am
 * Wochenende (message ist werktags-gated), arbeitet die Freigaben aber verlässlich ab.
 */
export async function sendApprovedDrafts(limit = 10): Promise<number> {
  const rows = db.prepare("SELECT id FROM drafts WHERE status='approved' ORDER BY created_at LIMIT ?").all(limit) as { id: number }[];
  let sent = 0;
  for (const { id } of rows) {
    const r = await sendDraft(id).catch((e) => {
      console.error("[approved] Sendefehler:", String((e as Error)?.message ?? e).slice(0, 90));
      return { ok: false, reason: "Fehler" } as { ok: boolean; reason?: string };
    });
    if (r.ok) sent++;
    else if (r.reason && /Governor|Arbeitszeit|Wochenende|Limit|blockiert/i.test(r.reason)) break;
  }
  if (sent) console.info(`[approved] ${sent} freigegebene Entwürfe gesendet`);
  return sent;
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
  // DUPLIKAT-SPERRE für Erstnachrichten: wenn der Kontakt schon angeschrieben wurde, NICHT
  // erneut senden (auch wenn der Entwurf freigegeben ist). Entwurf aus der Warteschlange nehmen.
  if (d.kind === "first") {
    const st = db.prepare("SELECT messaged_at FROM contacts WHERE profile_url=?").get(d.thread_url) as { messaged_at?: string } | undefined;
    if (st?.messaged_at) {
      db.prepare("UPDATE drafts SET status='blockiert' WHERE id=?").run(id);
      console.info(`[sicherheit] Entwurf #${id} nicht gesendet – ${d.participant ?? "Kontakt"} wurde schon angeschrieben (kein Duplikat).`);
      return { ok: false, reason: "Schon angeschrieben – kein Duplikat" };
    }
  }
  try {
    // 'first'/'followup' = Nachricht an einen Kontakt (über Profil), 'message' = Thread-Antwort.
    if (d.kind === "comment") await sendComment(d.thread_url, d.draft); // öffentlicher Kommentar
    else if (d.kind === "first" || d.kind === "followup") await sendMessage(d.thread_url, d.draft);
    else await sendThreadReply(d.thread_url, d.draft);
    db.prepare("UPDATE drafts SET status='sent', sent_at=datetime('now') WHERE id=?").run(id);
    return { ok: true };
  } catch (e) {
    if (e instanceof GovernorBlocked) return { ok: false, reason: e.message };
    /**
     * UNSICHERE NACHRICHT (Kauderwelsch / Feld-Inhalt weicht ab): NICHT erneut versuchen –
     * sonst würde derselbe Mist wieder und wieder rausgehen. Entwurf 'blockiert' setzen (kommt
     * NICHT in die Sende-Warteschlange zurück) und den Nutzer informieren.
     */
    if (e instanceof UnsichereNachricht) {
      db.prepare("UPDATE drafts SET status='blockiert' WHERE id=?").run(id);
      console.error(`[sicherheit] Entwurf #${id} blockiert – ${e.grund}. Nicht gesendet.`);
      events.emit("draft:blockiert", { id, grund: e.grund, participant: d.participant });
      return { ok: false, reason: `Blockiert: ${e.grund}` };
    }
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
    const echtesInteresse = ["meeting", "chance", "positive"].includes(step.intent);
    if (echtesInteresse && markRepliedByName(t.participant)) replies++;
    if (step.intent === "absage") markDeclinedByName(t.participant);

    const info = db
      .prepare("INSERT INTO drafts(kind, thread_url, participant, incoming, draft, ki_original, intent) VALUES('message',?,?,?,?,?,?)")
      .run(t.threadUrl, t.participant, t.lastIncoming, step.reply, step.reply, step.intent);
    const d = getDraft(Number(info.lastInsertRowid));
    created++;

    // Heikle Fälle (Absage/Einwand) NICHT als normalen Entwurf durchwinken, sondern mit
    // Kontext an Sinan eskalieren: Zusammenfassung, Vorschlag, Strategie. Er entscheidet.
    if (["absage", "einwand", "meeting", "chance"].includes(step.intent)) {
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
