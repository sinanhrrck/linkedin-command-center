import { db } from "../db/index.js";
import { generateText } from "../core/textLlm.js";
import { handleIncomingMessage, type Entscheidung } from "../agent/application/handleIncomingMessage.js";
import { neueConversation, type Conversation } from "../agent/domain/conversation.js";
import { analyzeLlm, replyLlm } from "../agent/runtime/llmKanaele.js";
import { firstMessage } from "./personalize.js";
import { angebotsWahl } from "./angebot.js";
import { aecAktiv, gespraechsKontext, getAusrichtung } from "./ausrichtung.js";
import { MAX_AKTIVE_BEISPIELE, MAX_AKTIVE_REGELN, aktiveTrainingsRegeln, type RegelBereich } from "./trainingsRegeln.js";
import { saubern } from "../context.js";

/**
 * TRAINING (2026-10-23, Sinan: „eine Seite, auf der jeder Chats simulieren und danach Feedback geben
 * kann, damit sich der Bot verbessert“).
 *
 * Ein Mensch spielt den Lead, der Bot antwortet über GENAU die Pipeline, die live antwortet:
 * Erstnachricht über `firstMessage`, jede Antwort über `handleIncomingMessage` mit `gespraechsKontext()`,
 * `angebotsWahl()` und denselben KI-Kanälen wie der Agent. Nur der Ausgang ist anders: nichts geht an
 * LinkedIn, nichts landet in contacts/actions/crm_stage_events/drafts – eine Simulation darf keine
 * echte Kennzahl verändern.
 *
 * LERNEN: Am Ende bewertet der Tester (Zusage ja/vielleicht/nein, Note, Freitext). Daraus schlägt die KI
 * höchstens drei Regeln vor. Sie wirken ERST, wenn ein Mensch sie annimmt (Sinans Vorgabe) – ein
 * einzelnes falsches Feedback soll nie direkt verändern, was an echte Leads rausgeht.
 */

export type SimNachricht = { sender: string; text: string; art?: "bot" | "lead" | "hinweis" | "entwurf" };
export type SimChat = {
  id: number; tester: string | null; lead_name: string; lead_headline: string | null; ausrichtung: string;
  verlauf: SimNachricht[]; status: "laeuft" | "uebergabe" | "beendet"; ende_grund: string | null;
  zusage: string | null; note: number | null; feedback: string | null; created_at: string; beendet_at: string | null;
};

const BOT = "Sinan";
const text = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

type Zeile = Omit<SimChat, "verlauf"> & { verlauf: string; conversation: string | null };
function laden(id: number): (SimChat & { conversation: Conversation | null }) | null {
  const r = db.prepare("SELECT * FROM sim_chats WHERE id=?").get(id) as Zeile | undefined;
  if (!r) return null;
  return { ...r, verlauf: JSON.parse(r.verlauf || "[]"), conversation: r.conversation ? JSON.parse(r.conversation) : null };
}
const oeffentlich = (c: SimChat & { conversation?: unknown }): SimChat => {
  const { conversation: _c, ...rest } = c as SimChat & { conversation?: unknown };
  return rest;
};

export function simChat(id: number): SimChat | null {
  const c = laden(id);
  return c ? oeffentlich(c) : null;
}

/** Neue Simulation: legt den Chat an und schreibt die echte Erstnachricht. */
export async function starteSimulation(input: { tester?: unknown; name?: unknown; headline?: unknown }): Promise<SimChat> {
  const name = text(input.name, 60) || "Max Muster";
  const headline = text(input.headline, 200) || "Auszubildender Bankkaufmann";
  const tester = text(input.tester, 60) || null;
  // Unechter Kontakt (id -1): firstMessage liest Profil-Fakten/Zielgruppe über die id und findet nichts.
  const opener = await firstMessage({ id: -1, profile_url: "sim:", full_name: name, headline, status: "accepted", zielgruppe: "azubi" });
  if (!opener.trim()) throw new Error("Die KI hat keine Erstnachricht geliefert. Bitte erneut versuchen.");
  const verlauf: SimNachricht[] = [{ sender: BOT, text: opener, art: "bot" }];
  const info = db.prepare(
    "INSERT INTO sim_chats(tester,lead_name,lead_headline,ausrichtung,verlauf) VALUES(?,?,?,?,?)",
  ).run(tester, name, headline, getAusrichtung(), JSON.stringify(verlauf));
  const id = Number(info.lastInsertRowid);
  const conv = neueConversation(`sim:${id}`, name, name);
  db.prepare("UPDATE sim_chats SET conversation=? WHERE id=?").run(JSON.stringify(conv), id);
  return simChat(id)!;
}

