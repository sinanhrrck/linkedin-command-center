import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { db } from "../db/index.js";
import { config } from "../config.js";

export const OUTCOME_STAGES = ["qualified", "meeting", "won", "lost", "not_fit"] as const;
export type OutcomeStage = (typeof OUTCOME_STAGES)[number];

export type CampaignInput = {
  name: string;
  audience?: string;
  valueProp?: string;
  goal?: string;
  kind?: "outreach" | "event";
  eventUrl?: string;
  eventDate?: string;
  eventTime?: string;
  location?: string;
  briefing?: string;
  audienceScope?: "network" | "external" | "both";
  filters?: { keywords?: string; region?: string; minScore?: number };
  messageTemplate?: string;
  dailyLimit?: number;
};

export type CampaignRow = {
  id: number;
  name: string;
  audience: string | null;
  value_prop: string | null;
  goal: string | null;
  active: number;
  created_at: string;
  archived_at: string | null;
  kind: string;
  event_url: string | null;
  event_date: string | null;
  event_time: string | null;
  location: string | null;
  briefing: string | null;
  audience_scope: string;
  filters_json: string | null;
  message_template: string | null;
  daily_limit: number;
  targets: number;
  target_network: number;
  target_external: number;
  target_drafted: number;
  target_sent: number;
  sources: number;
  leads: number;
  invited: number;
  accepted: number;
  messaged: number;
  replied: number;
  qualified: number;
  meetings: number;
  won: number;
  lost: number;
  assets: CampaignAsset[];
};

export type CampaignAsset = {
  id: number;
  campaign_id: number;
  name: string;
  kind: string;
  file_name: string | null;
  mime: string | null;
  bytes: number | null;
  url: string | null;
  summary: string | null;
  created_at: string;
};

/**
 * Schlagwörter trennen an Komma, Semikolon ODER Leerzeichen (Fix 2026-08-06).
 *
 * Vorher wurde nur an Komma/Semikolon getrennt. Wer "Ausbildung Bankkaufmann" eintippte – eine
 * völlig naheliegende Eingabe – bekam daraus EINEN Suchbegriff, der als exakte Wortfolge im
 * Profil stehen musste. "Auszubildender Bankkaufmann" passte dann nicht mehr. Real fiel Sinans
 * Zielgruppe dadurch von 492 auf 46 Kontakte, ohne dass irgendwo ein Hinweis erschien.
 * Jedes Wort ist jetzt ein eigener Begriff, verknüpft mit ODER.
 */
const BEGRIFF_TRENNER = /[,;\s]+/;

const text = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) : "";
const scope = (value: unknown): "network" | "external" | "both" => value === "network" || value === "both" ? value : "external";
const kind = (value: unknown): "outreach" | "event" => value === "event" ? "event" : "outreach";
const limit = (value: unknown) => Math.max(1, Math.min(30, Math.round(Number(value) || 10)));
const filtersJson = (input: CampaignInput) => JSON.stringify({
  keywords: text(input.filters?.keywords, 240),
  region: text(input.filters?.region, 120),
  minScore: Math.max(0, Math.min(100, Number(input.filters?.minScore) || 0)),
});

/**
 * WER BEKOMMT EINE KAMPAGNEN-NACHRICHT? (Sinans Vorgabe 2026-08-05)
 *
 * Vorher lief jeder Kontakt außer 'closed'/'skipped' in die Zielgruppe – auch die 63 Leute, die
 * gerade angeschrieben waren und noch nicht geantwortet hatten. Die bekamen zusätzlich zur
 * offenen Erstnachricht eine Event-Einladung: aufdringlich und der schnellste Weg zu einem Report.
 *
 * Erlaubt sind jetzt nur zwei Gruppen:
 *  1. FRISCH VERNETZT ('accepted'): Verbindung steht, es lief noch kein Gespräch.
 *  2. VERSANDET ('replied' + seit TAGE_BIS_VERSANDET keine Aktivität): Es gab einen Austausch,
 *     daraus ist nichts geworden. Ein Event ist ein legitimer neuer Anlass.
 *
 * Ausgeschlossen bleiben:
 *  - 'messaged': wartet noch auf eine Antwort – da kommt keine zweite Ansprache dazwischen.
 *  - 'replied' mit frischer Aktivität: laufendes Gespräch, gehört dem Sales-Agent.
 *  - 'closed'/'skipped': ausdrückliche Absage. Nach einem Nein wird nicht weiter eingeladen.
 * Noch nicht vernetzte Kontakte ('new'/'invited') sind davon unberührt – die laufen ohnehin
 * erst durch den normalen Vernetzungsprozess ('awaiting_connection').
 */
