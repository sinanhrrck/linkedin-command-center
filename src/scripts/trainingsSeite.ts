/**
 * Baut die Trainingsseiten aus den AKTUELLEN Daten des Bots.
 *
 *   npm run trainingsseite
 *     → training-web/api/_bot.json   Momentaufnahme für die öffentliche Website (Vercel), nur serverseitig
 *     → training-web/api/_kern.mjs   gebündelter Bot-Kern (src/trainingsweb/kern.ts)
 *     → training-seite/chat-training.html  claude.ai-Artifact (nur intern, vereinfachte Fassung)
 *
 *   npm run trainingsseite -- --nur-snapshot <pfad>
 *     → schreibt NUR die Momentaufnahme. Für den Heimserver: dort liegen die Live-Daten (Zielgruppen,
 *       Stil-Varianten, freigegebene Regeln, Vertriebswissen) – nur ein dort erzeugter Snapshot ist 1:1.
 *
 * Alle Ausgaben sind gitignored, weil Profil und Vertriebswissen drinstehen. Liest nur, schreibt nichts in die DB.
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { promptKontext } from "../context.js";
import { ausrichtungsBlock } from "../modules/ausrichtung.js";
import { CTA_PLATZHALTER } from "../trainingsweb/kern.js";
import { baueSnapshot } from "../trainingsweb/snapshot.js";

const snapshot = baueSnapshot();

const nurSnapshot = process.argv.indexOf("--nur-snapshot");
if (nurSnapshot >= 0) {
  const ziel = process.argv[nurSnapshot + 1];
  if (!ziel) throw new Error("Pfad fehlt: --nur-snapshot <pfad>");
  writeFileSync(ziel, JSON.stringify(snapshot, null, 2));
  console.log(`Snapshot (${snapshot.quelle}, Modell ${snapshot.modell}, Wissen ${snapshot.gespraech.wissen ? "ja" : "NEIN"}) → ${ziel}`);
  process.exit(0);
}

// Website: Momentaufnahme + gebündelter Kern.
writeFileSync("training-web/api/_bot.json", JSON.stringify(snapshot, null, 2));
execSync("npx esbuild src/trainingsweb/kern.ts --bundle --platform=node --format=esm --target=node20 --log-level=warning --outfile=training-web/api/_kern.mjs", { stdio: "inherit" });

// claude.ai-Artifact (intern, vereinfachte Fassung): alte Datenform.
const ohneTermin = (t: string) => t.replace(CTA_PLATZHALTER, "").trim();
const artifact = {
  persona: promptKontext(), aec: ausrichtungsBlock("aec"),
  angebotStandard: ohneTermin(snapshot.gespraech.angebot.standard), angebotAec: ohneTermin(snapshot.gespraech.angebot.aec),
};
const template = readFileSync("training-seite/template.html", "utf8");
if (!template.includes("__BOT__")) throw new Error("Platzhalter __BOT__ fehlt im Template.");
writeFileSync("training-seite/chat-training.html", template.replace("__BOT__", JSON.stringify(artifact).replace(/<\//g, "<\\/")));

console.log(`Gebaut (Quelle ${snapshot.quelle}, Modell ${snapshot.modell}, Vertriebswissen ${snapshot.gespraech.wissen ? "ja" : "NEIN"}).`);
console.log("Website: aus training-web/ `npx vercel deploy --prod`. Artifact: training-seite/chat-training.html neu veröffentlichen.");
if (snapshot.quelle !== "server") console.log("HINWEIS: lokaler Snapshot – für 1:1 auf dem Heimserver mit --nur-snapshot erzeugen.");