/** Der Tester schreibt als Lead, der Bot antwortet wie live. */
export async function simAntwort(id: number, eingabe: unknown): Promise<SimChat> {
  const c = laden(id);
  if (!c) throw new Error("Diesen Trainings-Chat gibt es nicht.");
  if (c.status !== "laeuft") throw new Error("Dieser Chat ist abgeschlossen. Bitte bewerten oder einen neuen starten.");
  const nachricht = text(eingabe, 1500);
  if (!nachricht) throw new Error("Leere Nachricht.");

  const verlauf: SimNachricht[] = [...c.verlauf, { sender: c.lead_name, text: nachricht, art: "lead" }];
  // Für die Pipeline zählen nur echte Chatnachrichten; Hinweise sind nur für den Tester. Ein Entwurf,
  // den Sinan geprüft hätte, zählt als gesendet – sonst liefe das Gespräch ohne ihn weiter.
  const fuerBot = verlauf.filter((m) => m.art !== "hinweis").map((m) => ({ sender: m.sender, text: m.text }));
  const conv = c.conversation ?? neueConversation(`sim:${id}`, c.lead_name, c.lead_name);

  const e: Entscheidung = await handleIncomingMessage({ ...conv, status: "aktiv" }, fuerBot, {
    persona: gespraechsKontext(),
    angebot: angebotsWahl(new Date(), undefined, { nurAec: aecAktiv() }),
    analyzeLlm, replyLlm, maxRegenerierungen: 1,
  });

  let status: SimChat["status"] = "laeuft";
  let grund: string | null = null;
  if (e.typ === "senden") {
    verlauf.push({ sender: BOT, text: e.text, art: "bot" });
  } else if (e.typ === "eskalieren") {
    if (e.conversation.status === "gebucht") {
      status = "uebergabe";
      grund = e.grund;
      verlauf.push({ sender: "System", text: `Ab hier übernimmt Sinan selbst: ${e.grund}.`, art: "hinweis" });
    } else if (e.entwurf) {
      verlauf.push({ sender: BOT, text: e.entwurf, art: "entwurf" });
      verlauf.push({ sender: "System", text: `Diese Antwort wäre live nicht automatisch rausgegangen, sondern als Entwurf zu Sinan (${e.grund}).`, art: "hinweis" });
    } else {
      verlauf.push({ sender: "System", text: `Der Bot hätte hier an Sinan übergeben: ${e.grund}.`, art: "hinweis" });
    }
  } else if (e.typ === "schweigen") {
    if (e.art === "dauerhaft") { status = "beendet"; grund = e.grund; }
    verlauf.push({ sender: "System", text: e.art === "dauerhaft"
      ? `Der Bot würde ab hier gar nicht mehr antworten: ${e.grund}.`
      : `Der Bot würde auf diese Nachricht bewusst nicht antworten (${e.grund}). Du kannst trotzdem weiterschreiben.`, art: "hinweis" });
  } else {
    verlauf.push({ sender: "System", text: `Keine Antwort: ${e.grund}.`, art: "hinweis" });
  }

  db.prepare("UPDATE sim_chats SET verlauf=?,conversation=?,status=?,ende_grund=COALESCE(?,ende_grund) WHERE id=?")
    .run(JSON.stringify(verlauf), JSON.stringify(e.conversation), status, grund, id);
  return simChat(id)!;
}

export type RegelVorschlag = { bereich: RegelBereich; regel: string; begruendung: string };

