import { db, getMode } from "../db/index.js";
import { generateText } from "../core/textLlm.js";
import { fetchThreads, type ThreadContext } from "./inbox.js";
import { sendThreadReply, sendMessage, sendComment, VersandNichtVersucht } from "./outreach.js";
import { firstMessage, followupMessage , converseStep, pitchIdeen, messageAusIdee } from "./personalize.js";
import { GovernorBlocked, DuplikatBlockiert } from "../core/safetyGovernor.js";
import { istPlausibleNachricht, UnsichereNachricht } from "../core/nachrichtCheck.js";
import { markInboundReply, messagedAwaitingFollowup, type Contact } from "./crm.js";
import { contactForConversation, recordCrmStage } from "./crmStages.js";
import { promptKontext, saubern } from "../context.js";
import { events } from "../core/events.js";
import { directionOptions, feedbackInstruction, type DraftDirection, type RejectionReason } from "./draftDirections.js";
import { campaignContext } from "./campaigns.js";
import { goalForContact, goalForConversation, recordGoalAlert } from "./goals.js";
import { learnFromDraft, learnFromReply } from "./learning.js";
import { blockDraftForRelationship, observeRelationshipMessage, proactiveDecisionForTarget } from "./relationshipPolicy.js";
import { syncCampaignTargetForDraft } from "./campaignWorkflow.js";
import { leseStand } from "../core/leseBudget.js";
import { attachDraftContext, getConversationMemory, validateProactiveContext } from "./conversationMemory.js";

/**
 * DM-Entwürfe: Inbox lesen → Gemini-Draft → als 'pending' speichern.
 * Erzeugt NUR Entwürfe, sendet nichts. Der Versand läuft separat über den
 * Governor (modules/outreach.ts / Freigabe-Schritt).
 * Der Standpunkt (wer Sinan ist) kommt zentral aus context.ts (PERSONA).
 */
