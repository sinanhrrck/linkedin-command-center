/**
 * PROMPT BUILDER – modular statt Monster-Prompt.
 *
 * Baut die zwei Prompts der Pipeline aus klar getrennten Blöcken zusammen:
 *  1) Analyse-Prompt  → liefert den AnalysisResult-Vertrag (Intents/Signale/Fakten/Zusammenfassung)
 *  2) Antwort-Prompt  → System(Persona) + aktueller State + Profil-Stil + Memory + Stilregeln + letzte Nachricht
 *
 * Reine Funktionen (kein LLM-Call, keine I/O) → voll testbar. Die Persona (promptKontext) wird
 * von außen hereingereicht, damit dieser Baustein nichts über die Infrastruktur wissen muss.
 */
import { INTENTS } from "../domain/intent.js";
import type { Stage } from "../domain/state.js";
import { STAGE_DEF } from "../domain/state.js";
import type { PsychProfile } from "../domain/profile.js";
import type { ConversationMemory } from "../domain/memory.js";
import { memoryAlsText } from "../domain/memory.js";

// ---------- Analyse-Prompt ----------

/** Weist die KI an, die LETZTE Nachricht zu analysieren und NUR strukturiertes JSON zu liefern. */
export function buildAnalysisPrompt(transcript: string, teilnehmer: string): string {
  return `Analysiere in einem LinkedIn-Verkaufschat die LETZTE Nachricht von ${teilnehmer}.
Du bewertest nur – du antwortest NICHT.

Verlauf:
${transcript}

Gib AUSSCHLIESSLICH dieses JSON zurück (kein Text drumherum):
{"intents":[ ${INTENTS.map((i) => `"${i}"`).join(", ")} ],
 "signale":{"trust":0..1|null,"skepticism":0..1|null,"moneyInterest":0..1|null,"careerInterest":0..1|null,"investmentInterest":0..1|null,"humor":0..1|null,"extroversion":0..1|null,"openness":0..1|null,"financialKnowledge":0..1|null,"responseLength":<Zeichenzahl der letzten Nachricht>,"emojiUsage":true|false},
 "fakten":{"alter":Zahl|null,"studiumOderAusbildung":Text|null,"beruf":Text|null,"ziele":Text|null,"einwaende":Text|null,"themen":Text|null},
 "kontakt":"Telefonnummer/E-Mail falls genannt, sonst null",
 "zusammenfassung":"1-2 Sätze, worum es GERADE geht und was die Person will"}

Regeln:
- "intents": alle zutreffenden (mehrere möglich), NUR aus der Liste. Nichts erfinden.
- "signale": jede Dimension NUR setzen, wenn die Nachricht sie belegt – sonst null. Nicht raten.
- Werte 0..1: 0 = gar nicht, 1 = sehr stark.`;
}

// ---------- Antwort-Prompt (modular) ----------

export interface ReplyPromptInput {
  persona: string; // promptKontext() – Standpunkt/Stil/Tabus des Nutzers
  stage: Stage;
  profile: PsychProfile;
  memory: ConversationMemory;
  letzteNachricht: string;
  teilnehmer: string;
}

/** Deterministische Stil-Hinweise aus dem Profil (nur wo es ein Signal gibt). Seed der Trigger Engine. */
export function stilHinweise(p: PsychProfile): string[] {
  const h: string[] = [];
  if (p.trust < 0.3) h.push("Vertrauen ist noch dünn – erst zuhören, nicht drängen.");
  if (p.skepticism > 0.5) h.push("Sie ist skeptisch – kein Verkaufston, ruhig und ehrlich.");
  if (p.humor > 0.5) h.push("Sie hat Humor – bleib locker.");
  if (p.responseLength > 0 && p.responseLength < 0.3) h.push("Sie schreibt knapp – halte dich sehr kurz.");
  if (p.financialKnowledge > 0.6) h.push("Sie kennt sich aus – sachlich, nicht erklärbärig.");
  if (p.openness > 0.6) h.push("Sie ist offen – du darfst etwas persönlicher werden.");
  if (p.extroversion > 0.6) h.push("Sie ist gesprächig – Raum geben, nicht zutexten.");
  return h;
}

/** Woran die Person andockt – aus den Interessens-Dimensionen. Sagt dem Bot, WORÜBER er reden soll. */
export function interessenFokus(p: PsychProfile): string[] {
  const f: string[] = [];
  if (p.moneyInterest > 0.45) f.push("finanzielle Absicherung/Geld");
  if (p.investmentInterest > 0.45) f.push("Investieren/Vermögensaufbau");
  if (p.careerInterest > 0.45) f.push("Karriere/Perspektive nach der Ausbildung");
  return f;
}

const stateBlock = (stage: Stage): string => {
  const d = STAGE_DEF[stage];
  return `# Aktuelle Gesprächsphase: ${stage}
Ziel dieser Nachricht: ${d.ziel}
Erlaubt: ${d.erlaubt.join(", ")}
NIEMALS in dieser Phase: ${d.verboten.join(", ") || "—"}
Phase abgeschlossen, wenn: ${d.exit.join(" · ")}`;
};

const STILREGELN = `# Stil (Pflicht)
- kurze, lockere LinkedIn-DM in Umgangssprache, keine langen Absätze
- höchstens EINE Frage – und nicht jede Nachricht mit einer Frage beenden
- keine Marketing-/Verkaufsbegriffe, keine Aufzählungen, keine Bindestrich-Floskeln
- gelegentlich (nicht immer) mal ein Emoji, sparsam und passend
- klingt wie ein echter Mensch, nicht wie ChatGPT`;

/** Setzt den vollständigen Antwort-Prompt aus den Blöcken zusammen. */
export function buildReplyPrompt(inp: ReplyPromptInput): string {
  const hinweise = stilHinweise(inp.profile);
  const fokus = interessenFokus(inp.profile);
  const mem = memoryAlsText(inp.memory);
  const wenigInfo = inp.profile.beobachtungen < 2;
  return `${inp.persona}

${stateBlock(inp.stage)}

# Was du über die Person weißt
${mem || "Noch wenig – finde behutsam mehr heraus."}

# Wie die Person tickt (nur beobachtet)
${hinweise.length ? hinweise.join(" ") : "Noch neutral – tastend und freundlich bleiben."}${wenigInfo ? "\n(Erst wenige Signale – nicht überinterpretieren, mehr zuhören.)" : ""}

# Woran die Person andockt
${fokus.length ? "Zeigt Interesse an: " + fokus.join(", ") + ". Knüpf hier an, aber ohne zu pitchen." : "Noch kein klares Interessens-Signal – neugierig bleiben, herausfinden was sie bewegt."}

${STILREGELN}

# Letzte Nachricht von ${inp.teilnehmer}
${inp.letzteNachricht}

Schreibe Sinans nächste Nachricht – passend zur Phase und zum Ziel oben. Gib NUR die Nachricht aus, ohne Anführungszeichen.`;
}
