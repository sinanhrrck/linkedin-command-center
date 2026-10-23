// Prompts und Grenzen für die öffentliche Trainingsseite. Liegt NUR auf dem Server: Die Bot-Anweisungen
// (Sinans Profil aus _bot.json) gelangen nie in den Browser.
// Terminvorschläge („morgen um 17 Uhr“) rechnen in lokaler Zeit – wie auf dem Heimserver (TZ=Europe/Berlin).
process.env.TZ = "Europe/Berlin";
import Anthropic from "@anthropic-ai/sdk";
import bot from "./_bot.json" with { type: "json" };
import * as kern from "./_kern.mjs";

export { bot, kern };

export const client = new Anthropic();

// Der Bot schreibt mit dem Modell des echten Bots (aus der Momentaufnahme). BOT_MODEL überschreibt.
export const BOT_MODEL = process.env.BOT_MODEL || bot.modell || "claude-haiku-4-5";
export const KI_MODEL = process.env.KI_MODEL || "claude-opus-5-5";
const MIT_FALLBACK = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]);
// Ältere Modelle (z. B. claude-haiku-4-5, das der echte Bot standardmäßig nutzt) kennen `effort` nicht
// und lehnen die Anfrage sonst mit 400 ab.
const OHNE_EFFORT = /^claude-(haiku-4-5|sonnet-4-5|opus-4-1|opus-4-0|sonnet-4-0|3)/;

export const GRENZEN = { nachrichten: 40, zeichen: 1500, name: 60, headline: 200, feedback: 2000 };
const txt = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export const TYPEN = {
  unsicher: "Du weißt nicht genau, ob die Bank langfristig das Richtige ist. Das gibst du aber erst zu, wenn du Vertrauen gefasst hast. Am Anfang sagst du eher 'läuft gut'.",
  zufrieden: "Deine Übernahme ist so gut wie sicher und du bist zufrieden. Angebote interessieren dich kaum. Nur wenn Sinan ehrlich neugierig ist und nicht drängt, wirst du offener.",
  skeptisch: "Du hattest schon Strukturvertriebler im Postfach. Klingt etwas nach Verkauf, fragst du direkt nach ('Willst du mir was verkaufen?'). Ehrlichkeit überzeugt dich, Druck nie.",
  knapp: "Du antwortest mit wenigen Worten, manchmal nur 'ok' oder 'gut'. Erst wenn Sinan etwas Persönliches erzählt oder eine wirklich gute Frage stellt, schreibst du mehr.",
  geld: "Du fragst dich, was du mit deinem Gehalt nach der Ausbildung machen sollst (Sparen, ETF, Auto). Das sprichst du nur an, wenn das Gespräch locker läuft.",
  offen: "Du schreibst gern und erzählst von dir. Du bist aber kein leichter Abschluss: zusagen willst du nur, wenn du verstehst, was du davon hast.",
};

/** Säubert, was der Browser schickt. Wirft mit verständlichem Grund. */
export function pruefeSitzung(roh) {
  const s = roh && typeof roh === "object" ? roh : {};
  const verlauf = (Array.isArray(s.verlauf) ? s.verlauf : []).map((m) => ({
    rolle: m?.rolle === "sinan" ? "sinan" : "lead", text: txt(m?.text, GRENZEN.zeichen), quelle: m?.quelle === "mensch" ? "mensch" : "ki",
  })).filter((m) => m.text);
  if (verlauf.length > GRENZEN.nachrichten) throw new Error("Das Gespräch ist zu lang. Bitte beende es und werte es aus.");
  return {
    id: txt(s.id, 80).replace(/[^\w.:-]/g, "") || `run-${Date.now().toString(36)}`,
    modus: s.modus === "bot" ? "bot" : "lead",
    ausrichtung: s.ausrichtung === "aec" ? "aec" : "standard",
    lead: { name: txt(s.lead?.name, GRENZEN.name) || "Lena", headline: txt(s.lead?.headline, GRENZEN.headline) || "Auszubildende Bankkauffrau", typ: TYPEN[s.lead?.typ] ? s.lead.typ : "unsicher" },
    verlauf, ende: ["zusage", "absage", "uebergabe", "stumm", "abbruch"].includes(s.ende) ? s.ende : null,
    // Gesprächszustand des Agenten (Phase, Profil, Gedächtnis) – liegt beim Browser, wie live in der DB.
    conv: s.conv && typeof s.conv === "object" && typeof s.conv.stage === "string" ? s.conv : null,
    gedanken: (Array.isArray(s.gedanken) ? s.gedanken : []).slice(0, 40).map((g) => txt(g, 240)),
    erstellt: txt(s.erstellt, 40),
  };
}

