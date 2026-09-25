import { db } from "../db/index.js";
import { generateText } from "../core/textLlm.js";
import { pruefeZielgruppe, woerter, zgBedingung, type ZielgruppenRegel } from "../core/zielgruppenRegel.js";

/**
 * ZIELGRUPPEN (2026-09-25). Regel und SQL-Baustein stehen in core/zielgruppenRegel.ts; hier liegen
 * Zuordnung, Einzelprüfung, Cockpit-Übersicht, Vorschau und die Erstnachricht je Zielgruppe.
 *
 * Zuordnung: Ein Kontakt bekommt die Zielgruppe seiner Quelle (beim ersten Fund, danach eingefroren
 * wie `source_id`). Ohne Quelle – Altbestand, Netzwerk-Scan – die erste Zielgruppe, zu der sein
 * Profil passt. Wer nirgends passt, bleibt ohne und wird NIE automatisch angeschrieben.
 */

export type Zielgruppe = ZielgruppenRegel & {
  id: number;
  name: string;
  aktiv: number;
  erstnachricht: string | null;
  updated_at: string;
};

/**
 * Standard-Aufbau der Erstnachricht (Sinan 2026-09-25: „ohne Gedanken“). Der frühere Baustein
 * „eigener Bezug MIT nützlichem Gedanken“ erzeugte Sätze über Weichen und die richtige Richtung
 * nach der Ausbildung – das las sich wie die Vorbereitung eines Pitches. Die festen Stilregeln
 * (kein Pitch, Du-Form, keine Emojis …) stehen weiter im Code von personalize.firstMessage und
 * gelten immer, egal was hier steht.
 */
export const STANDARD_ERSTNACHRICHT = `AUFBAU (3 kurze Bausteine, genau in dieser Reihenfolge):
1. Persönliche Anknüpfung (1 Zeile). Etwas Konkretes aus dem Profil: Bank, Standort, Ausbildungsjahr, ein Post. Etwas, das nur auf diese Person zutrifft.
2. Eigener Bezug (1 kurzer Satz). Dass du selbst mal in der Bank angefangen hast. NUR diese Tatsache: keine Lehre daraus, kein Rat, keine Aussage über Weichen, Richtung, Chancen oder was man unterschätzt.
3. Leichte Frage (1 Zeile). Genau EINE ehrliche Frage zu ihrer aktuellen Situation, die man in fünf Sekunden beantworten kann. Die Nachricht endet mit dieser Frage.

GUTE BEISPIELE:
Beispiel 1: Hey Marvin, ich hab gesehen du bist im 2. Lehrjahr bei der Sparkasse Köln. Ich hab damals auch als Azubi in der Bank angefangen. Wie erlebst du den Alltag da gerade?
Beispiel 2: Hey Lisa, cool dass du deine Ausbildung bei der Volksbank machst. Ich war früher selbst bei der Bank. Was ist bisher das Überraschendste für dich in der Praxis?
Beispiel 3 (Ausbildung schon fertig): Hey Jonas, ich hab gesehen du bist bei der Sparkasse Köln als Bankkaufmann. Ich hab damals auch in der Bank angefangen. Wie ging's für dich nach der Ausbildung weiter?`;

export function alleZielgruppen(): Zielgruppe[] {
  return db.prepare("SELECT * FROM zielgruppen ORDER BY id").all() as Zielgruppe[];
}

export function zielgruppe(id: number | null | undefined): Zielgruppe | null {
  if (!id) return null;
  return (db.prepare("SELECT * FROM zielgruppen WHERE id=?").get(id) as Zielgruppe | undefined) ?? null;
}

type PersonRow = { id: number; headline: string | null; rolle: string | null; seit: string | null; zielgruppe_id: number | null; source_id: number | null };

/**
 * Trägt fehlende Zuordnungen nach: erst aus der Quelle, sonst über die Regel. Idempotent, belegte
 * Zuordnungen werden nie geändert. Läuft vor jeder Auswahl-Runde und beim Cockpit-Abruf.
 */
