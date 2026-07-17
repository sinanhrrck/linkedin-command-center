import { config } from "../config.js";
import { db, getMode } from "../db/index.js";
import { fetchThreads } from "./inbox.js";
import { converseStep } from "./personalize.js";
import { sendThreadReply } from "./outreach.js";
import { queueReplyDraft, getDraft } from "./drafts.js";
import { markRepliedByName, markDeclinedByName } from "./crm.js";
import { governor, GovernorBlocked } from "../core/safetyGovernor.js";
import { events } from "../core/events.js";

/**
 * AUTOPILOT: voll-autonome Gespräche. Liest Threads, beantwortet Routine selbst
 * (governor-gedrosselt), erkennt Termin-Zusagen → Handoff via Telegram, und eskaliert
 * Einwände/Unsicheres an den Menschen (statt unbeaufsichtigt Mist zu bauen).
 *
 * NUR aktiv mit config.autopilot.enabled = true (bezahlter KI-Key + Immer-an-Maschine).
 */
type Conv = { thread_url: string; participant: string; auto_count: number; status: string; contact: string | null };

function getConv(threadUrl: string, participant = ""): Conv {
  // participant wurde bisher IMMER leer gespeichert – die Tabelle war damit fuer die
  // Nachschau wertlos ("wem hat der Bot was geschrieben?" liess sich nicht beantworten).
  db.prepare(
    "INSERT INTO conversations(thread_url, participant) VALUES(?,?) ON CONFLICT(thread_url) DO UPDATE SET participant=COALESCE(NULLIF(excluded.participant,''), conversations.participant)",
  ).run(threadUrl, participant);
  return db.prepare("SELECT * FROM conversations WHERE thread_url=?").get(threadUrl) as Conv;
}

