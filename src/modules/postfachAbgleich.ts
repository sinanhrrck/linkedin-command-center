import { db } from "../db/index.js";
import { recordCrmStage } from "./crmStages.js";

/**
 * POSTFACH-ABGLEICH (2026-09-25). Anlass: Neuaufbau des Servers mit einer Datenbank vom August –
 * der alte Server samt Verlauf war verloren. Der Bot hielt längst angeschriebene Kontakte für neu.
 * LinkedIn ist die Wahrheit: Was dort im Chat steht, korrigiert die Datenbank, nie umgekehrt.
 *
 * Zwei Quellen, beide ohne zusätzlichen Seitenaufruf:
 *  1. Der geöffnete Chat beim Senden (outreach.ts → VerlaufVorhanden) – exakt, je Person.
 *  2. Die Chatliste, die inbox.fetchThreads ohnehin mehrmals täglich liest – nur bei EINDEUTIGEM
 *     Namen (zwei Kontakte gleichen Namens → nichts tun, lieber ein Entwurf zu viel als ein
 *     falsch markierter Kontakt).
 *
 * Korrigiert wird nur in eine Richtung: „noch nie angeschrieben“ → „angeschrieben“ bzw. „hat
 * geantwortet“. Nichts wird zurückgestuft, nichts gelöscht; verworfene Entwürfe tragen den Grund.
 */

const OFFENE_ENTWURF = "status IN ('pending','approved')";

function name(n: string | null | undefined): string {
  return String(n ?? "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

type Row = { id: number; profile_url: string; status: string; messaged_at: string | null; full_name: string | null };

/**
 * Setzt den Kontakt auf den Stand, den LinkedIn zeigt, und verwirft überholte Entwürfe.
 * Gibt die Zahl verworfener Entwürfe zurück.
 */
export function heileKontakt(contactId: number, befund: { personHatGeschrieben: boolean }, quelle: string): number {
  const c = db.prepare("SELECT id, profile_url, status, messaged_at, full_name FROM contacts WHERE id=?").get(contactId) as Row | undefined;
  if (!c) return 0;
  const vorher = c.status;
  db.prepare(
    `UPDATE contacts SET
       status = CASE
         WHEN status IN ('closed','skipped') THEN status
         WHEN ? = 1 THEN 'replied'
         WHEN status IN ('new','inviting','invited','accepted') THEN 'messaged'
         ELSE status END,
       accepted_at = COALESCE(accepted_at, datetime('now')),
       messaged_at = COALESCE(messaged_at, datetime('now')),
       replied_at = CASE WHEN ? = 1 THEN COALESCE(replied_at, datetime('now')) ELSE replied_at END
     WHERE id=?`,
  ).run(befund.personHatGeschrieben ? 1 : 0, befund.personHatGeschrieben ? 1 : 0, contactId);
  recordCrmStage(contactId, "messaged", "backfill");
  if (befund.personHatGeschrieben) recordCrmStage(contactId, "replied", "backfill");
  const arten = befund.personHatGeschrieben ? "('first','reaktivierung','followup')" : "('first','reaktivierung')";
  const verworfen = db.prepare(
    `UPDATE drafts SET status='discarded', blockiert_grund=? WHERE thread_url=? AND kind IN ${arten} AND ${OFFENE_ENTWURF}`,
  ).run(`Abgleich mit LinkedIn (${quelle}): Chat hat schon Verlauf`, c.profile_url).changes;
  if (vorher !== "messaged" && vorher !== "replied" || verworfen)
    console.info(`[abgleich] ${c.full_name ?? c.profile_url}: ${vorher} → laut LinkedIn ${befund.personHatGeschrieben ? "hat geantwortet" : "angeschrieben"}${verworfen ? `, ${verworfen} Entwurf/Entwürfe verworfen` : ""} (${quelle})`);
  return verworfen;
}

export function heileKontaktNachUrl(profileUrl: string, befund: { personHatGeschrieben: boolean }, quelle: string): number {
  const c = db.prepare("SELECT id FROM contacts WHERE profile_url=?").get(profileUrl) as { id: number } | undefined;
  return c ? heileKontakt(c.id, befund, quelle) : 0;
}

/**
 * Chatliste auswerten: Jede Zeile heißt „mit dieser Person gibt es einen Chat“. `sinanZuletzt`
 * kommt aus der Vorschau („Sie:/Du:“). Liefert Zahlen fürs Log.
 */
export function heileAusChatliste(zeilen: { participant: string; sinanZuletzt: boolean | null }[]): { kontakte: number; entwuerfe: number } {
  if (!zeilen.length) return { kontakte: 0, entwuerfe: 0 };
  const alle = db.prepare("SELECT id, profile_url, status, messaged_at, full_name FROM contacts WHERE full_name IS NOT NULL").all() as Row[];
  const nachName = new Map<string, Row[]>();
  for (const c of alle) {
    const k = name(c.full_name);
    if (k) nachName.set(k, [...(nachName.get(k) || []), c]);
  }
  const verwirfAntwort = db.prepare(
    `UPDATE drafts SET status='discarded', blockiert_grund='Abgleich mit LinkedIn: du hast in diesem Chat zuletzt geschrieben'
      WHERE kind IN ('message','pitchidee') AND ${OFFENE_ENTWURF} AND participant=?`,
  );
  let kontakte = 0, entwuerfe = 0;
  db.transaction(() => {
    for (const z of zeilen) {
      const k = name(z.participant);
      if (!k) continue;
      const treffer = nachName.get(k) || [];
      if (treffer.length === 1) {
        const c = treffer[0];
        const personHat = z.sinanZuletzt === false;
        // Nur, wenn die Datenbank etwas anderes glaubt – sonst kein Schreiben, keine Logzeile.
        const offen = (db.prepare(
          `SELECT COUNT(*) n FROM drafts WHERE thread_url=? AND ${OFFENE_ENTWURF}
             AND (kind IN ('first','reaktivierung') OR (? = 1 AND kind='followup'))`,
        ).get(c.profile_url, personHat ? 1 : 0) as { n: number }).n;
        const falscherStatus = !c.messaged_at || (personHat && c.status === "messaged");
        if (falscherStatus || offen) {
          entwuerfe += heileKontakt(c.id, { personHatGeschrieben: personHat }, "Chatliste");
          kontakte++;
        }
      }
      // Antwort-Entwürfe sind am Teilnehmernamen festgemacht, nicht am Kontakt.
      if (z.sinanZuletzt === true) {
        for (const variante of new Set([z.participant.trim(), ...(treffer.length === 1 ? [treffer[0].full_name ?? ""] : [])])) {
          if (variante) entwuerfe += verwirfAntwort.run(variante).changes;
        }
      }
    }
  })();
  if (kontakte || entwuerfe) console.info(`[abgleich] Chatliste: ${kontakte} Kontakt(e) korrigiert, ${entwuerfe} überholte(r) Entwurf/Entwürfe verworfen`);
  return { kontakte, entwuerfe };
}
