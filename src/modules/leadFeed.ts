import { db, getFocus } from "../db/index.js";
import { scrapeSearch } from "./leads.js";
import { countContacts } from "./crm.js";

/**
 * Automatische Lead-Fütterung aus gespeicherten Such-URLs (lead_sources).
 * Rein lesend (scrapt Suchergebnisse), kein Governor nötig. Blättert pro Lauf
 * eine Seite weiter, damit stetig neue Leads reinkommen statt immer derselben.
 */
export type LeadSource = {
  id: number;
  label: string | null;
  search_url: string;
  cursor_page: number;
  active: number;
  keep_filter: string | null;
  zielgruppe: string | null;
  last_run: string | null;
  last_added: number;
};

/** Quelle anlegen oder reaktivieren (dedupliziert per URL). keepFilter = Regex (i). */
export function addSource(searchUrl: string, label?: string, keepFilter?: string) {
  db.prepare(
    `INSERT INTO lead_sources(label, search_url, keep_filter) VALUES(?, ?, ?)
     ON CONFLICT(search_url) DO UPDATE SET
       label = COALESCE(excluded.label, lead_sources.label),
       keep_filter = COALESCE(excluded.keep_filter, lead_sources.keep_filter),
       active = 1`,
  ).run(label ?? null, searchUrl, keepFilter ?? null);
}

export function listSources(): LeadSource[] {
  return db.prepare("SELECT * FROM lead_sources ORDER BY created_at").all() as LeadSource[];
}

export function setSourceActive(id: number, active: boolean) {
  db.prepare("UPDATE lead_sources SET active=? WHERE id=?").run(active ? 1 : 0, id);
}

/** Baut die seitenweise Such-URL (LinkedIn nutzt &page=N). */
function pagedUrl(url: string, page: number): string {
  if (page <= 1) return url;
  if (/[?&]page=\d+/.test(url)) return url.replace(/([?&]page=)\d+/, `$1${page}`);
  return url + (url.includes("?") ? "&" : "?") + "page=" + page;
}

/**
 * Ein Fütterungs-Durchlauf: grast jede aktive Quelle eine Seite ab.
 * Bringt eine Seite neue Treffer → cursor_page++. Bringt sie nichts Neues
 * (Ende erreicht) → zurück auf Seite 1 (Suchergebnisse ändern sich über Zeit).
 */
export async function feedTick(maxPerSource = 25): Promise<number> {
  // FOKUS: Sinan stellt im Dashboard ein, auf wen er gerade geht – der Bot holt sich den
  // Nachschub dann selbst aus den passenden Quellen. Kein manuelles An-/Ausknipsen mehr.
  // Quellen ohne Zielgruppe laufen immer mit (alte Quellen bleiben so funktionsfähig).
  const focus = getFocus();
  const sources = (
    db.prepare("SELECT * FROM lead_sources WHERE active=1").all() as LeadSource[]
  ).filter((s) => focus === "beides" || !s.zielgruppe || s.zielgruppe === focus);
  if (!sources.length) {
    console.info(`[feed] keine Quelle für Fokus "${focus}" – nichts zu tun.`);
    return 0;
  }
  console.info(`[feed] Fokus "${focus}" → ${sources.length} Quelle(n)`);
  let totalNew = 0;
  for (const s of sources) {
    const before = countContacts();
    // Rückgabe = Anzahl gefundener Profile auf der Seite (vor Filter, inkl. Duplikate).
    const found = await scrapeSearch(pagedUrl(s.search_url, s.cursor_page), maxPerSource, s.keep_filter ?? undefined);
    const added = countContacts() - before;
    // Solange die Seite Profile hat: weiterblättern (auch wenn nur Duplikate).
    // Erst wenn eine Seite LEER ist (Ende der Ergebnisse): zurück auf Seite 1.
    const nextPage = found > 0 ? s.cursor_page + 1 : 1;
    db.prepare("UPDATE lead_sources SET cursor_page=?, last_run=datetime('now'), last_added=? WHERE id=?")
      .run(nextPage, added, s.id);
    totalNew += added;
    console.info(`[feed] ${s.label || s.search_url.slice(0, 45)} · Seite ${s.cursor_page}: ${found} gefunden, +${added} neu`);
  }
  console.info(`[feed] gesamt +${totalNew} neue Leads`);
  return totalNew;
}
