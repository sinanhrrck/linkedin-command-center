import { db } from "../db/index.js";

type Topic = { id: string; label: string; detail: string; pattern: RegExp };

// Kein KI-Raten für die Auswertung: klare Themen aus den echten eingegangenen Nachrichten und
// handschriftlichen Ergebnisnotizen. Die Taxonomie ist bewusst nah an Sinans Zielgruppe.
const TOPICS: Topic[] = [
  { id: "erstes-gehalt", label: "Erstes Gehalt & Geldalltag", detail: "Gehalt, Sparen und der Umgang mit dem ersten eigenen Geld", pattern: /erst(?:es|e[nr]?)\s+gehalt|gehalt|sparen|sparplan|konto|geld|finanz/i },
  { id: "ausbildung", label: "Ausbildung & Berufsstart", detail: "Unsicherheit und Entscheidungen rund um Ausbildung, Einstieg und Entwicklung", pattern: /ausbildung|azubi|lehre|berufsstart|abschluss|übernahme|uebernahme/i },
  { id: "karriere", label: "Karriere nach der Ausbildung", detail: "Was nach der Ausbildung möglich ist und wie man sich entwickelt", pattern: /karriere|weiterbildung|aufstieg|selbstständig|selbststaendig|jobwechsel|zukunft/i },
  { id: "nebenverdienst", label: "Nebenverdienst & Freiheit", detail: "Interesse an zusätzlichem Einkommen und mehr Gestaltungsspielraum", pattern: /nebenjob|nebenverdienst|zusätzlich|zusaetzlich|einkommen|verdienst|unabhängig|unabhaengig/i },
  { id: "gespraech", label: "Orientierung im Gespräch", detail: "Konkrete Fragen, ob und wie ein persönlicher Austausch helfen kann", pattern: /telefon|call|gespräch|gespraech|termin|austausch|reden/i },
];

export type DemandSignal = { id: string; label: string; detail: string; mentions: number };

/** Verdichtet die letzten 90 Tage Gesprächssignale, ohne Inhalte nach außen zu geben. */
export function getDemandSignals(limit = 4): DemandSignal[] {
  const rows = db.prepare(
    `SELECT incoming AS text FROM drafts
       WHERE incoming IS NOT NULL AND trim(incoming) != '' AND created_at >= datetime('now','-90 days')
     UNION ALL
     SELECT note AS text FROM sales_outcomes
       WHERE note IS NOT NULL AND trim(note) != '' AND updated_at >= datetime('now','-90 days')`,
  ).all() as { text: string }[];
  return TOPICS.map((topic) => ({
    id: topic.id,
    label: topic.label,
    detail: topic.detail,
    mentions: rows.reduce((sum, row) => sum + (topic.pattern.test(row.text) ? 1 : 0), 0),
  }))
    .filter((topic) => topic.mentions > 0)
    .sort((a, b) => b.mentions - a.mentions || a.label.localeCompare(b.label, "de"))
    .slice(0, limit);
}

/** Kompakter, datensparsamer Brief für einen Content-Entwurf aus echter Nachfrage. */
export function contentBrief() {
  const signals = getDemandSignals(3);
  if (!signals.length) {
    return {
      source: "Grundpositionierung",
      headline: "Ehrliche Orientierung für den Berufseinstieg",
      instruction: "Wähle eine konkrete Erfahrung aus Ausbildung, Berufsstart oder erstem Gehalt und mache sie praktisch.",
      signals,
    };
  }
  return {
    source: "Signale aus echten Gesprächen",
    headline: signals.map((s) => s.label).join(" · "),
    instruction: `Greife besonders „${signals[0].label}" auf. Erkläre einen konkreten, hilfreichen Gedanken aus Sinans Erfahrung statt allgemein zu motivieren.`,
    signals,
  };
}