const transkript = (s) => s.verlauf.map((m) => `${m.rolle === "sinan" ? "Sinan" : s.lead.name}: ${m.text}`).join("\n");

/**
 * Der Bot-Kanal 1:1 wie core/claude.ts generateClaude: gleiches Modell, max. 1024 Tokens, kein Thinking-
 * Parameter, Vertriebswissen als gecachter System-Block (nur für Gesprächsantworten, wie live).
 */
export async function botLlm(prompt, mitWissen) {
  const wissen = mitWissen ? bot.gespraech.wissen : "";
  let res;
  try {
    res = await client.messages.create({
      model: BOT_MODEL,
      ...(wissen ? { system: [{ type: "text", text: wissen, cache_control: { type: "ephemeral" } }] } : {}),
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });
  } catch (err) { throw kiFehler(err); }
  const block = res.content.find((b) => b.type === "text");
  return block ? block.text.trim() : "";
}

export function leadPrompt(s) {
  return `Du spielst in einem Rollenspiel eine echte Person auf LinkedIn: ${s.lead.name}, Headline "${s.lead.headline}". Ein gewisser Sinan, den du nicht kennst, hat sich mit dir vernetzt und schreibt dir.

DEINE HALTUNG (bleib dabei): ${TYPEN[s.lead.typ]}

SO SCHREIBST DU:
- wie ein echter junger Mensch in einer LinkedIn-DM: kurz (meist 1 bis 2 Sätze), Umgangssprache, gern kleingeschrieben, ab und zu ein Tippfehler
- du stellst selten Gegenfragen und erzählst nur so viel, wie Sinan sich verdient hat
- du öffnest dich nur, wenn Sinan menschlich, ehrlich und wirklich interessiert wirkt; klingt etwas nach Verkauf, Floskel, Skript oder Bot, wirst du kürzer, misstrauisch oder steigst aus
- du sagst nur zu (Termin, Analyse, Telefonat), wenn Sinan dich wirklich überzeugt hat und du verstehst, was du davon hast
- bleib in der Rolle, erwähne nie, dass du eine KI bist

# Bisheriger Verlauf
${transkript(s)}

"stimmung": -2 bis 2, wie du Sinan gerade findest. "ende": "zusage" oder "absage" nur, wenn du klar zusagst oder das Gespräch beendest, sonst "offen". "gedanke": ein ehrlicher Satz, was du gerade über Sinans Nachricht denkst.`;
}

