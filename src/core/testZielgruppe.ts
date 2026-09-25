import type Database from "better-sqlite3";

/**
 * NUR FÜR TESTS: Seit 2026-09-25 bekommt ein Kontakt ohne aktive Zielgruppe keine automatische
 * Ansprache. Tests, die etwas ANDERES prüfen (Warteschlange, Freigabe, Nachfass-Plan …), stellen
 * damit jeden Kontakt in eine offene Zielgruppe ohne Wörter – sonst prüften sie nur noch die
 * Zielgruppen-Schranke. Die Schranke selbst testet zielgruppen.test.ts.
 */
export function alleKontakteInZielgruppe(db: Database.Database): number {
  db.exec("UPDATE zielgruppen SET aktiv=0");
  const id = Number(db.prepare("INSERT INTO zielgruppen(name, aktiv) VALUES('Alle (Test)', 1)").run().lastInsertRowid);
  db.exec(`CREATE TRIGGER IF NOT EXISTS test_alle_in_zielgruppe AFTER INSERT ON contacts
    BEGIN UPDATE contacts SET zielgruppe_id=${id} WHERE id=NEW.id AND zielgruppe_id IS NULL; END`);
  db.prepare("UPDATE contacts SET zielgruppe_id=? WHERE zielgruppe_id IS NULL").run(id);
  return id;
}
