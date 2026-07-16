import { config } from "../config.js";
import { upsertEnv } from "./env.js";

const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";

/**
 * Tauscht den Refresh-Token gegen einen frischen Access-Token.
 * Access-Tokens laufen nach 60 Tagen ab, Refresh-Tokens nach 365.
 * Der neue Token wird in .env gespeichert und zurückgegeben.
 */
export async function refreshAccessToken(): Promise<string> {
  if (!config.linkedin.refreshToken) throw new Error("Kein LINKEDIN_REFRESH_TOKEN vorhanden");

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: config.linkedin.refreshToken,
    client_id: config.linkedin.clientId,
    client_secret: config.linkedin.clientSecret,
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Token-Refresh fehlgeschlagen ${res.status}: ${await res.text()}`);

  const data = (await res.json()) as { access_token: string; refresh_token?: string };
  const updates: Record<string, string> = { LINKEDIN_ACCESS_TOKEN: data.access_token };
  if (data.refresh_token) updates.LINKEDIN_REFRESH_TOKEN = data.refresh_token;
  upsertEnv(updates);
  console.info("[auth] Access-Token erneuert");
  return data.access_token;
}
