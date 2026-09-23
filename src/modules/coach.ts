import { db } from "../db/index.js";
import { generateText } from "../core/textLlm.js";
import { promptKontext, saubern } from "../context.js";
import { pruefeAusgehend } from "../core/ausgehendCheck.js";
import { erlaubteLinks, angebotsHinweis } from "./angebot.js";
import { faktenBlock } from "./profilFakten.js";
import { ausbildungsVorgabe } from "../core/ausbildungsStand.js";
import { followupPlan, zweckFuer, ZWECK_ANWEISUNG } from "./playbook.js";

/**
 * KI-COACH IM PRÜFER (2026-09-23): zu einem offenen Entwurf ein kurzes Urteil wie von einem
 * erfahrenen Vertriebscoach – was stark ist, was er ändern würde – plus ein verbesserter Text.
 *
 * Bewusst NUR ein Vorschlag: Übernehmen landet im Textfeld, genehmigen bleibt beim Menschen.
 * Der Vorschlag durchläuft dieselbe Ausgangsprüfung wie jeder Entwurf; das Ergebnis wird
 * mitgeliefert, statt einen schlechten Vorschlag still zu verschweigen.
 */

export type CoachUrteil = {
  staerke: string;
  aendern: string;
  vorschlag: string;
  pruefung: { ok: boolean; gruende: string[] } | null;
};

const ART: Record<string, string> = {
  first: "Erstnachricht nach angenommener Vernetzung", followup: "Nachfassung ohne bisherige Antwort",
  reaktivierung: "erste Nachricht an eine bestehende, stille Verbindung", message: "Antwort in einem laufenden Gespräch",
};

export async function kiCoach(draftId: number): Promise<CoachUrteil> {
  const d = db.prepare("SELECT * FROM drafts WHERE id=?").get(draftId) as
    { id: number; kind: string; draft: string; incoming: string | null; participant: string | null; contact_id: number | null; thread_url: string; sequence_stage: number | null; phase: string | null } | undefined;
  if (!d || d.phase === "approach") throw new Error("Für diesen Entwurf gibt es keinen Text zum Coachen.");
  const c = (d.contact_id
    ? db.prepare("SELECT id, full_name, headline FROM contacts WHERE id=?").get(d.contact_id)
    : db.prepare("SELECT id, full_name, headline FROM contacts WHERE profile_url=?").get(d.thread_url)) as { id: number; full_name: string | null; headline: string | null } | undefined;

  const plan = followupPlan();
  const zweck = d.kind === "followup" ? zweckFuer(d.sequence_stage ?? 1, plan) : null;
  const kontext = [
    `ART: ${ART[d.kind] || d.kind}${zweck ? ` (Stufe ${d.sequence_stage ?? 1}, ${ZWECK_ANWEISUNG[zweck].split("\n")[0]})` : ""}`,
    `EMPFÄNGER: ${c?.full_name ?? d.participant ?? "unbekannt"}${c?.headline ? ` – ${c.headline}` : ""}`,
    c ? faktenBlock(c.id) : "",
    c && d.kind !== "message" ? ausbildungsVorgabe(c.headline) : "",
    d.incoming && !String(d.incoming).startsWith("campaign:") ? `LETZTE NACHRICHT DER PERSON:\n${d.incoming}` : "",
    d.kind !== "message" && zweck !== "abschied" ? angebotsHinweis("karriere") : "",
  ].filter(Boolean).join("\n");

  const prompt = `Du bist ein erfahrener Vertriebscoach (Denkweise wie Alex Hormozi: Wert zuerst, klare leichte nächste Schritte, kein Druck) und prüfst eine LinkedIn-Nachricht, die gleich rausgehen soll.
${promptKontext()}

${kontext}

ENTWURF:
${d.draft}

Beurteile knapp und ehrlich:
1. "staerke": was an dem Entwurf gut ist (ein Satz).
2. "aendern": was ein Top-Verkäufer ändern würde und warum (höchstens zwei Sätze). Wenn nichts: sag das.
3. "vorschlag": der verbesserte Text, fertig zum Senden. Gleiche Absicht, gleiche Person, alle Stilregeln oben, höchstens eine Frage${zweck === "abschied" ? " (hier KEINE Frage)" : ""}, keine Emojis, keine Gedankenstriche, nichts erfinden.

Antworte AUSSCHLIESSLICH mit JSON: {"staerke":"…","aendern":"…","vorschlag":"…"}`;
  const roh = await generateText(prompt);
  const start = roh.indexOf("{"), ende = roh.lastIndexOf("}");
  if (start < 0 || ende <= start) throw new Error("Der Coach hat kein verwertbares Ergebnis geliefert. Bitte nochmal versuchen.");
  const x = JSON.parse(roh.slice(start, ende + 1)) as Record<string, unknown>;
  const vorschlag = saubern(String(x.vorschlag ?? ""));
  if (!vorschlag) throw new Error("Der Coach hat keinen Textvorschlag geliefert.");
  const pruefung = ["first", "followup", "reaktivierung"].includes(d.kind)
    ? pruefeAusgehend(vorschlag, { kind: d.kind as "first" | "followup" | "reaktivierung", vorname: c?.full_name ?? d.participant, erlaubteLinks: erlaubteLinks(), abschied: zweck === "abschied" })
    : null;
  return { staerke: String(x.staerke ?? "").trim().slice(0, 400), aendern: String(x.aendern ?? "").trim().slice(0, 600), vorschlag, pruefung };
}
