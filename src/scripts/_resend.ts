import { db, getMode } from "../db/index.js";
import { governor } from "../core/safetyGovernor.js";
import { deliverFirstMessage } from "../modules/drafts.js";
import { closeSession } from "../core/session.js";
import type { Contact } from "../modules/crm.js";

async function main() {
  console.log("Modus:", getMode(), "| Governor pausiert:", governor.isPaused());
  const d = governor.canDoAction("message");
  console.log("Governor erlaubt Nachricht:", d.ok, d.ok ? "" : "-> " + d.reason);
  if (!d.ok) { await closeSession(); process.exit(1); }

  const ziele = db.prepare(
    `SELECT * FROM contacts WHERE status='accepted'
       AND NOT EXISTS (SELECT 1 FROM drafts dr WHERE dr.thread_url = contacts.profile_url AND dr.kind='first')
     ORDER BY accepted_at DESC LIMIT 2`,
  ).all() as Contact[];

  for (const c of ziele) {
    console.log(`\n--- ${c.full_name} ---`);
    await deliverFirstMessage(c);
    const nach = db.prepare("SELECT status, messaged_at FROM contacts WHERE profile_url=?").get(c.profile_url) as any;
    console.log("   Status danach:", nach.status, nach.messaged_at ? "(gesendet " + nach.messaged_at + ")" : "(NICHT gesendet)");
  }
  await closeSession();
  process.exit(0);
}
main().catch(async (e) => { console.error("FEHLER:", e.message?.split("\n")[0]); await closeSession(); process.exit(1); });
