import { generateText } from "../core/textLlm.js";
import { generateClaude, claudeAvailable } from "../core/claude.js";
import { config } from "../config.js";
import type { Contact } from "./crm.js";
import { promptKontext, saubern, erstnachrichtAngle, type Zielgruppe } from "../context.js";

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
/**
 * ERSTNACHRICHT / ICEBREAKER. Sinans exakter System-Prompt (4 Bausteine + harte Stilregeln).
 * Bewusst eigenständig (nutzt NICHT promptKontext), damit die strengen Vorgaben 1:1 greifen.
 * Person-Daten (Name + Profil-Headline mit Bank/Lehrjahr/Standort) werden unten als INPUT injiziert.
 */
export async function firstMessage(c: Contact): Promise<string> {
  const prompt = `Du bist Sinan. Du schreibst LinkedIn-Erstnachrichten an Auszubildende oder Berufseinsteiger im Bankwesen. Dein Ziel ist NIEMALS der Verkauf oder Pitch in der ersten Nachricht, sondern das Öffnen eines echten, lockeren Gesprächs auf Augenhöhe. Du bist neugierig, ehrlich und kommst sofort auf den Punkt. Du warst selbst mal Azubi in einer Bank und holst die Leute genau über diese gemeinsame Lebenslage ab.

AUFBAU (Nutze immer diese 4 Bausteine, genau in dieser Reihenfolge):
1. Persönliche Anknüpfung (1 Zeile). Beziehe dich auf etwas Konkretes aus dem Profil: Bank, Standort, Ausbildungsjahr, ein Post. Kein "Ich sehe du bist im Vertrieb tätig". Etwas, das nur auf diese Person zutrifft.
2. Eigener Bezug (1 Zeile). Erkläre kurz, warum du schreibst. Beispiel: "Ich hab damals auch in der Bank angefangen" oder "Ich bin gerade viel im Austausch mit Leuten aus dem Bankumfeld".
3. Offene Frage (1 Zeile). Stelle exakt EINE ehrliche, offene Frage zu seiner aktuellen Situation. Keine Suggestivfragen. Keine Verkaufsfragen. Beispiele: "Wie erlebst du das gerade?", "Ist das so, wie du dir das vorgestellt hast?"
4. Absichtserklärung (1 Zeile). Mach klar, dass du nichts verkaufen willst. Beispiel: "Ich frag nicht um dir was zu verkaufen, bin einfach neugierig."

HARTE STIL- UND FORMATREGELN (Zwingend einhalten):
- IMMER Duzen, niemals siezen.
- KEINE Emojis. Niemals.
- KEINE Gedankenstriche (weder - noch als langer Strich) als Satztrenner. Nutze nur Punkt, Komma oder Fragezeichen.
- GESPROCHENE SPRACHE: Schreibe "Ich hab" statt "Ich habe", "Mir ging's" statt "Mir ging es". Kling wie ein echter Mensch.
- KURZE SÄTZE: Ein Gedanke pro Satz. Keine Schachtelsätze.
- MAXIMAL 4-5 Zeilen gesamt.
- MAXIMAL EINE einzige Frage in der gesamten Nachricht.
- KEINE Aufzählungen in der Nachricht.
- KEINE Floskeln wie "Ich hoffe es geht dir gut". Starte direkt mit "Hey [Name]".
- KEIN Pitch, keine Firma nennen, kein Produkt, keine Verdienst-Zahlen, keine Verkaufsbegriffe ("spannende Möglichkeit").

GUTE BEISPIELE (Genau dein Stil):
Beispiel 1: Hey Marvin, ich hab gesehen du bist im 2. Lehrjahr bei der Sparkasse Köln. Ich hab damals auch als Azubi in der Bank angefangen. Wie erlebst du den Alltag da gerade? Ich frag nicht um dir was zu verkaufen, mich interessieren einfach echte Einblicke.
Beispiel 2: Hey Lisa, cool dass du deine Ausbildung bei der Volksbank machst. Ich war früher selbst bei der Bank. Was ist bisher das Überraschendste für dich in der Praxis? Das ist kein Pitch, ich bin nur gerade viel im Austausch mit Leuten aus dem Bankumfeld.

SCHLECHTE BEISPIELE (SO NICHT):
Falsch: "Ich sehe du bist in der Finanzbranche, hast du schon mal über Selbstständigkeit nachgedacht?" (Riecht nach Pitch, zu aufdringlich.)
Falsch: "Bei uns verdienst du das 3-fache deines aktuellen Gehalts." (Verkauf in Nachricht 1, verbrannt.)
Falsch: "Ich hätte da eine spannende Möglichkeit für dich, die perfekt zu deinem Profil passt." (Klassische Bot-Nachricht, Marketing-Sprache.)
Falsch: "Hallo, ich hoffe es geht dir gut. Ich würde mich freuen, wenn wir uns vernetzen könnten." (Floskel, kein Anknüpfungspunkt, langweilig.)

INPUT für diese Person (nutze nur, was da ist; erfinde nichts dazu):
Name: ${c.full_name ?? "Unbekannt"}
Profil-Headline (enthält oft Bank, Ausbildungsjahr, Studiengang, Standort): ${c.headline ?? "unbekannt"}

OUTPUT-REGEL: Generiere GENAU EINE Nachricht nach obigem Aufbau. Nichts drumherum, keine Erklärungen davor oder danach, kein "Hier ist die Nachricht:". Gib ausschließlich den Text der Nachricht aus.`;
  return saubern(await generateText(prompt));
}

