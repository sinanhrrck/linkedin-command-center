import { db } from "../db/index.js";

/**
 * SELBSTLERNENDE VARIANTEN (2026-09-23, Phase 4).
 *
 * Vorher lernte der Bot nur aus Sinans Ablehnungen – und damit immer nur in eine Richtung
 * („weniger verkäuferisch“). Ob eine Nachricht eine ANTWORT bringt, floss nie zurück.
 * Jetzt bekommt jede Nachricht einer Art eine Variante (Arm), und die Auswahl folgt dem, was
 * nachweislich positive Antworten bringt (Thompson Sampling).
 *
 * Messregeln wie bei crm_stage_events (CLAUDE.md, Phase 5.1):
 *  1. Ein Versand zählt einmal: fachlicher Schlüssel `variant:contact:<id>:<kind>:<stufe>`.
 *  2. Zuordnung (Slot, Arm, Ziel) wird beim Schreiben eingefroren; Antwort/Termin werden genau
 *     einmal nachgetragen und nie überschrieben.
 *  3. Ein Misserfolg ist nur ein REIFER Versand (≥ REIFE_TAGE ohne Antwort). Frische Versände
 *     sind keine Niederlage – sonst verliert jede neue Variante, bevor jemand antworten konnte.
 * Kein Nachrichtentext wird gespeichert.
 */

export const REIFE_TAGE = 10;
export const MIN_REIF_JE_ARM = 15;
export const ZUFALL_ANTEIL = 0.15;
const VETO = { minEntscheidungen: 6, maxAblehnung: 0.5 };
const POSITIV = ["interested", "question", "meeting"];

export type Arm = { key: string; titel: string; anweisung: string };
export type Wahl = { slot: string; arm: string; anweisung: string };

/**
 * Arme je Slot. Bewusst wenige (2–3): bei ~16 Nachrichten am Tag braucht jeder Arm Wochen,
 * bis er belastbar ist. Die Anweisung hat Vorrang vor dem allgemeinen Aufbau im Prompt.
 */
export const ARME: Record<string, Arm[]> = {
  first: [
    { key: "erfahrung", titel: "Eigene Erfahrung + Gedanke", anweisung: "Nutze den Standard-Aufbau: eigene Erfahrung als kurze Tatsache (ohne Lehre oder Rat daraus), dann die leichte Frage." },
    { key: "kurz_direkt", titel: "Kurz und direkt", anweisung: "Höchstens zwei Sätze. Kein Rückblick auf dich selbst, sondern nach der Anrede direkt eine konkrete, leicht zu beantwortende Frage zu ihrem Weg nach der Ausbildung bzw. im Job." },
    { key: "beobachtung", titel: "Beobachtung zum Arbeitgeber", anweisung: "Starte mit einer konkreten Beobachtung zu ihrem Arbeitgeber oder Beruf (nur was die Headline hergibt, nichts erfinden), dann die Frage dazu. Deine eigene Geschichte höchstens als halber Satz." },
  ],
  "followup:wert": [
    { key: "angebot_direkt", titel: "Angebot beim Namen", anweisung: "Nenne das Angebot beim Namen und ende mit seiner leichten Frage." },
    { key: "erlaubnis", titel: "Erst um Erlaubnis fragen", anweisung: "Nenne das Angebot NICHT beim Namen. Frag stattdessen um Erlaubnis, ob du kurz zeigen darfst, wie andere in ihrer Lage genau diese Frage für sich geklärt haben." },
  ],
  "followup:abschied": [
    { key: "tuer_offen", titel: "Tür offen lassen", anweisung: "Sag ehrlich, dass du dich nicht mehr meldest, und dass sie sich jederzeit melden kann." },
    { key: "stichwort", titel: "Stichwort anbieten", anweisung: "Sag ehrlich, dass du dich nicht mehr meldest, und nenne ein einziges Stichwort, das sie einfach zurückschreiben kann, wenn es später passt (zum Beispiel: schreib einfach \"Check\")." },
  ],
  reaktivierung: [
    { key: "anlass", titel: "Echter Anlass zuerst", anweisung: "Nenne zuerst kurz den echten Anlass (du sprichst gerade viel mit Leuten in ihrer Lage), dann die Frage." },
    { key: "frage_zuerst", titel: "Frage zuerst", anweisung: "Kein langer Anlass: direkt eine konkrete Frage zu ihrem aktuellen Weg, dazu höchstens ein kurzer Satz, warum du fragst." },
  ],
};

/**
 * Feste Arme + von der KI erfundene Herausforderer (modules/kiStile.ts, Tabelle variant_arme_ki).
 * Beendete KI-Arme fallen raus – ihre Versände bleiben in message_variants erhalten.
 */
