import { zgBedingung } from "../core/zielgruppenRegel.js";
import { db } from "../db/index.js";
import { generateText } from "../core/textLlm.js";
import { getProfil } from "../profil.js";
import { leadMagnete } from "./angebot.js";

/**
 * KI-LEAD-BEWERTUNG (2026-09-23): bevor eine Vernetzungsanfrage (knappes Kontingent!) rausgeht,
 * schätzt die KI, wie gut ein neuer Kontakt zu Sinans Angeboten passt – Beratung (Geld),
 * Partner/Karriere oder gar nicht – mit Note 0–100 und kurzer Begründung.
 *
 * Grundlage ist NUR, was ohnehin im CRM steht (Name, Headline, ggf. Profil-Fakten) – kein
 * zusätzlicher Profilaufruf, das Lese-Budget bleibt unberührt. In Gruppen zu 20, damit 600 Leads
 * rund 30 KI-Aufrufe kosten statt 600.
 *
 * Wirkung:
 *  - Die Warteschlange (crm.nextNewContacts, warteschlange.ts) sortiert nach KI-Note vor der
 *    alten Regel-Note: die besten Leads bekommen die begrenzten Anfragen zuerst.
 *  - Nur KLAR Unpassende (Note < AUSSORTIEREN_UNTER UND „keiner“) werden übersprungen
 *    (status 'skipped', Grund sichtbar). Im Zweifel bleibt der Kontakt drin.
 */

export const GRUPPE = 20;
export const AUSSORTIEREN_UNTER = 20;
export type Fit = "beratung" | "partner" | "beide" | "keiner";

type Kandidat = { id: number; full_name: string | null; headline: string | null; rolle: string | null; firma: string | null };

function kandidaten(limit: number): Kandidat[] {
  return db.prepare(
    `SELECT c.id, c.full_name, c.headline, f.rolle, f.firma
       FROM contacts c LEFT JOIN contact_profile_facts f ON f.contact_id=c.id
      WHERE c.status='new' AND c.ki_bewertet_at IS NULL AND COALESCE(c.do_not_contact,0)=0
        AND ${zgBedingung("c")}
      ORDER BY COALESCE(c.lead_score,50) DESC, c.created_at
      LIMIT ?`,
  ).all(limit) as Kandidat[];
}

