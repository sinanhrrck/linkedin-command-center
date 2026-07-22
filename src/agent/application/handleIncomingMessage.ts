/**
 * ORCHESTRATOR – die Pipeline pro eingehender Nachricht. Verdrahtet Phase 1–3 zum Agenten.
 *
 * Ablauf: Analyse (Call 1) → Profil/Memory/Scores → State-Übergang → Trigger → Antwort (Call 2)
 * → Humanizer → Validator (mit Regenerier-Schleife) → Entscheidung. SENDET NICHT selbst – das
 * macht später der Adapter (outreach). Reine Orchestrierung, KI + Persona per DI → testbar.
 */
import { analyze, type Nachricht, type LlmFn } from "../llm/analyzer.js";
import { generateReply } from "../llm/replyGenerator.js";
import { deriveTriggers, triggerHinweise } from "../domain/policy/triggerEngine.js";
import { updateProfile } from "../domain/profile.js";
import { updateMemory } from "../domain/memory.js";
import { computeScores } from "../domain/scores.js";
import { nextStage } from "../domain/state.js";
import { validiereAntwort } from "../domain/validation/responseValidator.js";
import { humanize } from "../domain/validation/humanizer.js";
import type { Conversation, ConvStatus } from "../domain/conversation.js";
import type { IntentSet } from "../domain/intent.js";

export interface AgentDeps {
  analyzeLlm: LlmFn;               // günstiger Kanal (Gemini)
  replyLlm: LlmFn;                 // starker Kanal (Claude)
  persona: string;                 // promptKontext()
  maxRegenerierungen?: number;     // Default 2
}

export type Entscheidung =
  | { typ: "senden"; text: string; intents: IntentSet; conversation: Conversation }
  | { typ: "eskalieren"; grund: string; entwurf: string | null; kontakt?: string | null; conversation: Conversation }
  | { typ: "nichts"; grund: string; conversation: Conversation };

export async function handleIncomingMessage(conv: Conversation, verlauf: Nachricht[], deps: AgentDeps): Promise<Entscheidung> {
  if (conv.status !== "aktiv") return { typ: "nichts", grund: `Status ${conv.status}`, conversation: conv };

  // Zähler aus dem Verlauf ableiten (eine Wahrheitsquelle).
  const eigene = verlauf.filter((m) => m.sender !== conv.teilnehmer).map((m) => m.text);
  const antworten = verlauf.filter((m) => m.sender === conv.teilnehmer).length;
  const gesamt = verlauf.length;
  const letzteNachricht = verlauf[verlauf.length - 1]?.text ?? "";

  // 1) Analyse (Call 1). Fällt sie aus → an den Menschen.
  const analyse = await analyze(verlauf, conv.teilnehmer, deps.analyzeLlm);
  const analyseLeer = analyse.intents.length === 0 && Object.keys(analyse.signale).length === 0 && !analyse.zusammenfassung && !analyse.kontakt;
  if (analyseLeer) return { typ: "eskalieren", grund: "Analyse fehlgeschlagen (KI)", entwurf: null, conversation: conv };

  // 2) Profil / Memory / Scores fortschreiben.
  const profile = updateProfile(conv.profile, analyse.signale);
  const memory = updateMemory(conv.memory, analyse.fakten, analyse.zusammenfassung);
  const scores = computeScores(profile, { nachrichtenGesamt: gesamt, antwortenDerPerson: antworten, letzteAntwortVorH: 0, offeneNachfragen: 0 });

  // 3) Nächster State.
  const stage = nextStage(conv.stage, analyse.intents, scores);
  const basis: Conversation = { ...conv, profile, memory, scores, stage };

  // 4) ÜBERGABE-MOMENT: Kontakt genannt oder Termin-Zusage → an den Menschen (nie auto-abschließen).
  if (analyse.kontakt || analyse.intents.includes("termin_zusage")) {
    return { typ: "eskalieren", grund: "Termin/Kontakt – Übergabe an dich", entwurf: null, kontakt: analyse.kontakt, conversation: { ...basis, status: "gebucht" } };
  }

  // 5) Antwort erzeugen + Schutzschleife: Humanizer → Validator → bei Verstoß regenerieren.
  const triggers = deriveTriggers(profile, analyse.intents, scores);
  const hinweise = triggerHinweise(triggers);
  const vctx = { stage, letzteEigene: eigene };
  const maxTry = deps.maxRegenerierungen ?? 2;
  let text = "", gruende: string[] = [];
  for (let versuch = 0; versuch <= maxTry; versuch++) {
    const roh = await generateReply({
      persona: deps.persona, stage, profile, memory, letzteNachricht, teilnehmer: conv.teilnehmer,
      triggerHinweise: versuch === 0 ? hinweise : [...hinweise, `Deine letzte Antwort war unpassend (${gruende.join("; ")}). Schreib sie besser, kurz und menschlich.`],
    }, deps.replyLlm);
    text = humanize(roh);
    const v = validiereAntwort(text, vctx);
    if (v.ok) { gruende = []; break; }
    gruende = v.gruende;
  }
  // Nach allen Versuchen immer noch regelwidrig → lieber Mensch als Peinlichkeit.
  if (gruende.length) return { typ: "eskalieren", grund: `Antwort nicht regelkonform: ${gruende.join("; ")}`, entwurf: text, conversation: basis };

  const status: ConvStatus = stage === "verloren" ? "verloren" : basis.status;
  return { typ: "senden", text, intents: analyse.intents, conversation: { ...basis, status } };
}
