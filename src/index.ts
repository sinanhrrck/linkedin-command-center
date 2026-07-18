import cron from "node-cron";
import { db, setState, getMode } from "./db/index.js";
import { governor } from "./core/safetyGovernor.js";
import { events } from "./core/events.js";
import { publishPost } from "./modules/posting.js";
import { outreachTick } from "./modules/outreachTick.js";
import { checkAcceptances } from "./modules/acceptance.js";
import { feedTick } from "./modules/leadFeed.js";
import { generateInboxDrafts, generateFollowups } from "./modules/drafts.js";
import { runAutopilot } from "./modules/autopilot.js";
import { config } from "./config.js";
import { startTelegram } from "./modules/telegram.js";
import { countByStatus } from "./modules/crm.js";
import { saveLiveShot } from "./core/session.js";

/**
 * Zentraler Loop. Läuft lokal dauerhaft.
 * - Posting: fällige, freigegebene Posts über die offizielle API.
 * - Outreach: neue Leads vernetzen – der Governor entscheidet, ob/ wie viel JETZT geht.
 */

/**
 * Verhindert, dass sich derselbe Job überlappt. WICHTIG für die Sicherheit: Der Governor
 * hält seinen 20-75s-Abstand nur INNERHALB eines Durchlaufs. Laufen zwei Durchläufe parallel
 * (z.B. Start-Tick trifft auf Cron-Tick, oder ein Tick dauert länger als sein Intervall),
 * feuern beide gleichzeitig und die Taktung bricht. Real gemessen: zwei Vernetzungen 8s
 * auseinander, obwohl das Minimum 20s ist. Genau das verhindert diese Sperre.
 */
const laeuft = new Set<string>();
async function einzeln(name: string, fn: () => Promise<unknown>) {
  if (laeuft.has(name)) {
    console.info(`[${name}] läuft noch – Durchlauf übersprungen (kein Doppel-Feuern).`);
    return;
  }
  laeuft.add(name);
  try {
    await fn();
  } catch (e) {
    console.error(`[${name}] Fehler:`, e);
  } finally {
    laeuft.delete(name);
  }
}

// Heartbeat: Lebenszeichen des Loops, damit das Dashboard "Bot arbeitet" erkennt.
// Dazu ein Schnappschuss des (versteckten) Browsers für die Live-Ansicht im Dashboard –
// so siehst du, was der Bot gerade macht, ohne dass dir ein Fenster im Weg steht.
setState("engine_heartbeat", new Date().toISOString());
setState("engine_started", new Date().toISOString());
setState("engine_pid", String(process.pid)); // fürs saubere Stoppen vom Dashboard
cron.schedule("* * * * *", async () => {
  setState("engine_heartbeat", new Date().toISOString());
  await saveLiveShot();
});

// Beim Start EINMAL sofort loslegen, statt bis zu 12 Min auf den ersten Cron-Tick zu warten.
// (Governor drosselt weiterhin – Delay/Caps/Arbeitszeit gelten.)
setTimeout(async () => {
  await einzeln("acceptance", () => checkAcceptances());
  await einzeln("outreach", () => outreachTick());
  // Auch das Postfach sofort prüfen: wer den Bot mittags startet, soll nicht bis zur
  // nächsten Viertelstunde warten, um zu sehen, dass er arbeitet.
  await einzeln("drafts", async () => {
    if (getMode() !== "full") await generateInboxDrafts(8);
  });
}, 4000);

// Fällige Posts veröffentlichen (offizielle API, kein Governor nötig)
cron.schedule("* * * * *", async () => {
  const due = db
    .prepare(
      "SELECT id, body FROM posts WHERE status='approved' AND scheduled_for <= datetime('now') ORDER BY scheduled_for LIMIT 1",
    )
    .get() as { id: number; body: string } | undefined;
  if (!due) return;
  try {
    const urn = await publishPost(due.body);
    db.prepare("UPDATE posts SET status='posted', posted_urn=? WHERE id=?").run(urn, due.id);
    console.info(`[post] veröffentlicht: ${urn}`);
  } catch (e) {
    db.prepare("UPDATE posts SET status='failed' WHERE id=?").run(due.id);
    console.error(`[post] fehlgeschlagen (#${due.id}):`, e);
  }
});

