import { nextNewContacts, markSkippedLowScore } from "./crm.js";
import { connectionNote } from "./personalize.js";
import { sendConnectionRequest } from "./outreach.js";
import { governor } from "../core/safetyGovernor.js";
import { config } from "../config.js";

/**
 * Ein Outreach-Durchlauf. Nimmt neue Leads, personalisiert die Notiz und vernetzt –
 * aber nur so weit, wie der Governor JETZT erlaubt. Alle Drosselung (Caps, Warm-up,
 * Arbeitszeit, Delays, Circuit-Breaker) passiert im Governor, nicht hier.
 */
export async function outreachTick() {
  if (governor.isPaused()) return;
  if (!governor.canDoAction("connect").ok) return;

  // Erst den Müll aussortieren (kostet kein Kontingent), dann die BESTEN Leads zuerst.
  const aussortiert = markSkippedLowScore();
  if (aussortiert) console.info(`[outreach] ${aussortiert} schwache Lead(s) aussortiert (Score zu niedrig)`);
  // Bewusst nur wenige pro Tick anfassen; der Governor bremst zusätzlich zwischen den Sends.
  const contacts = nextNewContacts(3);
  for (const c of contacts) {
    if (!governor.canDoAction("connect").ok) break; // Limit mitten im Tick erreicht
    // Notiz nur generieren, wenn aktiviert (schont das knappe Gemini-Free-Kontingent).
    const note = config.gemini.connectNotes
      ? await connectionNote(c).catch(() => undefined)
      : undefined;
    await sendConnectionRequest(c.profile_url, note); // setzt bei Erfolg Status 'invited'
  }
}
