import { setAutonomy, autonomyFor, type IntentKat } from "../db/index.js";
import { computeBilanz } from "../modules/bilanz.js";

/**
 * CLI-Ansicht der Bilanz. Der Report kommt im Betrieb automatisch per Telegram (index.ts Cron) –
 * dieses Skript ist nur zum Nachschauen/Umschalten von Hand.
 *
 * npm run bilanz                 → Report
 * npm run bilanz -- frei chance  → Kategorie autonom stellen
 * npm run bilanz -- zu chance    → wieder auf Freigabe
 */
const arg = process.argv.slice(2);
const KATS: IntentKat[] = ["absage", "einwand", "chance", "positive", "neutral"];

if (arg[0] === "frei" || arg[0] === "zu") {
  const k = arg[1] as IntentKat;
  if (!KATS.includes(k)) { console.log(`Erlaubt: ${KATS.join(", ")}`); process.exit(1); }
  setAutonomy(k, arg[0] === "frei" ? "auto" : "ask");
  console.log(`\n  ${k} -> ${arg[0] === "frei" ? "AUTONOM" : "FREIGABE"}\n`);
  process.exit(0);
}

const b = computeBilanz();
if (!b.length) { console.log("\nNoch keine Daten.\n"); process.exit(0); }

console.log("\n== WOCHEN-BILANZ · taugt die KI pro Kategorie? ==\n");
for (const k of b) {
  console.log(`-- ${k.intent.toUpperCase()}  [${k.autonom ? "AUTONOM" : "Freigabe"}]`);
  console.log(`   ${k.entschieden} entschieden · ${k.unveraendert} unveraendert · ${k.editiert} editiert · ${k.verworfen} verworfen`);
  if (k.entschieden >= 5 || k.autonom) console.log(`   Trefferquote: ${k.quote}%${k.reif ? "  -> REIF: npm run bilanz -- frei " + k.intent : ""}`);
  else console.log(`   noch zu wenig Daten fuer eine Empfehlung.`);
  if (k.korrekturen) console.log(`   deine Korrekturen: ${k.korrekturen}`);
  console.log("");
}
console.log("Umschalten:  npm run bilanz -- frei|zu <kategorie>\n");
process.exit(0);
