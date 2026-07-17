import { generateText } from "../core/textLlm.js";
import { generateClaude, claudeAvailable } from "../core/claude.js";
import { config } from "../config.js";
import type { Contact } from "./crm.js";
import { promptKontext, saubern, ERSTNACHRICHT_ANGLE } from "../context.js";

/**
 * Router für den Autopilot-Text: bezahltes Claude (Standard im Voll-Modus, Qualität +
 * kein 20/Tag-Limit) mit automatischem Gemini-Fallback, falls kein Anthropic-Key gesetzt
 * ist oder LLM_AUTOPILOT_PROVIDER=gemini erzwungen wurde. Alle ANDEREN KI-Aufrufe
 * (Notizen, Erstnachricht, Follow-up, Entwürfe) bleiben bewusst auf Gemini gratis.
 */
async function generateAutopilot(prompt: string): Promise<string> {
  if (config.llm.autopilotProvider === "claude" && claudeAvailable()) {
    return generateClaude(prompt);
  }
  return generateText(prompt);
}

/** Beschreibt den Lead für den Prompt (inkl. Jobbezeichnung, falls erfasst). */
function personZeile(c: Contact): string {
  return `Person: ${c.full_name ?? "Unbekannt"}${c.headline ? ` – ${c.headline}` : ""}.`;
}

/**
 * Kurze, personalisierte Vernetzungsnotiz (< 200 Zeichen, LinkedIn-Limit).
 * Personalisierung ist hier kein Nice-to-have: Sie ist der einzige Hebel, der
 * deine Akzeptanzrate über die 30%-Schwelle des Governor-Circuit-Breakers hält.
 */
export async function connectionNote(c: Contact): Promise<string> {
  const prompt = `Schreibe eine LinkedIn-Vernetzungsnotiz (max. 180 Zeichen).
${promptKontext()}
${personZeile(c)}
Nimm EINEN konkreten Bezug zur Person (z.B. ihre Rolle/Ausbildung). Gib NUR die Notiz aus, ohne Anführungszeichen.`;
  return saubern(await generateText(prompt)).slice(0, 200);
}

/** Erstnachricht nach angenommener Vernetzung an einen Azubi (persönlich, mit Bezug). */
export async function firstMessage(c: Contact): Promise<string> {
  const prompt = `Schreibe eine erste LinkedIn-Nachricht an einen frisch vernetzten Kontakt (3-4 Sätze).
${promptKontext()}
Winkel dieser Nachricht: ${ERSTNACHRICHT_ANGLE}
${personZeile(c)}
Nimm konkret Bezug auf die Ausbildung/Bank der Person und ende mit EINER echten Frage danach,
wie es für sie nach der Ausbildung weitergehen soll. Gib NUR die Nachricht aus, ohne Anführungszeichen.`;
  return saubern(await generateText(prompt));
}

export type ConverseStep = {
  intent: "meeting" | "positive" | "objection" | "neutral";
  contact: string | null; // Telefonnummer/E-Mail, falls die Person sie genannt hat
  reply: string; // Sinans nächste Nachricht
  /** 1-2 Sätze: worum ging es im Gespräch? Für die Telegram-Eskalation. */
  zusammenfassung: string;
  /** Warum dieser intent + wie Sinan damit umgehen sollte. Der Rat, nicht nur die Einordnung. */
  strategie: string;
};

/**
 * AUTOPILOT-Kern: analysiert die letzte Nachricht der Person UND formuliert Sinans
 * nächste Antwort – in EINEM Call (spart KI-Kontingent). Ziel: mehrwert-first zu einem
 * kurzen Kennenlern-Telefonat bewegen, ohne aufdringlich zu sein.
 */
export async function converseStep(messages: { sender: string; text: string }[], participant: string): Promise<ConverseStep | null> {
  const transcript = messages.map((m) => `${m.sender || "?"}: ${m.text}`).join("\n");
  const prompt = `Du bist Sinan und führst einen LinkedIn-Chat mit ${participant}.
${promptKontext()}
Übergeordnetes Ziel: die Person mehrwert-first zu einem kurzen, lockeren Kennenlern-Telefonat
bewegen – niemals aufdringlich, echtes Interesse.

Bisheriger Verlauf:
${transcript}

Analysiere die LETZTE Nachricht der Person und antworte AUSSCHLIESSLICH mit JSON (kein Text drumherum):
{"intent":"meeting|positive|objection|neutral","contact":"Telefonnummer oder E-Mail der Person falls im Verlauf genannt, sonst null","reply":"Sinans nächste Nachricht","zusammenfassung":"1-2 Sätze: worum ging es, was will die Person","strategie":"2-3 Sätze: warum dieser intent und wie Sinan konkret damit umgehen sollte"}
Regeln für intent:
- "meeting": Person sagt Ja zu Telefonat/Termin ODER nennt ihre Nummer.
- "objection": Einwand, Absage ODER höfliches Abwinken. Achte auf Schluss-Signale wie
  "danke der Nachfrage", "viel Erfolg", "hab schon einen Plan", "bin versorgt" – das ist ein
  Nein, auch wenn es freundlich klingt. Lieber einmal zu oft "objection" als aufdringlich sein.
- "positive": interessiert, aber noch kein Termin.
- "neutral": Smalltalk/neutral.
Die "reply" folgt den Stil-Regeln oben. Bei "objection" ist die "reply" ein WÜRDIGER ABSCHLUSS:
das Nein respektieren, keine Nachfass-Frage, keine versteckte zweite Chance, Tür freundlich
offen lassen. Niemals gegen ein Nein anargumentieren.
Die "strategie" ist Sinans Handlungsempfehlung in Klartext, nicht die Wiederholung des intents.`;
  try {
    const raw = await generateAutopilot(prompt);
    const json = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
    const parsed = JSON.parse(json) as ConverseStep;
    parsed.reply = saubern(parsed.reply || "");
    parsed.zusammenfassung = (parsed.zusammenfassung || "").trim();
    parsed.strategie = (parsed.strategie || "").trim();
    if (!["meeting", "positive", "objection", "neutral"].includes(parsed.intent)) parsed.intent = "neutral";
    parsed.contact = parsed.contact && String(parsed.contact).toLowerCase() !== "null" ? String(parsed.contact) : null;
    return parsed;
  } catch {
    return null; // Parsing/KI fehlgeschlagen → Aufrufer eskaliert an den Menschen
  }
}

/** Freundliches Follow-up, wenn die Erstnachricht unbeantwortet blieb. */
export async function followupMessage(c: Contact): Promise<string> {
  const prompt = `Schreibe ein kurzes, freundliches Follow-up auf LinkedIn (2-3 Sätze).
${promptKontext()}
${personZeile(c)}
Kontext: Sinan hatte der Person schon geschrieben, aber noch keine Antwort bekommen.
KEIN Druck, kein Vorwurf, locker und sympathisch. Knüpf leicht an das Thema an (Ausbildung/
Weg nach der Ausbildung) und mach es der Person leicht zu antworten. Gib NUR die Nachricht aus,
ohne Anführungszeichen.`;
  return saubern(await generateText(prompt));
}
