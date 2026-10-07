/**
 * STUFE „GESPRÄCHE VORSICHTIG“ (2026-10-07): Risiko je Antwort + Vertrauen aus Sinans Freigaben.
 * Eigene Temp-DB (TEST-FALLE: DB_PATH VOR dem ersten Import setzen).
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { antwortRisiko } from "../agent/domain/policy/risiko.js";

const dir = mkdtempSync(join(tmpdir(), "nextlead-agentvertrauen-"));
process.env.DB_PATH = join(dir, "v.sqlite");
const { db } = await import("../db/index.js");
const { agentVertrauen, darfAutonom, setzeManuelleStufe, manuelleStufe } = await import("../modules/agentVertrauen.js");

function entwurf(o: { status: "sent" | "approved" | "discarded"; geaendert?: boolean; intent?: string; reason?: string; quelle?: string; alterTage?: number }) {
  const ts = new Date(Date.now() - (o.alterTage ?? 0) * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
  db.prepare(
    `INSERT INTO drafts(kind,thread_url,participant,draft,ki_original,status,intent,rejection_reason,freigabe_quelle,freigegeben_at,created_at)
     VALUES('message','https://www.linkedin.com/messaging/thread/x/','P',?,?,?,?,?,?,?,?)`,
  ).run(o.geaendert ? "geändert" : "original", "original", o.status, o.intent ?? "agent-vorsichtig", o.reason ?? null, o.quelle ?? "mensch", ts, ts);
}
const reset = () => db.prepare("DELETE FROM drafts").run();

test("Risiko: Eröffnung niedrig, Bedarf mittel, Einwand/Angebot/Termin hoch, Skepsis immer hoch", () => {
  assert.equal(antwortRisiko("icebreaker", ["smalltalk"]), "niedrig");
  assert.equal(antwortRisiko("discovery", ["offene_frage"]), "niedrig");
  assert.equal(antwortRisiko("discovery", ["karriere_interesse"]), "mittel");
  assert.equal(antwortRisiko("bedarf", []), "mittel");
  assert.equal(antwortRisiko("vertrauen", ["positives_signal"]), "mittel");
  assert.equal(antwortRisiko("einwand", []), "hoch");
  assert.equal(antwortRisiko("call_angebot", ["positives_signal"]), "hoch");
  assert.equal(antwortRisiko("smalltalk", ["skepsis"]), "hoch");
  assert.equal(antwortRisiko("icebreaker", ["preisfrage"]), "hoch");
});

test("Start: ohne Entscheidungen Stufe 0, nichts autonom", () => {
  reset();
  const v = agentVertrauen();
  assert.equal(v.stufe, 0);
  assert.deepEqual(v.autonom, []);
  assert.equal(darfAutonom("niedrig", v), false);
  assert.equal(v.naechste?.stufe, 1);
  assert.equal(v.naechste?.fehlen, 10);
});

test("Stufe 1 ab 10 Entscheidungen mit 80 % unverändert; Stufe 2 ab 25", () => {
  reset();
  for (let i = 0; i < 8; i++) entwurf({ status: "sent" });
  entwurf({ status: "approved", geaendert: true });
  entwurf({ status: "discarded", reason: "too_salesy" });
  let v = agentVertrauen();
  assert.equal(v.entscheidungen, 10); assert.equal(v.unveraendert, 8); assert.equal(v.abgelehnt, 1);
  assert.equal(v.stufe, 1);
  assert.equal(darfAutonom("niedrig", v), true);
  assert.equal(darfAutonom("mittel", v), false);
  for (let i = 0; i < 15; i++) entwurf({ status: "sent" });
  v = agentVertrauen();
  assert.equal(v.stufe, 2);
  assert.equal(darfAutonom("mittel", v), true);
  assert.equal(darfAutonom("hoch", v), false);
});

test("Zu viele Änderungen: Quote unter 80 % → keine Stufe trotz vieler Entscheidungen", () => {
  reset();
  for (let i = 0; i < 6; i++) entwurf({ status: "sent" });
  for (let i = 0; i < 6; i++) entwurf({ status: "sent", geaendert: true });
  assert.equal(agentVertrauen().stufe, 0);
});

test("Veto: 3 Ablehnungen unter den letzten 10 → eine Stufe zurück", () => {
  reset();
  for (let i = 0; i < 30; i++) entwurf({ status: "sent", alterTage: 5 });
  let v = agentVertrauen();
  assert.equal(v.stufe, 2);
  for (let i = 0; i < 3; i++) entwurf({ status: "discarded", reason: "artificial" });
  v = agentVertrauen();
  assert.equal(v.veto, true);
  assert.equal(v.verdient, 2);
  assert.equal(v.stufe, 1);
});

test("Zählt nur Sinans Entscheidungen über Agent-Entwürfe: Auto-Freigaben, Stumm, Verfall, Fremd-Entwürfe nicht", () => {
  reset();
  for (let i = 0; i < 12; i++) entwurf({ status: "sent", quelle: "auto" });
  for (let i = 0; i < 12; i++) entwurf({ status: "discarded", reason: "stumm" });
  for (let i = 0; i < 12; i++) entwurf({ status: "discarded", reason: "expired" });
  for (let i = 0; i < 12; i++) entwurf({ status: "sent", intent: "chance" });
  for (let i = 0; i < 12; i++) entwurf({ status: "sent", alterTage: 90 });
  assert.equal(agentVertrauen().entscheidungen, 0);
});

test("Regler: feste Stufe schlägt Zahlen und Veto, „automatisch“ gibt die Steuerung zurück", () => {
  reset();
  for (let i = 0; i < 3; i++) entwurf({ status: "discarded", reason: "artificial" });
  assert.equal(agentVertrauen().stufe, 0);
  setzeManuelleStufe(3);
  let v = agentVertrauen();
  assert.equal(v.stufe, 3); assert.equal(v.manuell, 3); assert.equal(v.verdient, 0);
  assert.equal(darfAutonom("hoch", v), true);
  setzeManuelleStufe(null);
  assert.equal(manuelleStufe(), null);
  assert.equal(agentVertrauen().stufe, 0);
  assert.throws(() => setzeManuelleStufe(7));
});
