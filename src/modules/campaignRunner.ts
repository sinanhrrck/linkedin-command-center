import { db } from "../db/index.js";
import { events } from "../core/events.js";
import { getDraft } from "./drafts.js";
import { refreshCampaignTargets, campaignContext } from "./campaigns.js";
import { eventInvitation } from "./personalize.js";
import { proactiveDecision } from "./relationshipPolicy.js";
import { claimCampaignTargets, reconcileCampaignWorkflows, transitionCampaignTarget } from "./campaignWorkflow.js";
import { attachDraftContext, type DraftContextEvidence, validateProactiveContext } from "./conversationMemory.js";

type Target = {
  campaign_id: number;
  contact_id: number;
  name: string | null;
  headline: string | null;
  profile_url: string;
  contact_status: string;
  accepted_at: string | null;
  title: string;
  event_url: string;
  event_date: string | null;
  event_time: string | null;
  location: string | null;
  briefing: string | null;
  kind: string;
  audience: string | null;
  value_prop: string | null;
  goal: string | null;
  message_template: string | null;
  daily_limit: number;
};

const renderMessage = (target: Target) => {
  const firstName = (target.name || "").trim().split(/\s+/)[0] || "dir";
  const date = target.event_date ? new Date(`${target.event_date}T12:00:00`).toLocaleDateString("de-DE") : "";
  const value = String(target.value_prop || "").replace(/\s+/g, " ").trim().slice(0, 320);
  const ort = String(target.location || "").trim();
  const zeit = String(target.event_time || "").trim();
  const template = target.message_template?.trim() || (target.kind === "event"
    ? "Hey {name}, ich veranstalte am {date} „{campaign}“. Das Thema könnte gut zu dir passen. Hier findest du alle Infos: {url}"
    : "Hey {name}, ich lade gerade zu „{campaign}“ ein. Dabei geht es um {value}. Wenn das für dich interessant ist, schicke ich dir gern die Details.");
  return template
    .replaceAll("{name}", firstName)
    .replaceAll("{event}", target.title)
    .replaceAll("{campaign}", target.title)
    .replaceAll("{value}", value || target.goal || "einen persönlichen Austausch")
    .replaceAll("{goal}", target.goal || "")
    .replaceAll("{url}", target.event_url || "")
    .replaceAll("{date}", date || "demnächst")
    .replaceAll("{zeit}", zeit)
    .replaceAll("{ort}", ort)
    .replaceAll("{briefing}", String(target.briefing || "").replace(/\s+/g, " ").trim())
    // Doppelte Leerzeichen entfernen, falls ein Platzhalter leer geblieben ist.
    .replace(/[ \t]{2,}/g, " ")
    .trim();
};

/**
 * Der hinterlegte Einladungstext ist VORLAGE, kein Versandtext: die KI schreibt ihn je Person
 * neu (Sinan 2026-08-05), damit nicht hunderte Leute wortgleich dieselbe Nachricht bekommen.
 * Fällt der KI-Aufruf aus (kein Key, API-Fehler), geht die gerenderte Vorlage raus – lieber
 * eine unpersönliche Einladung zur Freigabe als gar kein Entwurf.
 */
async function inviteText(target: Target, kontext: string): Promise<string> {
  const vorlage = renderMessage(target);
  try {
    const ki = await eventInvitation({
      name: target.name, headline: target.headline, kontext, vorlage,
    });
    if (ki.trim().length >= 40) return ki.trim();
    console.warn("[kampagnen] KI-Einladung zu kurz – Vorlage verwendet.");
  } catch (e) {
    console.error("[kampagnen] KI-Einladung fehlgeschlagen, nutze Vorlage:", String((e as Error)?.message ?? e).slice(0, 120));
  }
  return vorlage;
}

function conversationContext(evidence: DraftContextEvidence | null): string {
  if (!evidence) return "";
  const facts = [
    evidence.lastStatement ? `Letzte echte Aussage des Kontakts: „${evidence.lastStatement}“` : "",
    evidence.commitment ? `Vereinbarte Wiedervorlage: ${evidence.commitment}` : "",
    evidence.openPoint ? `Offener Punkt: ${evidence.openPoint}` : "",
  ].filter(Boolean);
  if (!facts.length) return "";
  return [
    "", "Bisheriger Gesprächskontext (verbindliche Fakten):", ...facts,
    "Beziehe dich nur darauf, wenn es natürlich zur Einladung passt. Erfinde weder Interesse noch eine Zusage.",
  ].join("\n");
}

