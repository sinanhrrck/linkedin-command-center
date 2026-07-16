import { config } from "../config.js";
import { upsertEnv } from "../core/env.js";

/**
 * Holt die Person-URN über OpenID userinfo und speichert sie in .env.
 * Nutzung: npm run urn   (setzt LINKEDIN_ACCESS_TOKEN voraus)
 */
const res = await fetch("https://api.linkedin.com/v2/userinfo", {
  headers: { Authorization: `Bearer ${config.linkedin.accessToken}` },
});
if (!res.ok) {
  console.error(`Fehler ${res.status}: ${await res.text()}`);
  process.exit(1);
}
const me = (await res.json()) as { sub: string };
const personUrn = `urn:li:person:${me.sub}`;
upsertEnv({ LINKEDIN_PERSON_URN: personUrn });
console.info(`PERSON_URN = ${personUrn} (in .env gespeichert)`);
process.exit(0);