export function armeFuer(slot: string): (Arm & { ki?: boolean })[] {
  const fest = ARME[slot] || [];
  if (!fest.length) return [];
  let ki: (Arm & { ki: boolean })[] = [];
  try {
    ki = (db.prepare("SELECT key, titel, anweisung FROM variant_arme_ki WHERE slot=? AND status='aktiv' ORDER BY id").all(slot) as Arm[])
      .map((a) => ({ ...a, ki: true }));
  } catch { /* Tabelle fehlt in sehr alten DBs – dann nur feste Arme */ }
  return [...fest, ...ki];
}

type ArmStand = { arm: string; gesendet: number; reif: number; positiv: number; antworten: number; entscheidungen: number; abgelehnt: number };

function armStaende(slot: string): ArmStand[] {
  const arme = armeFuer(slot);
  const versand = db.prepare(
    `SELECT arm,
            COUNT(*) gesendet,
            SUM(CASE WHEN replied_at IS NOT NULL OR sent_at <= datetime('now', ?) THEN 1 ELSE 0 END) reif,
            SUM(CASE WHEN reply_quality IN (${POSITIV.map(() => "?").join(",")}) OR meeting_at IS NOT NULL THEN 1 ELSE 0 END) positiv,
            SUM(CASE WHEN replied_at IS NOT NULL THEN 1 ELSE 0 END) antworten
       FROM message_variants WHERE slot=? GROUP BY arm`,
  ).all(`-${REIFE_TAGE} days`, ...POSITIV, slot) as { arm: string; gesendet: number; reif: number; positiv: number; antworten: number }[];
  // Sinans Urteil: menschliche Entscheidungen über Entwürfe dieses Arms.
  const urteil = db.prepare(
    `SELECT json_extract(variant_json,'$.arm') arm,
            SUM(CASE WHEN status IN ('approved','sent','discarded') THEN 1 ELSE 0 END) entscheidungen,
            SUM(CASE WHEN status='discarded' THEN 1 ELSE 0 END) abgelehnt
       FROM drafts
      WHERE json_extract(variant_json,'$.slot')=? AND COALESCE(freigabe_quelle,'mensch')='mensch'
      GROUP BY 1`,
  ).all(slot) as { arm: string; entscheidungen: number; abgelehnt: number }[];
  return arme.map((a) => {
    const v = versand.find((x) => x.arm === a.key);
    const u = urteil.find((x) => x.arm === a.key);
    return {
      arm: a.key, gesendet: v?.gesendet || 0, reif: v?.reif || 0, positiv: v?.positiv || 0, antworten: v?.antworten || 0,
      entscheidungen: u?.entscheidungen || 0, abgelehnt: u?.abgelehnt || 0,
    };
  });
}

const vetoed = (s: ArmStand) => s.entscheidungen >= VETO.minEntscheidungen && s.abgelehnt / s.entscheidungen >= VETO.maxAblehnung;

/** Gamma(k,1) für ganzzahliges k ≥ 1 (Summe von Exponentialverteilungen) – reicht für Zählwerte. */
function gamma(k: number, rng: () => number): number {
  let s = 0;
  for (let i = 0; i < k; i++) s -= Math.log(1 - rng());
  return s;
}
export const beta = (a: number, b: number, rng: () => number) => { const x = gamma(a, rng); return x / (x + gamma(b, rng)); };

/** Wählt den Arm für einen Slot. `null`, wenn der Slot keine Varianten kennt. */
export function waehleArm(slot: string, rng: () => number = Math.random): Wahl | null {
  const arme = armeFuer(slot);
  if (!arme?.length) return null;
  let kandidaten = armStaende(slot).filter((s) => !vetoed(s));
  if (!kandidaten.length) kandidaten = armStaende(slot); // alle abgelehnt → nicht blockieren, weiter testen
  const zuWenig = kandidaten.filter((s) => s.reif < MIN_REIF_JE_ARM);
  let gewaehlt: ArmStand;
  if (zuWenig.length) {
    // Erkundung: der Arm mit den wenigsten Versänden zuerst, damit alle zügig Daten sammeln.
    const min = Math.min(...zuWenig.map((s) => s.gesendet));
    const pool = zuWenig.filter((s) => s.gesendet === min);
    gewaehlt = pool[Math.floor(rng() * pool.length)];
  } else if (rng() < ZUFALL_ANTEIL) {
    gewaehlt = kandidaten[Math.floor(rng() * kandidaten.length)];
  } else {
    let best = -1;
    gewaehlt = kandidaten[0];
    for (const s of kandidaten) {
      const misserfolg = Math.max(0, s.reif - s.positiv);
      const wert = beta(1 + s.positiv, 1 + misserfolg, rng);
      if (wert > best) { best = wert; gewaehlt = s; }
    }
  }
  const arm = arme.find((a) => a.key === gewaehlt.arm)!;
  return { slot, arm: arm.key, anweisung: arm.anweisung };
}

