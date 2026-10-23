/**
 * AGENT-RUNNER – die Laufzeit-Verdrahtung (das „Umschalten"). Hängt den neuen Sales-Agent an
 * die echte Inbox und den echten Versand. STRENG gated:
 *  - config.agent.enabled === false  → tut GAR NICHTS (laufender Bot unverändert).
 *  - config.agent.shadowMode === true → denkt mit, legt seine Antwort nur als ENTWURF ab (sendet
 *    NICHT). So sieht Sinan, was der Agent tun WÜRDE, bevor er Verantwortung übernimmt.
 *  - shadowMode === false → sendet governor-gedrosselt (über sendThreadReply → tippenUndSenden,
 *    also inkl. der bestehenden Sicherheits-Sende-Prüfung). Die Antwort wurde vorher schon vom
 *    Response Validator geprüft – doppelter Schutz.
 */
import { config } from "../../config.js";
import { fetchThreads } from "../../modules/inbox.js";
import { sendThreadReply } from "../../modules/outreach.js";
import { queueReplyDraft } from "../../modules/drafts.js";
import { markInboundReply } from "../../modules/crm.js";
import { recordCrmStage } from "../../modules/crmStages.js";
import { db, getAgentMode } from "../../db/index.js";
import { events } from "../../core/events.js";
import { gespraechsKontext, aecAktiv } from "../../modules/ausrichtung.js";
import { GovernorBlocked } from "../../core/safetyGovernor.js";
import { analyzeLlm, replyLlm } from "./llmKanaele.js";
import { SqliteConversationRepository } from "../infra/sqliteConversationRepository.js";
import { handleIncomingMessage } from "../application/handleIncomingMessage.js";
import { neueConversation } from "../domain/conversation.js";
import { angebotsWahl } from "../../modules/angebot.js";
import { istStumm, stummschalten } from "../../modules/stumm.js";
import { agentVertrauen, darfAutonom } from "../../modules/agentVertrauen.js";
import { antwortRisiko } from "../domain/policy/risiko.js";

// KI-Kanäle (Analyse + Antwort) liegen in llmKanaele.ts – der Trainings-Simulator nutzt dieselben.

/** Stabiler Kurz-Fingerabdruck (djb2) der eingegangenen Nachricht – Basis der Idempotenz-Sperre. */
function fingerprint(text: string): string {
  const s = (text || "").replace(/\s+/g, " ").trim().toLowerCase();
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `${h}:${s.length}`;
}