/** Ein KI-Aufruf: aus Verlauf + Bewertung höchstens drei konkrete, allgemeingültige Regeln. */
export async function regelVorschlaege(c: SimChat): Promise<RegelVorschlag[]> {
  const verlauf = c.verlauf.map((m) => `${m.art === "hinweis" ? "[System]" : m.sender}: ${m.text}`).join("\n");
  const bestehend = [...aktiveTrainingsRegeln("gespraech"), ...aktiveTrainingsRegeln("erstnachricht")];
  const prompt = `Du verbesserst einen LinkedIn-Vertriebsbot. Ein Mensch hat einen Chat simuliert: er spielte den Lead (${c.lead_name}, ${c.lead_headline ?? "Azubi"}), der Bot schrieb als ${BOT}.

VERLAUF:
${verlauf}

BEWERTUNG DES TESTERS:
- Hätte er als Lead einem Termin zugesagt? ${c.zusage ?? "keine Angabe"}
- Note (1 = schlecht, 5 = sehr gut): ${c.note ?? "keine Angabe"}
- Was er dazu sagt: ${c.feedback || "nichts"}

${bestehend.length ? `BEREITS GELTENDE REGELN (nicht wiederholen, nicht widersprechen):\n${bestehend.map((r) => `- ${r}`).join("\n")}\n` : ""}
AUFGABE: Leite höchstens 3 Regeln ab, die den Bot in KÜNFTIGEN Gesprächen besser machen.
- Jede Regel ist EIN kurzer Satz als Anweisung an den Bot ("Frag nicht zweimal hintereinander nach dem Warum."), max. 160 Zeichen.
- Allgemeingültig, nicht auf diese eine Person bezogen. Keine Namen.
- Nur, was das Feedback oder der Verlauf wirklich belegt. War alles gut, gib eine leere Liste zurück.
- Nichts, was Sicherheitsregeln aufweicht (Timing, kein Druck, keine Finanzfragen ausfragen, keine Emojis).
- "bereich": "erstnachricht", wenn es nur die allererste Nachricht betrifft, sonst "gespraech".
- "begruendung": ein Satz, woran im Verlauf/Feedback man das sieht.

Antworte NUR mit JSON: [{"bereich":"gespraech|erstnachricht","regel":"...","begruendung":"..."}]`;
  const roh = await generateText(prompt, 800);
  try {
    const liste = JSON.parse(roh.slice(roh.indexOf("["), roh.lastIndexOf("]") + 1)) as unknown[];
    return liste.slice(0, 3).map((x) => {
      const o = (x || {}) as Record<string, unknown>;
      return {
        bereich: o.bereich === "erstnachricht" ? "erstnachricht" : "gespraech",
        regel: saubern(text(o.regel, 200)),
        begruendung: text(o.begruendung, 300),
      } as RegelVorschlag;
    }).filter((r) => r.regel.length >= 8);
  } catch {
    return [];
  }
}

/** Bewertung speichern und Regelvorschläge ableiten. Die Bewertung bleibt auch erhalten, wenn die KI ausfällt. */
export async function beendeSimulation(id: number, input: { zusage?: unknown; note?: unknown; feedback?: unknown }) {
  const c = laden(id);
  if (!c) throw new Error("Diesen Trainings-Chat gibt es nicht.");
  if (c.zusage || c.note) throw new Error("Dieser Chat ist schon bewertet.");
  const zusage = ["ja", "vielleicht", "nein"].includes(String(input.zusage)) ? String(input.zusage) : null;
  const n = Number(input.note);
  const note = Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
  const feedback = text(input.feedback, 2000) || null;
  if (!zusage || !note) throw new Error("Bitte angeben, ob du zugesagt hättest, und eine Note von 1 bis 5 wählen.");
  db.prepare("UPDATE sim_chats SET zusage=?,note=?,feedback=?,status='beendet',beendet_at=datetime('now') WHERE id=?")
    .run(zusage, note, feedback, id);

  let vorschlaege: RegelVorschlag[] = [];
  let kiFehler: string | null = null;
  try { vorschlaege = await regelVorschlaege(simChat(id)!); }
  catch (err) { kiFehler = String((err as Error)?.message ?? err).slice(0, 160); }
  const ins = db.prepare("INSERT INTO sim_regeln(chat_id,bereich,regel,begruendung) VALUES(?,?,?,?)");
  for (const v of vorschlaege) ins.run(id, v.bereich, v.regel, v.begruendung);
  return { chat: simChat(id)!, vorschlaege: vorschlaege.length, kiFehler };
}

