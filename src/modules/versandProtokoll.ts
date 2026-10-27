import { db } from "../db/index.js";
import { events } from "../core/events.js";

/**
 * VERSANDPROTOKOLL (2026-10-27, Sinan: „ich fühle mich unsicher, den Bot dauerhaft laufen zu lassen …
 * keine Übersicht“). Vorher meldete Telegram nur „Nachricht gesendet an X“ – WAS rausging, stand
 * nirgends gesammelt. Jetzt: eine Zeile je nachweislich gesendeter Direktnachricht mit vollem Text.
 * Aufrufer: outreach.sendMessage / sendThreadReply, erst NACH dem belegten Versand (nie vorher).
 */
export type VersandArt = "erstnachricht" | "nachfassung" | "antwort" | "kampagne" | "nachricht";
export type VersandEintrag = { id: number; at: string; art: VersandArt; ziel_url: string | null; empfaenger: string | null; contact_id: number | null; text: string };

export function protokolliereVersand(i: { art: VersandArt; zielUrl: string; empfaenger: string; text: string }): void {
  try {
    const kontakt = db.prepare("SELECT id FROM contacts WHERE profile_url=?").get(i.zielUrl) as { id: number } | undefined;
    const id = Number(db.prepare("INSERT INTO versand_protokoll(art,ziel_url,empfaenger,contact_id,text) VALUES(?,?,?,?,?)")
      .run(i.art, i.zielUrl, i.empfaenger, kontakt?.id ?? null, i.text).lastInsertRowid);
    events.emit("versand:gesendet", db.prepare("SELECT * FROM versand_protokoll WHERE id=?").get(id) as VersandEintrag);
  } catch (err) {
    // Das Protokoll darf einen bereits erfolgten Versand nie als Fehler erscheinen lassen.
    console.error("[versand-protokoll] nicht geschrieben:", (err as Error).message);
  }
}

/** Heute (lokale Zeit) Gesendetes, neueste zuerst – fürs Cockpit. */
export function versandHeute(limit = 60): { eintraege: VersandEintrag[]; zaehler: Record<string, number> } {
  const eintraege = db.prepare(
    "SELECT * FROM versand_protokoll WHERE date(at,'localtime')=date('now','localtime') ORDER BY id DESC LIMIT ?",
  ).all(limit) as VersandEintrag[];
  const zaehler = Object.fromEntries((db.prepare(
    "SELECT art, COUNT(*) n FROM versand_protokoll WHERE date(at,'localtime')=date('now','localtime') GROUP BY art",
  ).all() as { art: string; n: number }[]).map((r) => [r.art, r.n]));
  return { eintraege, zaehler };
}