/**
 * Event-Kampagnen laufen in derselben Nachrichten-Pipeline wie der übrige Bot. Externe Kontakte
 * warten zunächst auf die Annahme; bestehende Verbindungen bekommen einen prüfbaren Entwurf.
 */
export async function campaignTick(): Promise<number> {
  const workflow = reconcileCampaignWorkflows();
  if (workflow.failed) console.info(`[kampagnen] ${workflow.failed} Ziel(e) brauchen nach zwei Versuchen eine manuelle Prüfung.`);

  // B1/P1/AEC-Aufträge nutzen die normale Erstnachrichten- und Gesprächslogik. Nur klassische
  // Kampagnen erzeugen hier zusätzliche Kampagnennachrichten; neue Ziele würden sonst doppelt
  // anschreiben. Legacy-Outreach ohne goal_code bleibt aus Kompatibilitätsgründen erhalten.
  const campaigns = db.prepare("SELECT id,daily_limit FROM campaigns WHERE active=1 AND (goal_code IS NULL OR kind='event')").all() as Array<{ id: number; daily_limit: number }>;
  let created = 0;
  for (const campaign of campaigns) {
    refreshCampaignTargets(campaign.id);
    reconcileCampaignWorkflows(campaign.id);
    /**
     * TAGESZIEL = GESENDETE NACHRICHTEN, nicht erzeugte Entwürfe (Sinans Vorgabe 2026-08-05).
     *
     * Vorher zählte hier `created_at` von heute: Wurden 12 der 20 Entwürfe abgelehnt oder
     * gelöscht, blieb der Zähler trotzdem bei 20 und der Nachschub stand still – am Ende des
     * Tages gingen 8 Nachrichten raus statt 20. Jetzt wird gezählt, was WIRKLICH gesendet
     * wurde, plus das, was noch zur Freigabe bereitliegt (das geht ja noch raus). Die Lücke
     * dazwischen wird nachproduziert, so oft der Tick läuft.
     *
     * Der Governor bleibt die Decke: Er entscheidet, wie viele davon tatsächlich rausgehen
     * (Tages-Cap für Nachrichten, Arbeitszeit, Wochenende). Diese Zahl ist ein Ziel, kein Zwang.
     */
    const key = `campaign:${campaign.id}`;
    const gesendetHeute = (db.prepare(
      `SELECT COUNT(*) n FROM drafts
        WHERE kind='event' AND incoming=? AND status='sent'
          AND date(sent_at,'localtime')=date('now','localtime')`,
    ).get(key) as { n: number }).n;
    const nochOffen = (db.prepare(
      `SELECT COUNT(*) n FROM drafts
        WHERE kind='event' AND incoming=? AND status IN ('pending','approved','sending')`,
    ).get(key) as { n: number }).n;
    const remaining = Math.max(0, campaign.daily_limit - gesendetHeute - nochOffen);
    if (!remaining) continue;
    const claimed = claimCampaignTargets(campaign.id, remaining);
    if (!claimed.length) continue;
    const claimedIds = claimed.map((row) => row.contact_id);
    const targets = db.prepare(
      `SELECT t.campaign_id,t.contact_id,c.full_name name,c.headline,c.profile_url,c.status contact_status,c.accepted_at,
              ca.name title,ca.kind,ca.audience,ca.value_prop,ca.goal,
              ca.event_url,ca.event_date,ca.event_time,ca.location,ca.briefing,ca.message_template,ca.daily_limit
        FROM campaign_targets t JOIN contacts c ON c.id=t.contact_id JOIN campaigns ca ON ca.id=t.campaign_id
        WHERE t.campaign_id=? AND t.status='generating' AND t.contact_id IN (${claimedIds.map(() => "?").join(",")})
        ORDER BY COALESCE(c.lead_score,0) DESC,t.created_at`,
    ).all(campaign.id, ...claimedIds) as Target[];
    // Einmal je Kampagne holen: die Fakten sind für alle Zielkontakte identisch.
    const kontext = targets.length ? campaignContext(campaign.id) : "";
    for (const target of targets) {
      try {
        const policy = proactiveDecision(target.contact_id, "campaign");
        if (!policy.ok) {
          const contact = db.prepare("SELECT automation_status,do_not_contact FROM contacts WHERE id=?").get(target.contact_id) as { automation_status: string | null; do_not_contact: number | null };
          transitionCampaignTarget({ campaignId: target.campaign_id, contactId: target.contact_id,
            to: contact.do_not_contact || contact.automation_status === "excluded" ? "excluded" : "snoozed",
            reason: policy.reason, source: "campaign_tick" });
          console.info(`[beziehungsschutz] ${target.name ?? target.profile_url}: Kampagne wartet – ${policy.reason}`);
          continue;
        }
        const contextCheck = validateProactiveContext(target.contact_id);
        if (!contextCheck.ok) {
          transitionCampaignTarget({ campaignId: target.campaign_id, contactId: target.contact_id,
            to: "snoozed", reason: contextCheck.reason, source: "conversation_memory", force: true });
          console.info(`[gesprächskontext] ${target.name ?? target.profile_url}: Kampagne blockiert – ${contextCheck.reason}`);
          continue;
        }
        const incoming = `campaign:${target.campaign_id}`;
        const exists = db.prepare("SELECT id,status FROM drafts WHERE contact_id=? AND kind='event' AND incoming=? AND status IN ('pending','approved','sending','sent') ORDER BY id DESC LIMIT 1")
          .get(target.contact_id, incoming) as { id: number; status: string } | undefined;
        if (exists) {
          const to = exists.status === "sent" ? "sent" : exists.status === "sending" ? "sending" : exists.status === "approved" ? "approved" : "drafted";
          transitionCampaignTarget({ campaignId: target.campaign_id, contactId: target.contact_id, to, reason: "Vorhandener Entwurf übernommen", source: "campaign_tick", draftId: exists.id, force: true });
          continue;
        }
        const message = await inviteText(target, `${kontext}${conversationContext(contextCheck.evidence)}`);
        const ersetzt = db.prepare(
          "UPDATE drafts SET status='discarded' WHERE contact_id=? AND kind='reaktivierung' AND status='pending'",
        ).run(target.contact_id).changes;
        if (ersetzt) console.info(`[kampagnen] Reaktivierungs-Entwurf für ${target.name ?? target.profile_url} durch die Event-Einladung ersetzt.`);
        const result = db.prepare(
          "INSERT INTO drafts(contact_id,kind,thread_url,participant,incoming,draft,ki_original,intent) VALUES(?,'event',?,?,?,?,?,'event')",
        ).run(target.contact_id, target.profile_url, target.name, incoming, message, message);
        const draftId = Number(result.lastInsertRowid);
        const attached = attachDraftContext(draftId, target.contact_id);
        if (!attached.ok) {
          db.prepare("UPDATE drafts SET status='blockiert',blockiert_grund=? WHERE id=?").run(attached.reason, draftId);
          transitionCampaignTarget({ campaignId: target.campaign_id, contactId: target.contact_id, to: "snoozed",
            reason: attached.reason, source: "conversation_memory", draftId, force: true });
          continue;
        }
        transitionCampaignTarget({ campaignId: target.campaign_id, contactId: target.contact_id, to: "drafted", reason: "Entwurf vorbereitet", source: "campaign_tick", draftId });
        events.emit("draft:new", getDraft(draftId));
        created++;
      } catch (error) {
        const row = db.prepare("SELECT attempt_count FROM campaign_targets WHERE campaign_id=? AND contact_id=?")
          .get(target.campaign_id, target.contact_id) as { attempt_count: number } | undefined;
        const reason = `Entwurf konnte nicht erstellt werden: ${String((error as Error)?.message ?? error).slice(0, 180)}`;
        transitionCampaignTarget({ campaignId: target.campaign_id, contactId: target.contact_id,
          to: (row?.attempt_count || 0) >= 2 ? "failed" : "queued", reason, source: "campaign_tick" });
        console.error(`[kampagnen] ${target.name ?? target.profile_url}: ${reason}`);
      }
    }
  }
  if (created) console.info(`[kampagnen] ${created} Event-Einladung(en) als Entwurf vorbereitet.`);
  return created;
}