/** Annehmen/Verwerfen eines Vorschlags bzw. Abschalten einer aktiven Regel. */
export function regelEntscheiden(id: number, aktion: "annehmen" | "verwerfen" | "aus", neuerText?: unknown): void {
  const r = db.prepare("SELECT status FROM sim_regeln WHERE id=?").get(id) as { status: string } | undefined;
  if (!r) throw new Error("Diese Regel gibt es nicht.");
  if (aktion === "annehmen") {
    if (r.status !== "vorschlag" && r.status !== "aus") throw new Error("Diese Regel ist nicht mehr offen.");
    const bereich = (db.prepare("SELECT bereich FROM sim_regeln WHERE id=?").get(id) as { bereich: string }).bereich;
    const beispiel = bereich === "beispiel";
    const aktiv = (db.prepare(`SELECT COUNT(*) n FROM sim_regeln WHERE status='aktiv' AND ${beispiel ? "bereich='beispiel'" : "bereich<>'beispiel'"}`).get() as { n: number }).n;
    const max = beispiel ? MAX_AKTIVE_BEISPIELE : MAX_AKTIVE_REGELN;
    if (aktiv >= max) throw new Error(`Höchstens ${max} ${beispiel ? "Beispiele" : "Regeln"} gleichzeitig. Schalte erst ${beispiel ? "eins" : "eine"} ab.`);
    const t = neuerText === undefined ? null : saubern(text(neuerText, beispiel ? 500 : 200));
    if (t !== null && t.length < 8) throw new Error("Die Regel ist zu kurz.");
    db.prepare("UPDATE sim_regeln SET status='aktiv',regel=COALESCE(?,regel),entschieden_at=datetime('now') WHERE id=?").run(t, id);
  } else if (aktion === "verwerfen") {
    if (r.status !== "vorschlag") throw new Error("Diese Regel ist nicht mehr offen.");
    db.prepare("UPDATE sim_regeln SET status='verworfen',entschieden_at=datetime('now') WHERE id=?").run(id);
  } else {
    if (r.status !== "aktiv") throw new Error("Diese Regel ist nicht aktiv.");
    db.prepare("UPDATE sim_regeln SET status='aus',entschieden_at=datetime('now') WHERE id=?").run(id);
  }
}

/** Alles, was die Trainings-Ansicht braucht. Rein lesend. */
export function trainingUebersicht() {
  const chats = (db.prepare(
    `SELECT id,tester,lead_name,ausrichtung,status,zusage,note,feedback,created_at,beendet_at,modus,quelle,
            json_array_length(verlauf) nachrichten FROM sim_chats ORDER BY id DESC LIMIT 30`,
  ).all()) as { id: number; zusage: string | null; note: number | null }[];
  const bewertet = db.prepare(
    "SELECT COUNT(*) n, SUM(zusage='ja') ja, AVG(note) note FROM sim_chats WHERE note IS NOT NULL",
  ).get() as { n: number; ja: number | null; note: number | null };
  const regeln = db.prepare(
    `SELECT r.id,r.chat_id,r.bereich,r.regel,r.begruendung,r.status,r.created_at,c.tester
       FROM sim_regeln r LEFT JOIN sim_chats c ON c.id=r.chat_id
      WHERE r.status IN ('vorschlag','aktiv','aus') ORDER BY r.status='vorschlag' DESC, r.id DESC LIMIT 80`,
  ).all() as { id: number; chat_id: number | null; bereich: RegelBereich; regel: string; begruendung: string | null; status: string; created_at: string; tester: string | null }[];
  return {
    ausrichtung: getAusrichtung(),
    chats,
    statistik: { bewertet: bewertet.n, zusagen: bewertet.ja ?? 0, durchschnitt: bewertet.note ? Math.round(bewertet.note * 10) / 10 : null },
    regeln,
  };
}

/**
 * IMPORT VON DER TRAININGSSEITE (claude.ai-Artifact, 2026-10-23). Die Seite läuft ohne Zugriff auf
 * den Heimserver – der Server ist von außen bewusst unerreichbar. Sinan exportiert dort eine Datei und
 * lädt sie hier hoch. Wiederholbar: jede Sitzung und jeder Vorschlag hat einen festen Schlüssel
 * (`link:<runId>`), ein zweiter Import derselben Datei legt nichts doppelt an.
 * Vorschläge kommen IMMER als `vorschlag` an – die Datei ist Fremdeingabe, wirksam wird erst die Freigabe.
 */
