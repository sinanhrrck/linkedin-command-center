import { db, autonomyFor, setAutonomy, type IntentKat } from "../db/index.js";

/**
 * WOCHEN-BILANZ – das Messinstrument für Sinans Stufenmodell.
 *
 * Ziel: fertige Leads, keine Klickarbeit. Ob der Bot eine Kategorie allein fahren darf
 * (Stufe 2), soll DATEN entscheiden, nicht das Bauchgefühl. Der ehrlichste Maßstab ist Sinan
 * selbst: schickt er den KI-Vorschlag unverändert raus, war er gut. Schreibt er ihn um, zeigt
 * genau diese Änderung, was der KI fehlt – und WELCHE Art Änderung (Heuristik unten), ohne dass
 * ein KI-Call Geld kostet oder Sinan einen Grund eintippen muss.
 *
 * Aufruf:  npm run bilanz                 → Report pro Kategorie
 *          npm run bilanz -- frei chance  → Kategorie 'chance' auf autonom stellen
 *          npm run bilanz -- zu chance    → wieder auf Freigabe
 */
type D = { intent: string | null; draft: string; ki_original: string | null; status: string };

const norm = (s: string | null) => (s ?? "").replace(/\s+/g, " ").trim();
const woerter = (s: string) => norm(s).toLowerCase().split(/\s+/).filter(Boolean);

/** Heuristik: was hat Sinan an der KI-Antwort geändert? Kein KI-Call, nur Textvergleich. */
function aenderung(ki: string, du: string): string {
  const a = woerter(ki), b = woerter(du);
  if (norm(ki) === norm(du)) return "unverändert";
  const setA = new Set(a);
  const gemeinsam = b.filter((w) => setA.has(w)).length;
  const ueberlappung = b.length ? gemeinsam / b.length : 0;
  if (ueberlappung < 0.3) return "komplett neu geschrieben";
  const kiFrage = /\?/.test(ki), duFrage = /\?/.test(du);
  const gruende: string[] = [];
  if (b.length < a.length * 0.7) gruende.push("kürzer");
  if (b.length > a.length * 1.4) gruende.push("länger");
  if (kiFrage && !duFrage) gruende.push("Frage rausgenommen");
  if (!kiFrage && duFrage) gruende.push("Frage ergänzt");
  if (/telefon|anruf|nummer|call|kurz reden|austausch/i.test(du) && !/telefon|anruf|nummer|call|kurz reden|austausch/i.test(ki))
    gruende.push("direkter aufs Gespräch");
  return gruende.length ? gruende.join(", ") : "umformuliert (Ton)";
}

// --- CLI: Kategorie freischalten / zurücknehmen ---
const arg = process.argv.slice(2);
const KATS: IntentKat[] = ["absage", "einwand", "chance", "positive", "neutral"];
if (arg[0] === "frei" || arg[0] === "zu") {
  const k = arg[1] as IntentKat;
  if (!KATS.includes(k)) {
    console.log(`Unbekannte Kategorie. Erlaubt: ${KATS.join(", ")}`);
    process.exit(1);
  }
  setAutonomy(k, arg[0] === "frei" ? "auto" : "ask");
  console.log(`\n  ${k} steht jetzt auf ${arg[0] === "frei" ? "AUTONOM (Bot fährt selbst)" : "FREIGABE (geht zu dir)"}.\n`);
  process.exit(0);
}

const alle = db
  .prepare("SELECT intent, draft, ki_original, status FROM drafts WHERE ki_original IS NOT NULL")
  .all() as D[];

if (!alle.length) {
  console.log("\nNoch keine Daten. Der Bot schreibt sie ab jetzt bei jedem Entwurf mit.\n");
  process.exit(0);
}

console.log("\n== WOCHEN-BILANZ · taugt die KI pro Kategorie? ==\n");

// Pro Kategorie aufschlüsseln – Grundlage fürs kategorienweise Freischalten (Stufe 2).
const kategorien = [...new Set(alle.map((d) => d.intent ?? "unklar"))];
for (const kat of kategorien) {
  const rows = alle.filter((d) => (d.intent ?? "unklar") === kat);
  const entschieden = rows.filter((d) => d.status === "sent" || d.status === "discarded");
  const gesendet = entschieden.filter((d) => d.status === "sent");
  const asis = gesendet.filter((d) => norm(d.draft) === norm(d.ki_original));
  const editiert = gesendet.filter((d) => norm(d.draft) !== norm(d.ki_original));
  const verworfen = entschieden.filter((d) => d.status === "discarded");
  const quote = gesendet.length ? Math.round((asis.length / gesendet.length) * 100) : 0;
  const status = autonomyFor(kat) === "auto" ? "AUTONOM" : "Freigabe";

  console.log(`-- ${kat.toUpperCase()}  [${status}]`);
  console.log(`   ${entschieden.length} entschieden · ${asis.length} unverändert · ${editiert.length} editiert · ${verworfen.length} verworfen`);
  if (gesendet.length >= 5) {
    console.log(`   Trefferquote: ${quote}%`);
    if (autonomyFor(kat) === "ask" && quote >= 80 && verworfen.length === 0)
      console.log(`   -> REIF. Freischalten:  npm run bilanz -- frei ${kat}`);
    else if (autonomyFor(kat) === "ask")
      console.log(`   -> noch behalten (zu oft korrigiert oder verworfen).`);
  } else {
    console.log(`   noch zu wenig Daten (${gesendet.length}/5 gesendet) für eine Empfehlung.`);
  }
  // WAS wurde geändert – das Lernmaterial für context.ts.
  const muster = editiert.map((d) => aenderung(d.ki_original!, d.draft));
  if (muster.length) {
    const zaehl = muster.reduce((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {} as Record<string, number>);
    const top = Object.entries(zaehl).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} (${n}x)`);
    console.log(`   deine Korrekturen: ${top.join(" · ")}`);
  }
  console.log("");
}

console.log("Freischalten:  npm run bilanz -- frei <kategorie>   |   Zurück:  npm run bilanz -- zu <kategorie>\n");
process.exit(0);
