import { config } from "../config.js";
import { db, getMode } from "../db/index.js";
import { fetchThreads } from "./inbox.js";
import { converseStep } from "./personalize.js";
import { sendThreadReply } from "./outreach.js";
import { queueReplyDraft } from "./drafts.js";
import { markRepliedByName } from "./crm.js";
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

function getConv(threadUrl: string): Conv {
  db.prepare(
    "INSERT INTO conversations(thread_url, participant) VALUES(?,?) ON CONFLICT(thread_url) DO NOTHING",
  ).run(threadUrl, "");
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

    const conv = getConv(t.threadUrl);
    if (conv.status !== "active") continue; // schon gebucht oder eskaliert → Finger weg

    markRepliedByName(t.participant); // Hot Lead

    const step = await converseStep(t.messages, t.participant).catch(() => null);

    // KI unsicher / Einwand / Nachrichten-Limit erreicht → an den Menschen eskalieren
    if (!step || step.intent === "objection" || conv.auto_count >= config.autopilot.maxMessagesPerThread) {
      queueReplyDraft(t.threadUrl, t.participant, t.lastIncoming, step?.reply || "");
      db.prepare("UPDATE conversations SET status='escalated', updated_at=datetime('now') WHERE thread_url=?").run(t.threadUrl);
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
    } catch (e) {
      if (!(e instanceof GovernorBlocked)) throw e; // Limit/Checkpoint → still überspringen
    }
  }

  if (res.replied || res.booked || res.escalated)
    console.info(`[autopilot] ${res.replied} auto-geantwortet · ${res.booked} Termin(e) · ${res.escalated} eskaliert`);
  return res;
}
