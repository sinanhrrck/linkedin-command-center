import { db } from "../db/index.js";

/**
 * Wochen-Bilanz: taugt die KI im Tuer-Moment?
 *
 * Sinans Ziel sind fertige Leads, nicht Klickarbeit. Ob der Bot den vertrieblich
 * entscheidenden Moment allein fahren darf, soll aber nicht das Bauchgefuehl entscheiden,
 * sondern DATEN. Der ehrlichste Massstab ist Sinan selbst: schickt er den KI-Vorschlag
 * unveraendert raus, war er gut. Schreibt er ihn um, zeigt die Aenderung was fehlt.
 *
 * Aufruf: npm run bilanz
 */
type D = { id: number; participant: string; intent: string | null; draft: string; ki_original: string | null; status: string; created_at: string };

const norm = (s: string) => (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

const alle = db
  .prepare("SELECT id, participant, intent, draft, ki_original, status, created_at FROM drafts WHERE ki_original IS NOT NULL ORDER BY created_at")
  .all() as D[];

if (!alle.length) {
  console.log("\nNoch keine Daten. Der Bot sammelt sie ab jetzt bei jedem Entwurf.\n");
  process.exit(0);
}

const gesendet = alle.filter((d) => d.status === "sent");
const unveraendert = gesendet.filter((d) => norm(d.draft) === norm(d.ki_original!));
const editiert = gesendet.filter((d) => norm(d.draft) !== norm(d.ki_original!));
const verworfen = alle.filter((d) => d.status === "discarded");
const offen = alle.filter((d) => d.status === "pending");

const q = gesendet.length ? Math.round((unveraendert.length / gesendet.length) * 100) : 0;

console.log("\n╔══ WOCHEN-BILANZ: taugt die KI im Tuer-Moment? ══\n");
console.log(`  Vorschlaege gesamt : ${alle.length}   (offen: ${offen.length})`);
console.log(`  unveraendert raus  : ${unveraendert.length}`);
console.log(`  von dir umgeschrieben: ${editiert.length}`);
console.log(`  verworfen          : ${verworfen.length}`);
console.log(`\n  TREFFERQUOTE: ${q}%  (${unveraendert.length} von ${gesendet.length} gesendeten)\n`);

if (editiert.length) {
  console.log("── Was du umgeschrieben hast (da fehlt der KI was) ──");
  for (const d of editiert.slice(-5)) {
    console.log(`\n  ${d.participant} [${d.intent ?? "?"}]`);
    console.log(`   KI : ${d.ki_original!.replace(/\s+/g, " ").slice(0, 110)}`);
    console.log(`   DU : ${d.draft.replace(/\s+/g, " ").slice(0, 110)}`);
  }
  console.log("");
}

console.log("── EMPFEHLUNG ──");
if (gesendet.length < 5) console.log("  Zu wenig Daten. Warte, bis du 5+ Vorschlaege freigegeben hast.");
else if (q >= 80) console.log(`  ${q}% unveraendert -> die KI trifft deinen Ton. Tuer-Moment freischalten ist vertretbar.`);
else if (q >= 50) console.log(`  ${q}% unveraendert -> brauchbar, aber du korrigierst noch zu oft. Erst die Muster oben in context.ts giessen.`);
else console.log(`  Nur ${q}% unveraendert -> NICHT freischalten. Die Beispiele oben zeigen, was der KI fehlt.`);
console.log("");
process.exit(0);