export function ordneZielgruppenZu(): number {
  const ausQuelle = db.prepare(
    `UPDATE contacts SET zielgruppe_id=(SELECT s.zielgruppe_id FROM lead_sources s WHERE s.id=contacts.source_id)
      WHERE zielgruppe_id IS NULL AND source_id IS NOT NULL
        AND (SELECT s.zielgruppe_id FROM lead_sources s WHERE s.id=contacts.source_id) IS NOT NULL`,
  ).run().changes;
  const gruppen = alleZielgruppen();
  if (!gruppen.length) return ausQuelle;
  const offen = db.prepare(
    `SELECT c.id, c.headline, f.rolle, f.seit, c.zielgruppe_id, c.source_id
       FROM contacts c LEFT JOIN contact_profile_facts f ON f.contact_id=c.id
      WHERE c.zielgruppe_id IS NULL`,
  ).all() as PersonRow[];
  const setze = db.prepare("UPDATE contacts SET zielgruppe_id=? WHERE id=? AND zielgruppe_id IS NULL");
  let n = ausQuelle;
  db.transaction(() => {
    for (const p of offen) {
      const g = gruppen.find((z) => pruefeZielgruppe(p, z).ok);
      if (g) n += setze.run(g.id, p.id).changes;
    }
  })();
  return n;
}

/**
 * Einzelprüfung vor einem automatischen Versand oder Entwurf. Dieselbe Regel wie `zgBedingung`,
 * nur mit Klartext-Grund fürs Log („warum wurde X nicht angeschrieben?“).
 */
export function zielgruppenPruefung(contactId: number): { ok: boolean; grund: string; gruppe: Zielgruppe | null } {
  const p = db.prepare(
    `SELECT c.id, c.headline, f.rolle, f.seit, c.zielgruppe_id, c.source_id
       FROM contacts c LEFT JOIN contact_profile_facts f ON f.contact_id=c.id WHERE c.id=?`,
  ).get(contactId) as PersonRow | undefined;
  if (!p) return { ok: false, grund: "Kontakt unbekannt", gruppe: null };
  const g = zielgruppe(p.zielgruppe_id);
  if (!g) return { ok: false, grund: "gehört zu keiner Zielgruppe", gruppe: null };
  if (!g.aktiv) return { ok: false, grund: `Zielgruppe „${g.name}“ ist pausiert`, gruppe: g };
  const r = pruefeZielgruppe(p, g);
  return r.ok ? { ok: true, grund: "", gruppe: g } : { ok: false, grund: `passt nicht mehr zu „${g.name}“: ${r.grund}`, gruppe: g };
}

/** Eigener Erstnachricht-Aufbau der Zielgruppe des Kontakts, sonst null (= Standard). */
export function erstnachrichtFuer(contactId: number): { gruppe: string; text: string } | null {
  const row = db.prepare(
    "SELECT z.name, z.erstnachricht FROM contacts c JOIN zielgruppen z ON z.id=c.zielgruppe_id WHERE c.id=?",
  ).get(contactId) as { name: string; erstnachricht: string | null } | undefined;
  return row?.erstnachricht?.trim() ? { gruppe: row.name, text: row.erstnachricht.trim() } : null;
}

export function zielgruppenName(contactId: number): string | null {
  return (db.prepare("SELECT z.name FROM contacts c JOIN zielgruppen z ON z.id=c.zielgruppe_id WHERE c.id=?").get(contactId) as { name: string } | undefined)?.name ?? null;
}

