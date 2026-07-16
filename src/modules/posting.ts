import { config } from "../config.js";
import { refreshAccessToken } from "../core/linkedinToken.js";

/**
 * Postet über die OFFIZIELLE LinkedIn Posts-API (/rest/posts).
 * Kein Browser, kein Governor – das ist der saubere, erlaubte Weg.
 * Voraussetzung: App mit "Share on LinkedIn"-Produkt, Scope w_member_social.
 *
 * Limits: Text max 3000 Zeichen, ~100 Calls/Tag. Kein natives Scheduling
 * (das übernimmt unser eigener Scheduler in index.ts).
 */
export async function publishPost(body: string): Promise<string> {
  if (body.length > 3000) throw new Error("Post > 3000 Zeichen (LinkedIn-Limit)");
  if (!config.linkedin.personUrn) throw new Error("LINKEDIN_PERSON_URN fehlt");

  let token = config.linkedin.accessToken;
  let res = await doPost(body, token);

  // Access-Token abgelaufen? Einmal refreshen und erneut versuchen.
  if (res.status === 401) {
    token = await refreshAccessToken();
    res = await doPost(body, token);
  }

  if (!res.ok) throw new Error(`LinkedIn API ${res.status}: ${await res.text()}`);
  return res.headers.get("x-restli-id") ?? "unbekannt"; // Post-URN
}

function doPost(body: string, token: string) {
  return fetch("https://api.linkedin.com/rest/posts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "LinkedIn-Version": config.linkedin.apiVersion,
      "X-Restli-Protocol-Version": "2.0.0",
    },
    body: JSON.stringify({
      author: config.linkedin.personUrn,
      commentary: body,
      visibility: "PUBLIC",
      distribution: {
        feedDistribution: "MAIN_FEED",
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    }),
  });
}