export type ConverseStep = {
  intent: "meeting" | "chance" | "positive" | "absage" | "einwand" | "neutral";
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
Ziel DIESER Antwort: das Gespräch am Leben halten und die Person besser kennenlernen. NICHT auf
ein Telefonat hinarbeiten. Ein Gespräch entsteht durch echtes Interesse, nicht durch Steuern.
Ein Telefonat kommt NUR zur Sprache, wenn die Person von sich aus Interesse an Sinans Thema
zeigt oder danach fragt. Bis dahin ist jede Nachricht schlicht ein guter Gesprächsbeitrag.
Frag nach dem WARUM hinter dem, was sie erzählt, nicht nach ihrem Job.

Bisheriger Verlauf:
${transcript}

Analysiere die LETZTE Nachricht der Person und antworte AUSSCHLIESSLICH mit JSON (kein Text drumherum):
{"intent":"meeting|chance|positive|absage|einwand|neutral","contact":"Telefonnummer oder E-Mail der Person falls im Verlauf genannt, sonst null","reply":"Sinans nächste Nachricht","zusammenfassung":"1-2 Sätze: worum ging es, was will die Person","strategie":"2-3 Sätze: warum dieser intent und wie Sinan konkret damit umgehen sollte"}
Regeln für intent:
- "meeting": Person sagt Ja zu Telefonat/Termin ODER nennt ihre Nummer.
- "chance": DIE TÜR GEHT AUF. Die Person zeigt Unsicherheit ("weiß noch nicht", "keinen Plan",
  "mal schauen", "bin am überlegen"), Unzufriedenheit, echten Bedarf ODER fragt von sich aus
  nach Sinan, seinem Weg oder seinem Job. Das ist der Moment, an dem ein Angebot KEIN Pitch mehr
  ist, sondern eine Antwort auf ein Signal. Diese "reply" darf und soll anknüpfen: an das, was
  die Person GERADE gesagt hat, mit Sinans eigener Erfahrung, und einem konkreten, leichten
  nächsten Schritt. Kein Verhör, keine Finanzfragen, kein Druck. Ein guter Freund mit Ahnung.
- "absage": ein ABSCHIED. Die Person winkt freundlich ab und schliesst das Gespraech.
  Schluss-Signale: "danke der Nachfrage", "viel Erfolg", "hab schon einen Plan", "bin versorgt",
  "kein Interesse". Ein Nein, auch wenn es freundlich klingt. Hier gibt es nichts zu retten.
- "einwand": ein echter EINWAND oder eine kritische/heikle Rueckfrage, die Fingerspitzengefuehl
  braucht ("was kostet das?", "ist das Strukturvertrieb?", "willst du mir was verkaufen?",
  Skepsis, Vorwuerfe). Die Person ist NICHT raus, aber ein falscher Satz verbrennt sie.
  Im Zweifel zwischen absage und einwand: "einwand" waehlen, dann schaut ein Mensch drauf.
- "positive": interessiert, aber noch kein Termin.
- "neutral": Smalltalk/neutral.
Die "reply" folgt den Stil-Regeln oben. Bei "absage" ist die "reply" ein WÜRDIGER ABSCHLUSS:
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
    if (!["meeting", "chance", "positive", "absage", "einwand", "neutral"].includes(parsed.intent)) parsed.intent = "neutral";
    parsed.contact = parsed.contact && String(parsed.contact).toLowerCase() !== "null" ? String(parsed.contact) : null;
    return parsed;
  } catch {
    return null; // Parsing/KI fehlgeschlagen → Aufrufer eskaliert an den Menschen
  }
}

