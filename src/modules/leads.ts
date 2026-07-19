import { newPage, guardAgainstCheckpoint } from "../core/session.js";
import { humanScroll, humanDelay } from "../core/humanize.js";
import { upsertContact } from "./crm.js";

/**
 * Scrapt LinkedIn People-Search-Ergebnisse in dein CRM.
 * `searchUrl` = eine LinkedIn- oder Sales-Navigator-Suchergebnis-URL.
 *
 * Das ist der kostenlose Ersatz für Apollo/Apify. DSGVO-Hinweis: Du erhebst
 * personenbezogene Daten Dritter – führe eine Rechtsgrundlage und ein
 * Löschkonzept für dein CRM. Bleibt dein Thema.
 *
 * Selektoren an die aktuelle LinkedIn-UI anpassen, falls sich etwas ändert.
 */
export async function scrapeSearch(
  searchUrl: string,
  maxProfiles = 25,
  keepFilter?: string,
  sourceId?: number,
): Promise<number> {
  const page = await newPage();
  await page.goto(searchUrl, { waitUntil: "domcontentloaded" });
  if (await guardAgainstCheckpoint(page)) return 0;

  await humanScroll(page);
  await humanDelay(1500, 3500);

  // LinkedIn verschleiert die CSS-Klassen der Ergebniskarten. Deshalb NICHT über
  // Klassen, sondern über den KARTEN-TEXT parsen: Der Profil-Anchor umschließt die
  // ganze Karte, sein innerText enthält Name, Untertitel und die "Aktuell:"-Zeile.
  const results = await page.$$eval("a[href*='/in/']", (anchors) => {
    // Pro Profil-URL den Anchor mit dem meisten Text wählen (= der die Karte umspannt).
    const byUrl = new Map<string, { url: string; text: string }>();
    for (const el of anchors) {
      const a = el as HTMLAnchorElement;
      if (!a.href.includes("/in/")) continue;
      const url = a.href.split("?")[0];
      const text = (a.innerText || "").trim();
      const prev = byUrl.get(url);
      if (!prev || text.length > prev.text.length) byUrl.set(url, { url, text });
    }

    const out: { url: string; name: string; headline: string }[] = [];
    for (const { url, text } of byUrl.values()) {
      const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
      if (!lines.length) continue;
      const name = lines[0].split("•")[0].trim(); // "Linus Thole • 2." → "Linus Thole"
      if (!name) continue;
      // Jobbezeichnung: bevorzugt die "Aktuell:"-Zeile, sonst der Untertitel (Zeile 2).
      let headline = "";
      const aktuell = lines.find((l) => /^(Aktuell|Current)\s*:/i.test(l));
      if (aktuell) headline = aktuell.replace(/^(Aktuell|Current)\s*:\s*/i, "").trim();
      else if (lines[1] && !/(gemeinsame|gemeinsamer|Kontakt|Vernetzen|Folgen|Nachricht|•)/i.test(lines[1]))
        headline = lines[1];
      out.push({ url, name, headline });
    }
    return out;
  });

  // Optionaler Filter: nur Kontakte übernehmen, deren Name/Headline dazu passt
  // (z.B. eine Azubi-Quelle speichert nur Profile mit "Ausbildung" im Jobtitel).
  const rx = keepFilter ? new RegExp(keepFilter, "i") : null;

  let count = 0;
  for (const r of results.slice(0, maxProfiles)) {
    if (!r.name) continue; // leere Karten überspringen
    if (rx && !rx.test(`${r.name} ${r.headline}`)) continue; // passt nicht zum Filter → skip
    upsertContact({ profileUrl: r.url, fullName: r.name, headline: r.headline || undefined, sourceId });
    count++;
  }
  console.info(
    `[leads] ${results.length} Profile gefunden, ${count} übernommen${rx ? " (gefiltert)" : ""}`,
  );
  // Rückgabe = gefundene Profile auf der Seite (vor Filter) – für die Pagination-Ende-Erkennung.
  return results.length;
}