export type ImportErgebnis = { sitzungen: number; neueSitzungen: number; vorschlaege: number };
export function importiereTrainings(daten: unknown): ImportErgebnis {
  const d = (daten || {}) as { format?: unknown; sitzungen?: unknown };
  if (d.format !== "nextlead-training" || !Array.isArray(d.sitzungen))
    throw new Error("Das ist keine Export-Datei der Trainingsseite.");
  if (d.sitzungen.length > 500) throw new Error("Zu viele Sitzungen in einer Datei (höchstens 500).");
  const res: ImportErgebnis = { sitzungen: d.sitzungen.length, neueSitzungen: 0, vorschlaege: 0 };
  const insChat = db.prepare(
    `INSERT OR IGNORE INTO sim_chats(tester,lead_name,lead_headline,ausrichtung,verlauf,status,zusage,note,feedback,created_at,beendet_at,modus,quelle,quelle_key)
     VALUES(?,?,?,?,?,'beendet',?,?,?,?,?,?,'link',?)`);
  const insRegel = db.prepare("INSERT OR IGNORE INTO sim_regeln(chat_id,bereich,regel,begruendung,quelle_key) VALUES(?,?,?,?,?)");
  const zeit = (v: unknown) => { const t = new Date(String(v ?? "")); return Number.isNaN(t.getTime()) ? null : t.toISOString().slice(0, 19).replace("T", " "); };
  db.transaction(() => {
    for (const roh of d.sitzungen as unknown[]) {
      const s = (roh || {}) as Record<string, unknown>;
      const runId = text(s.id, 80).replace(/[^\w.:@+~-]/g, "");
      if (!runId) continue;
      const key = `link:${runId}`;
      const lead = (s.lead || {}) as Record<string, unknown>;
      const modus = s.modus === "bot" ? "bot" : "lead";
      const verlauf: SimNachricht[] = (Array.isArray(s.verlauf) ? s.verlauf : []).slice(0, 80).map((m) => {
        const n = (m || {}) as Record<string, unknown>;
        const sinan = n.rolle === "sinan";
        return { sender: sinan ? BOT : text(lead.name, 60) || "Lead", text: text(n.text, 1500), art: sinan ? "bot" : "lead" } as SimNachricht;
      }).filter((m) => m.text);
      const e = (s.ergebnis || {}) as Record<string, unknown>;
      const zusage = ["ja", "vielleicht", "nein"].includes(String(e.zusage)) ? String(e.zusage) : null;
      const note = Number.isInteger(Number(e.note)) && Number(e.note) >= 1 && Number(e.note) <= 5 ? Number(e.note) : null;
      const feedback = [text(e.feedback, 2000), text(e.kiUrteil, 600)].filter(Boolean).join(" · ") || null;
      const info = insChat.run(text(s.tester, 60) || null, text(lead.name, 60) || "Lead", text(lead.headline, 200) || null,
        s.ausrichtung === "aec" ? "aec" : "standard", JSON.stringify(verlauf), zusage, note, feedback,
        zeit(s.erstellt) ?? zeit(Date.now()), zeit(s.beendet), modus, key);
      const chatId = info.changes
        ? Number(info.lastInsertRowid)
        : (db.prepare("SELECT id FROM sim_chats WHERE quelle_key=?").get(key) as { id: number }).id;
      if (info.changes) res.neueSitzungen++;
      (Array.isArray(s.vorschlaege) ? s.vorschlaege : []).slice(0, 10).forEach((v, i) => {
        const o = (v || {}) as Record<string, unknown>;
        const bereich: RegelBereich = o.bereich === "erstnachricht" ? "erstnachricht" : o.bereich === "beispiel" ? "beispiel" : "gespraech";
        const t = saubern(text(o.text, bereich === "beispiel" ? 500 : 200));
        if (t.length < 8) return;
        res.vorschlaege += insRegel.run(chatId, bereich, t, text(o.begruendung, 300) || null, `${key}:${i}`).changes;
      });
    }
  })();
  return res;
}