const TAGE_BIS_VERSANDET = 14;

type ReifeZeile = { status: string; letzte_aktivitaet: string | null };

function kampagnenReif(c: ReifeZeile, grenze: string): boolean {
  if (c.status === "messaged") return false;
  if (c.status === "replied") return !!c.letzte_aktivitaet && c.letzte_aktivitaet < grenze;
  return true;
}

/** Stichtag als SQLite-Zeitstempel – so bleibt der Vergleich in derselben Zeitbasis wie die Daten. */
const versandetGrenze = () =>
  String((db.prepare("SELECT datetime('now', ?) g").get(`-${TAGE_BIS_VERSANDET} days`) as { g: string }).g);

/**
 * Letzter Kontaktpunkt: bevorzugt ein nachweislich gesendeter Entwurf, sonst die CRM-Marker.
 * COALESCE statt MAX(), weil SQLites skalares max() bei einem NULL-Argument NULL liefert.
 */
const LETZTE_AKTIVITAET_SQL =
  `COALESCE((SELECT MAX(d.sent_at) FROM drafts d WHERE d.thread_url=c.profile_url AND d.status='sent'),
            c.replied_at, c.messaged_at)`;

function seedCampaignTargets(campaignId: number, input: CampaignInput): number {
  const filters = JSON.parse(filtersJson(input)) as { keywords: string; region: string; minScore: number };
  const terms = filters.keywords.toLowerCase().split(BEGRIFF_TRENNER).map((term) => term.trim()).filter(Boolean);
  const region = filters.region.toLowerCase();
  const selectedScope = scope(input.audienceScope);
  const grenze = versandetGrenze();
  const contacts = db.prepare(
    `SELECT c.id,c.full_name,c.headline,c.status,c.lead_score,c.aus_netzwerk,c.accepted_at,
            ${LETZTE_AKTIVITAET_SQL} letzte_aktivitaet
       FROM contacts c WHERE c.status NOT IN ('closed','skipped')`,
  ).all() as Array<{ id: number; full_name: string | null; headline: string | null; status: string; lead_score: number | null; aus_netzwerk: number; accepted_at: string | null; letzte_aktivitaet: string | null }>;
  const add = db.prepare("INSERT OR IGNORE INTO campaign_targets(campaign_id,contact_id,route,status) VALUES(?,?,?,?)");
  let count = 0;
  for (const contact of contacts) {
    const haystack = `${contact.full_name ?? ""} ${contact.headline ?? ""}`.toLowerCase();
    if (terms.length && !terms.some((term) => haystack.includes(term))) continue;
    if (region && !haystack.includes(region)) continue;
    if ((contact.lead_score ?? 0) < filters.minScore) continue;
    if (!kampagnenReif(contact, grenze)) continue;
    const connected = !!contact.aus_netzwerk || !!contact.accepted_at || ["accepted", "messaged", "replied"].includes(contact.status);
    const route = connected ? "network" : "external";
    if (selectedScope !== "both" && selectedScope !== route) continue;
    const status = connected ? "queued" : "awaiting_connection";
    count += add.run(campaignId, contact.id, route, status).changes;
  }
  db.prepare("UPDATE contacts SET campaign_id=COALESCE(campaign_id,?) WHERE id IN (SELECT contact_id FROM campaign_targets WHERE campaign_id=?)").run(campaignId, campaignId);
  return count;
}

