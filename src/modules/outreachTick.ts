import { nextNewContacts, markSkippedLowScore, claimForInvite, releaseInvite } from "./crm.js";
import { connectionNote } from "./personalize.js";
import { sendConnectionRequest } from "./outreach.js";
import { governor } from "../core/safetyGovernor.js";
import { db } from "../db/index.js";
import { config } from "../config.js";

/**
 * Ein Outreach-Durchlauf. Nimmt neue Leads, personalisiert die Notiz und vernetzt –
 * aber nur so weit, wie der Governor JETZT erlaubt. Alle Drosselung (Caps, Warm-up,
 * Arbeitszeit, Delays, Circuit-Breaker) passiert im Governor, nicht hier.
 *
 * DOPPEL-VERNETZUNGS-SCHUTZ: jeder Lead wird ATOMAR beansprucht ('new'→'inviting'), bevor
 * angefragt wird. Selbst wenn versehentlich zwei Engines laufen, schnappt SQLite-serialisiert
 * nur EINE den Lead – die andere bekommt ihn nicht und vernetzt nicht doppelt.
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

    // ATOMAR beanspruchen. Bekommt ein anderer Durchlauf/Engine den Lead → hier changes=0 → weiter.
    if (!claimForInvite(c.profile_url)) continue;

    try {
      // Notiz nur generieren, wenn aktiviert (LinkedIn lässt Notizen ohnehin meist nicht zu).
      const note = config.gemini.connectNotes ? await connectionNote(c).catch(() => undefined) : undefined;
      await sendConnectionRequest(c.profile_url, note); // setzt bei Erfolg Status 'invited'
      // Blieb der Lead 'inviting' (Governor-Skip/Duplikat, kein echter Versand) → wieder freigeben.
      const st = db.prepare("SELECT status FROM contacts WHERE profile_url=?").get(c.profile_url) as { status?: string } | undefined;
      if (st?.status === "inviting") releaseInvite(c.profile_url);
    } catch (e) {
      releaseInvite(c.profile_url); // Fehler → Anspruch zurückgeben, später neu versuchen
      throw e;
    }
  }
}
