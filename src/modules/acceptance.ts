import { newPage, guardAgainstCheckpoint } from "../core/session.js";
import { humanScroll, humanDelay } from "../core/humanize.js";
import { invitedNotAccepted, markAccepted } from "./crm.js";
import { deliverFirstMessage } from "./drafts.js";
import { db } from "../db/index.js";
import type { Contact } from "./crm.js";

/**
 * Phase 4 – Acceptance-Tracking.
 * Liest die eigene Kontaktliste (rein lesend, KEIN Governor nötig, kein Senden)
 * und markiert jede eingeladene Person, die inzwischen in den Verbindungen auftaucht,
 * als angenommen. Damit wird accepted_at gesetzt – die Grundlage für den
 * Akzeptanzraten-Circuit-Breaker im Governor.
 *
 * Wir besuchen bewusst NICHT jedes Profil einzeln (das wären teure, rate-limitierte
 * profileViews). Stattdessen ein einziger Sweep über die Verbindungsseite.
 *
 * Selektoren gebündelt – LinkedIn ändert die UI regelmäßig, dann nur hier anpassen.
 */
const SEL = {
  // Anker auf Personen-Profile in den Verbindungskarten.
  connectionLink: "a[href*='/in/']",
};

const CONNECTIONS_URL = "https://www.linkedin.com/mynetwork/invite-connect/connections/";

/** Profil-URL auf einen vergleichbaren Schlüssel normalisieren (Query/Slash/Case egal). */
function normalizeProfileUrl(url: string): string {
  const noQuery = url.split("?")[0].split("#")[0];
  return noQuery.replace(/\/+$/, "").toLowerCase();
}

/**
 * Ein Durchlauf: gleicht offene Einladungen gegen die aktuelle Kontaktliste ab.
 * Rückgabe: Anzahl neu erkannter Annahmen.
 */
export async function checkAcceptances(): Promise<number> {
  const pending = invitedNotAccepted();
  if (pending.length === 0) return 0;

  const page = await newPage();
  await page.goto(CONNECTIONS_URL, { waitUntil: "domcontentloaded" });
  if (await guardAgainstCheckpoint(page)) return 0;

  // Mehrfach scrollen, damit auch etwas ältere Verbindungen nachladen.
  for (let i = 0; i < 5; i++) {
    await humanScroll(page);
    await humanDelay(1200, 2800);
  }

  // Alle aktuell sichtbaren Verbindungs-URLs einsammeln, normalisiert & dedupliziert.
  const rawUrls = await page.$$eval(SEL.connectionLink, (anchors) =>
    Array.from(
      new Set(
        anchors
          .map((a) => (a as HTMLAnchorElement).href)
          .filter((href) => href.includes("/in/")),
      ),
    ),
  );
  const connected = new Set(rawUrls.map(normalizeProfileUrl));

  let newlyAccepted = 0;
  for (const c of pending) {
    if (connected.has(normalizeProfileUrl(c.profile_url))) {
      if (markAccepted(c.profile_url)) {
        newlyAccepted++;
        // Bei Annahme sofort eine personalisierte Erstnachricht als Entwurf erzeugen
        // (Freigabe im Dashboard). Das ist der Ergebnis-Hebel: Vernetzung → Gespräch.
        const contact = db.prepare("SELECT * FROM contacts WHERE profile_url=?").get(c.profile_url) as Contact | undefined;
        if (contact) await deliverFirstMessage(contact).catch(() => {});
      }
    }
  }

  // Nachholen: angenommene Kontakte ohne Erstnachricht-Entwurf (z.B. weil das Gemini-Kontingent
  // beim Annehmen leer war). Begrenzt, um das Kontingent zu schonen.
  const missing = db
    .prepare(
      `SELECT c.* FROM contacts c
       WHERE c.status='accepted'
         AND NOT EXISTS (SELECT 1 FROM drafts d WHERE d.thread_url = c.profile_url AND d.kind='first')
       ORDER BY c.accepted_at DESC LIMIT 3`,
    )
    .all() as Contact[];
  let backfilled = 0;
  for (const c of missing) {
    await deliverFirstMessage(c).catch(() => {});
    backfilled++;
  }

  console.info(
    `[acceptance] ${newlyAccepted} neue Annahme(n), ${backfilled} Erstnachricht(en) nachgeholt (von ${pending.length} offenen Einladungen)`,
  );
  return newlyAccepted;
}