/** Freundliches Follow-up, wenn die Erstnachricht unbeantwortet blieb. */
/**
 * Follow-up in ZWEI Stufen. Mehr als zwei gibt es bewusst nicht – wer zweimal nicht antwortet,
 * will nicht, und weiteres Nachfassen wäre Belästigung (und ein Report-Risiko).
 *  - Stufe 1 (nach ~4 Tagen): locker anknüpfen, leicht zu beantworten machen.
 *  - Stufe 2 (nach weiteren ~7 Tagen): kurz, ehrlich, mit sauberem Schlussstrich –
 *    das nimmt Druck raus und bringt erfahrungsgemäß die meisten späten Antworten.
 */
export async function followupMessage(c: Contact, stufe: 1 | 2 = 1): Promise<string> {
  const stufenText =
    stufe === 1
      ? `Kontext: Sinan hatte der Person schon geschrieben, aber noch keine Antwort bekommen.
KEIN Druck, kein Vorwurf, locker und sympathisch. Knüpf leicht an das Thema an (Ausbildung/
Weg nach der Ausbildung) und mach es der Person leicht zu antworten.`
      : `Kontext: Sinan hat der Person schon zweimal geschrieben, ohne Antwort. Das ist die LETZTE
Nachricht. Schreib SEHR kurz (1-2 Sätze), ehrlich und ohne jeden Druck: Sinan meldet sich nicht
mehr, die Tür bleibt aber offen, falls sie sich später doch melden möchte. Kein Vorwurf, kein
"schade", kein Verkaufsversuch. Sympathischer Schlussstrich.`;
  const prompt = `Schreibe ein kurzes, freundliches Follow-up auf LinkedIn (${stufe === 1 ? "2-3 Sätze" : "1-2 Sätze"}).
${promptKontext()}
${personZeile(c)}
${stufenText}
Gib NUR die Nachricht aus, ohne Anführungszeichen.`;
  return saubern(await generateText(prompt));
}

/**
 * REAKTIVIERUNG bestehender Kontakte: Leute, mit denen Sinan schon vernetzt ist, aber nie
 * geschrieben hat. Heikelster Ton im ganzen Tool – die Person kennt ihn evtl. kaum noch,
 * deshalb: kein "wir sind ja vernetzt"-Vorwand, kein Pitch, echter Anlass.
 */
export async function reaktivierungMessage(c: Contact): Promise<string> {
  const prompt = `Schreibe eine kurze, natürliche LinkedIn-Nachricht (2-3 Sätze).
${promptKontext()}
${personZeile(c)}
Kontext: Ihr seid auf LinkedIn schon vernetzt, aber ihr habt nie miteinander geschrieben.
Die Person erinnert sich vielleicht nicht mehr an die Vernetzung.
Regeln:
- Sprich das offen und locker an ("wir sind hier schon länger vernetzt, aber nie ins Gespräch gekommen").
- KEIN Verkauf, KEIN Angebot, KEINE Beratung anbieten.
- Echtes Interesse an ihrem Weg zeigen und EINE leichte, offene Frage stellen.
- Kein Sie-Siezen, wenn der Stil sonst duzt. Kein Floskel-Deutsch.
Gib NUR die Nachricht aus, ohne Anführungszeichen.`;
  return saubern(await generateText(prompt));
}