export async function agentTick(max = 25): Promise<{ verarbeitet: number; gesendet: number; entwuerfe: number; eskaliert: number; geschwiegen: number }> {
  const res = { verarbeitet: 0, gesendet: 0, entwuerfe: 0, eskaliert: 0, geschwiegen: 0 };
  const mode = getAgentMode();
  if (mode === "off") return res;
  const schatten = mode === "shadow";
  // VORSICHTIG (2026-10-07): einmal je Tick messen, was Sinans bisherige Freigaben hergeben.
  const vorsichtig = mode === "vorsichtig";
  const vertrauen = vorsichtig ? agentVertrauen() : null;

  const repo = new SqliteConversationRepository(db);
  // ALTLASTEN AUS DEM SCHATTEN (2026-10-08): frühere Versionen merkten Schatten-Antworten als
  // „senden/unsent“. Solange der Schatten läuft, werden sie zu „entwurf“ – damit beim Umschalten
  // auf vorsichtig/automatisch nichts Ungeprüftes nachgesendet wird.
  if (schatten) repo.schattenEntscheidungenEntschaerfen();
  // Ausrichtung (Standard/AEC) wird je Tick gelesen → der Schalter wirkt ab dem nächsten Tick,
  // auch für laufende Gespräche, ohne Engine-Neustart.
  const persona = gespraechsKontext();
  const angebot = angebotsWahl(new Date(), undefined, { nurAec: aecAktiv() });
  const threads = await fetchThreads(max);

  for (const t of threads) {
    if (!t.theirTurn) continue; // nur reagieren, wenn die Person am Zug ist (aus der Vorschau, zuverlässig)

    // Person ist am Zug = sie hat geantwortet → im CRM als 'replied' markieren (Hot Lead). WICHTIG:
    // Sonst bleibt sie 'messaged' und bekäme fälschlich ein Follow-up/Reminder, obwohl SINAN am Zug
    // ist (der Grund, warum trotz Antwort Reminder rausgingen, wenn der Agent aktiv war).
    const crmContactId = t.participant ? markInboundReply(t.threadUrl, t.participant) : null;
    if (crmContactId) recordCrmStage(crmContactId, "replied", "agent");

    // STUMM (2026-10-07): Chat oder Kontakt wurde vom Menschen oder vom Agenten selbst auf Funkstille
    // gesetzt → kein KI-Aufruf, keine Antwort, keine Eskalation. Steht VOR dem Laden des Gesprächs.
    if (istStumm(t.threadUrl, crmContactId)) continue;

    let conv = (await repo.load(t.threadUrl)) ?? neueConversation(t.threadUrl, t.participant);
    if (conv.status !== "aktiv") continue;

    // ---- IDEMPOTENZ: pro EINGEGANGENER Nachricht wird die KI genau EINMAL bemüht ----
    const eingang = t.lastIncoming || t.messages[t.messages.length - 1]?.text || "";
    const hash = fingerprint(eingang);
    const stand = repo.verarbeitungsStand(t.threadUrl);
    if (stand && stand.incomingHash === hash) {
      // Diese Nachricht wurde schon durch die KI verarbeitet.
      // Nur EIN Sonderfall darf noch etwas tun: Antwort war fertig, Versand aber (noch) nicht raus
      // (z.B. Governor-Fenster/Limit). Dann NUR erneut SENDEN – ohne neuen, teuren KI-Aufruf.
      if (!schatten && stand.decision === "senden" && !stand.sent && stand.replyText) {
        // VORSICHTIG (2026-10-08): auch das NACHSENDEN unterliegt der Risiko-Stufe. Die gespeicherte
        // Entscheidung kann aus „automatisch“ stammen, bevor auf „vorsichtig“ zurückgeschaltet wurde.
        // Die Intents der alten Analyse liegen nicht mehr vor – die Phase allein reicht als
        // Untergrenze (Intents heben das Risiko nur an). Zu riskant → Entwurf statt Versand.
        if (vorsichtig && vertrauen && !darfAutonom(antwortRisiko(conv.stage, []), vertrauen)) {
          repo.merkeVerarbeitung(t.threadUrl, hash, "entwurf", stand.replyText);
          queueReplyDraft(t.threadUrl, t.participant, t.lastIncoming, stand.replyText, "agent-vorsichtig");
          console.info(`[agent-vorsichtig] ${t.participant}: offene Antwort wird Entwurf statt nachgesendet (Phase ${conv.stage}, Stufe ${vertrauen.stufe})`);
          res.entwuerfe++;
          continue;
        }
        try {
          await sendThreadReply(t.threadUrl, stand.replyText, t.participant);
          repo.markiereGesendet(t.threadUrl);
          repo.saveMessage(t.threadUrl, "Sinan", stand.replyText);
          res.gesendet++;
          events.emit("agent:gesendet", { participant: t.participant, text: stand.replyText, threadUrl: t.threadUrl, stage: conv.stage });
        } catch (err) {
          if (err instanceof GovernorBlocked) { /* noch nicht dran – später erneut, kein KI-Aufruf */ }
          else { // echter Sendefehler: als Entwurf ablegen, sperren, damit es NICHT in der Schleife hängt
            repo.protokolliereSendefehler(t.threadUrl, t.participant, (err as Error)?.message ?? "unbekannt");
            queueReplyDraft(t.threadUrl, t.participant, t.lastIncoming, stand.replyText, "agent-sendefehler");
            repo.markiereGesendet(t.threadUrl);
            res.entwuerfe++;
          }
        }
      }
      continue; // in JEDEM Fall: kein neuer KI-Aufruf für dieselbe Nachricht
    }

    // ---- NEUE Nachricht → einmal durch die Pipeline (kostet KI) ----
    let e;
    try {
      e = await handleIncomingMessage(conv, t.messages, { persona, angebot, analyzeLlm, replyLlm, maxRegenerierungen: 1 });
    } catch (err) {
      // Pipeline-Fehler (KI weg, Guthaben leer, Netz) nicht in einer Endlosschleife wiederholen:
      // abhaken, aber NICHT still (Fix 2026-10-08). Vorher wurde „nichts“ vermerkt – die Person
      // bekam nie eine Antwort, niemand erfuhr davon. Jetzt: Eskalation an den Menschen mit Grund.
      const grund = (err as Error)?.message?.slice(0, 120) ?? "unbekannt";
      console.error("[agent] Pipeline-Fehler → Eskalation:", grund);
      repo.merkeVerarbeitung(t.threadUrl, hash, "eskalieren", null);
      if (!schatten) {
        queueReplyDraft(t.threadUrl, t.participant, t.lastIncoming, "", "agent-eskalation");
        events.emit("agent:eskaliert", { participant: t.participant, grund: `KI-Fehler: ${grund}`, threadUrl: t.threadUrl });
        res.eskaliert++;
      }
      continue;
    }
    await repo.save(e.conversation);
    // SOFORT abhaken (mit erzeugtem Text) – ab jetzt wird diese Nachricht nie wieder neu generiert.
    // SCHATTEN (Fix 2026-10-08): dort NIE als „senden“ merken. Sonst sendete der Nachsende-Pfad oben
    // beim Umschalten auf vorsichtig/automatisch alle alten Schatten-Antworten ungeprüft los.
    const entscheidung = schatten && e.typ === "senden" ? "entwurf" : e.typ;
    repo.merkeVerarbeitung(t.threadUrl, hash, entscheidung, e.typ === "senden" ? e.text : e.typ === "eskalieren" ? (e.entwurf ?? null) : null);
    res.verarbeitet++;

    // ---- SCHWEIGEN: bewusst keine Antwort (fremdes Angebot, Automat, Kontakt-Stopp, Gesprächsende) ----
    if (e.typ === "schweigen") {
      if (e.art === "dauerhaft" && !schatten) {
        stummschalten({ threadUrl: t.threadUrl, contactId: crmContactId, participant: t.participant, grund: e.grund, quelle: "agent" });
      }
      console.info(`[agent${schatten ? "-schatten" : ""}] schweigt ${e.art} (${t.participant}): ${e.grund}`);
      events.emit("agent:schweigen", { participant: t.participant, grund: e.grund, art: e.art, quelle: e.quelle, threadUrl: t.threadUrl, schatten });
      res.geschwiegen++;
      continue;
    }

    // ---- SCHATTEN-MODUS: nur zeigen, was der Agent tun würde ----
    if (schatten) {
      if (e.typ !== "nichts") {
        const vorschau = e.typ === "senden" ? e.text : `[Agent würde eskalieren: ${e.grund}] ${e.entwurf ?? ""}`.trim();
        queueReplyDraft(t.threadUrl, t.participant, t.lastIncoming, vorschau, "agent-schatten");
        res.entwuerfe++;
      }
      console.info(`[agent-schatten] ${t.participant}: ${e.typ} → "${(e.typ === "senden" ? e.text : e.grund).slice(0, 70)}"`);
      continue;
    }

    // ---- VORSICHTIG: nur risikoarme Antworten selbst senden, der Rest wird Entwurf ----
    if (e.typ === "senden" && vorsichtig && vertrauen && !darfAutonom(antwortRisiko(e.conversation.stage, e.intents), vertrauen)) {
      // Entscheidung umschreiben: NICHT „senden/unsent“, sonst würde der nächste Tick den Text
      // automatisch nachsenden. Der Entwurf geht den normalen Freigabeweg (sendApprovedDrafts).
      repo.merkeVerarbeitung(t.threadUrl, hash, "entwurf", e.text);
      queueReplyDraft(t.threadUrl, t.participant, t.lastIncoming, e.text, "agent-vorsichtig");
      console.info(`[agent-vorsichtig] ${t.participant}: Entwurf statt Versand (Risiko ${antwortRisiko(e.conversation.stage, e.intents)}, Stufe ${vertrauen.stufe})`);
      res.entwuerfe++;
      continue;
    }

    // ---- LIVE-MODUS ----
    if (e.typ === "senden") {
      try {
        await sendThreadReply(t.threadUrl, e.text, t.participant); // governor-gated + Sicherheits-Sende-Prüfung
        repo.markiereGesendet(t.threadUrl);
        repo.saveMessage(t.threadUrl, "Sinan", e.text, e.intents);
        res.gesendet++;
        events.emit("agent:gesendet", { participant: t.participant, text: e.text, threadUrl: t.threadUrl, stage: e.conversation.stage });
        if (e.conversation.status === "verloren") {
          if (crmContactId) recordCrmStage(crmContactId, "lost", "agent");
          repo.recordOutcome({ threadUrl: t.threadUrl, teilnehmer: t.participant, ergebnis: "verloren", letzterState: e.conversation.stage, nachrichten: t.messages.length, trust: e.conversation.scores.trust, interest: e.conversation.scores.interest });
        }
      } catch (err) {
        // GovernorBlocked = vorübergehend (Arbeitszeit/Limit): NICHT gesendet-markieren → nächster
        // Tick versucht NUR den Versand erneut (kein neuer KI-Aufruf, siehe oben). Echter Fehler:
        // Text als Entwurf ablegen + abhaken, damit es nicht in der Schleife hängt.
        if (err instanceof GovernorBlocked) {
          console.info(`[agent] Versand vertagt (${t.participant}): ${(err as Error).message.slice(0, 60)}`);
        } else {
          console.error("[agent] Sendefehler → Entwurf:", (err as Error)?.message?.slice(0, 90));
          repo.protokolliereSendefehler(t.threadUrl, t.participant, (err as Error)?.message ?? "unbekannt");
          queueReplyDraft(t.threadUrl, t.participant, t.lastIncoming, e.text, "agent-sendefehler");
          repo.markiereGesendet(t.threadUrl); // abgehakt (als Entwurf gerettet)
          res.entwuerfe++;
        }
      }
    } else if (e.typ === "eskalieren") {
      if (e.conversation.status === "gebucht") {
        if (crmContactId) {
          recordCrmStage(crmContactId, "qualified", "agent");
          recordCrmStage(crmContactId, "meeting", "agent");
        }
        events.emit("lead:booked", { participant: t.participant, contact: e.kontakt, threadUrl: t.threadUrl });
        repo.recordOutcome({ threadUrl: t.threadUrl, teilnehmer: t.participant, ergebnis: "gebucht", letzterState: e.conversation.stage, nachrichten: t.messages.length, trust: e.conversation.scores.trust, interest: e.conversation.scores.interest });
      } else {
        queueReplyDraft(t.threadUrl, t.participant, t.lastIncoming, e.entwurf ?? "", "agent-eskalation");
        events.emit("agent:eskaliert", { participant: t.participant, grund: e.grund, threadUrl: t.threadUrl });
      }
      res.eskaliert++;
    }
  }

  if (res.verarbeitet) console.info(`[agent] ${res.verarbeitet} Threads · ${res.gesendet} gesendet · ${res.entwuerfe} Entwürfe · ${res.eskaliert} eskaliert · ${res.geschwiegen} bewusst unbeantwortet${schatten ? " (Schatten)" : ""}`);
  return res;
}