/** Cockpit: jede Zielgruppe mit Quellen und den Zahlen, die zeigen, was an ihr hängt. */
export function zielgruppenUebersicht() {
  ordneZielgruppenZu();
  const zahl = db.prepare(
    `SELECT
       SUM(CASE WHEN ${zgBedingung("c")} THEN 1 ELSE 0 END) AS passend,
       SUM(CASE WHEN c.status='new' AND ${zgBedingung("c")} THEN 1 ELSE 0 END) AS neu,
       SUM(CASE WHEN c.status='accepted' AND c.messaged_at IS NULL AND ${zgBedingung("c")} THEN 1 ELSE 0 END) AS erstnachricht,
       SUM(CASE WHEN c.messaged_at IS NOT NULL THEN 1 ELSE 0 END) AS angeschrieben,
       COUNT(*) AS gesamt
     FROM contacts c WHERE c.zielgruppe_id=?`,
  );
  const quellen = db.prepare("SELECT id, label, active FROM lead_sources WHERE zielgruppe_id=? ORDER BY id");
  return alleZielgruppen().map((g) => {
    const z = zahl.get(g.id) as Record<string, number | null>;
    return {
      ...g,
      zahlen: {
        gesamt: z.gesamt ?? 0, passend: z.passend ?? 0, neu: z.neu ?? 0,
        erstnachricht: z.erstnachricht ?? 0, angeschrieben: z.angeschrieben ?? 0,
      },
      quellen: quellen.all(g.id) as { id: number; label: string | null; active: number }[],
    };
  });
}

/** Kontakte ohne Zielgruppe (angenommen, noch nie angeschrieben) – damit sie nicht unsichtbar werden. */
export function ohneZielgruppe(): { gesamt: number; wartend: number } {
  return db.prepare(
    `SELECT COUNT(*) gesamt, SUM(CASE WHEN status='accepted' AND messaged_at IS NULL THEN 1 ELSE 0 END) wartend
       FROM contacts WHERE zielgruppe_id IS NULL AND COALESCE(do_not_contact,0)=0`,
  ).get() as { gesamt: number; wartend: number };
}

export type ZielgruppeEingabe = { id?: number; name?: unknown; aktiv?: unknown; erkennung?: unknown; ausschluss?: unknown; max_berufsjahre?: unknown; erstnachricht?: unknown };

function saubereListe(v: unknown): string {
  return woerter(String(v ?? "")).map((w) => w.slice(0, 40)).slice(0, 40).join(", ");
}

export function speichereZielgruppe(e: ZielgruppeEingabe): Zielgruppe {
  const name = String(e.name ?? "").trim().slice(0, 80);
  if (!name) throw new Error("Bitte einen Namen für die Zielgruppe eintragen.");
  const erkennung = saubereListe(e.erkennung);
  const ausschluss = saubereListe(e.ausschluss);
  const maxRoh = e.max_berufsjahre === "" || e.max_berufsjahre == null ? null : Number(e.max_berufsjahre);
  if (maxRoh != null && (!Number.isInteger(maxRoh) || maxRoh < 1 || maxRoh > 50)) throw new Error("Berufsjahre: eine ganze Zahl zwischen 1 und 50 oder leer lassen.");
  const erst = String(e.erstnachricht ?? "").trim();
  if (erst.length > 4000) throw new Error("Die Erstnachricht-Anleitung ist zu lang (höchstens 4000 Zeichen).");
  // Der Standardtext wird nicht als eigener gespeichert: sonst zöge eine spätere Verbesserung
  // des Standards an dieser Gruppe unbemerkt vorbei.
  const erstnachricht = erst && erst !== STANDARD_ERSTNACHRICHT.trim() ? erst : null;
  const aktiv = e.aktiv === undefined ? 1 : e.aktiv ? 1 : 0;
  if (e.id) {
    const r = db.prepare(
      `UPDATE zielgruppen SET name=?, aktiv=?, erkennung=?, ausschluss=?, max_berufsjahre=?, erstnachricht=?, updated_at=datetime('now') WHERE id=?`,
    ).run(name, aktiv, erkennung || null, ausschluss || null, maxRoh, erstnachricht, Number(e.id));
    if (!r.changes) throw new Error("Diese Zielgruppe gibt es nicht mehr.");
    return zielgruppe(Number(e.id))!;
  }
  const id = Number(db.prepare(
    "INSERT INTO zielgruppen(name, aktiv, erkennung, ausschluss, max_berufsjahre, erstnachricht) VALUES(?,?,?,?,?,?)",
  ).run(name, aktiv, erkennung || null, ausschluss || null, maxRoh, erstnachricht).lastInsertRowid);
  ordneZielgruppenZu();
  return zielgruppe(id)!;
}

