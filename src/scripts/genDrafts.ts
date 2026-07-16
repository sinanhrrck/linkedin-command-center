import { generateInboxDrafts, pendingDrafts } from "../modules/drafts.js";
import { closeSession } from "../core/session.js";

/**
 * Nutzung: npm run drafts            (alle jüngsten Threads)
 *          npm run drafts -- unread  (nur ungelesene)
 * Liest die Inbox und erzeugt DM-Entwürfe. Sendet NICHTS – Freigabe separat.
 */
const onlyUnread = process.argv[2] === "unread";
const n = await generateInboxDrafts(6, onlyUnread);

console.info(`\n${n} neue Entwürfe. Offene Entwürfe insgesamt:\n`);
for (const d of pendingDrafts()) {
  console.info(`#${d.id}  →  ${d.participant}`);
  console.info(`   Eingehend: "${(d.incoming || "").slice(0, 80)}"`);
  console.info(`   Entwurf:   ${d.draft}\n`);
}
console.info("Freigeben später über Dashboard/CLI. Nichts wurde gesendet.");
await closeSession();
process.exit(0);
