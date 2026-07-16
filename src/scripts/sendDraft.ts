import { getDraft, sendDraft } from "../modules/drafts.js";
import { closeSession } from "../core/session.js";

/**
 * Nutzung: npm run send -- <draftId>
 * Sendet EINEN freigegebenen DM-Entwurf über den Governor. Bewusst pro Entwurf
 * einzeln und explizit – Senden ist eine irreversible Aktion.
 */
const id = Number(process.argv[2]);
if (!id) {
  console.error("Bitte Draft-ID angeben: npm run send -- <id>   (IDs siehst du in npm run drafts)");
  process.exit(1);
}

const d = getDraft(id);
if (!d) {
  console.error(`Entwurf #${id} nicht gefunden.`);
  process.exit(1);
}

console.info(`\nSende an: ${d.participant}`);
console.info(`Text: ${d.draft}\n`);

const res = await sendDraft(id);
if (res.ok) console.info(`✅ Gesendet an ${d.participant}.`);
else console.info(`⏭  Nicht gesendet: ${res.reason}`);

await closeSession();
process.exit(res.ok ? 0 : 1);
