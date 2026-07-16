import { createServer } from "node:http";
import { exec } from "node:child_process";
import { config } from "../config.js";
import { upsertEnv } from "../core/env.js";

/**
 * Einmaliger LinkedIn-OAuth-Flow. Voraussetzung in .env:
 *   LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET
 * (aus dem LinkedIn Developer Portal, App mit den Produkten
 *  "Sign In with LinkedIn using OpenID Connect" + "Share on LinkedIn").
 *
 * Als Redirect-URL muss im Portal exakt eingetragen sein:
 *   http://localhost:5555/callback
 *
 * Nutzung: npm run auth
 * Danach stehen ACCESS_TOKEN, REFRESH_TOKEN und PERSON_URN automatisch in .env.
 */
const PORT = 5555;
const REDIRECT = `http://localhost:${PORT}/callback`;
const SCOPES = "openid profile w_member_social";

if (!config.linkedin.clientId || !config.linkedin.clientSecret) {
  console.error("Bitte zuerst LINKEDIN_CLIENT_ID und LINKEDIN_CLIENT_SECRET in .env eintragen.");
  process.exit(1);
}

const state = Math.random().toString(36).slice(2);
const authUrl =
  "https://www.linkedin.com/oauth/v2/authorization?" +
  new URLSearchParams({
    response_type: "code",
    client_id: config.linkedin.clientId,
    redirect_uri: REDIRECT,
    state,
    scope: SCOPES,
  });

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "", `http://localhost:${PORT}`);
  if (!url.pathname.startsWith("/callback")) {
    res.writeHead(404).end();
    return;
  }
  const code = url.searchParams.get("code");
  if (!code) {
    res.writeHead(400).end("Kein Code erhalten.");
    return;
  }

  try {
    // 1) Code gegen Tokens tauschen
    const tokenRes = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        client_id: config.linkedin.clientId,
        client_secret: config.linkedin.clientSecret,
      }),
    });
    const tokens = (await tokenRes.json()) as {
      access_token: string;
      refresh_token?: string;
    };
    if (!tokens.access_token) throw new Error(JSON.stringify(tokens));

    // 2) Person-URN via OpenID userinfo holen
    const meRes = await fetch("https://api.linkedin.com/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const me = (await meRes.json()) as { sub: string };
    const personUrn = `urn:li:person:${me.sub}`;

    upsertEnv({
      LINKEDIN_ACCESS_TOKEN: tokens.access_token,
      LINKEDIN_REFRESH_TOKEN: tokens.refresh_token ?? "",
      LINKEDIN_PERSON_URN: personUrn,
    });

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(
      "<h2>✅ Fertig. Tokens in .env gespeichert. Du kannst dieses Fenster schließen.</h2>",
    );
    console.info("\n✅ ACCESS_TOKEN, REFRESH_TOKEN und PERSON_URN in .env gespeichert.");
    console.info(`   PERSON_URN = ${personUrn}`);
    server.close();
    process.exit(0);
  } catch (e) {
    res.writeHead(500).end("Fehler beim Token-Tausch. Siehe Terminal.");
    console.error(e);
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.info("→ Öffne diese URL im Browser (falls sie nicht automatisch aufgeht):\n");
  console.info(authUrl.toString() + "\n");
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  exec(`${cmd} "${authUrl}"`);
});