export async function runAutopilot(max = 8): Promise<{ replied: number; booked: number; escalated: number }> {
  const res = { replied: 0, booked: 0, escalated: 0 };
  if (getMode() !== "full") return res; // Autopilot nur im Vollautomatik-Modus
  if (governor.isPaused()) return res;

  const threads = await fetchThreads(max);
  for (const t of threads) {
    const last = t.messages[t.messages.length - 1];
    const theirTurn = last ? (last.sender ? last.sender === t.participant : t.unread) : false;
    if (!theirTurn) continue;

    const conv = getConv(t.threadUrl, t.participant);
    if (conv.status !== "active") continue; // schon gebucht oder eskaliert → Finger weg

    markRepliedByName(t.participant); // Hot Lead

    const step = await converseStep(t.messages, t.participant).catch(() => null);

    /**
     * ABSAGE = ein Abschied. Da gibt es nichts zu retten und nichts zu entscheiden – der
     * würdige Schlusssatz geht autonom raus. Vorher landete das zusammen mit echten Einwänden
     * unter "objection" bei Sinan und war reine Klickarbeit ohne Wert.
     * Der Thread wird geschlossen, der Bot fasst ihn nie wieder an.
     */
    if (step && step.intent === "absage") {
      try {
        if (step.reply) await sendThreadReply(t.threadUrl, step.reply);
        markDeclinedByName(t.participant);
        db.prepare("UPDATE conversations SET status='closed', updated_at=datetime('now') WHERE thread_url=?").run(t.threadUrl);
        console.info(`[autopilot] ${t.participant} hat abgewunken → Abschied gesendet, Thread zu.`);
      } catch (e) {
        if (!(e instanceof GovernorBlocked)) throw e;
      }
      continue;
    }

    // KI unsicher / echter EINWAND / Nachrichten-Limit → an den Menschen eskalieren.
    // Ein Einwand ist NICHT das Ende: die Person ist noch da, aber ein falscher Satz
    // verbrennt sie. Genau dafür gibt es Sinan.
    if (!step || step.intent === "einwand" || conv.auto_count >= config.autopilot.maxMessagesPerThread) {
      queueReplyDraft(t.threadUrl, t.participant, t.lastIncoming, step?.reply || "");
      db.prepare("UPDATE conversations SET status='escalated', updated_at=datetime('now') WHERE thread_url=?").run(t.threadUrl);
      res.escalated++;
      continue;
    }

    /**
     * DIE TÜR GEHT AUF – der vertrieblich wichtigste Moment im ganzen System.
     * Die Person zeigt Unsicherheit, Bedarf oder fragt nach Sinan. Genau hier entscheidet
     * sich, ob ein Gespräch zu etwas wird. Der Bot SENDET hier bewusst NICHT: er bereitet
     * Sinans Antwort als Entwurf vor und übergibt (Sinans Entscheidung: "der Bot darf und
     * soll pitchen, aber gut und schlau" + "Entwurf vorbereiten, du gibst frei").
     * Vorher gab es diesen Zustand nicht: ein heißer Lead plauderte SECHS Mal mit dem Bot,
     * bevor er überhaupt bei Sinan ankam. Die Chance war dann meist durch.
     */
    if (step.intent === "chance") {
      queueReplyDraft(t.threadUrl, t.participant, t.lastIncoming, step.reply);
      db.prepare("UPDATE conversations SET status='escalated', updated_at=datetime('now') WHERE thread_url=?").run(t.threadUrl);
      events.emit("lead:chance", {
        participant: t.participant,
        zusammenfassung: step.zusammenfassung,
        strategie: step.strategie,
        vorschlag: step.reply,
        threadUrl: t.threadUrl,
      });
      res.escalated++;
      continue;
    }

    // Termin-Zusage oder Kontakt genannt → HANDOFF, ab hier übernimmt der Mensch
    if (step.intent === "meeting" || step.contact) {
      db.prepare("UPDATE conversations SET status='booked', contact=?, updated_at=datetime('now') WHERE thread_url=?")
        .run(step.contact ?? null, t.threadUrl);
      events.emit("lead:booked", { participant: t.participant, contact: step.contact, threadUrl: t.threadUrl });
      res.booked++;
      continue;
    }

    // Routine (positiv/neutral) → KI-Antwort autonom senden, governor-gedrosselt
    try {
      await sendThreadReply(t.threadUrl, step.reply);
      db.prepare("UPDATE conversations SET auto_count=auto_count+1, updated_at=datetime('now') WHERE thread_url=?").run(t.threadUrl);
      res.replied++;

      /**
       * PROTOKOLL + PUSH. Vorher speicherte der Autopilot NICHT, was er verschickt hat –
       * es gab keinerlei Nachschau. Real passiert 2026-07-17: der Bot fragte eine Azubi nach
       * ihren privaten Finanzen; Sinan sah es nur, weil er zufaellig im Chat war, und musste
       * die Nachricht loeschen. Ein Bot, der autonom in fremdem Namen schreibt, MUSS
       * nachvollziehbar sein. Als Draft mit status='sent' abgelegt (gleiche Tabelle wie alles
       * andere, im Dashboard nachlesbar) + sofortiger Telegram-Push.
       */
      const info = db
        .prepare(
          "INSERT INTO drafts(kind, thread_url, participant, incoming, draft, status, sent_at) VALUES('message',?,?,?,?,'sent',datetime('now'))",
        )
        .run(t.threadUrl, t.participant, t.lastIncoming, step.reply);
      events.emit("autopilot:gesendet", {
        draft: getDraft(Number(info.lastInsertRowid)),
        participant: t.participant,
        intent: step.intent,
        zusammenfassung: step.zusammenfassung,
        threadUrl: t.threadUrl,
        nachrichtNr: conv.auto_count + 1,
      });
    } catch (e) {
      if (!(e instanceof GovernorBlocked)) throw e; // Limit/Checkpoint → still überspringen
    }
  }

  if (res.replied || res.booked || res.escalated)
    console.info(`[autopilot] ${res.replied} auto-geantwortet · ${res.booked} Termin(e) · ${res.escalated} eskaliert`);
  return res;
}
