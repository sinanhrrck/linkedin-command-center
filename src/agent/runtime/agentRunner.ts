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
import { db, getAgentMode } from "../../db/index.js";
import { events } from "../../core/events.js";
import { generateText } from "../../core/textLlm.js";
import { generateClaude, claudeAvailable } from "../../core/claude.js";
import { promptKontext } from "../../context.js";
import { GovernorBlocked } from "../../core/safetyGovernor.js";
import { SqliteConversationRepository } from "../infra/sqliteConversationRepository.js";
import { handleIncomingMessage } from "../application/handleIncomingMessage.js";
import { neueConversation } from "../domain/conversation.js";

/**
 * KI-Kanäle für den Agent. WICHTIG (Fix 2026-07-24): BEIDE Schritte (Analyse UND Antwort) laufen
 * über Claude, sobald ein bezahlter Key konfiguriert ist. Vorher nutzte die Analyse immer das
 * kostenlose Gemini (~20 Aufrufe/Tag, geteilt mit Erstnachrichten) → nach wenigen Gesprächen war
 * das Kontingent leer und der Agent konnte NICHTS mehr analysieren = "der Agent macht nichts".
 * Der Voll-Auto-Agent ist ohnehin der bezahlte Pfad; ohne Claude-Key fällt beides auf Gemini zurück.
 */
const claudeAn = () => config.llm.autopilotProvider === "claude" && claudeAvailable();
const analyzeLlm = (p: string) => (claudeAn() ? generateClaude(p) : generateText(p));
const replyLlm = (p: string) => (claudeAn() ? generateClaude(p) : generateText(p));

/** Stabiler Kurz-Fingerabdruck (djb2) der eingegangenen Nachricht – Basis der Idempotenz-Sperre. */
function fingerprint(text: string): string {
  const s = (text || "").replace(/\s+/g, " ").trim().toLowerCase();
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `${h}:${s.length}`;
}

export async function agentTick(max = 25): Promise<{ verarbeitet: number; gesendet: number; entwuerfe: number; eskaliert: number }> {
  const res = { verarbeitet: 0, gesendet: 0, entwuerfe: 0, eskaliert: 0 };
  const mode = getAgentMode();
  if (mode === "off") return res;
  const schatten = mode === "shadow";

  const repo = new SqliteConversationRepository(db);
  const persona = promptKontext();
  const threads = await fetchThreads(max);

  for (const t of threads) {
    if (!t.theirTurn) continue; // nur reagieren, wenn die Person am Zug ist (aus der Vorschau, zuverlässig)

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
      e = await handleIncomingMessage(conv, t.messages, { persona, analyzeLlm, replyLlm, maxRegenerierungen: 1 });
    } catch (err) {
      // Pipeline-Fehler nicht in einer Endlosschleife wiederholen: abhaken, weiter.
      console.error("[agent] Pipeline-Fehler:", (err as Error)?.message?.slice(0, 90));
      repo.merkeVerarbeitung(t.threadUrl, hash, "nichts", null);
      continue;
    }
    await repo.save(e.conversation);
    // SOFORT abhaken (mit erzeugtem Text) – ab jetzt wird diese Nachricht nie wieder neu generiert.
    repo.merkeVerarbeitung(t.threadUrl, hash, e.typ, e.typ === "senden" ? e.text : e.typ === "eskalieren" ? (e.entwurf ?? null) : null);
    res.verarbeitet++;

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

    // ---- LIVE-MODUS ----
    if (e.typ === "senden") {
      try {
        await sendThreadReply(t.threadUrl, e.text, t.participant); // governor-gated + Sicherheits-Sende-Prüfung
        repo.markiereGesendet(t.threadUrl);
        repo.saveMessage(t.threadUrl, "Sinan", e.text, e.intents);
        res.gesendet++;
        events.emit("agent:gesendet", { participant: t.participant, text: e.text, threadUrl: t.threadUrl, stage: e.conversation.stage });
        if (e.conversation.status === "verloren")
          repo.recordOutcome({ threadUrl: t.threadUrl, teilnehmer: t.participant, ergebnis: "verloren", letzterState: e.conversation.stage, nachrichten: t.messages.length, trust: e.conversation.scores.trust, interest: e.conversation.scores.interest });
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
        events.emit("lead:booked", { participant: t.participant, contact: e.kontakt, threadUrl: t.threadUrl });
        repo.recordOutcome({ threadUrl: t.threadUrl, teilnehmer: t.participant, ergebnis: "gebucht", letzterState: e.conversation.stage, nachrichten: t.messages.length, trust: e.conversation.scores.trust, interest: e.conversation.scores.interest });
      } else {
        queueReplyDraft(t.threadUrl, t.participant, t.lastIncoming, e.entwurf ?? "", "agent-eskalation");
        events.emit("agent:eskaliert", { participant: t.participant, grund: e.grund, threadUrl: t.threadUrl });
      }
      res.eskaliert++;
    }
  }

  if (res.verarbeitet) console.info(`[agent] ${res.verarbeitet} Threads · ${res.gesendet} gesendet · ${res.entwuerfe} Entwürfe · ${res.eskaliert} eskaliert${schatten ? " (Schatten)" : ""}`);
  return res;
}