export type Draft = {
  id: number;
  contact_id: number | null;
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
  phase: "message" | "approach";
  parent_draft_id: number | null;
  approach_key: string | null;
  rejection_reason: string | null;
  blockiert_grund: string | null;
  context_evidence_json: string | null;
  context_validation: string | null;
  context_memory_version: number | null;
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
  // Bestehendes Netzwerk ist ein bewusster Zusatzbereich. Es darf niemals in die normale
  // Erstnachrichten-Automatik rutschen; dort entstehen ausschließlich Reaktivierungsentwürfe.
  if (c.aus_netzwerk) return false;
  if (!proactiveDecisionForTarget(c.profile_url, c.full_name ?? "", "first").ok) return false;
  const exists = db
    .prepare(
      // 'discarded' zählt mit: hat der Nutzer den Erstnachricht-Entwurf gelöscht, NICHT neu erzeugen.
      "SELECT 1 FROM drafts WHERE thread_url=? AND kind='first' AND status IN ('pending','approved','sent','discarded') LIMIT 1",
    )
    .get(c.profile_url);
  if (exists) return false;
  const text = await firstMessage(c, undefined, goalForContact(c.id)).catch((e: Error) => {
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
    .prepare("INSERT INTO drafts(contact_id,kind, thread_url, participant, incoming, draft, ki_original, intent) VALUES(?,'first',?,?,?,?,?,'first')")
    .run(c.id, c.profile_url, c.full_name ?? null, "", text, text);
  const draftId = Number(info.lastInsertRowid);
  attachDraftContext(draftId, c.id);
  events.emit("draft:new", getDraft(draftId));
  return true;
}

/**
 * Follow-up-Entwurf für einen angeschriebenen, aber unbeantworteten Kontakt (kind='followup').
 * Idempotent: nur ein offener Follow-up-Entwurf pro Kontakt.
 */
/**
 * Follow-up-Entwurf. ZWEISTUFIG: `stufe` ergibt sich aus der Zahl bereits erzeugter Follow-ups.
 * Nach der 2. Stufe wird NIE wieder nachgefasst (siehe followupMessage) – wer zweimal nicht
 * antwortet, will nicht. Das schützt Sinans Ruf und das Konto (Report-Risiko).
 */
export async function createFollowupDraft(c: Contact): Promise<boolean> {
  if (!proactiveDecisionForTarget(c.profile_url, c.full_name ?? "", "followup").ok) return false;
  const bisher = (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM drafts WHERE thread_url=? AND kind='followup' AND status IN ('pending','approved','sent')",
      )
      .get(c.profile_url) as { n: number }
  ).n;
  if (bisher >= 2) return false; // Schluss nach zwei Versuchen
  // Ein offener Follow-up (oder ein vom Nutzer GELÖSCHTER = 'discarded') blockiert einen weiteren.
  const offen = db
    .prepare("SELECT 1 FROM drafts WHERE thread_url=? AND kind='followup' AND status IN ('pending','approved','discarded') LIMIT 1")
    .get(c.profile_url);
  if (offen) return false;
  const stufe: 1 | 2 = bisher === 0 ? 1 : 2;
  const text = await followupMessage(c, stufe).catch(() => "");
  if (!text) return false;
  const chkF = istPlausibleNachricht(text);
  if (!chkF.ok) {
    console.error(`[sicherheit] Follow-up-Entwurf fuer ${c.full_name} verworfen (${chkF.grund}).`);
    return false;
  }
  const info = db
    .prepare("INSERT INTO drafts(contact_id,kind, thread_url, participant, incoming, draft) VALUES(?,'followup',?,?,?,?)")
    .run(c.id, c.profile_url, c.full_name ?? null, "", text);
  const draftId = Number(info.lastInsertRowid);
  attachDraftContext(draftId, c.id);
  events.emit("draft:new", getDraft(draftId));
  return true;
}

/**
 * PITCH Stufe 2 (Sinan 2026-07-28): Aus einem gewählten Pitch-Ansatz die konkrete Nachricht
 * generieren und als normalen 'message'-Entwurf zur (zweiten) Freigabe ablegen. Der 'pitchidee'-
 * Entwurf wird dabei als erledigt markiert. Nutzt den in ki_original abgelegten Verlauf – kein
 * erneutes Inbox-Lesen nötig.
 */
export async function pitchZuNachricht(id: number, idee: string): Promise<boolean> {
  const d = getDraft(id);
  if (!d || d.kind !== "pitchidee") return false;
  let transcript: { sender: string; text: string }[] = [];
  try {
    transcript = JSON.parse(d.ki_original || "{}").transcript || [];
  } catch {
    transcript = [];
  }
  const text = await messageAusIdee(transcript, d.participant ?? "", idee).catch(() => "");
  if (!text) return false;
  const info = db
    .prepare("INSERT INTO drafts(kind, thread_url, participant, incoming, draft, ki_original, intent) VALUES('message',?,?,?,?,?,?)")
    .run(d.thread_url, d.participant ?? null, d.incoming ?? "", text, text, "chance");
  db.prepare("UPDATE drafts SET status='discarded' WHERE id=?").run(id);
  events.emit("draft:new", getDraft(Number(info.lastInsertRowid)));
  return true;
}

/**
 * Einen eingeschlafenen Chat WIEDERBELEBEN (Dashboard-Knopf, Sinan 2026-07-27): erzeugt für den
 * Kontakt einen Nachfass-Entwurf zur Freigabe. Nutzt dieselben Schutzregeln wie createFollowupDraft
 * (max. 2 Stufen, kein zweiter offener Entwurf) – lieber kein Entwurf als Belästigung.
 */
export async function reviveChat(profileUrl: string): Promise<boolean> {
  const c = db.prepare("SELECT * FROM contacts WHERE profile_url=?").get(profileUrl) as Contact | undefined;
  if (!c) return false;
  return createFollowupDraft(c);
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
  // Harte zweite Schutzlinie zusätzlich zur Acceptance-Query: Selbst ein zukünftiger falscher
  // Aufrufer darf einen Bestandskontakt niemals automatisch als neue Annahme anschreiben.
  if (c.aus_netzwerk) {
    console.info(`[sicherheit] ${c.full_name ?? c.profile_url} ist bestehendes Netzwerk – keine automatische Erstnachricht.`);
    return;
  }
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
  const text = await firstMessage(c, undefined, goalForContact(c.id)).catch((e: Error) => {
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
    // GovernorBlocked (z.B. Sonntag/außerhalb der Zeit/Limit) = nur vertagt: Kontakt bleibt
    // 'accepted' und wird beim nächsten Lauf erneut versucht. KEIN Entwurf daraus machen.
    if (e instanceof GovernorBlocked) {
      console.info(`[first] ${c.full_name} vertagt (${e.message.slice(0, 50)}) – nächster Versuch später.`);
      return;
    }
    console.error("[first] Sendefehler → Entwurf:", (e as Error)?.message);
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
/**
 * Wie lange ein VERWORFENER Entwurf denselben Chat von der Prüfliste fernhält.
 *
 * BEFRISTET seit 2026-08-05 (vorher: für immer). Der unbefristete Grabstein hatte einen
 * teuren Nebeneffekt: Wer einen Vorschlag verwarf und dessen Person nichts Neues schrieb,
 * sah diesen Chat NIE wieder – er verschwand still aus dem System. In Sinans Daten traf das
 * 16 Chats, darunter Leute, die aktiv auf eine Antwort warteten ("schade dass du mich
 * ignorierst"). Kurzfristig soll ein Verwurf weiter ruhig halten (kein sofortiger Neu-Vorschlag
 * zur selben Nachricht), nach dieser Frist kommt der Chat aber zurück auf den Tisch.
 */
const VERWURF_RUHEZEIT_TAGE = 3;

function hasOpenDraft(threadUrl: string, incoming?: string): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM drafts
        WHERE thread_url = ?
          AND ( status IN ('pending','approved')
                OR (status = 'discarded' AND incoming IS ?
                    AND created_at > datetime('now', ?)) )
        LIMIT 1`,
    )
    .get(threadUrl, incoming ?? null, `-${VERWURF_RUHEZEIT_TAGE} days`);
}

export function pendingDrafts(): Draft[] {
  return db.prepare("SELECT * FROM drafts WHERE status='pending' ORDER BY created_at DESC").all() as Draft[];
}

export function getDraft(id: number): Draft | undefined {
  return db.prepare("SELECT * FROM drafts WHERE id=?").get(id) as Draft | undefined;
}

export function setDraftStatus(id: number, status: string) {
  db.prepare("UPDATE drafts SET status=? WHERE id=?").run(status, id);
  syncCampaignTargetForDraft(id, status);
}

/**
 * BLOCKIERTE Entwürfe HANDELBAR machen – als ENTWÜRFE ZUR PRÜFUNG (Sinans Vorgabe 2026-07-26:
 * NICHT automatisch nachsenden, weil eine alte Nachricht oft keinen Sinn mehr macht, wenn sich
 * das Gespräch weiterbewegt hat). Diese Funktion trennt:
 *  - Sinnlos (Duplikat: Person schon angeschrieben / Follow-up an jemanden, der geantwortet hat)
 *    → VERWERFEN (die würden nie mehr passen).
 *  - Rest (echter Sendefehler) → zurück auf 'pending' = Entwurf, den DU prüfst/anpasst/freigibst.
 * So geht nie eine veraltete Nachricht ungeprüft raus.
 */
export function retryBlockierte(): { entwuerfe: number; verworfen: number } {
  // 'unknown' ist absichtlich ebenfalls NUR auf manuellen Knopfdruck wieder sichtbar: Bei
  // einem technischen Abbruch darf der Bot nicht selbst erneut senden, der Mensch kann nach
  // Blick in den LinkedIn-Verlauf aber bewusst entscheiden.
  const rows = db.prepare("SELECT id, kind, thread_url FROM drafts WHERE status IN ('blockiert','unknown')").all() as { id: number; kind: string; thread_url: string }[];
  let entwuerfe = 0,
    verworfen = 0;
  for (const r of rows) {
    const c = db.prepare("SELECT status, messaged_at, replied_at FROM contacts WHERE profile_url=?").get(r.thread_url) as { status?: string; messaged_at?: string; replied_at?: string } | undefined;
    // Erst-/Reaktivierungs-Nachricht an schon Angeschriebene = Duplikat. Follow-up an jemanden,
    // der geantwortet hat = hinfällig. Beides verwerfen.
    const sinnlos =
      (["first", "reaktivierung"].includes(r.kind) && !!c && (!!c.messaged_at || ["messaged", "replied", "closed"].includes(c.status ?? ""))) ||
      (r.kind === "followup" && !!c && (!!c.replied_at || ["replied", "closed"].includes(c.status ?? "")));
    db.prepare("UPDATE drafts SET status=? WHERE id=?").run(sinnlos ? "discarded" : "pending", r.id);
    if (sinnlos) verworfen++;
    else entwuerfe++;
  }
  return { entwuerfe, verworfen };
}

/**
 * Entwurf löschen: verschwindet aus der Liste (nur 'pending' wird angezeigt) und kommt für
 * VERWURF_RUHEZEIT_TAGE nicht wieder. WICHTIG: KEIN hartes DELETE – die Zeile bleibt als
 * "Grabstein" (status='discarded') stehen, denn genau daran erkennt der Bot, dass diese
 * eingegangene Nachricht schon abgehakt ist (siehe hasOpenDraft). Würde man die Zeile löschen,
 * hielte der Bot die Nachricht sofort wieder für unbeantwortet und erzeugte den Entwurf neu.
 * Nach Ablauf der Ruhezeit ist das ERWÜNSCHT: ein wartender Chat darf nicht für immer verschwinden.
 * Anders als "ablehnen" wird KEIN Ersatz erzeugt. Gesendetes bleibt unangetastet.
 */
export function deleteDraft(id: number): boolean {
  const changed = db.prepare("UPDATE drafts SET status='discarded' WHERE id=? AND status != 'sent'").run(id).changes > 0;
  if (changed) syncCampaignTargetForDraft(id, "discarded", "Entwurf wurde gelöscht");
  return changed;
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
  if (!d || d.status === "sent" || d.phase === "approach") return false;
  if (["first", "followup", "reaktivierung", "event"].includes(d.kind) && d.contact_id) {
    const context = validateProactiveContext(d.contact_id);
    if (!context.ok) {
      db.prepare("UPDATE drafts SET status='blockiert',blockiert_grund=?,context_validation='blocked' WHERE id=?")
        .run(context.reason, id);
      syncCampaignTargetForDraft(id, "blockiert", context.reason);
      return false;
    }
    attachDraftContext(id, d.contact_id);
  }
  if (typeof text === "string" && text.trim()) db.prepare("UPDATE drafts SET draft=? WHERE id=?").run(text.trim(), id);
  setDraftStatus(id, "approved");
  learnFromDraft(id, "approved");
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
export async function rejectDraft(
  id: number,
  reason: RejectionReason = "different_approach",
  instruction?: string,
): Promise<{ ok: boolean; regenerated: boolean; choosingApproach?: boolean }> {
  const d = getDraft(id);
  if (!d) return { ok: false, regenerated: false };
  if (d.phase === "approach") return { ok: false, regenerated: false };
  const cleanInstruction = String(instruction || "").trim().slice(0, 500);
  const tx = db.transaction(() => {
    db.prepare("UPDATE drafts SET status='discarded',rejection_reason=? WHERE id=? AND status IN ('pending','approved')").run(reason, id);
    db.prepare(
      "INSERT INTO draft_feedback(draft_id,thread_url,kind,reason,instruction,rejected_text,approach_key) VALUES(?,?,?,?,?,?,?)",
    ).run(id, d.thread_url, d.kind, reason, cleanInstruction || null, d.draft, d.approach_key ?? null);
  });
  tx();
  syncCampaignTargetForDraft(id, "discarded", "Entwurf wurde abgelehnt");
  learnFromDraft(id, "rejected", reason);

  const history = feedbackHistory(d.thread_url, d.kind);
  if (reason === "different_approach") {
    const options = directionOptions(d.kind, history.map((item) => item.approach_key || ""));
    const info = db
      .prepare(
        `INSERT INTO drafts(contact_id,kind,thread_url,participant,incoming,draft,ki_original,intent,phase,parent_draft_id)
         VALUES(?,?,?,?,?,?,?,?,'approach',?)`,
      )
      .run(d.contact_id, d.kind, d.thread_url, d.participant, d.incoming, JSON.stringify(options), JSON.stringify(options), d.intent ?? null, d.id);
    syncCampaignTargetForDraft(Number(info.lastInsertRowid), "pending", "Neue Gesprächsrichtung wird ausgewählt");
    if (d.contact_id) attachDraftContext(Number(info.lastInsertRowid), d.contact_id);
    // Die Richtungswahl ist nur ein Zwischenschritt im geöffneten Dashboard und keine
    // sendbare Nachricht. Deshalb kein Telegram-Push; erst der fertige Text wird gemeldet.
    return { ok: true, regenerated: true, choosingApproach: true };
  }

  const neu = await regenerateText(d, feedbackInstruction(reason, cleanInstruction), history.map((item) => item.rejected_text)).catch((e) => {
    console.error("[reject] Neu-Generierung fehlgeschlagen:", String((e as Error)?.message ?? e).slice(0, 90));
    return "";
  });
  if (!neu) return { ok: true, regenerated: false };
  const info = db
    .prepare("INSERT INTO drafts(contact_id,kind,thread_url,participant,incoming,draft,ki_original,intent,parent_draft_id) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(d.contact_id, d.kind, d.thread_url, d.participant, d.incoming, neu, neu, d.intent ?? null, d.id);
  syncCampaignTargetForDraft(Number(info.lastInsertRowid), "pending", "Ersatzentwurf wurde vorbereitet");
  if (d.contact_id) attachDraftContext(Number(info.lastInsertRowid), d.contact_id);
  events.emit("draft:new", getDraft(Number(info.lastInsertRowid)));
  return { ok: true, regenerated: true };
}

type FeedbackRow = { rejected_text: string; approach_key: string | null };
function feedbackHistory(threadUrl: string, kind: string): FeedbackRow[] {
  return (db
    .prepare("SELECT rejected_text,approach_key FROM draft_feedback WHERE thread_url=? AND kind=? ORDER BY created_at DESC,id DESC LIMIT 12")
    .all(threadUrl, kind) as FeedbackRow[]).reverse();
}

export async function chooseDraftApproach(id: number, approachKey: string): Promise<boolean> {
  const d = getDraft(id);
  if (!d || d.phase !== "approach" || d.status !== "pending") return false;
  let options: DraftDirection[] = [];
  try { options = JSON.parse(d.draft || "[]") as DraftDirection[]; } catch { return false; }
  const selected = options.find((option) => option.key === approachKey);
  if (!selected) return false;
  const history = feedbackHistory(d.thread_url, d.kind);
  const text = await regenerateText(d, selected.instruction, history.map((item) => item.rejected_text)).catch(() => "");
  if (!text) return false;
  const tx = db.transaction(() => {
    db.prepare("UPDATE drafts SET status='discarded' WHERE id=? AND status='pending'").run(id);
    return db
      .prepare(
        `INSERT INTO drafts(contact_id,kind,thread_url,participant,incoming,draft,ki_original,intent,phase,parent_draft_id,approach_key)
         VALUES(?,?,?,?,?,?,?,?,'message',?,?)`,
      )
      .run(d.contact_id, d.kind, d.thread_url, d.participant, d.incoming, text, text, d.intent ?? null, d.id, selected.key);
  });
  const info = tx();
  syncCampaignTargetForDraft(Number(info.lastInsertRowid), "pending", "Gewählte Gesprächsrichtung wurde ausgearbeitet");
  if (d.contact_id) attachDraftContext(Number(info.lastInsertRowid), d.contact_id);
  events.emit("draft:new", getDraft(Number(info.lastInsertRowid)));
  return true;
}

/** Erzeugt einen neuen Text mit verbindlicher Richtung und kompletter Ablehnungshistorie. */
async function regenerateText(d: Draft, instruction: string, rejectedTexts: string[]): Promise<string> {
  const rejected = rejectedTexts.filter(Boolean).slice(-5);
  const avoid = rejected.length
    ? `\n\nBEREITS ABGELEHNT. Übernimm weder Gesprächsidee, Satzbau noch Frage:\n${rejected.map((text, i) => `${i + 1}. ${text}`).join("\n")}`
    : "";
  if (d.kind === "first" || d.kind === "followup") {
    // Für den richtigen Winkel den Kontakt holen; sonst generischer Fallback.
    const c = db.prepare("SELECT * FROM contacts WHERE profile_url=?").get(d.thread_url) as Contact | undefined;
    if (c) return d.kind === "first"
      ? firstMessage(c, { instruction, rejectedTexts: rejected }, goalForContact(c.id))
      : followupMessage(c, 1, { instruction, rejectedTexts: rejected });
  }
  if (d.kind === "comment") {
    return saubern(await generateText(
      `Du bist Sinan und kommentierst diesen fremden LinkedIn-Post:\n"${d.incoming}"\n${promptKontext()}\n` +
      `Schreibe einen kurzen, echten Kommentar (1-2 Sätze), kein Pitch, keine Eigenwerbung.\nVERBINDLICHE RICHTUNG: ${instruction}${avoid}\nNur der Kommentar.`,
    ));
  }
  // Kampagnen-Einladung: hier gibt es kein eingehendes Gespräch, sondern harte Event-Fakten.
  // Der Kampagnen-Kontext (Ort, Zeit, Ablauf, Flyer-Kernaussagen) wird eingespeist, damit die
  // KI nichts erfindet – das ist der einzige Ort, an dem eine Einladung KI-Text bekommt.
  if (d.kind === "event") {
    const campaignId = Number(String(d.incoming || "").replace(/^campaign:/, ""));
    const kontext = Number.isInteger(campaignId) && campaignId > 0 ? campaignContext(campaignId) : "";
    const anrede = d.participant ? `Die Nachricht geht an ${d.participant}.` : "";
    return saubern(await generateText(
      `Du bist Sinan und lädst per LinkedIn-Direktnachricht zu einer eigenen Veranstaltung ein.\n${promptKontext()}\n` +
      `${kontext}\n${anrede}\n` +
      `Bisheriger abgelehnter Entwurf als Sachkontext:\n"${d.draft}"\n` +
      `VERBINDLICHE NEUE RICHTUNG: ${instruction}\n` +
      `Schreibe kurz, persönlich und ohne Werbesprache. Nenne Datum, Ort und Link nur, wenn sie oben stehen.${avoid}\n` +
      `Nur der Nachrichtentext.`,
    ));
  }
  // Thread-Antwort, Reaktivierung und Fallback ohne Kontakt.
  return saubern(await generateText(
    `Du bist Sinan und antwortest ${d.participant || "jemandem"} auf eine LinkedIn-Nachricht.\n${promptKontext()}\n` +
    `Letzte Nachricht von ${d.participant || "der Person"}:\n"${d.incoming}"\n` +
    `Bisheriger abgelehnter Entwurf als Sachkontext:\n"${d.draft}"\n` +
    `VERBINDLICHE NEUE RICHTUNG: ${instruction}\nSchreibe Sinans Antwort konkret und natürlich.${avoid}\nNur der Nachrichtentext.`,
  ));
}

/**
 * Engine-Routine: sendet freigegebene ('approved') Entwürfe nacheinander über den Governor.
 * Bei Governor-Block (Cap/Arbeitszeit/Wochenende) wird ABGEBROCHEN – die restlichen bleiben
 * 'approved' und kommen beim nächsten Lauf dran. So sendet der Bot Nachrichten nie am
 * Wochenende (message ist werktags-gated), arbeitet die Freigaben aber verlässlich ab.
 */
export async function sendApprovedDrafts(limit = 10): Promise<number> {
  // Ohne Lesebudget kann der Browser den Zielthread nicht sicher öffnen. Das ist eine geplante
  // Vertagung bis zum nächsten Tag und darf weder als Versandfehler erscheinen noch jeden
  // freigegebenen Entwurf einzeln gegen dasselbe Limit laufen lassen.
  if (leseStand().erschoepft) return 0;
  const rows = db.prepare("SELECT id FROM drafts WHERE status='approved' ORDER BY created_at LIMIT ?").all(limit) as { id: number }[];
  let sent = 0;
  for (const { id } of rows) {
    const r = await sendDraft(id).catch((e) => {
      console.error("[approved] Sendefehler:", String((e as Error)?.message ?? e).slice(0, 90));
      return { ok: false, reason: "Fehler" } as { ok: boolean; reason?: string };
    });
    if (r.ok) sent++;
    else if (r.reason && /Governor|Arbeitszeit|Wochenende|Limit|blockiert|Technischer Fehler vor Versand/i.test(r.reason)) break;
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
  // Pitch-Ideen sind KEINE Nachricht (Stufe 1) – niemals senden. Erst pitchZuNachricht erzeugt
  // daraus einen echten 'message'-Entwurf. Schutz, falls so einer je 'approved' würde.
  if (d.kind === "pitchidee") return { ok: false, reason: "Pitch-Idee ist keine sendbare Nachricht" };
  if (d.phase === "approach") return { ok: false, reason: "Zuerst eine Gesprächsrichtung auswählen" };
  if (d.status === "sent") return { ok: false, reason: "Bereits gesendet" };
  if (d.status !== "pending" && d.status !== "approved") return { ok: false, reason: `Entwurf ist bereits ${d.status}` };
  if (!d.thread_url) return { ok: false, reason: "Kein Ziel (Thread/Profil)" };

  // ATOMARER CLAIM: Nur genau ein Prozess darf diesen Entwurf versenden. Das schützt gegen
  // Dashboard, Telegram und Engine-Cron, die vorher alle denselben 'approved'-Entwurf lesen
  // und parallel lossenden konnten.
  const vorherigerStatus = d.status;
  const claim = db.prepare("UPDATE drafts SET status='sending' WHERE id=? AND status=?").run(id, vorherigerStatus);
  if (claim.changes === 0) return { ok: false, reason: "Entwurf wird bereits verarbeitet" };
  syncCampaignTargetForDraft(id, "sending", "Versand wurde atomar reserviert");
  const zurueckstellen = () => {
    const changed = db.prepare("UPDATE drafts SET status=? WHERE id=? AND status='sending'").run(vorherigerStatus, id).changes;
    if (changed) syncCampaignTargetForDraft(id, vorherigerStatus, "Versand wurde sicher vertagt");
  };
  // Letzte, atomare Beziehungskontrolle direkt vor dem Browserversand. Selbst ein bereits
  // freigegebener alter Entwurf darf eine inzwischen erkannte Wiedervorlage nicht übergehen.
  if (["first", "followup", "reaktivierung", "event"].includes(d.kind)) {
    if (d.contact_id) {
      const memory = getConversationMemory(d.contact_id);
      const context = validateProactiveContext(d.contact_id);
      if (!context.ok) {
        db.prepare("UPDATE drafts SET status='blockiert',blockiert_grund=?,context_validation='blocked' WHERE id=? AND status='sending'")
          .run(context.reason, id);
        syncCampaignTargetForDraft(id, "blockiert", context.reason);
        return { ok: false, reason: context.reason };
      }
      if (memory && d.context_memory_version && memory.version !== d.context_memory_version) {
        const reason = "Das Gespräch hat sich seit diesem Entwurf verändert – bitte Nachricht neu prüfen";
        db.prepare("UPDATE drafts SET status='blockiert',blockiert_grund=?,context_validation='stale' WHERE id=? AND status='sending'")
          .run(reason, id);
        syncCampaignTargetForDraft(id, "blockiert", reason);
        return { ok: false, reason };
      }
    }
    const kind = d.kind === "event" ? "campaign" : d.kind as "first" | "followup" | "reaktivierung";
    const policy = proactiveDecisionForTarget(d.thread_url, d.participant ?? "", kind);
    if (!policy.ok) {
      blockDraftForRelationship(id, policy.reason);
      syncCampaignTargetForDraft(id, "blockiert", policy.reason);
      console.info(`[beziehungsschutz] Entwurf #${id} nicht gesendet – ${policy.reason}`);
      events.emit("draft:blockiert", { id, grund: policy.reason, participant: d.participant });
      return { ok: false, reason: policy.reason };
    }
  }
  // DUPLIKAT-SPERRE für Erstnachrichten: wenn der Kontakt schon angeschrieben wurde, NICHT
  // erneut senden (auch wenn der Entwurf freigegeben ist). Entwurf aus der Warteschlange nehmen.
  if (d.kind === "first") {
    const st = db.prepare("SELECT messaged_at FROM contacts WHERE profile_url=?").get(d.thread_url) as { messaged_at?: string } | undefined;
    if (st?.messaged_at) {
      db.prepare("UPDATE drafts SET status='blockiert', blockiert_grund=? WHERE id=? AND status='sending'")
        .run(`Schon angeschrieben – ein zweiter Erstkontakt wäre ein Duplikat`, id);
      console.info(`[sicherheit] Entwurf #${id} nicht gesendet – ${d.participant ?? "Kontakt"} wurde schon angeschrieben (kein Duplikat).`);
      return { ok: false, reason: "Schon angeschrieben – kein Duplikat" };
    }
  }
  // STALENESS-SPERRE für Follow-ups (Bug-Fix 2026-07-26): Hat die Person INZWISCHEN geantwortet,
  // ist ein Follow-up/Reminder sinnlos (SINAN ist am Zug, nicht die Person). Solche veralteten
  // Follow-ups NICHT senden – verwerfen. Die Antwort behandelt der Agent bzw. ein frischer Entwurf.
  if (d.kind === "followup") {
    const st = db.prepare("SELECT status, replied_at FROM contacts WHERE profile_url=?").get(d.thread_url) as { status?: string; replied_at?: string } | undefined;
    if (st && (st.replied_at || ["replied", "closed"].includes(st.status ?? ""))) {
      db.prepare("UPDATE drafts SET status='discarded' WHERE id=? AND status='sending'").run(id);
      syncCampaignTargetForDraft(id, "discarded", "Person hat inzwischen geantwortet");
      console.info(`[sicherheit] Follow-up #${id} verworfen – ${d.participant ?? "Kontakt"} hat inzwischen geantwortet (kein Reminder an Antwortende).`);
      return { ok: false, reason: "Person hat geantwortet – Follow-up hinfällig" };
    }
  }
  try {
    // 'first'/'followup'/'reaktivierung' = Nachricht an einen Kontakt (über Profil),
    // 'message' = Antwort im bestehenden Thread, 'comment' = öffentlicher Kommentar.
    if (d.kind === "comment") await sendComment(d.thread_url, d.draft); // öffentlicher Kommentar
    // Event-Einladungen laufen in den eigenen Kampagnen-Topf des Governors, damit sie das
    // Akquise-Kontingent nicht aufbrauchen (Sinans Vorgabe 2026-08-05). Sendeweg identisch.
    else if (d.kind === "first" || d.kind === "followup" || d.kind === "reaktivierung" || d.kind === "event")
      await sendMessage(d.thread_url, d.draft, d.kind === "event" ? "campaign" : "message");
    else await sendThreadReply(d.thread_url, d.draft, d.participant ?? "");
    db.prepare("UPDATE drafts SET status='sent', sent_at=datetime('now') WHERE id=? AND status='sending'").run(id);
    syncCampaignTargetForDraft(id, "sent", "Nachricht nachweislich gesendet");
    if (["first", "reaktivierung", "event"].includes(d.kind)) {
      const contact = contactForConversation(d.thread_url, d.participant ?? "");
      if (contact) recordCrmStage(contact.id, "messaged", "bot");
    }
    learnFromDraft(id, "sent");
    return { ok: true };
  } catch (e) {
    if (e instanceof DuplikatBlockiert) {
      db.prepare("UPDATE drafts SET status='discarded' WHERE id=? AND status='sending'").run(id);
      syncCampaignTargetForDraft(id, "discarded", e.message);
      return { ok: false, reason: e.message };
    }
    if (e instanceof GovernorBlocked) {
      zurueckstellen();
      return { ok: false, reason: e.message };
    }
    // Navigation, Laden des Editors oder ein Selektor kann scheitern, BEVOR LinkedIn einen
    // Sende-Klick bekommen hat. Dann ist der Status nicht "unklar": Es ging sicher nichts raus.
    // Entwurf zurück in die Warteschlange und beim nächsten Cron-Lauf erneut versuchen.
    if (e instanceof VersandNichtVersucht) {
      zurueckstellen();
      console.warn(`[send] Entwurf #${id}: technischer Fehler vor Versand – bleibt ${vorherigerStatus}, erneuter Versuch später: ${e.message.slice(0, 120)}`);
      return { ok: false, reason: "Technischer Fehler vor Versand – wird erneut versucht" };
    }
    /**
     * UNSICHERE NACHRICHT (Kauderwelsch / Feld-Inhalt weicht ab): NICHT erneut versuchen –
     * sonst würde derselbe Mist wieder und wieder rausgehen. Entwurf 'blockiert' setzen (kommt
     * NICHT in die Sende-Warteschlange zurück) und den Nutzer informieren.
     */
    if (e instanceof UnsichereNachricht) {
      db.prepare("UPDATE drafts SET status='blockiert', blockiert_grund=? WHERE id=? AND status='sending'").run(e.grund, id);
      syncCampaignTargetForDraft(id, "blockiert", e.grund);
      console.error(`[sicherheit] Entwurf #${id} blockiert – ${e.grund}. Nicht gesendet.`);
      events.emit("draft:blockiert", { id, grund: e.grund, participant: d.participant });
      return { ok: false, reason: `Blockiert: ${e.grund}` };
    }
    // Nach einem technischen Fehler ist nicht beweisbar, ob LinkedIn den Klick doch noch
    // angenommen hat (z.B. Browser/Netz stirbt direkt danach). Deshalb KEIN Auto-Retry: der
    // Status bleibt sichtbar und der Mensch prüft den Verlauf, bevor etwas erneut rausgeht.
    db.prepare("UPDATE drafts SET status='unknown', blockiert_grund=? WHERE id=? AND status='sending'")
      .run(`Versand unklar nach technischem Fehler: ${String((e as Error)?.message ?? e).slice(0, 120)}`, id);
    syncCampaignTargetForDraft(id, "unknown", "Versandstatus unklar – LinkedIn-Verlauf prüfen");
    console.error(`[send] Entwurf #${id}: Versandstatus unklar – kein automatischer Retry: ${(e as Error)?.message?.slice(0, 120)}`);
    events.emit("draft:blockiert", { id, grund: "Versandstatus unklar – LinkedIn-Verlauf prüfen", participant: d.participant });
    return { ok: false, reason: "Versandstatus unklar – nicht automatisch erneut gesendet" };
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
    const conversationGoal = goalForConversation(t.threadUrl, t.participant);
    const step = await converseStep(t.messages, t.participant, conversationGoal).catch((e) => {
      console.error(`[drafts] ⚠ KI-Fehler bei ${t.participant}: ${String(e?.message ?? e).slice(0, 80)}`);
      return null;
    });
    if (!step || !step.reply) continue;
    learnFromReply(t.threadUrl, t.participant, t.lastIncoming, step.intent);

    // Ein anderer sinnvoller Weg ist eine Entscheidung, kein stiller Prompt-Wechsel. Antwort als
    // Entwurf sichern, Abweichung separat melden und diesen Thread für den Lauf beenden.
    if (conversationGoal && step.goalAlignment === "different_goal") {
      const info = db.prepare(
        "INSERT INTO drafts(kind,thread_url,participant,incoming,draft,ki_original,intent) VALUES('message',?,?,?,?,?,'goal_deviation')",
      ).run(t.threadUrl, t.participant, t.lastIncoming, step.reply, step.reply);
      const alertId = recordGoalAlert({
        threadUrl: t.threadUrl,
        participant: t.participant,
        currentGoal: conversationGoal.code,
        suggestedGoal: step.suggestedGoal,
        summary: step.zusammenfassung || step.strategie || "Das Gespräch entwickelt sich in eine andere Richtung.",
        campaignId: conversationGoal.campaignId,
      });
      const d = getDraft(Number(info.lastInsertRowid));
      events.emit("draft:new", d);
      events.emit("goal:deviation", { alertId, draft: d, participant: t.participant, currentGoal: conversationGoal.code,
        suggestedGoal: step.suggestedGoal, summary: step.zusammenfassung, threadUrl: t.threadUrl });
      created++;
      continue;
    }

    // Hot Lead NUR bei echtem Interesse. Ein höfliches Abwinken ist KEIN heißer Lead –
    // sonst verfälscht es die Pipeline und Sinan ruft die Falschen an.
    const contactId = markInboundReply(t.threadUrl, t.participant, step.intent === "absage");
    if (contactId) {
      observeRelationshipMessage(contactId, t.lastIncoming);
      recordCrmStage(contactId, "replied", "bot");
      if (["chance", "positive", "meeting"].includes(step.intent)) recordCrmStage(contactId, "qualified", "bot");
      if (step.intent === "meeting" || step.contact) recordCrmStage(contactId, "meeting", "bot");
      if (step.intent === "absage") recordCrmStage(contactId, "lost", "bot");
      replies++;
    }

    // PITCHBEREIT (chance): Sinan will hier ERST Pitch-IDEEN statt einer fertigen Nachricht
    // (2026-07-28). Der Bot legt einen 'pitchidee'-Entwurf mit mehreren Ansätzen ab; Sinan wählt
    // einen → daraus wird die Nachricht generiert (pitchZuNachricht) → nochmal Freigabe. Den
    // Verlauf legen wir in ki_original ab, damit Stufe 2 ohne erneutes Inbox-Lesen auskommt.
    if (step.intent === "chance") {
      const ideen = await pitchIdeen(t.messages, t.participant).catch(() => [] as string[]);
      if (ideen.length) {
        const info = db
          .prepare("INSERT INTO drafts(kind, thread_url, participant, incoming, draft, ki_original, intent) VALUES('pitchidee',?,?,?,?,?,?)")
          .run(t.threadUrl, t.participant, t.lastIncoming, JSON.stringify(ideen), JSON.stringify({ transcript: t.messages, ideen }), "chance");
        const d = getDraft(Number(info.lastInsertRowid));
        created++;
        events.emit("lead:eskalation", {
          draft: d, participant: t.participant, intent: "chance",
          zusammenfassung: step.zusammenfassung, strategie: step.strategie,
          threadUrl: t.threadUrl, contact: step.contact,
        });
        continue; // KEINE fertige Nachricht in dieser Stufe
      }
      // Keine Ideen erzeugt (KI-Limit o.ä.) → Fallback: normale Antwort wie bisher.
    }

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