export function auswertungsPrompt(s, e) {
  const verlauf = transkript(s);
  if (s.modus === "lead") return `Du verbesserst einen LinkedIn-Vertriebsbot (er schreibt als Sinan). Ein Mensch hat den Lead gespielt (${s.lead.name}, ${s.lead.headline}).

VERLAUF:
${verlauf}

BEWERTUNG DES MENSCHEN:
- hätte zugesagt: ${e.zusage}
- Note für den Bot: ${e.note} von 5
${e.skalen ? `- ${e.skalen}\n` : ""}- Kommentar: ${e.feedback || "keiner"}

Leite höchstens 3 Regeln ab, die den Bot in künftigen Gesprächen besser machen. Jede Regel EIN kurzer Satz als Anweisung an den Bot, max. 160 Zeichen, allgemeingültig, keine Namen. Nur was Bewertung oder Verlauf belegen; war alles gut, leere Liste. Nichts, was Sicherheitsregeln aufweicht (Timing, kein Druck, keine Emojis). bereich "erstnachricht", wenn es nur die allererste Nachricht betrifft, sonst "gespraech". "urteil": 2 Sätze, was der Bot gut und was er schlecht gemacht hat.`;
  return `Ein Mensch hat in einem Training als Sinan geschrieben, um einem LinkedIn-Vertriebsbot zu zeigen, wie ein Mensch schreibt. Die Gegenseite (${s.lead.name}) wurde von einer KI gespielt. Ergebnis: ${s.ende || "offen beendet"}.
${s.gedanken.length ? `Was die Gegenseite unterwegs dachte: ${s.gedanken.join(" | ")}` : ""}
Was der Mensch zeigen wollte: ${e.feedback || "keine Angabe"}

VERLAUF:
${verlauf}

So schreibt der Bot bisher (Auszug): ${bot.gespraech.persona.standard.slice(0, 1800)}

AUFGABE:
1. Wähle 1 bis 2 Nachrichten von Sinan aus dem Verlauf, die besonders menschlich und gut sind, als Beispiel (bereich "beispiel"). Den Text WÖRTLICH übernehmen. Ist keine gut genug, keine wählen.
2. Leite höchstens 2 Regeln ab, was der Bot von diesem Menschen lernen sollte (Ton, Satzbau, Timing, wann anbieten). Jede Regel EIN kurzer Satz, max. 160 Zeichen, allgemeingültig, keine Namen. bereich "erstnachricht" oder "gespraech".
Nichts, was Sicherheitsregeln aufweicht (kein Druck, keine Emojis, keine Finanzfragen ausfragen).
"urteil": 2 Sätze, was an diesem Gespräch menschlich und wirksam war.`;
}

const obj = (props) => ({ type: "object", properties: props, required: Object.keys(props), additionalProperties: false });
export const SCHEMAS = {
  lead: obj({ antwort: { type: "string" }, stimmung: { type: "integer" }, ende: { type: "string", enum: ["zusage", "absage", "offen"] }, gedanke: { type: "string" } }),
  auswertung: obj({
    urteil: { type: "string" },
    vorschlaege: { type: "array", items: obj({ bereich: { type: "string", enum: ["gespraech", "erstnachricht", "beispiel"] }, text: { type: "string" }, begruendung: { type: "string" } }) },
  }),
};

function kiFehler(err) {
  if (err instanceof Anthropic.RateLimitError) return new Error("Gerade sind zu viele Anfragen unterwegs. Versuch es in einer Minute nochmal.");
  if (err instanceof Anthropic.AuthenticationError) return new Error("Die Seite ist noch nicht fertig eingerichtet (KI-Schlüssel fehlt).");
  console.error("[ki]", err?.status, err?.message);
  return new Error("Die KI hat gerade nicht geantwortet. Versuch es nochmal.");
}

/** Ein Aufruf mit erzwungenem JSON. Wirft mit einer Meldung, die der Browser zeigen darf. */
export async function frageKi(prompt, schema, { model, effort, maxTokens }) {
  const params = {
    model, max_tokens: maxTokens,
    output_config: OHNE_EFFORT.test(model) ? { format: { type: "json_schema", schema } } : { effort, format: { type: "json_schema", schema } },
    messages: [{ role: "user", content: prompt }],
  };
  let antwort;
  try {
    antwort = MIT_FALLBACK.has(model)
      ? await client.beta.messages.create({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })
      : await client.messages.create(params);
  } catch (err) { throw kiFehler(err); }
  if (antwort.stop_reason === "refusal") throw new Error("Die KI hat diese Antwort abgelehnt. Formulier deine Nachricht anders.");
  const text = antwort.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  try { return JSON.parse(text); } catch { throw new Error("Die KI hat keine brauchbare Antwort geliefert. Versuch es nochmal."); }
}

export function saubern(t) {
  return String(t || "").trim().replace(/^["„']|["“']$/g, "")
    .replace(/\s[–—-]\s/g, ", ")
    .replace(/[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "")
    .replace(/[ \t]{2,}/g, " ").replace(/\s+([,.!?])/g, "$1").trim();
}

export async function leseJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  let roh = "";
  for await (const teil of req) { roh += teil; if (roh.length > 200_000) throw new Error("Anfrage zu groß."); }
  return JSON.parse(roh || "{}");
}