export function setzeZielgruppeAktiv(id: number, aktiv: boolean): void {
  db.prepare("UPDATE zielgruppen SET aktiv=?, updated_at=datetime('now') WHERE id=?").run(aktiv ? 1 : 0, id);
}

/**
 * Löschen: Quellen verlieren die Zuordnung (werden dann nicht mehr durchsucht), Kontakte behalten
 * ihre Zeile unverändert – ohne Zielgruppe schreibt der Bot sie einfach nicht mehr an. Keine
 * Historie wird angefasst.
 */
export function loescheZielgruppe(id: number): void {
  db.transaction(() => {
    db.prepare("UPDATE lead_sources SET zielgruppe_id=NULL WHERE zielgruppe_id=?").run(id);
    db.prepare("UPDATE contacts SET zielgruppe_id=NULL WHERE zielgruppe_id=?").run(id);
    db.prepare("DELETE FROM zielgruppen WHERE id=?").run(id);
  })();
  ordneZielgruppenZu();
}

export function setzeQuellenZielgruppe(quelleId: number, zielgruppeId: number | null): void {
  if (zielgruppeId != null && !zielgruppe(zielgruppeId)) throw new Error("Diese Zielgruppe gibt es nicht.");
  db.prepare("UPDATE lead_sources SET zielgruppe_id=? WHERE id=?").run(zielgruppeId, quelleId);
}

/**
 * VORSCHAU vor dem Speichern: Wie viele Kontakte dieser Zielgruppe (bzw. aller noch nicht
 * zugeordneten, bei einer neuen) würden mit den eingegebenen Wörtern passen – und welche fielen
 * heraus. Zeigt nur Headlines, damit man die Wirkung einer Änderung sieht, bevor sie greift.
 */
export function vorschau(e: ZielgruppeEingabe) {
  const regel: ZielgruppenRegel = {
    erkennung: saubereListe(e.erkennung) || null,
    ausschluss: saubereListe(e.ausschluss) || null,
    max_berufsjahre: e.max_berufsjahre === "" || e.max_berufsjahre == null ? null : Number(e.max_berufsjahre),
  };
  const personen = db.prepare(
    `SELECT c.id, c.headline, f.rolle, f.seit, c.status, c.messaged_at
       FROM contacts c LEFT JOIN contact_profile_facts f ON f.contact_id=c.id
      WHERE ${e.id ? "c.zielgruppe_id=?" : "c.zielgruppe_id IS NULL"} AND COALESCE(c.do_not_contact,0)=0`,
  ).all(...(e.id ? [Number(e.id)] : [])) as (PersonRow & { status: string; messaged_at: string | null })[];
  const drin: string[] = [], raus: { headline: string; grund: string }[] = [];
  let wartend = 0;
  for (const p of personen) {
    const r = pruefeZielgruppe(p, regel);
    if (r.ok) {
      drin.push(p.headline || "–");
      if (p.status === "accepted" && !p.messaged_at) wartend++;
    } else raus.push({ headline: p.headline || "–", grund: r.grund });
  }
  return { geprueft: personen.length, passend: drin.length, wartendAufErstnachricht: wartend, beispieleDrin: drin.slice(0, 6), beispieleRaus: raus.slice(0, 8) };
}