/** Prompt-Baustein für eine Wahl. */
export function variantenBlock(w: Wahl | null): string {
  return w ? `\nVARIANTE FÜR DIESE NACHRICHT (hat Vorrang vor dem Aufbau oben): ${w.anweisung}\n` : "";
}

export function registriereVersand(input: {
  contactId: number; draftId?: number | null; kind: string; stufe?: number | null; slot: string; arm: string; goalCode?: string | null; zielgruppe?: string | null;
}): boolean {
  // Auch ein inzwischen beendeter KI-Arm zählt noch: der Entwurf entstand, als er aktiv war.
  const bekannt = armeFuer(input.slot).some((a) => a.key === input.arm)
    || !!db.prepare("SELECT 1 FROM variant_arme_ki WHERE slot=? AND key=?").get(input.slot, input.arm);
  if (!bekannt) return false;
  const stufe = input.stufe ?? 0;
  return db.prepare(
    `INSERT OR IGNORE INTO message_variants(dedupe_key,contact_id,draft_id,kind,stage,slot,arm,goal_code,zielgruppe,sent_at)
     VALUES(?,?,?,?,?,?,?,?,?,datetime('now'))`,
  ).run(`variant:contact:${input.contactId}:${input.kind}:${stufe}`, input.contactId, input.draftId ?? null, input.kind, stufe,
    input.slot, input.arm, input.goalCode ?? null, input.zielgruppe ?? null).changes > 0;
}

/**
 * Antwort/Termin der LETZTEN Variante VOR dem Ereignis zuordnen – genau einmal. Eine Antwort,
 * die vor einem Versand kam, gehört nicht zu ihm.
 */
export function attribuiereErgebnis(contactId: number, stage: "replied" | "meeting", occurredAt?: string | null, quality?: string | null): void {
  const wann = occurredAt || new Date().toISOString().slice(0, 19).replace("T", " ");
  const spalte = stage === "meeting" ? "meeting_at" : "replied_at";
  const row = db.prepare(
    `SELECT id FROM message_variants WHERE contact_id=? AND sent_at < ? ORDER BY sent_at DESC, id DESC LIMIT 1`,
  ).get(contactId, wann) as { id: number } | undefined;
  if (!row) return;
  if (stage === "meeting") {
    db.prepare(`UPDATE message_variants SET ${spalte}=? WHERE id=? AND ${spalte} IS NULL`).run(wann, row.id);
  } else {
    db.prepare("UPDATE message_variants SET replied_at=?, reply_quality=? WHERE id=? AND replied_at IS NULL").run(wann, quality ?? null, row.id);
  }
}

/** Präzisierte Einordnung derselben Antwort (neutral → interessiert) nachziehen. */
export function aktualisiereAntwortQualitaet(contactId: number, quality: string): void {
  db.prepare(
    `UPDATE message_variants SET reply_quality=?
      WHERE id=(SELECT id FROM message_variants WHERE contact_id=? AND replied_at IS NOT NULL ORDER BY replied_at DESC LIMIT 1)`,
  ).run(quality, contactId);
}

/** Für die Auswertung „Was wirkt“. */
export function variantenStatistik() {
  return Object.keys(ARME).map((slot) => {
    const arme = armeFuer(slot);
    const staende = armStaende(slot);
    return {
      slot,
      arme: arme.map((a) => {
        const s = staende.find((x) => x.arm === a.key)!;
        const quote = s.reif ? s.positiv / s.reif : null;
        return {
          key: a.key, titel: a.titel, ki: !!a.ki, gesendet: s.gesendet, reif: s.reif, antworten: s.antworten, positiv: s.positiv, quote,
          status: vetoed(s) ? "pausiert (von dir oft abgelehnt)" : s.reif < MIN_REIF_JE_ARM ? "sammelt Daten" : "im Test",
        };
      }),
    };
  });
}

/**
 * Wahrscheinlichkeit je Arm, der beste zu sein (Monte-Carlo über die Beta-Verteilungen der
 * REIFEN Versände). Grundlage für „klarer Gewinner“ und „klarer Verlierer“ in kiStile.ts.
 */
export function gewinnChancen(slot: string, runden = 2000, rng: () => number = Math.random): { arm: string; reif: number; positiv: number; chance: number }[] {
  const s = armStaende(slot);
  const siege = new Map(s.map((x) => [x.arm, 0]));
  for (let r = 0; r < runden; r++) {
    let best = -1, bestArm = "";
    for (const x of s) {
      const v = beta(1 + x.positiv, 1 + Math.max(0, x.reif - x.positiv), rng);
      if (v > best) { best = v; bestArm = x.arm; }
    }
    siege.set(bestArm, (siege.get(bestArm) || 0) + 1);
  }
  return s.map((x) => ({ arm: x.arm, reif: x.reif, positiv: x.positiv, chance: (siege.get(x.arm) || 0) / runden }));
}
