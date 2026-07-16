import { scrapeSearch } from "../modules/leads.js";
import { countByStatus } from "../modules/crm.js";
import { closeSession } from "../core/session.js";

/**
 * Nutzung: npm run scrape -- "<LinkedIn-Suchergebnis-URL>" [maxProfiles]
 */
const url = process.argv[2];
const max = Number(process.argv[3] ?? 25);

if (!url) {
  console.error('Bitte eine Such-URL angeben: npm run scrape -- "https://www.linkedin.com/search/results/people/?..."');
  process.exit(1);
}

const n = await scrapeSearch(url, max);
console.info(`Fertig: ${n} Kontakte. CRM-Status:`, countByStatus());
await closeSession();
process.exit(0);