/**
 * Ergänzt eine bereits gespeicherte Kampagne um passende Kontakte. Das ist wichtig für laufende
 * Kampagnen: Neue Leads und ältere Kampagnen ohne initiale Targets werden so beim nächsten Tick
 * automatisch aufgenommen, ohne bestehende Entscheidungen oder Versandstände zurückzusetzen.
 */
export function refreshCampaignTargets(campaignId: number): number {
  const row = db.prepare(
    `SELECT name,audience,value_prop,goal,kind,event_url,event_date,event_time,location,briefing,
            audience_scope,filters_json,message_template,daily_limit
       FROM campaigns WHERE id=?`,
  ).get(campaignId) as Record<string, unknown> | undefined;
  if (!row) return 0;
  let filters: CampaignInput["filters"] = {};
  try { filters = JSON.parse(String(row.filters_json || "{}")); } catch { filters = {}; }
  return seedCampaignTargets(campaignId, {
    name: String(row.name || ""), audience: String(row.audience || ""), valueProp: String(row.value_prop || ""),
    goal: String(row.goal || ""), kind: row.kind === "event" ? "event" : "outreach",
    eventUrl: String(row.event_url || ""), eventDate: String(row.event_date || ""),
    eventTime: String(row.event_time || ""), location: String(row.location || ""), briefing: String(row.briefing || ""),
    audienceScope: row.audience_scope === "network" || row.audience_scope === "both" ? row.audience_scope : "external",
    filters, messageTemplate: String(row.message_template || ""), dailyLimit: Number(row.daily_limit || 10),
  });
}