// Outreach-Tick alle 12 Minuten. Der Governor drosselt intern (Caps/Warm-up/Zeitfenster/Delays).
cron.schedule("*/12 * * * *", () => einzeln("outreach", () => outreachTick()));

// Acceptance-Tracking STÜNDLICH in der Arbeitszeit (vorher nur 3x täglich).
// Rein lesend, kein Senden, kein Governor → kostet KEINE Sicherheit, spart aber Wartezeit:
// Jede erkannte Annahme erzeugt sofort den Erstnachricht-Entwurf. Vorher lag zwischen
// "hat angenommen" und "Entwurf liegt bereit" bis zu 8 Stunden, jetzt maximal 1.
cron.schedule("5 9-19 * * *", () => einzeln("acceptance", () => checkAcceptances()));

// Lead-Fütterung 2x täglich: gespeicherte Such-Quellen abgrasen (rein lesend).
// Hält die Pipeline gefüllt, damit der Outreach nicht trockenläuft.
cron.schedule("0 10,16 * * *", () => einzeln("feed", () => feedTick()));

// DM-Entwürfe 2x täglich generieren (rein lesend + Gemini, SENDET NICHT).
// Neue Entwürfe erscheinen als 'pending' im Dashboard zur Freigabe.
/**
 * Postfach ALLE 15 MINUTEN prüfen, solange der Bot läuft (vorher nur 2x täglich um 9:30/15:30 –
 * wer den Bot um 11:36 startete, sah bis 15:30 nichts passieren).
 *
 * Warum das trotz Gemini-Limit (~20/Tag) geht: Threads lesen kostet KEINEN KI-Aufruf. Die KI
 * läuft nur, wenn wirklich eine neue, unbeantwortete Nachricht da ist – und `hasOpenDraft`
 * überspringt Chats, für die schon ein Entwurf offen ist oder für die dieselbe Nachricht
 * bereits verworfen wurde. Die Kosten hängen also an der Zahl NEUER Nachrichten, nicht am Takt.
 * Ist das Gratis-Kontingent leer, springt Claude ein und meldet sich vorher (core/textLlm.ts).
 */
cron.schedule("*/15 9-19 * * *", () =>
  einzeln("drafts", async () => {
    // Im Vollautomatik-Modus übernimmt der Autopilot die Antworten – dann keine Entwürfe.
    if (getMode() !== "full") await generateInboxDrafts(8);
  }),
);

// Follow-ups 1x täglich: für Kontakte, die seit >=4 Tagen nicht geantwortet haben.
cron.schedule("0 11 * * *", () => einzeln("followup", () => generateFollowups(4, 5)));

// AUTOPILOT (voll-autonome Gespräche) – läuft nur, wenn Modus 'full' aktiv ist (self-gated).
cron.schedule(`*/${config.autopilot.intervalMinutes} * * * *`, () =>
  einzeln("autopilot", () => runAutopilot()),
);

// WOCHEN-BILANZ automatisch: Montag 9:05 Uhr per Telegram, ohne dass Sinan etwas tippt.
// "sowas muss automatisch passieren" – der Report kommt von allein, reife Kategorien
// mit Tap-Button zum Freischalten. events statt Direktaufruf (kein Import-Zyklus zu telegram).
cron.schedule("5 9 * * 1", () => events.emit("bilanz:woche"));

// Statusausgabe alle 15 Min (später via Telegram)
cron.schedule("*/15 * * * *", () => {
  const { rate, sample } = governor.acceptanceRate();
  console.info(
    `[status] pausiert=${governor.isPaused()} | Akzeptanzrate=${(rate * 100).toFixed(0)}% (n=${sample}) | CRM=`,
    countByStatus(),
  );
});

// Telegram-Steuerung starten (falls Token gesetzt).
startTelegram();

console.info("LinkedIn Command Center läuft. Posting-Scheduler + Outreach-Loop aktiv.");
console.info(governor.isPaused() ? "⚠ Governor ist pausiert." : "✓ Governor aktiv.");
