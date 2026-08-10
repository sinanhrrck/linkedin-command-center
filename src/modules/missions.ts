import { generateText } from "../core/textLlm.js";
import { setState } from "../db/index.js";
import { createCampaign } from "./campaigns.js";
import { addSource } from "./leadFeed.js";
import { goalDefinition, isGoalCode, type GoalCode } from "./goals.js";

export type SearchRoute = { label: string; keywords: string };

export function linkedinPeopleSearchUrl(keywords: string): string {
  const query = keywords.trim().replace(/\s+/g, " ");
  return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(query)}&origin=GLOBAL_SEARCH_HEADER`;
}

const cleanRoute = (value: unknown): SearchRoute | null => {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const keywords = typeof item.keywords === "string" ? item.keywords.trim().slice(0, 160) : "";
  const label = typeof item.label === "string" ? item.label.trim().slice(0, 80) : keywords;
  return keywords ? { label: label || keywords, keywords } : null;
};

/** Das Modell plant nur Suchbegriffe. Die LinkedIn-URL baut der Code selbst, damit sie valide bleibt. */
export async function planSearchRoutes(searchBrief: string): Promise<SearchRoute[]> {
  const brief = searchBrief.trim().slice(0, 600);
  if (!brief) throw new Error("Beschreibe kurz, welche Menschen NextLead finden soll.");
  const prompt = `Du planst eine LinkedIn-Personensuche. Der Nutzer beschreibt in Alltagssprache, wen er finden will.
Erzeuge 2 bis 4 unterschiedliche, präzise Suchphrasen, die direkt in das LinkedIn-Feld "Personen suchen" passen.
Erhalte genannte Rollen, Branchen, Ausbildungsstufen, Arbeitgeber und Orte. Erfinde keine Kriterien.
Nutze Synonyme nur als separate Suchroute. Keine URLs und keine Erklärungen.

Nutzerwunsch: ${brief}

Antworte ausschließlich als JSON-Array:
[{"label":"kurzer verständlicher Name","keywords":"LinkedIn Suchphrase"}]`;
  try {
    const raw = await generateText(prompt);
    const json = raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1);
    const routes = (JSON.parse(json) as unknown[]).map(cleanRoute).filter((v): v is SearchRoute => !!v).slice(0, 4);
    if (routes.length) return routes;
  } catch {
    // Ein fehlender KI-Kanal darf das Anlegen eines Auftrags nicht blockieren.
  }
  return [{ label: brief.slice(0, 80), keywords: brief }];
}

export async function createMission(input: { searchBrief?: unknown; goalCode?: unknown; dailyLimit?: unknown }) {
  const searchBrief = typeof input.searchBrief === "string" ? input.searchBrief.trim().slice(0, 600) : "";
  if (!searchBrief) throw new Error("Beschreibe kurz, welche Menschen NextLead finden soll.");
  if (!isGoalCode(input.goalCode)) throw new Error("Wähle B1, P1 oder AEC als Gesprächsziel.");
  const goalCode: GoalCode = input.goalCode;
  const goal = goalDefinition(goalCode);
  const routes = await planSearchRoutes(searchBrief);
  const name = `${goalCode} · ${searchBrief}`.slice(0, 90);
  const campaignId = createCampaign({
    name,
    audience: searchBrief,
    goal: `${goalCode} – ${goal.label}`,
    kind: "outreach",
    audienceScope: "external",
    filters: {},
    briefing: goal.instruction,
    dailyLimit: Math.max(1, Math.min(30, Math.round(Number(input.dailyLimit) || 10))),
    goalCode,
    searchBrief,
    seedExisting: false,
  });
  for (const route of routes) addSource(linkedinPeopleSearchUrl(route.keywords), route.label, undefined, undefined, campaignId);
  setState("feed_now", "1");
  return { campaignId, goalCode, routes: routes.map((route) => ({ ...route, url: linkedinPeopleSearchUrl(route.keywords) })) };
}
