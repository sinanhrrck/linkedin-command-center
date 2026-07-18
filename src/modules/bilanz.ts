import { db, autonomyFor, type IntentKat } from "../db/index.js";

/**
 * Bilanz-BERECHNUNG als wiederverwendbare Funktion – Grundlage fuer den CLI-Report
 * (npm run bilanz), den woechentlichen Telegram-Push und die Reif-Empfehlung.
 *
 * Sinans Ansage: "sowas muss automatisch passieren, ich will dafuer nichts tippen." Deshalb
 * lebt die Logik hier zentral und wird vom Cron (index.ts) automatisch gefeuert.
 */
export type KatBilanz = {
  intent: string;
  autonom: boolean;
  entschieden: number;
  unveraendert: number;
  editiert: number;
  verworfen: number;
  quote: number; // % unveraendert von gesendeten
  reif: boolean; // genug Daten + hohe Quote + nichts verworfen -> Freischalten empfohlen
  korrekturen: string; // haeufigste Aenderungsmuster (Lernmaterial)
};

type D = { intent: string | null; draft: string; ki_original: string | null; status: string };

const norm = (s: string | null) => (s ?? "").replace(/\s+/g, " ").trim();
const woerter = (s: string) => norm(s).toLowerCase().split(/\s+/).filter(Boolean);

/** Heuristik: WAS hat Sinan geaendert? Kein KI-Call, nur Textvergleich. */
export function aenderung(ki: string, du: string): string {
  const a = woerter(ki), b = woerter(du);
  if (norm(ki) === norm(du)) return "unveraendert";
  const setA = new Set(a);
  const ueberlappung = b.length ? b.filter((w) => setA.has(w)).length / b.length : 0;
  if (ueberlappung < 0.3) return "komplett neu geschrieben";
  const kiFrage = /\?/.test(ki), duFrage = /\?/.test(du);
  const g: string[] = [];
  if (b.length < a.length * 0.7) g.push("kuerzer");
  if (b.length > a.length * 1.4) g.push("laenger");
  if (kiFrage && !duFrage) g.push("Frage raus");
  if (!kiFrage && duFrage) g.push("Frage ergaenzt");
  if (/telefon|anruf|nummer|call|kurz reden|austausch/i.test(du) && !/telefon|anruf|nummer|call|kurz reden|austausch/i.test(ki))
    g.push("direkter aufs Gespraech");
  return g.length ? g.join(", ") : "Ton umformuliert";
}

/** Rechnet die Bilanz pro Kategorie. min = ab wie vielen gesendeten eine Empfehlung faellt. */
export function computeBilanz(min = 5): KatBilanz[] {
  const alle = db
    .prepare("SELECT intent, draft, ki_original, status FROM drafts WHERE ki_original IS NOT NULL")
    .all() as D[];
  const kats = [...new Set(alle.map((d) => d.intent ?? "unklar"))];
  return kats.map((intent) => {
    const rows = alle.filter((d) => (d.intent ?? "unklar") === intent);
    const gesendet = rows.filter((d) => d.status === "sent");
    const asis = gesendet.filter((d) => norm(d.draft) === norm(d.ki_original));
    const editiert = gesendet.filter((d) => norm(d.draft) !== norm(d.ki_original));
    const verworfen = rows.filter((d) => d.status === "discarded");
    const quote = gesendet.length ? Math.round((asis.length / gesendet.length) * 100) : 0;
    const muster = editiert.map((d) => aenderung(d.ki_original!, d.draft));
    const zaehl = muster.reduce((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {} as Record<string, number>);
    const korrekturen = Object.entries(zaehl).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} (${n}x)`).join(" · ");
    return {
      intent,
      autonom: autonomyFor(intent) === "auto",
      entschieden: gesendet.length + verworfen.length,
      unveraendert: asis.length,
      editiert: editiert.length,
      verworfen: verworfen.length,
      quote,
      reif: autonomyFor(intent) === "ask" && gesendet.length >= min && quote >= 80 && verworfen.length === 0,
      korrekturen,
    };
  });
}

/** Nur die Kategorien, die JETZT reif zum Freischalten sind (fuer die proaktive Meldung). */
export function reifeKategorien(): IntentKat[] {
  const KATS: IntentKat[] = ["chance", "einwand", "positive", "neutral", "absage"];
  return computeBilanz().filter((b) => b.reif && KATS.includes(b.intent as IntentKat)).map((b) => b.intent as IntentKat);
}
