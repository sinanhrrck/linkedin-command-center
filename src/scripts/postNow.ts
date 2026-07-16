import { publishPost } from "../modules/posting.js";

/**
 * Sofort einen Post veröffentlichen (Test der offiziellen API).
 * Nutzung: npm run post -- "Mein Testpost über die API 🚀"
 */
const text = process.argv.slice(2).join(" ");
if (!text) {
  console.error('Bitte Text angeben: npm run post -- "..."');
  process.exit(1);
}
const urn = await publishPost(text);
console.info(`✅ Veröffentlicht: ${urn}`);
process.exit(0);
