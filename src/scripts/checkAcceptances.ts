import { checkAcceptances } from "../modules/acceptance.js";
import { countByStatus } from "../modules/crm.js";
import { governor } from "../core/safetyGovernor.js";
import { closeSession } from "../core/session.js";

/**
 * Nutzung: npm run accept
 * Einmaliger Abgleich: markiert angenommene Vernetzungen (setzt accepted_at).
 */
const n = await checkAcceptances();
const { rate, sample } = governor.acceptanceRate();
console.info(`Fertig: ${n} neue Annahme(n). CRM-Status:`, countByStatus());
console.info(`Akzeptanzrate (7 Tage): ${(rate * 100).toFixed(0)}% (n=${sample})`);
await closeSession();
process.exit(0);
