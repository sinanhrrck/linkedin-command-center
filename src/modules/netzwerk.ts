import { newPage, guardAgainstCheckpoint } from "../core/session.js";
import { humanDelay, humanScroll } from "../core/humanize.js";
import { db } from "../db/index.js";
import { upsertContact, type Contact } from "./crm.js";
import { reaktivierungMessage } from "./personalize.js";
import { istPlausibleNachricht } from "../core/nachrichtCheck.js";
import { events } from "../core/events.js";
import { getDraft } from "./drafts.js";

/**
 * BESTEHENDES NETZWERK REAKTIVIEREN.
 *
 * Der stärkste ungenutzte Hebel: Leute, mit denen man SCHON vernetzt ist, aber nie geschrieben
 * hat. Kein Vernetzungs-Kontingent nötig (die Verbindung steht bereits), keine Annahme-Wartezeit,
 * und die Antwortquote ist deutlich höher als bei Kaltkontakten.
 *
 * Rein LESEND auf LinkedIn (Kontaktliste scrollen) → KEIN Governor nötig, genau wie acceptance.ts.
 * Gesendet wird erst über den normalen, governor-gedrosselten Entwurfs-Weg nach DEINER Freigabe.
 */

const SEL = {
  // Verbindungskarten: Anker auf Personen-Profile. Bewusst breit – LinkedIn verschleiert Klassen.
  connectionLink: "a[href*='/in/']",
};
const CONNECTIONS_URL = "https://www.linkedin.com/mynetwork/invite-connect/connections/";

/** Profil-URL vergleichbar machen (Query/Slash/Case egal) – identisch zu acceptance.ts. */
function normalizeProfileUrl(url: string): string {
  return url.split("?")[0].split("#")[0].replace(/\/+$/, "").toLowerCase();
}

/**
 * Liest die eigene Kontaktliste und legt alle gefundenen Verbindungen im CRM an
 * (Status 'accepted' – die Vernetzung besteht ja schon).
 *
 * Namen/Headline werden aus dem KARTEN-TEXT geparst, nicht aus CSS-Klassen: LinkedIn
 * verschleiert Klassennamen, der Text ist stabiler (gleiche Strategie wie leads.ts).
 * Rückgabe: Anzahl NEU angelegter Kontakte.
 */
export async function scanNetzwerk(scrolls = 8): Promise<number> {
  const page = await newPage();
  await page.goto(CONNECTIONS_URL, { waitUntil: "domcontentloaded" });
  if (await guardAgainstCheckpoint(page)) return 0;
  await humanDelay(1500, 3000);

  // Mehrfach scrollen, damit auch ältere Verbindungen nachladen.
  for (let i = 0; i < scrolls; i++) {
    await humanScroll(page);
    await humanDelay(1200, 2600);
  }

  const gefunden = await page.$$eval(SEL.connectionLink, (anchors) => {
    const raus: { url: string; name: string; headline: string }[] = [];
    const gesehen = new Set<string>();
    for (const a of anchors) {
      const el = a as HTMLAnchorElement;
      if (!el.href.includes("/in/")) continue;
      const key = el.href.split("?")[0];
      if (gesehen.has(key)) continue;
      gesehen.add(key);
      // Karte = nächstgelegener Listeneintrag; daraus Name (1. Zeile) + Headline (2. Zeile).
      const karte = el.closest("li") || el.parentElement;
      const zeilen = ((karte as HTMLElement)?.innerText || el.innerText || "")
        .split("\n")
        .map((z) => z.trim())
        .filter(Boolean)
        // LinkedIn-Rauschen entfernen (Statuszeilen, Buttons).
        .filter((z) => !/^(mitglied|status|nachricht|mehr|·|vernetzt)/i.test(z));
      raus.push({ url: key, name: zeilen[0] ?? "", headline: zeilen[1] ?? "" });
    }
    return raus;
  });

  let neu = 0;
  for (const g of gefunden) {
    if (!g.name) continue; // ohne Namen kein Kontakt (Empfänger-Verifikation braucht ihn!)
    const url = normalizeProfileUrl(g.url);
    const schonDa = db.prepare("SELECT 1 FROM contacts WHERE profile_url=?").get(url);
    upsertContact({ profileUrl: url, fullName: g.name, headline: g.headline || undefined });
    if (!schonDa) {
      neu++;
      // Verbindung besteht bereits → direkt als 'accepted' markieren, damit der Kontakt
      // NICHT in die Vernetzungs-Warteschlange rutscht (das Kontingent wäre verschwendet).
      db.prepare(
        "UPDATE contacts SET status='accepted', accepted_at=COALESCE(accepted_at, datetime('now')), aus_netzwerk=1 WHERE profile_url=?",
      ).run(url);
    }
  }
  console.info(`[netzwerk] ${gefunden.length} Verbindungen gelesen, ${neu} neu im CRM.`);
  return neu;
}

/** Bestehende Verbindungen, die NIE angeschrieben wurden – die Reaktivierungs-Kandidaten. */
export function reaktivierbareKontakte(limit: number): Contact[] {
  return db
    .prepare(
      `SELECT * FROM contacts
       WHERE aus_netzwerk = 1
         AND messaged_at IS NULL
         AND status NOT IN ('messaged','replied','closed','skipped')
         AND NOT EXISTS (
           SELECT 1 FROM drafts d WHERE d.thread_url = contacts.profile_url
             AND d.kind='reaktivierung' AND d.status IN ('pending','approved','sent','discarded')
         )
       ORDER BY lead_score DESC, created_at
       LIMIT ?`,
    )
    .all(limit) as Contact[];
}

/**
 * Erzeugt Reaktivierungs-Entwürfe (kind='reaktivierung') für bestehende Verbindungen.
 * Gesendet wird NUR nach Freigabe über den normalen Weg (sendDraft → sendMessage, governor-gated).
 * Bewusst kleines Limit: das Gemini-Kontingent ist knapp, und Masse ist hier kontraproduktiv.
 */
export async function generateReaktivierung(limit = 3): Promise<number> {
  const kandidaten = reaktivierbareKontakte(limit);
  let done = 0;
  for (const c of kandidaten) {
    const text = await reaktivierungMessage(c).catch(() => "");
    if (!text) continue;
    const chk = istPlausibleNachricht(text);
    if (!chk.ok) {
      console.error(`[netzwerk] Entwurf für ${c.full_name} verworfen (${chk.grund}).`);
      continue;
    }
    const info = db
      .prepare("INSERT INTO drafts(kind, thread_url, participant, incoming, draft, ki_original) VALUES('reaktivierung',?,?,?,?,?)")
      .run(c.profile_url, c.full_name ?? null, "", text, text);
    events.emit("draft:new", getDraft(Number(info.lastInsertRowid)));
    done++;
  }
  if (done) console.info(`[netzwerk] ${done} Reaktivierungs-Entwurf/-Entwürfe erzeugt.`);
  return done;
}