async function bewerteGruppe(liste: Kandidat[]): Promise<number> {
  const p = getProfil();
  const angebote = leadMagnete().map((m) => `- ${m.titel} (${m.route === "finanzen" ? "Geldfragen/Beratung" : "Karriere/Partner"})`).join("\n");
  const prompt = `Du bewertest LinkedIn-Kontakte für ${p.name}, bevor eine (knappe) Vernetzungsanfrage rausgeht.
ÜBER ${p.name.toUpperCase()}: ${p.persona}
ZIEL: ${p.ziel}
${angebote ? `ANGEBOTE:\n${angebote}` : ""}
Zwei Wege: "beratung" = Kunde für Finanzberatung (Berufseinsteiger mit erstem Gehalt, Geldfragen). "partner" = Karriere/Vertriebspartner (Azubis und junge Bank-/Finanzleute mit Ehrgeiz, Orientierung nach der Ausbildung). "beide" = passt zu beidem. "keiner" = klar unpassend (z. B. Recruiter, Führungskräfte weit über der Zielgruppe, Fake-/Firmenprofile, völlig fremde Branche ohne Bezug).

Bewerte jede Person NUR anhand dieser Angaben, nichts dazuerfinden. Im Zweifel mittlere Note, nicht "keiner". Fehlen Angaben (Headline "-"), dann Note 40 und "beide" – fehlende Angaben sind kein Ausschlussgrund.

KONTAKTE:
${liste.map((k) => `${k.id} | ${k.full_name ?? "?"} | ${k.headline ?? "-"}${k.rolle ? ` | aktuell: ${k.rolle}${k.firma ? ` bei ${k.firma}` : ""}` : ""}`).join("\n")}

Antworte AUSSCHLIESSLICH mit einem JSON-Array, ein Objekt je Kontakt:
[{"id":123,"note":0-100,"fit":"beratung|partner|beide|keiner","grund":"max. 12 Wörter"}]`;
  // Die KI liefert meist sauberes JSON, aber nicht immer (2026-09-24: drei Fehlschläge in Folge →
  // Job tot, Rohtext nirgends gesichert). Darum: tolerant lesen, EIN Neuversuch mit klarer Ansage,
  // und scheitert auch der, steht ein Auszug der Antwort im Fehler – dann ist die Ursache sichtbar.
  let roh = await generateText(prompt, 3000);
  let ergebnis = leseBewertungen(roh);
  if (!ergebnis) {
    console.warn(`[leadbewertung] unlesbare Antwort, neuer Versuch. Auszug: ${auszug(roh)}`);
    roh = await generateText(`${prompt}\n\nWICHTIG: Deine Antwort beginnt mit [ und endet mit ]. Kein Text davor oder danach, keine Rückfrage.`, 3000);
    ergebnis = leseBewertungen(roh);
  }
  if (!ergebnis) throw new Error(`Lead-Bewertung: kein verwertbares Ergebnis (Antwort: ${auszug(roh)})`);
  const erlaubt = new Set(liste.map((k) => k.id));
  const speichern = db.prepare(
    `UPDATE contacts SET ki_score=?, ki_fit=?, ki_grund=?, ki_bewertet_at=datetime('now') WHERE id=? AND ki_bewertet_at IS NULL`,
  );
  const aussortieren = db.prepare(
    `UPDATE contacts SET status='skipped', score_grund=? WHERE id=? AND status='new'`,
  );
  let n = 0;
  const tx = db.transaction(() => {
    for (const r of ergebnis) {
      const id = Number(r.id);
      if (!erlaubt.has(id)) continue; // nur, wonach gefragt wurde
      const note = Math.max(0, Math.min(100, Math.round(Number(r.note))));
      if (!Number.isFinite(note)) continue;
      const fit: Fit = (["beratung", "partner", "beide", "keiner"] as const).includes(r.fit as Fit) ? r.fit as Fit : "beide";
      const grund = String(r.grund ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
      speichern.run(note, fit, grund, id);
      if (fit === "keiner" && note < AUSSORTIEREN_UNTER) aussortieren.run(`KI: ${grund || "passt nicht zur Zielgruppe"}`, id);
      n++;
    }
  });
  tx();
  return n;
}

function auszug(roh: string): string {
  const t = roh.replace(/\s+/g, " ").trim();
  return t ? `„${t.slice(0, 160)}${t.length > 160 ? "…" : ""}“` : "leer";
}

/**
 * Liest das Bewertungs-Array aus der KI-Antwort. Verträgt Code-Zäune, Text davor/danach und eine
 * abgeschnittene Antwort (dann zählen die vollständigen Objekte; der Rest bleibt unbewertet und
 * kommt im nächsten Lauf wieder). `null` = nichts Brauchbares.
 */
export function leseBewertungen(roh: string): Array<Record<string, unknown>> | null {
  const s = roh.indexOf("[");
  if (s < 0) return null;
  const e = roh.lastIndexOf("]");
  if (e > s) {
    try {
      const a = JSON.parse(roh.slice(s, e + 1));
      if (Array.isArray(a)) return a.filter((x) => x && typeof x === "object");
    } catch { /* unten Objekt für Objekt versuchen */ }
  }
  const einzeln: Array<Record<string, unknown>> = [];
  for (const m of roh.slice(s).matchAll(/\{[^{}]*\}/g)) {
    try { einzeln.push(JSON.parse(m[0])); } catch { /* kaputtes Objekt überspringen */ }
  }
  return einzeln.length ? einzeln : null;
}

/** Bewertet bis zu `limit` neue Kontakte. Gibt die Zahl der Bewertungen zurück. */
export async function kiLeadBewertung(limit = 60): Promise<number> {
  const alle = kandidaten(limit);
  let n = 0;
  for (let i = 0; i < alle.length; i += GRUPPE) {
    n += await bewerteGruppe(alle.slice(i, i + GRUPPE));
  }
  if (n) console.info(`[leadbewertung] ${n} Kontakt(e) von der KI bewertet`);
  return n;
}

export function leadBewertungStand() {
  return db.prepare(
    `SELECT SUM(CASE WHEN ki_bewertet_at IS NOT NULL THEN 1 ELSE 0 END) bewertet,
            SUM(CASE WHEN status='new' AND ki_bewertet_at IS NULL THEN 1 ELSE 0 END) offen,
            SUM(CASE WHEN status='skipped' AND score_grund LIKE 'KI:%' THEN 1 ELSE 0 END) aussortiert
       FROM contacts`,
  ).get() as { bewertet: number; offen: number; aussortiert: number };
}
