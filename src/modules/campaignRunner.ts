import { db } from "../db/index.js";
import { events } from "../core/events.js";
import { getDraft } from "./drafts.js";
import { refreshCampaignTargets, campaignContext } from "./campaigns.js";
import { eventInvitation } from "./personalize.js";

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

/**
 * Event-Kampagnen laufen in derselben Nachrichten-Pipeline wie der übrige Bot. Externe Kontakte
 * warten zunächst auf die Annahme; bestehende Verbindungen bekommen einen prüfbaren Entwurf.
 */
export async function campaignTick(): Promise<number> {
  // Zugestellte Kampagnen-Entwürfe in den Zielstatus spiegeln.
  db.prepare(
    `UPDATE campaign_targets SET status='sent',updated_at=datetime('now')
      WHERE status='drafted' AND EXISTS (
        SELECT 1 FROM drafts d WHERE d.thread_url=(SELECT profile_url FROM contacts WHERE id=campaign_targets.contact_id)
          AND d.kind='event' AND d.incoming='campaign:'||campaign_targets.campaign_id AND d.status='sent'
      )`,
  ).run();
  // Inzwischen angenommene externe Kontakte sind nun bereit.
  db.prepare(
    `UPDATE campaign_targets SET status='queued',updated_at=datetime('now')
      WHERE status='awaiting_connection' AND EXISTS (
        SELECT 1 FROM contacts c WHERE c.id=campaign_targets.contact_id AND c.accepted_at IS NOT NULL
      )`,
  ).run();

  /**
   * VERWAISTE ZIELE ZURÜCKHOLEN (Fix 2026-08-06). Ein Ziel wird auf 'drafted' gesetzt, sobald
   * ein Entwurf entsteht. Wird dieser Entwurf später verworfen – vom Nutzer oder beim Aufräumen
   * der Zielgruppe –, blieb das Ziel trotzdem für immer auf 'drafted' und wurde nie wieder
   * angefasst. Real waren 18 von 19 Zielen so festgenagelt: Kontakte, die nie eine Einladung
   * bekommen haben und trotzdem als erledigt galten. Die Kampagne stand still, obwohl 138
   * Leute in der Zielgruppe waren.
   *
   * Solche Ziele kommen zurück in die Warteschlange – aber höchstens einmal (max. 2 Entwürfe
   * pro Kontakt und Kampagne). Sonst entstünde eine Endlosschleife, wenn jemand denselben
   * Vorschlag wiederholt ablehnt.
   */
  const zurueckgeholt = db.prepare(
    `UPDATE campaign_targets SET status='queued', updated_at=datetime('now')
      WHERE status='drafted'
        AND NOT EXISTS (
          SELECT 1 FROM drafts d
           WHERE d.thread_url=(SELECT profile_url FROM contacts WHERE id=campaign_targets.contact_id)
             AND d.kind='event' AND d.incoming='campaign:'||campaign_targets.campaign_id
             AND d.status IN ('pending','approved','sending','sent'))
        AND (SELECT COUNT(*) FROM drafts d2
              WHERE d2.thread_url=(SELECT profile_url FROM contacts WHERE id=campaign_targets.contact_id)
                AND d2.kind='event' AND d2.incoming='campaign:'||campaign_targets.campaign_id) < 2`,
  ).run().changes;
  if (zurueckgeholt) console.info(`[kampagnen] ${zurueckgeholt} Kontakt(e) ohne Entwurf zurück in die Warteschlange.`);

  // B1/P1/AEC-Aufträge nutzen die normale Erstnachrichten- und Gesprächslogik. Nur klassische
  // Kampagnen erzeugen hier zusätzliche Kampagnennachrichten; neue Ziele würden sonst doppelt
  // anschreiben. Legacy-Outreach ohne goal_code bleibt aus Kompatibilitätsgründen erhalten.
  const campaigns = db.prepare("SELECT id,daily_limit FROM campaigns WHERE active=1 AND (goal_code IS NULL OR kind='event')").all() as Array<{ id: number; daily_limit: number }>;
  let created = 0;
  for (const campaign of campaigns) {
    refreshCampaignTargets(campaign.id);
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
    const targets = db.prepare(
      `SELECT t.campaign_id,t.contact_id,c.full_name name,c.headline,c.profile_url,c.status contact_status,c.accepted_at,
              ca.name title,ca.kind,ca.audience,ca.value_prop,ca.goal,
              ca.event_url,ca.event_date,ca.event_time,ca.location,ca.briefing,ca.message_template,ca.daily_limit
        FROM campaign_targets t JOIN contacts c ON c.id=t.contact_id JOIN campaigns ca ON ca.id=t.campaign_id
        WHERE t.campaign_id=? AND t.status='queued'
          /**
           * VORFAHRT DER KAMPAGNE VOR DER REAKTIVIERUNG (Sinans Vorgabe 2026-08-05).
           * Ein offener Entwurf sperrt den Kontakt weiterhin – niemand soll zwei Nachrichten
           * gleichzeitig bekommen. AUSNAHME: ein noch nicht freigegebener Reaktivierungs-
           * Entwurf. Der will dasselbe wie die Einladung (einen stillen Kontakt ansprechen),
           * hat aber keinen konkreten Anlass. Real blockierten 25 solcher Entwürfe die gesamte
           * Kampagne. Er wird unten beim Anlegen der Einladung verworfen, damit trotzdem nie
           * zwei offene Nachrichten für dieselbe Person existieren.
           * BEREITS FREIGEGEBENE ('approved'/'sending') Reaktivierungen sperren weiter: die
           * sind unterwegs, da darf die Kampagne nicht mehr dazwischenfunken.
           */
          AND NOT EXISTS (
            SELECT 1 FROM drafts open_draft
             WHERE open_draft.thread_url=c.profile_url
               AND NOT (open_draft.kind='reaktivierung' AND open_draft.status='pending')
               AND open_draft.status IN ('pending','approved','sending')
          )
        ORDER BY COALESCE(c.lead_score,0) DESC,t.created_at LIMIT ?`,
    ).all(campaign.id, remaining) as Target[];
    // Einmal je Kampagne holen: die Fakten sind für alle Zielkontakte identisch.
    const kontext = targets.length ? campaignContext(campaign.id) : "";
    for (const target of targets) {
      const incoming = `campaign:${target.campaign_id}`;
      const exists = db.prepare("SELECT 1 FROM drafts WHERE thread_url=? AND kind='event' AND incoming=? AND status IN ('pending','approved','sending','sent')").get(target.profile_url, incoming);
      if (exists) {
        db.prepare("UPDATE campaign_targets SET status='drafted',updated_at=datetime('now') WHERE campaign_id=? AND contact_id=?").run(target.campaign_id, target.contact_id);
        continue;
      }
      const message = await inviteText(target, kontext);
      // Die Einladung ERSETZT einen noch nicht freigegebenen Reaktivierungs-Entwurf (siehe
      // Vorfahrt-Regel oben). Beides offen zu lassen würde bedeuten, dass eine Freigabe von
      // beidem zwei Nachrichten an dieselbe Person schickt.
      const ersetzt = db.prepare(
        "UPDATE drafts SET status='discarded' WHERE thread_url=? AND kind='reaktivierung' AND status='pending'",
      ).run(target.profile_url).changes;
      if (ersetzt) console.info(`[kampagnen] Reaktivierungs-Entwurf für ${target.name ?? target.profile_url} durch die Event-Einladung ersetzt.`);
      const result = db.prepare(
        "INSERT INTO drafts(kind,thread_url,participant,incoming,draft,ki_original,intent) VALUES('event',?,?,?,?,?,'event')",
      ).run(target.profile_url, target.name, incoming, message, message);
      db.prepare("UPDATE campaign_targets SET status='drafted',updated_at=datetime('now') WHERE campaign_id=? AND contact_id=?").run(target.campaign_id, target.contact_id);
      events.emit("draft:new", getDraft(Number(result.lastInsertRowid)));
      created++;
    }
  }
  if (created) console.info(`[kampagnen] ${created} Event-Einladung(en) als Entwurf vorbereitet.`);
  return created;
}