/** KI verbessert die Erstnachricht-Anleitung. Speichert NICHTS – Übernehmen füllt nur das Feld. */
export async function kiErstnachrichtVerbessern(text: string, wunsch: string, gruppenName: string): Promise<{ text: string; warum: string }> {
  const basis = String(text || "").trim() || STANDARD_ERSTNACHRICHT;
  const prompt = `Du hilfst Sinan, die Anleitung für seine LinkedIn-ERSTNACHRICHTEN zu verbessern. Die Anleitung geht später an eine KI, die daraus je Person eine kurze Erstnachricht schreibt.
Zielgruppe: ${gruppenName || "unbekannt"}
Sinan war selbst Azubi in einer Bank. Ziel der Erstnachricht ist NIE Verkauf, sondern ein lockeres, echtes Gespräch zu öffnen, auf das man gern antwortet.

DIESE REGELN GELTEN IMMER (stehen fest im System, nicht in die Anleitung schreiben, aber nichts dagegen verlangen):
Du-Form, keine Emojis, keine Gedankenstriche, gesprochene Sprache, kurze Sätze, höchstens 4-5 Zeilen, genau eine Frage, keine Aufzählung, keine Floskeln, kein Pitch, keine Firma, kein Produkt, keine Zahlen zum Verdienst.

BISHERIGE ANLEITUNG:
"""
${basis}
"""
${wunsch?.trim() ? `\nSINANS WUNSCH: ${wunsch.trim().slice(0, 500)}\n` : ""}
Verbessere die Anleitung so, dass mehr Menschen antworten: konkreter Profilbezug, noch leichter zu beantwortende Frage, natürlicher Ton. Behalte Aufbau-Schritte und 2-3 GUTE BEISPIELE (mit erfundenen Beispielnamen). Keine Ratschläge oder Lebensweisheiten in der Nachricht, kein Hinarbeiten auf ein Angebot.

Antworte AUSSCHLIESSLICH mit einem JSON-Objekt:
{"text":"die vollständige neue Anleitung","warum":"ein bis zwei Sätze, was du geändert hast und warum"}`;
  const roh = await generateText(prompt, 2000);
  const s = roh.indexOf("{"), e = roh.lastIndexOf("}");
  if (s < 0 || e <= s) throw new Error("Die KI hat kein verwertbares Ergebnis geliefert. Bitte nochmal versuchen.");
  const x = JSON.parse(roh.slice(s, e + 1)) as { text?: unknown; warum?: unknown };
  const neu = String(x.text ?? "").trim().slice(0, 4000);
  if (!neu) throw new Error("Die KI hat keine Anleitung geliefert. Bitte nochmal versuchen.");
  return { text: neu, warum: String(x.warum ?? "").trim().slice(0, 400) };
}

/**
 * PROBE: schreibt mit der (noch ungespeicherten) Anleitung Erstnachrichten für bis zu drei echte
 * Kontakte dieser Zielgruppe – nichts wird gesendet oder gespeichert. Bevorzugt Kontakte, die
 * gerade auf ihre Erstnachricht warten, weil genau die als Nächstes dran sind.
 */
export async function probeErstnachrichten(gruppeId: number, text: string, anzahl = 3) {
  const { firstMessage } = await import("./personalize.js");
  const kontakte = db.prepare(
    `SELECT c.* FROM contacts c
      WHERE c.zielgruppe_id=? AND ${zgBedingung("c")} AND COALESCE(c.aus_netzwerk,0)=0
      ORDER BY CASE WHEN c.status='accepted' AND c.messaged_at IS NULL THEN 0 WHEN c.status='new' THEN 1 ELSE 2 END,
               COALESCE(c.ki_score, c.lead_score, 50) DESC
      LIMIT ?`,
  ).all(gruppeId, Math.max(1, Math.min(anzahl, 3))) as import("./crm.js").Contact[];
  if (!kontakte.length) throw new Error("In dieser Zielgruppe gibt es noch keinen passenden Kontakt für eine Probe.");
  const anleitung = String(text || "").trim() || STANDARD_ERSTNACHRICHT;
  const beispiele = [];
  for (const c of kontakte) {
    const nachricht = await firstMessage(c, undefined, null, undefined, undefined, null, anleitung).catch((e: Error) => `(Konnte nicht geschrieben werden: ${e.message.slice(0, 80)})`);
    beispiele.push({ name: c.full_name ?? "–", headline: c.headline ?? "", text: nachricht });
  }
  return beispiele;
}
