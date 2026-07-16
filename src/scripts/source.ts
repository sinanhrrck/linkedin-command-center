import { addSource, listSources, feedTick } from "../modules/leadFeed.js";
import { closeSession } from "../core/session.js";

/**
 * Lead-Quellen verwalten:
 *   npm run source -- add "<LinkedIn-Such-URL>" "<Label>"
 *   npm run source -- list
 *   npm run source -- feed        (jetzt einmal alle Quellen abgrasen)
 */
const cmd = process.argv[2];

if (cmd === "add") {
  const url = process.argv[3];
  const label = process.argv[4];
  const filter = process.argv[5]; // optional: Regex, nur passende Kontakte speichern
  if (!url) {
    console.error('URL fehlt: npm run source -- add "<url>" "<label>" ["<filter-regex>"]');
    process.exit(1);
  }
  addSource(url, label, filter);
  console.info(`✅ Quelle hinzugefügt: ${label || url}${filter ? ` · Filter: /${filter}/i` : ""}`);
  process.exit(0);
} else if (cmd === "list") {
  const s = listSources();
  if (!s.length) console.info("Keine Quellen. Anlegen mit: npm run source -- add \"<url>\" \"<label>\"");
  s.forEach((x) =>
    console.info(
      `#${x.id} ${x.active ? "●" : "○"} ${x.label || "(ohne Label)"} · Seite ${x.cursor_page} · zuletzt +${x.last_added}${x.keep_filter ? ` · Filter /${x.keep_filter}/i` : ""}\n   ${x.search_url}`,
    ),
  );
  process.exit(0);
} else if (cmd === "feed") {
  const n = await feedTick();
  console.info(`\nFertig: +${n} neue Leads.`);
  await closeSession();
  process.exit(0);
} else {
  console.error('Nutzung: npm run source -- add|list|feed');
  process.exit(1);
}