export function createCampaign(input: CampaignInput): number {
  const name = text(input.name, 90);
  if (!name) throw new Error("Bitte gib der Kampagne einen Namen.");
  const eventUrl = text(input.eventUrl, 500);
  if (kind(input.kind) === "event" && !/^https?:\/\//i.test(eventUrl)) throw new Error("Bitte hinterlege eine gültige Event-URL.");
  const result = db.prepare(
    `INSERT INTO campaigns(name,audience,value_prop,goal,kind,event_url,event_date,event_time,location,briefing,
        audience_scope,filters_json,message_template,daily_limit)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(name, text(input.audience, 180) || null, text(input.valueProp, 280) || null, text(input.goal, 120) || null,
    kind(input.kind), eventUrl || null, text(input.eventDate, 30) || null, text(input.eventTime, 40) || null,
    text(input.location, 160) || null, text(input.briefing, 2000) || null, scope(input.audienceScope), filtersJson(input),
    text(input.messageTemplate, 1200) || null, limit(input.dailyLimit));
  const id = Number(result.lastInsertRowid);
  seedCampaignTargets(id, input);
  return id;
}

export function updateCampaign(id: number, input: CampaignInput) {
  const name = text(input.name, 90);
  if (!Number.isInteger(id) || id <= 0 || !name) throw new Error("Ungültige Kampagne.");
  const eventUrl = text(input.eventUrl, 500);
  if (kind(input.kind) === "event" && !/^https?:\/\//i.test(eventUrl)) throw new Error("Bitte hinterlege eine gültige Event-URL.");
  const updated = db.prepare(
    `UPDATE campaigns SET name=?,audience=?,value_prop=?,goal=?,kind=?,event_url=?,event_date=?,event_time=?,location=?,briefing=?,
        audience_scope=?,filters_json=?,message_template=?,daily_limit=? WHERE id=?`,
  ).run(name, text(input.audience, 180) || null, text(input.valueProp, 280) || null, text(input.goal, 120) || null,
    kind(input.kind), eventUrl || null, text(input.eventDate, 30) || null, text(input.eventTime, 40) || null,
    text(input.location, 160) || null, text(input.briefing, 2000) || null, scope(input.audienceScope), filtersJson(input),
    text(input.messageTemplate, 1200) || null, limit(input.dailyLimit), id).changes > 0;
  if (updated) { pruneCampaignTargets(id); refreshCampaignTargets(id); }
  return updated;
}

/**
 * Zielgruppen-Filter dürfen sich beim Bearbeiten verengen. Kontakte, die nicht mehr passen und
 * noch NICHT angeschrieben wurden, fallen deshalb wieder aus der Kampagne heraus. Alles, was
 * bereits einen Entwurf oder Versand hat, bleibt bewusst stehen – Historie wird nie umgeschrieben.
 */
export function pruneCampaignTargets(campaignId: number): number {
  const row = db.prepare("SELECT audience_scope,filters_json FROM campaigns WHERE id=?").get(campaignId) as
    { audience_scope: string; filters_json: string | null } | undefined;
  if (!row) return 0;
  let filters = { keywords: "", region: "", minScore: 0 };
  try { filters = { ...filters, ...JSON.parse(row.filters_json || "{}") }; } catch { /* Default behalten */ }
  const terms = String(filters.keywords || "").toLowerCase().split(BEGRIFF_TRENNER).map((term) => term.trim()).filter(Boolean);
  const region = String(filters.region || "").toLowerCase();
  const selectedScope = scope(row.audience_scope);
  const grenze = versandetGrenze();
  const open = db.prepare(
    `SELECT t.contact_id,t.route,c.full_name,c.headline,c.lead_score,c.aus_netzwerk,c.accepted_at,c.status,
            ${LETZTE_AKTIVITAET_SQL} letzte_aktivitaet
       FROM campaign_targets t JOIN contacts c ON c.id=t.contact_id
      WHERE t.campaign_id=? AND t.status IN ('queued','awaiting_connection')`,
  ).all(campaignId) as Array<{ contact_id: number; route: string; full_name: string | null; headline: string | null; lead_score: number | null; aus_netzwerk: number; accepted_at: string | null; status: string; letzte_aktivitaet: string | null }>;
  const remove = db.prepare("DELETE FROM campaign_targets WHERE campaign_id=? AND contact_id=?");
  let removed = 0;
  for (const target of open) {
    const haystack = `${target.full_name ?? ""} ${target.headline ?? ""}`.toLowerCase();
    const connected = !!target.aus_netzwerk || !!target.accepted_at || ["accepted", "messaged", "replied"].includes(target.status);
    const route = connected ? "network" : "external";
    const matches = (!terms.length || terms.some((term) => haystack.includes(term)))
      && (!region || haystack.includes(region))
      && (target.lead_score ?? 0) >= (Number(filters.minScore) || 0)
      && (selectedScope === "both" || selectedScope === route)
      && kampagnenReif(target, grenze);
    if (matches) continue;
    removed += remove.run(campaignId, target.contact_id).changes;
  }
  return removed;
}

/**
 * Löscht eine Kampagne vollständig: Zielgruppe, Material (inklusive der lokalen Dateien) und ALLE
 * dazu erzeugten Nachrichten-Entwürfe. Kontakte selbst bleiben erhalten und verlieren nur ihre
 * Kampagnen-Zuordnung. Das Versandprotokoll in `actions` bleibt unangetastet – es ist die
 * unveränderliche Safety-Historie und darf nie von einer Aufräumaktion abhängen.
 */
export function deleteCampaign(id: number): { ok: boolean; drafts: number; targets: number; assets: number } {
  if (!Number.isInteger(id) || id <= 0) throw new Error("Ungültige Kampagne.");
  if (!db.prepare("SELECT 1 FROM campaigns WHERE id=?").get(id)) return { ok: false, drafts: 0, targets: 0, assets: 0 };
  const assets = listCampaignAssets(id);
  for (const asset of assets) {
    const path = campaignAssetPath(asset);
    if (path) { try { rmSync(path); } catch { /* Datei schon weg */ } }
  }
  try { rmSync(assetDir(id), { recursive: true, force: true }); } catch { /* Ordner schon weg */ }
  const remove = db.transaction(() => {
    const drafts = db.prepare("DELETE FROM drafts WHERE incoming=?").run(`campaign:${id}`).changes;
    const targets = db.prepare("DELETE FROM campaign_targets WHERE campaign_id=?").run(id).changes;
    db.prepare("DELETE FROM campaign_assets WHERE campaign_id=?").run(id);
    db.prepare("DELETE FROM experiment_arms WHERE campaign_id=?").run(id);
    db.prepare("UPDATE contacts SET campaign_id=NULL WHERE campaign_id=?").run(id);
    db.prepare("UPDATE lead_sources SET campaign_id=NULL WHERE campaign_id=?").run(id);
    db.prepare("UPDATE sales_outcomes SET campaign_id=NULL WHERE campaign_id=?").run(id);
    db.prepare("DELETE FROM campaigns WHERE id=?").run(id);
    return { drafts, targets };
  });
  const counts = remove();
  return { ok: true, drafts: counts.drafts, targets: counts.targets, assets: assets.length };
}

export function setCampaignActive(id: number, active: boolean) {
  return db.prepare(
    "UPDATE campaigns SET active=?, archived_at=CASE WHEN ? THEN NULL ELSE datetime('now') END WHERE id=?",
  ).run(active ? 1 : 0, active ? 1 : 0, id).changes > 0;
}

/** Kampagnen mit einem fokussierten Funnel. Korrelierte Zählungen vermeiden Join-Multiplikate. */
export function listCampaigns(): CampaignRow[] {
  const rows = db.prepare(
    `SELECT c.id, c.name, c.audience, c.value_prop, c.goal, c.kind, c.event_url, c.event_date,
      c.event_time, c.location, c.briefing,
      c.audience_scope,c.filters_json,c.message_template,c.daily_limit,c.active,c.created_at,c.archived_at,
      (SELECT COUNT(*) FROM campaign_targets t WHERE t.campaign_id=c.id) AS targets,
      (SELECT COUNT(*) FROM campaign_targets t WHERE t.campaign_id=c.id AND t.route='network') AS target_network,
      (SELECT COUNT(*) FROM campaign_targets t WHERE t.campaign_id=c.id AND t.route='external') AS target_external,
      -- ENTWÜRFE + GESENDET kommen aus den Entwürfen selbst, NICHT aus campaign_targets
      -- (Fix 2026-08-05): Der Ziel-Status ist ein abgeleiteter Zustand, der nur beim
      -- campaign-Tick nachgezogen wird. Stand die Engine still oder fiel ein Ziel aus der
      -- Zielgruppe, zeigte die Karte dauerhaft "0 gesendet", obwohl Nachrichten nachweislich
      -- rausgegangen waren. Die drafts-Tabelle ist die Wahrheit über den Versand.
      (SELECT COUNT(*) FROM drafts d WHERE d.incoming='campaign:'||c.id AND d.kind='event'
                                      AND d.status IN ('pending','approved','sending')) AS target_drafted,
      (SELECT COUNT(*) FROM drafts d WHERE d.incoming='campaign:'||c.id AND d.kind='event'
                                      AND d.status='sent') AS target_sent,
      (SELECT COUNT(*) FROM lead_sources s WHERE s.campaign_id=c.id) AS sources,
      (SELECT COUNT(*) FROM contacts l WHERE l.campaign_id=c.id) AS leads,
      (SELECT COUNT(*) FROM contacts l WHERE l.campaign_id=c.id AND l.invited_at IS NOT NULL) AS invited,
      (SELECT COUNT(*) FROM contacts l WHERE l.campaign_id=c.id AND l.accepted_at IS NOT NULL) AS accepted,
      (SELECT COUNT(*) FROM contacts l WHERE l.campaign_id=c.id AND l.messaged_at IS NOT NULL) AS messaged,
      (SELECT COUNT(*) FROM contacts l WHERE l.campaign_id=c.id AND l.replied_at IS NOT NULL) AS replied,
      (SELECT COUNT(*) FROM sales_outcomes o WHERE o.campaign_id=c.id AND o.stage='qualified') AS qualified,
      (SELECT COUNT(*) FROM sales_outcomes o WHERE o.campaign_id=c.id AND o.stage='meeting') AS meetings,
      (SELECT COUNT(*) FROM sales_outcomes o WHERE o.campaign_id=c.id AND o.stage='won') AS won,
      (SELECT COUNT(*) FROM sales_outcomes o WHERE o.campaign_id=c.id AND o.stage IN ('lost','not_fit')) AS lost
     FROM campaigns c
     ORDER BY c.active DESC, c.created_at DESC`,
  ).all() as CampaignRow[];
  const assets = listCampaignAssets();
  return rows.map((row) => ({ ...row, assets: assets.filter((asset) => asset.campaign_id === row.id) }));
}

// ---------------------------------------------------------------------------
// KAMPAGNEN-MATERIAL
// Dateien liegen bewusst NUR lokal (wie .session): pro Kampagne ein Ordner, in der DB steht
// ausschließlich der bereinigte Dateiname. Für die KI zählt nicht die Datei, sondern die vom
// Nutzer gepflegte Zusammenfassung – das bleibt vorhersagbar und kostet keinen Extra-Aufruf.
// ---------------------------------------------------------------------------

const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const assetRoot = () => resolve(config.paths.uploadDir, "campaigns");
const assetDir = (campaignId: number) => join(assetRoot(), String(campaignId));
const safeFileName = (value: string) => (value.replace(/[^\w.\- ]+/g, "_").replace(/\s+/g, " ").trim().slice(-90) || "material");

export function campaignAssetPath(asset: CampaignAsset): string | null {
  if (!asset.file_name) return null;
  const directory = assetDir(asset.campaign_id);
  const full = resolve(directory, asset.file_name);
  // Schutz gegen präparierte Dateinamen: der Pfad muss im Kampagnenordner bleiben.
  if (!full.startsWith(resolve(directory) + "/")) return null;
  return existsSync(full) ? full : null;
}

export function listCampaignAssets(campaignId?: number): CampaignAsset[] {
  return campaignId
    ? db.prepare("SELECT * FROM campaign_assets WHERE campaign_id=? ORDER BY id").all(campaignId) as CampaignAsset[]
    : db.prepare("SELECT * FROM campaign_assets ORDER BY campaign_id,id").all() as CampaignAsset[];
}

export function getCampaignAsset(id: number): CampaignAsset | undefined {
  return db.prepare("SELECT * FROM campaign_assets WHERE id=?").get(id) as CampaignAsset | undefined;
}

export type CampaignAssetInput = {
  campaignId: number;
  name?: string;
  summary?: string;
  url?: string;
  fileName?: string;
  mime?: string;
  /** Dateiinhalt als Base64 (Upload läuft als JSON, damit kein Multipart-Parser nötig ist). */
  data?: string;
};

export function addCampaignAsset(input: CampaignAssetInput): number {
  const campaignId = Number(input.campaignId);
  if (!Number.isInteger(campaignId) || campaignId <= 0) throw new Error("Ungültige Kampagne.");
  if (!db.prepare("SELECT 1 FROM campaigns WHERE id=?").get(campaignId)) throw new Error("Kampagne nicht gefunden.");
  const url = text(input.url, 500);
  const summary = text(input.summary, 2000);
  let storedName: string | null = null;
  let bytes: number | null = null;
  if (input.data) {
    const buffer = Buffer.from(String(input.data), "base64");
    if (!buffer.length) throw new Error("Die Datei ist leer.");
    if (buffer.length > MAX_ASSET_BYTES) throw new Error("Die Datei ist größer als 8 MB.");
    mkdirSync(assetDir(campaignId), { recursive: true });
    storedName = `${Date.now()}-${safeFileName(text(input.fileName, 120) || "material")}`;
    writeFileSync(join(assetDir(campaignId), storedName), buffer);
    bytes = buffer.length;
  }
  if (!storedName && !url && !summary) throw new Error("Bitte lade eine Datei hoch, hinterlege einen Link oder beschreibe die Kernaussagen.");
  const name = text(input.name, 120) || text(input.fileName, 120) || (url ? "Link" : "Material");
  const result = db.prepare(
    "INSERT INTO campaign_assets(campaign_id,name,kind,file_name,mime,bytes,url,summary) VALUES(?,?,?,?,?,?,?,?)",
  ).run(campaignId, name, storedName ? "file" : "link", storedName, text(input.mime, 120) || null, bytes, url || null, summary || null);
  return Number(result.lastInsertRowid);
}

export function updateCampaignAsset(id: number, patch: { name?: string; summary?: string; url?: string }): boolean {
  const asset = getCampaignAsset(id);
  if (!asset) return false;
  return db.prepare("UPDATE campaign_assets SET name=?,summary=?,url=? WHERE id=?").run(
    text(patch.name, 120) || asset.name,
    patch.summary === undefined ? asset.summary : (text(patch.summary, 2000) || null),
    patch.url === undefined ? asset.url : (text(patch.url, 500) || null),
    id,
  ).changes > 0;
}

export function deleteCampaignAsset(id: number): boolean {
  const asset = getCampaignAsset(id);
  if (!asset) return false;
  const path = campaignAssetPath(asset);
  if (path) { try { rmSync(path); } catch { /* Datei schon weg – Eintrag trotzdem entfernen */ } }
  return db.prepare("DELETE FROM campaign_assets WHERE id=?").run(id).changes > 0;
}

const dateLang = (value: string | null) => value ? new Date(`${value}T12:00:00`).toLocaleDateString("de-DE", { weekday: "long", day: "2-digit", month: "long", year: "numeric" }) : "";

/**
 * Sachkontext einer Kampagne als Prompt-Baustein. Wird beim Neuschreiben von Kampagnen-Entwürfen
 * eingespeist, damit die KI Ort, Zeit, Ablauf und Flyer-Kernaussagen kennt statt sie zu erfinden.
 */
export function campaignContext(campaignId: number): string {
  const c = db.prepare(
    `SELECT name,kind,audience,value_prop,goal,event_url,event_date,event_time,location,briefing
       FROM campaigns WHERE id=?`,
  ).get(campaignId) as Record<string, string | null> | undefined;
  if (!c) return "";
  const lines: string[] = [];
  const add = (label: string, value: string | null | undefined) => { if (value && String(value).trim()) lines.push(`${label}: ${String(value).trim()}`); };
  add(c.kind === "event" ? "Event" : "Kampagne", c.name);
  add("Datum", dateLang(c.event_date));
  add("Uhrzeit", c.event_time);
  add("Ort", c.location);
  add("Link", c.event_url);
  add("Zielgruppe", c.audience);
  add("Nutzen für die eingeladene Person", c.value_prop);
  add("Ziel dieser Kampagne", c.goal);
  add("Hintergrund und Ablauf", c.briefing);
  for (const asset of listCampaignAssets(campaignId)) {
    const parts = [asset.summary, asset.url].filter(Boolean).join(" · ");
    if (parts) lines.push(`Material „${asset.name}“: ${parts}`);
  }
  if (!lines.length) return "";
  return `KAMPAGNEN-FAKTEN (nur diese Angaben verwenden, nichts dazuerfinden):\n${lines.join("\n")}`;
}

/** Ergebnis wird pro Kontakt überschrieben: Das Cockpit zeigt immer den aktuellen Stand. */
export function recordOutcome(contactId: number, stage: OutcomeStage, note?: string, valueCents?: number) {
  if (!Number.isInteger(contactId) || contactId <= 0 || !OUTCOME_STAGES.includes(stage)) {
    throw new Error("Ungültiges Vertriebsergebnis.");
  }
  const contact = db.prepare("SELECT campaign_id FROM contacts WHERE id=?").get(contactId) as { campaign_id: number | null } | undefined;
  if (!contact) throw new Error("Kontakt nicht gefunden.");
  const cleanNote = text(note, 600) || null;
  const value = Number.isFinite(valueCents) && Number(valueCents) >= 0 ? Math.round(Number(valueCents)) : null;
  db.prepare(
    `INSERT INTO sales_outcomes(contact_id, campaign_id, stage, note, value_cents, updated_at)
     VALUES(?,?,?,?,?,datetime('now'))
     ON CONFLICT(contact_id) DO UPDATE SET
       campaign_id=excluded.campaign_id, stage=excluded.stage, note=excluded.note,
       value_cents=excluded.value_cents, updated_at=datetime('now')`,
  ).run(contactId, contact.campaign_id, stage, cleanNote, value);
}
