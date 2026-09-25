import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "nextlead-abgleich-")), "test.sqlite");
const { db } = await import("../db/index.js");
const { heileAusChatliste, heileKontakt } = await import("../modules/postfachAbgleich.js");
const { verlaufsWiderspruch } = await import("../modules/outreach.js");

let nr = 0;
const kontakt = (fullName: string, status: string, messagedAt: string | null = null) => {
  nr++;
  const url = `https://www.linkedin.com/in/abgleich-${nr}/`;
  const id = Number(db.prepare("INSERT INTO contacts(profile_url,normalized_url,full_name,headline,status,messaged_at) VALUES(?,?,?,?,?,?)")
    .run(url, url, fullName, "Azubi", status, messagedAt).lastInsertRowid);
  return { id, url };
};
const entwurf = (url: string, kind: string, participant: string) =>
  Number(db.prepare("INSERT INTO drafts(kind,thread_url,participant,incoming,draft,ki_original) VALUES(?,?,?,'','x','x')").run(kind, url, participant).lastInsertRowid);
const status = (table: string, id: number) => (db.prepare(`SELECT status FROM ${table} WHERE id=?`).get(id) as { status: string }).status;

test("Verlaufsregel: Erstnachricht nur in leeren Chat, Nachfassung nur ohne Antwort und nicht doppelt", () => {
  assert.equal(verlaufsWiderspruch({ art: "erst" }, 0, 0), null);
  assert.match(verlaufsWiderspruch({ art: "erst" }, 1, 0)!, /keine Erstnachricht/);
  assert.match(verlaufsWiderspruch({ art: "erst" }, 0, 1)!, /keine Erstnachricht/);
  assert.equal(verlaufsWiderspruch({ art: "nachfass", stufe: 1 }, 1, 0), null, "Erstnachricht da, Stufe 1 fällig");
  assert.match(verlaufsWiderspruch({ art: "nachfass", stufe: 1 }, 1, 1)!, /geschrieben/);
  assert.match(verlaufsWiderspruch({ art: "nachfass", stufe: 1 }, 3, 0)!, /schon 3/);
  assert.equal(verlaufsWiderspruch({ art: "nachfass", stufe: 2 }, 0, 0), null, "nichts gezählt = nicht blockieren (Selektor/Ladezeit)");
});

test("Chatliste korrigiert eindeutige Kontakte und verwirft überholte Entwürfe", () => {
  const anna = kontakt("Anna Beispiel", "accepted");
  const annaErst = entwurf(anna.url, "first", "Anna Beispiel");
  const ben = kontakt("Ben Muster", "messaged", "2026-08-20 10:00:00");
  const benNach = entwurf(ben.url, "followup", "Ben Muster");
  const zwilling1 = kontakt("Chris Gleich", "accepted");
  kontakt("Chris Gleich", "accepted");
  const zwillingErst = entwurf(zwilling1.url, "first", "Chris Gleich");
  const dora = kontakt("Dora Offen", "replied", "2026-08-20 10:00:00");
  const doraAntwort = entwurf(dora.url, "message", "Dora Offen");
  const emil = kontakt("Emil Neu", "accepted");
  const emilErst = entwurf(emil.url, "first", "Emil Neu");

  const r = heileAusChatliste([
    { participant: "Anna Beispiel", sinanZuletzt: true },
    { participant: "Ben Muster", sinanZuletzt: false },
    { participant: "Chris Gleich", sinanZuletzt: true },
    { participant: "Dora 🌟 Offen", sinanZuletzt: true },
  ]);
  assert.equal(status("contacts", anna.id), "messaged");
  assert.equal(status("drafts", annaErst), "discarded");
  assert.equal(status("contacts", ben.id), "replied", "Person schrieb zuletzt = hat geantwortet");
  assert.equal(status("drafts", benNach), "discarded", "keine Nachfassung an jemanden, der geantwortet hat");
  assert.equal(status("drafts", zwillingErst), "pending", "zwei gleiche Namen: nichts anfassen");
  assert.equal(status("drafts", doraAntwort), "discarded", "Sinan schrieb zuletzt: Antwort-Entwurf überholt");
  assert.equal(status("drafts", emilErst), "pending", "nicht in der Liste: bleibt");
  assert.ok(r.kontakte >= 2);
  assert.deepEqual(heileAusChatliste([{ participant: "Anna Beispiel", sinanZuletzt: true }]), { kontakte: 0, entwuerfe: 0 }, "zweiter Lauf ändert nichts");
});

test("Befund aus dem offenen Chat stuft nie zurück", () => {
  const f = kontakt("Fritz Fertig", "closed", "2026-08-01 10:00:00");
  heileKontakt(f.id, { personHatGeschrieben: true }, "Test");
  assert.equal(status("contacts", f.id), "closed");
});
