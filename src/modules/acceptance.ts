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
        if (contact)
          await deliverFirstMessage(contact).catch((e: Error) =>
            console.error(`[acceptance] ⚠ Erstnachricht fehlgeschlagen: ${e.message?.slice(0, 90)}`),
          );
      }
    }
  }

  // Nachholen: angenommene Kontakte, die noch KEINE Erstnachricht bekommen haben. Früher auf 3
  // gedrosselt wegen des Gemini-Tageslimits – das ist weg (nur noch Claude), also holen wir den
  // Rückstau zügiger auf (bis 10/Lauf). Der Governor drosselt den Versand ohnehin (Delay/Cap).
  // Ausschluss nur bei einem OFFENEN (pending/approved) oder GESENDETEN first-Entwurf – ein
  // 'blockiert'/'discarded' Alt-Entwurf blockiert einen frischen Versuch NICHT (der wird über den
  // "Als Entwürfe holen"-Knopf separat behandelt).
  const missing = db
    .prepare(
      `SELECT c.* FROM contacts c
       WHERE c.status='accepted'
         AND NOT EXISTS (SELECT 1 FROM drafts d WHERE d.thread_url = c.profile_url AND d.kind='first'
                          AND d.status IN ('pending','approved','sent'))
       ORDER BY c.accepted_at DESC LIMIT 10`,
    )
    .all() as Contact[];
  let backfilled = 0;
  for (const c of missing) {
    // Nur als "nachgeholt" zaehlen, was auch wirklich lief – sonst meldet das Log Arbeit,
    // die nie stattfand (siehe Versand-Falschmeldungen 2026-07-16).
    const ok = await deliverFirstMessage(c)
      .then(() => true)
      .catch((e: Error) => {
        console.error(`[acceptance] ⚠ Erstnachricht fehlgeschlagen fuer ${c.full_name}: ${e.message?.slice(0, 90)}`);
        return false;
      });
    if (ok) backfilled++;
  }

  console.info(
    `[acceptance] ${newlyAccepted} neue Annahme(n), ${backfilled} Erstnachricht(en) nachgeholt (von ${pending.length} offenen Einladungen)`,
  );
  return newlyAccepted;
}
