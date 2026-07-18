import { newPage, guardAgainstCheckpoint } from "../core/session.js";
import { humanDelay } from "../core/humanize.js";

/**
 * SICHTBARKEIT über Reichweiten-Posts. Statt des Zufalls-Feeds (voller Werbung) gezielt die
 * LinkedIn-CONTENT-SUCHE nach Sinans Nische – da posten Leute mit Reichweite, und genau dort
 * liest seine Zielgruppe (kaufm. Azubis, Berufseinsteiger) mit. Ein sinnvoller Kommentar dort
 * bringt neue Leute auf Sinans Profil.
 *
 * Rein LESEND (kein Governor). LinkedIn verschleiert die Post-Klassen → Anker ist der
 * "Kommentieren"-Button, von dem aus zum Post-Container hochgeklettert wird (wie bei leads.ts).
 */
export type FeedPost = { url: string; autor: string; text: string };

/** Suchbegriffe für Sinans Nische. Bewusst themennah, wo seine Zielgruppe mitliest. */
export const NISCHE_KEYWORDS = ["Ausbildung Bank", "Berufseinstieg", "Azubi Finanzen", "Ausbildung abgeschlossen"];

export async function fetchNichePosts(keyword: string, max = 6): Promise<FeedPost[]> {
  const page = await newPage();
  const url = `https://www.linkedin.com/search/results/content/?keywords=${encodeURIComponent(keyword)}&sortBy=%22date_posted%22`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  if (await guardAgainstCheckpoint(page)) return [];
  await humanDelay(3500, 5000);
  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel(0, 1500);
    await humanDelay(1200, 2200);
  }

  // Anker: "Kommentieren"-Button → Post-Container. Autor aus dem "Feed-Beitrag <Name> •"-Muster,
  // Post-URL aus dem ersten /feed/update-Link (der Zeitstempel verlinkt den Post).
  const posts = (await page.evaluate(`(() => {
    const btns = Array.from(document.querySelectorAll("button[aria-label*='ommentier'], button[aria-label*='omment']"));
    const seen = new Set(); const out = [];
    for (const btn of btns) {
      let node = btn, container = null;
      for (let i = 0; i < 12 && node; i++) { node = node.parentElement; if (node && node.innerText && node.innerText.length > 100) { container = node; break; } }
      if (!container) continue;
      const roh = container.innerText.replace(/\\s+/g, " ").trim();
      const key = roh.slice(0, 60); if (seen.has(key)) continue; seen.add(key);

      // Werbung/Anzeigen raus
      if (/gesponsert|anzeige|promoted|\\bAd\\b/i.test(roh.slice(0, 120))) continue;

      // Autor: nach "Feed-Beitrag" steht der Name, dann " • <Grad>"
      let autor = "";
      const m = roh.match(/Feed-Beitrag\\s+([^•]+?)\\s*•/);
      if (m) autor = m[1].trim().slice(0, 40);
      if (!autor) { const a = container.querySelector("a[href*='/in/']"); autor = a ? a.innerText.replace(/\\s+/g," ").trim().split("\\n")[0].slice(0,40) : ""; }

      // Post-URL
      const link = container.querySelector("a[href*='/feed/update/'], a[href*='/posts/']");
      const url = link ? link.href.split("?")[0] : "";

      // Reiner Post-Text: Kopf ("Feed-Beitrag ... •  <Zeit>") grob abschneiden
      let text = roh.replace(/^Feed-Beitrag\\s+[^•]+•\\s*\\S+\\s*(Grad|1\\.|2\\.|3\\.)?/i, "").trim();
      out.push({ url, autor, text: text.slice(0, 400) });
      if (out.length >= ${max}) break;
    }
    return out;
  })()`)) as FeedPost[];

  return posts.filter((p) => p.url && p.text.length > 40);
}
