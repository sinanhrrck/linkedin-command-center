/**
 * KERN FÜR DIE TRAININGS-WEBSITE (2026-10-23, Sinan: „er soll 1:1 so klingen“).
 *
 * Wird mit esbuild zu training-web/api/_kern.mjs gebündelt (`npm run trainingsseite`). Enthält NUR
 * Code, der ohne DB, Profil-Datei, Browser oder Netz auskommt – genau die Funktionen, mit denen der
 * echte Bot schreibt:
 *  - Antworten: `handleIncomingMessage` (Analyse → Phase → Antwort → Humanizer → Validator →
 *    Übergabe/Schweigen), aufgerufen wie in agentRunner.ts.
 *  - Erstnachricht: `erstnachrichtPrompt` + Ausbildungs- und Ausgangsprüfung, Ablauf wie
 *    drafts.createFirstMessageDraft.
 * Die Daten (Profil-Kontext, Angebot, Vertriebswissen, Zielgruppen-Aufbau, Stil-Varianten,
 * freigegebene Regeln) kommen aus einer Momentaufnahme (`TrainingsSnapshot`), die der echte Bot
 * mit seinen Live-Daten erzeugt. Keine zweite Prompt-Fassung – sonst klingt die Website anders.
 */
import { handleIncomingMessage, type Entscheidung } from "../agent/application/handleIncomingMessage.js";
import { neueConversation, type Conversation } from "../agent/domain/conversation.js";
import type { Nachricht, LlmFn } from "../agent/llm/analyzer.js";
import { erstnachrichtPrompt, mitAusbildungsCheckPur, mitAusgangsCheckPur, type Wahl } from "../modules/erstnachrichtPrompt.js";
import { pruefeAusgehend } from "../core/ausgehendCheck.js";
import { istPlausibleNachricht } from "../core/nachrichtCheck.js";
import { ctaText } from "../core/terminVorschlag.js";

export { neueConversation };
export type { Conversation, Entscheidung, Nachricht };

export const CTA_PLATZHALTER = "§CTA§";

export type TrainingsSnapshot = {
  version: 2;
  erzeugt: string;
  /** "server" = aus den Live-Daten des Heimservers, "lokal" = Entwicklungsstand (nicht 1:1). */
  quelle: "server" | "lokal";
  /** config.llm.model des echten Bots. */
  modell: string;
  gespraech: {
    /** gespraechsKontext() je Ausrichtung (Profil + AEC-Block + freigegebene Trainings-Regeln). */
    persona: { standard: string; aec: string };
    /** angebotsWahl() je Ausrichtung, die Termin-Zeile als CTA_PLATZHALTER (wird zur Laufzeit frisch berechnet). */
    angebot: { standard: string; aec: string };
    buchungslink: string;
    /** vertriebswissen("gespraech") – gecachter System-Block wie live. Leer = keine Datei. */
    wissen: string;
  };
  erstnachricht: {
    gruppe: string | null;
    aufbau: string;
    /** true = Zielgruppe hat eine eigene Anleitung → live ohne Stil-Test (keine Variante). */
    eigeneAnleitung: boolean;
    varianten: Wahl[];
    learning: string;
    regeln: string;
    erlaubteLinks: string[];
  };
};

const zufall = <T>(l: T[], rng: () => number) => l[Math.floor(rng() * l.length)];

/**
 * Erstnachricht wie drafts.createFirstMessageDraft: Variante wählen, Prompt bauen, Ausbildungs-
 * prüfung, Ausgangsprüfung mit einem Neuversuch, Plausibilitätsprüfung. `text: ""` = live wäre
 * KEIN Entwurf entstanden (Grund in `grund`).
 * Abweichung: live wählt die Variante per Thompson Sampling aus den Versandzahlen, hier zufällig.
 */
export async function erstnachrichtWieLive(
  snap: TrainingsSnapshot,
  lead: { name: string; headline: string },
  gen: (prompt: string) => Promise<string>,
  rng: () => number = Math.random,
): Promise<{ text: string; grund?: string }> {
  const e = snap.erstnachricht;
  const wahl = e.eigeneAnleitung || !e.varianten.length ? null : zufall(e.varianten, rng);
  const r = await mitAusgangsCheckPur(
    (korrektur) => mitAusbildungsCheckPur(
      erstnachrichtPrompt({
        gruppe: e.gruppe, aufbau: e.aufbau, name: lead.name, headline: lead.headline, fakten: "", stand: lead.headline,
        goal: null, learning: e.learning, regeln: e.regeln, variante: wahl, korrektur,
      }),
      lead.headline, lead.name, gen,
    ).catch(() => ""),
    (text) => pruefeAusgehend(text, { erlaubteLinks: e.erlaubteLinks, kind: "first", vorname: lead.name }),
  );
  if (!r.text) return { text: "", grund: r.gruende.join("; ") };
  const chk = istPlausibleNachricht(r.text);
  return chk.ok ? { text: r.text } : { text: "", grund: chk.grund };
}

/** Antwort wie agentRunner.agentTick: dieselbe Pipeline, dieselben Bausteine, ein Neuversuch. */
export function antwortWieLive(
  snap: TrainingsSnapshot,
  ausrichtung: "standard" | "aec",
  conv: Conversation,
  verlauf: Nachricht[],
  llm: LlmFn,
  now: Date = new Date(),
): Promise<Entscheidung> {
  const angebot = snap.gespraech.angebot[ausrichtung].replace(CTA_PLATZHALTER, ctaText(now, snap.gespraech.buchungslink));
  return handleIncomingMessage({ ...conv, status: "aktiv" }, verlauf, {
    persona: snap.gespraech.persona[ausrichtung], angebot, analyzeLlm: llm, replyLlm: llm, maxRegenerierungen: 1,
  });
}
