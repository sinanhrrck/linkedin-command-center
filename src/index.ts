import net from "node:net";
import { createRequire } from "node:module";
import cron from "node-cron";
import { db, setState, getState, getMode, setMode, getAgentMode, setAgentMode } from "./db/index.js";
import { governor } from "./core/safetyGovernor.js";
import { events } from "./core/events.js";
import { publishPost } from "./modules/posting.js";
import { publishPostBrowser } from "./modules/outreach.js";
import { outreachTick } from "./modules/outreachTick.js";
import { checkAcceptances } from "./modules/acceptance.js";
import { feedTick } from "./modules/leadFeed.js";
import { generateInboxDrafts, generateFollowups, sendApprovedDrafts as sendeFreigegebene, reviveChat, pitchZuNachricht } from "./modules/drafts.js";
import { autoFreigabe } from "./modules/freigabe.js";
import { kiWochenanalyse } from "./modules/kiAnalyse.js";
import { kiLeadBewertung } from "./modules/leadBewertung.js";
import { kiNeueStile } from "./modules/kiStile.js";

/** Vor jedem Versandlauf: automatische Freigabe (Opt-in, standardmäßig aus), dann Versand über den Governor. */
async function sendApprovedDrafts(limit: number): Promise<number> {
  try { autoFreigabe(); } catch (e) { console.error("[freigabe] Auto-Freigabe fehlgeschlagen:", (e as Error)?.message); }
  return sendeFreigegebene(limit);
}
import { generatePostIdeas } from "./modules/content.js";
import { commentTick } from "./modules/comment.js";
import { scanNetzwerk, generateReaktivierung } from "./modules/netzwerk.js";
import { campaignTick } from "./modules/campaignRunner.js";
import { agentTick } from "./agent/runtime/agentRunner.js";
import { selbstCheck } from "./modules/healthcheck.js";
import { config } from "./config.js";
import { startTelegram } from "./modules/telegram.js";
import { heartbeatAlter, kuerzeNeustartProtokoll, markiereNeustartsBerichtet, offeneNeustartMeldungen, protokolliereNeustart, stillstandGrund } from "./modules/engineWatch.js";
import { countByStatus, resetHaengendeInvites } from "./modules/crm.js";
import { closeSession, saveLiveShot } from "./core/session.js";
import { SerialJobQueue } from "./core/jobQueue.js";
import { ensureDailyBackup } from "./core/backups.js";
import { syncAnonymousLearning } from "./modules/learning.js";
import { backfillCrmStages } from "./modules/crmStages.js";
import { runReadJobWhenDue } from "./modules/lowRead.js";
import { backfillRelationshipSignals } from "./modules/relationshipPolicy.js";
import { backfillContactIdentities } from "./modules/contactIdentity.js";
import { backfillContactTimeline } from "./modules/contactTimeline.js";
import { backfillCampaignWorkflows, syncCampaignTargetForDraft } from "./modules/campaignWorkflow.js";
import { backfillConversationMemories, backfillDraftContexts } from "./modules/conversationMemory.js";
import { LeseBudgetErschoepft } from "./core/leseBudget.js";
import { jobRunPermission, recordJobFailure, recordJobSuccess } from "./core/jobReliability.js";
import { JobTimeoutError, JOB_TIMEOUT_MS, DEFAULT_JOB_TIMEOUT_MS, runWithJobTimeout } from "./core/jobTimeout.js";
import { istServerModus, logZeitzone, serverErststart } from "./core/serverMode.js";
import { pruefeSitzungBeimStart } from "./modules/sitzungsCheck.js";

// Beginn der Geschäftszeit (config.safety.workingHours.start). Alle Morgen-Jobs hängen daran,
// damit „ab 7 Uhr“ nicht nur im Governor, sondern auch in den Cron-Zeiten gilt.
const START_STUNDE = config.safety.workingHours.start;

backfillCrmStages();
const identityBackfill = backfillContactIdentities();
backfillContactTimeline();
backfillConversationMemories();
if (identityBackfill.unresolved) console.info(`[kontaktidentitaet] ${identityBackfill.unresolved} Zuordnung(en) brauchen eine manuelle Pruefung.`);
const relationshipBackfill = backfillRelationshipSignals();
if (relationshipBackfill) console.info(`[beziehungsschutz] ${relationshipBackfill} bestehende Wiedervorlage(n)/Sperre(n) übernommen.`);
const draftContexts = backfillDraftContexts();
if (draftContexts.blocked) console.info(`[gesprächskontext] ${draftContexts.blocked} widersprüchliche proaktive Entwürfe blockiert.`);
const campaignBackfill = backfillCampaignWorkflows();
if (campaignBackfill.failed) console.info(`[kampagnen] ${campaignBackfill.failed} festgefahrene Ziele sind jetzt sichtbar und manuell wiederholbar.`);

/**
 * Zentraler Loop. Läuft lokal dauerhaft.
 * - Posting: fällige, freigegebene Posts über die offizielle API.
 * - Outreach: neue Leads vernetzen – der Governor entscheidet, ob/ wie viel JETZT geht.
 */

/**
 * GLOBALER ENGINE-LOCK. Sämtliche Jobs teilen sich exakt einen Playwright-Tab
 * (session.newPage() liefert den bestehenden Tab). Deshalb reicht eine Sperre pro Jobname
 * NICHT: Ein Inbox-Scan, Agent und Versand könnten sich sonst gegenseitig mitten im Ablauf
 * weg-navigieren. Das verursachte fehlgeschlagene bzw. doppelte Nachrichten.
 *
 * Jobs werden seriell ausgeführt. Ein wartender Tick bleibt dabei erhalten und wird nach
 * Priorität abgearbeitet – freigegebene Nachrichten werden nicht von langem Outreach verdrängt.
 */
const jobQueue = new SerialJobQueue((snapshot) => {
  setState("engine_active_job", snapshot.activeJob ?? "");
  setState("engine_queue_length", String(snapshot.queuedJobs));
  setState("engine_queue_next", snapshot.nextJob ?? "");
});

async function einzeln(name: string, fn: () => Promise<unknown>, priority = 50) {
  const erlaubnis = jobRunPermission(name);
  if (!erlaubnis.allowed) {
    console.info(`[${name}] kontrolliert zurückgestellt – ${erlaubnis.reason}`);
    return false;
  }
  const protokolliert = async () => {
    const info = db.prepare("INSERT INTO bot_activity(job,status) VALUES(?,'running')").run(name);
    const id = Number(info.lastInsertRowid);
    try {
      const result = await runWithJobTimeout(name, fn, {
        timeoutMs: JOB_TIMEOUT_MS[name] ?? DEFAULT_JOB_TIMEOUT_MS,
        onTimeout: async (timeout) => {
          db.prepare("UPDATE bot_activity SET detail=? WHERE id=?")
            .run(`${timeout.message} – Browser wird sicher beendet`, id);
          console.warn(`[${name}] ${timeout.message}; gemeinsamer Browser wird geschlossen.`);
          await closeSession();
        },
      });
      const detail = typeof result === "number"
        ? result > 0 ? `${result} Element${result === 1 ? "" : "e"} bearbeitet` : "Geprüft, nichts Neues"
        : "Prüfung abgeschlossen";
      db.prepare("UPDATE bot_activity SET status='done',detail=?,finished_at=datetime('now') WHERE id=?").run(detail, id);
      recordJobSuccess(name);
      // Das Protokoll ist eine Betriebsanzeige, kein ewiges Audit-Log.
      db.prepare("DELETE FROM bot_activity WHERE id NOT IN (SELECT id FROM bot_activity ORDER BY id DESC LIMIT 300)").run();
      return result;
    } catch (error) {
      if (error instanceof LeseBudgetErschoepft) {
        db.prepare("UPDATE bot_activity SET status='skipped',detail=?,finished_at=datetime('now') WHERE id=?")
          .run(`Geplant pausiert: ${error.message}`, id);
        console.info(`[${name}] wartet planmäßig – ${error.message}`);
        return null;
      }
      const timeout = error instanceof JobTimeoutError;
      db.prepare("UPDATE bot_activity SET status=?,detail=?,finished_at=datetime('now') WHERE id=?")
        .run(timeout ? "timed_out" : "failed", String((error as Error)?.message || error).slice(0, 180), id);
      const reliability = recordJobFailure(name, error);
      if (reliability.status === "dead") {
        console.error(`[${name}] nach ${reliability.consecutiveFailures} Fehlern angehalten – im Dashboard prüfen.`);
      }
      throw error;
    }
  };
  const { queued, done } = jobQueue.enqueue(name, protokolliert, priority);
  if (!queued) {
    console.info(`[${name}] bereits aktiv oder vorgemerkt.`);
    return false;
  }
  try {
    await done;
    return true;
  } catch (e) {
    console.error(`[${name}] Fehler:`, e);
    return false;
  }
}

// Heartbeat: Lebenszeichen des Loops, damit das Dashboard "Bot arbeitet" erkennt.
// Dazu ein Schnappschuss des (versteckten) Browsers für die Live-Ansicht im Dashboard –
// so siehst du, was der Bot gerade macht, ohne dass dir ein Fenster im Weg steht.
// MIGRATION: alter Modus 'full' bediente den (jetzt stillgelegten) Autopilot. Solche Nutzer
// sanft auf den neuen Sales-Agent heben, damit ihre Gespräche nicht plötzlich unbeantwortet bleiben.
if (getMode() === "full") {
  setMode("semi");
  if (getAgentMode() === "off") setAgentMode("live");
  console.info("[migration] Modus 'full' → Sales-Agent (semi + agent live).");
}

/**
 * EINZEL-ENGINE-SPERRE via OS-PORTBINDUNG (RENNSICHER, start-weg-unabhängig).
 *
 * Warum nicht mehr der frühere Heartbeat-Check: der prüfte "läuft schon eine?" und schrieb ERST
 * danach die eigene PID – dazwischen klafft ein Zeitfenster. Starten zwei Engines fast gleichzeitig
 * (genau der reale Fall: alte App aus einem DMG + neue aus dem Programme-Ordner), sehen BEIDE noch
 * keinen frischen Heartbeat → beide laufen los → Doppel-Nachrichten/Doppel-Vernetzungen.
 *
 * Eine Portbindung dagegen ist vom Betriebssystem ATOMAR exklusiv: die zweite Bindung scheitert
 * garantiert mit EADDRINUSE – ganz ohne Zeitfenster oder tote-PID-Rätsel. Der Socket bleibt für die
 * gesamte Prozess-Lebensdauer offen (= der Lock); stirbt der Prozess (auch per kill -9), gibt das OS
 * den Port automatisch wieder frei (self-healing, kein hängender Lock). Top-Level-await: alle
 * folgenden Start-Schritte warten, bis der Lock steht.
 */
const ENGINE_LOCK_PORT = 43217; // nur lokal (127.0.0.1), kein echter Dienst – reine Sperre
let lockServer: import("net").Server | null = null; // Referenz halten, damit der Lock offen bleibt
function versucheBinden(): Promise<"ok" | "belegt" | "fehler"> {
  return new Promise((resolve) => {
    const lock = net.createServer();
    lock.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") return resolve("belegt");
      console.warn(`[engine] Lock-Port ${ENGINE_LOCK_PORT} nicht bindbar (${err.code}) – fahre ohne Portlock fort.`);
      resolve("fehler");
    });
    lock.listen(ENGINE_LOCK_PORT, "127.0.0.1", () => {
      lock.unref(); // hält den Prozess nicht künstlich am Leben
      lockServer = lock;
      resolve("ok");
    });
  });
}
{
  let stand = await versucheBinden();
  if (stand === "belegt") {
    /**
     * NEUESTER GEWINNT (Fix 2026-07-29): Der Port wird von einer ANDEREN Engine gehalten – oft eine
     * VERALTETE Waise (Parent-PID 1) aus einer Vorversion, die nach einem Update mit altem Code
     * weiterläuft und so JEDEN neuen Start blockiert (Symptom: "Nachrichten gehen nicht raus").
     * Diese – neu gestartete – Engine löst sie ab: die zuvor gemeldete Engine (engine_pid) killen,
     * kurz warten, EINMAL erneut binden. Erst wenn der Port DANN noch belegt ist, liegt ein echter
     * Gleichzeitig-Start vor → beenden. Der Doppel-Engine-Schutz bleibt (es läuft nur eine – die neueste).
     */
    const fremd = Number(getState("engine_pid") || 0);
    if (fremd && fremd !== process.pid) {
      try {
        process.kill(fremd, 0); // lebt der andere Prozess noch?
        console.warn(`[engine] Lock-Port belegt von Engine PID ${fremd} – löse sie ab (neuester Code gewinnt).`);
        try { process.kill(fremd, "SIGTERM"); } catch { /* schon weg */ }
      } catch { /* fremd bereits tot */ }
    }
    await new Promise((r) => setTimeout(r, 1200));
    stand = await versucheBinden();
    if (stand === "belegt") {
      console.error("[engine] Lock-Port weiterhin belegt (echter Doppelstart) – dieser Prozess beendet sich.");
      process.exit(0);
    }
  }
}

// Beim Start hängengebliebene Lead-Ansprüche freigeben: Starb ein Prozess mitten im Vernetzen,
// blieb ein Lead auf 'inviting' stehen. Wieder auf 'new' setzen, damit er normal weiterläuft.
{
  const frei = resetHaengendeInvites();
  if (frei) console.info(`[start] ${frei} hängende Lead-Ansprüche ('inviting') wieder freigegeben.`);
}

/**
 * HÄNGENDE VERSÄNDE AUFRÄUMEN (2026-08-05). Stirbt der Prozess mitten in `sendDraft` – bei einem
 * App-Update, Absturz oder Kill –, bleibt der Entwurf auf 'sending' stehen. In diesem Zustand
 * fasst ihn NICHTS mehr an: Der Versand-Job holt nur 'approved', das Cockpit zeigt nur 'pending'.
 * Der Entwurf verschwindet also lautlos, obwohl vielleicht ein Mensch auf die Antwort wartet.
 *
 * Bewusst NICHT zurück auf 'approved': Ob LinkedIn den Klick noch angenommen hat, ist nach einem
 * harten Abbruch nicht beweisbar. Ein blinder zweiter Versuch wäre ein Doppel-Versand. Deshalb
 * 'unknown' – derselbe Zustand wie bei jedem anderen unklaren Versand: sichtbar als technischer
 * Hinweis im Cockpit, und ein Mensch entscheidet nach Blick in den Verlauf.
 * Sicher, weil beim Start garantiert kein Versand läuft (der Portlock lässt nur eine Engine zu).
 */
{
  const haengendeIds = db.prepare("SELECT id FROM drafts WHERE status='sending'").all() as Array<{ id: number }>;
  const haengend = db.prepare("UPDATE drafts SET status='unknown' WHERE status='sending'").run().changes;
  for (const row of haengendeIds) syncCampaignTargetForDraft(row.id, "unknown", "App wurde während des Versands beendet – Verlauf prüfen");
  if (haengend) console.warn(`[start] ${haengend} Entwurf/Entwürfe hingen im Versand ('sending') – als "Status unklar" markiert, bitte im LinkedIn-Verlauf prüfen.`);
}

// Die tatsächlich laufende Code-Version festhalten (aus der mitgebündelten package.json – die kommt
// aus DEMSELBEN app.asar wie dieser Engine-Code). Das Dashboard vergleicht sie mit der Version auf
// der Platte und warnt, falls nach einem Update noch eine alte Engine im Speicher läuft.
const ENGINE_CODE_VERSION = (() => {
  try { return String(createRequire(import.meta.url)("../package.json").version || "?"); }
  catch { return "?"; }
})();
/**
 * ABSTURZ HINTERLÄSST EINE SPUR (2026-09-22). Node beendet den Prozess bei einer unbehandelten
 * Promise – vorher gab es dafür keinen Handler, und der Watchdog startete die Engine wortlos
 * neu. Der Grund muss in die Datenbank, BEVOR der Prozess geht: engine.log überlebt zwar, ist
 * aber nicht das, was der Nutzer sieht, und stdout wird beim Container-Neubau weggeworfen.
 * Danach wird bewusst beendet – eine Engine mit unklarem Zustand darf nicht weitersenden.
 */
for (const signal of ["unhandledRejection", "uncaughtException"] as const) {
  process.on(signal, (fehler: unknown) => {
    const text = fehler instanceof Error ? `${fehler.message}\n${fehler.stack ?? ""}` : String(fehler);
    try {
      protokolliereNeustart({
        grund: "absturz",
        detail: `${signal}: ${text}`,
        letzterJob: getState("engine_active_job") || null,
        heartbeatAlterSek: heartbeatAlter(),
      });
    } catch { /* Protokoll darf den Absturz nie verschlucken */ }
    console.error(`[engine] ABSTURZ (${signal}):`, text);
    process.exit(1);
  });
}

if (istServerModus()) {
  logZeitzone("engine");
  serverErststart(); // idempotent – greift nur, falls das Dashboard es noch nicht getan hat
}
setState("engine_heartbeat", new Date().toISOString());
setState("engine_started", new Date().toISOString());
setState("engine_pid", String(process.pid)); // fürs saubere Stoppen vom Dashboard
setState("engine_code_version", ENGINE_CODE_VERSION);
setState("engine_active_job", "");
setState("engine_queue_length", "0");
setState("engine_queue_next", "");
db.prepare("UPDATE bot_activity SET status='interrupted',detail='Durch Neustart sauber beendet',finished_at=datetime('now') WHERE status='running'").run();
cron.schedule("* * * * *", async () => {
  setState("engine_heartbeat", new Date().toISOString());
  // Ein Screenshot auf derselben Seite darf keine Navigation/Interaktion unterbrechen.
  if (!jobQueue.snapshot().activeJob) await saveLiveShot();
});

// Beim Start EINMAL sofort loslegen, statt bis zu 12 Min auf den ersten Cron-Tick zu warten.
// (Governor drosselt weiterhin – Delay/Caps/Arbeitszeit gelten.)
setTimeout(async () => {
  // Lokale Wiederherstellbarkeit: Datenbank einmal täglich konsistent sichern. Dieser Job nutzt
  // kein LinkedIn/Browser und bleibt bewusst sehr niedrig priorisiert.
  await einzeln("backup", () => ensureDailyBackup(), 5);
  // SERVER-MODUS: Ist die übertragene Sitzung überhaupt eingeloggt? Wenn nicht (Login-Seite,
  // Checkpoint, Authwall), pausiert der Governor SOFORT – bevor irgendein Job LinkedIn anfasst.
  if (istServerModus()) await einzeln("sitzung", () => pruefeSitzungBeimStart(), 90);
  // ZUERST der Selbst-Check: Funktioniert der Sende-Weg überhaupt? Ist er defekt, blockiert der
  // Governor Nachrichten von vornherein (statt still zu scheitern) und meldet es dir.
  await einzeln("healthcheck", () => runReadJobWhenDue("healthcheck", 360, () => selbstCheck()), 75);
  await einzeln("acceptance", () => runReadJobWhenDue("acceptance", 120, () => checkAcceptances()), 60);
  await einzeln("outreach", () => outreachTick(), 30);
  // Auch das Postfach sofort prüfen: wer den Bot mittags startet, soll nicht bis zur
  // nächsten Viertelstunde warten, um zu sehen, dass er arbeitet.
  await einzeln("drafts", async () => {
    if (getAgentMode() === "off") await runReadJobWhenDue("inbox", 30, () => generateInboxDrafts(8));
  }, 80);
  // Freigegebene Entwürfe, die noch offen sind, gleich beim Start abarbeiten.
  await einzeln("sendApproved", () => sendApprovedDrafts(15), 100);
  // Beim Start einmal Nachschub holen: wer Quellen angelegt + den Bot gestartet hat, bekommt
  // gleich Leads, statt bis zum nächsten festen Fütter-Termin zu warten.
  await einzeln("feed", () => runReadJobWhenDue("feed", 300, () => feedTick()), 20);
  if (config.campaigns.enabled) await einzeln("campaign", () => campaignTick(), 50);
  // Post-Ideen: nur nachlegen, wenn KEINE offen sind (schont das Gemini-Limit). So sieht der
  // Nutzer gleich beim ersten Start Beitrags-Entwürfe zum Freigeben, statt bis Montag zu warten.
  await einzeln("content", async () => {
    const offen = (db.prepare("SELECT COUNT(*) AS n FROM posts WHERE status='draft'").get() as { n: number }).n;
    if (offen === 0) await generatePostIdeas(2);
  }, 10);
}, 4000);

// Falls die App über Nacht läuft, entsteht auch ohne Neustart täglich ein frischer Snapshot.
cron.schedule("10 3 * * *", () => einzeln("backup", () => ensureDailyBackup(), 5));

// Lokales Lernen geschieht direkt bei jeder Entscheidung. Dieser Lauf teilt nur dann anonyme
// k-anonyme Aggregate, wenn der Betreiber bewusst einen sicheren Lernserver konfiguriert hat.
cron.schedule("20 4 * * *", () => einzeln("learning", () => syncAnonymousLearning(), 5));

/**
 * POSTEN läuft jetzt für JEDEN – auch OHNE LinkedIn-API-Schlüssel: dann über die Browser-Session
 * (publishPostBrowser), genau wie Vernetzen/Kommentieren. Ist ein API-Token da, wird der saubere
 * API-Weg (publishPost) bevorzugt (kein Selektor-Risiko). `hatPosting` wählt also nur noch den WEG,
 * schaltet Posten aber nicht mehr ab.
 */
const hatPosting = !!(config.linkedin.accessToken || config.linkedin.clientId);
console.info(hatPosting ? "[post] Posten über offizielle LinkedIn-API." : "[post] Kein API-Token – Posten läuft über die Browser-Session.");

// Fällige, freigegebene Posts veröffentlichen. In `einzeln` gekapselt (kein Doppel-Feuern), und der
// Status wird VOR dem Versuch atomar auf 'posting' gesetzt → derselbe Post kann nie zweimal rausgehen.
cron.schedule("* * * * *", () =>
  einzeln("post", async () => {
    const claim = db.prepare(
      "UPDATE posts SET status='posting' WHERE id=(SELECT id FROM posts WHERE status='approved' AND scheduled_for <= datetime('now') ORDER BY scheduled_for LIMIT 1)",
    ).run();
    if (claim.changes === 0) return 0; // nichts fällig
    const due = db.prepare("SELECT id, body FROM posts WHERE status='posting' ORDER BY scheduled_for LIMIT 1").get() as { id: number; body: string } | undefined;
    if (!due) return;
    try {
      if (hatPosting) {
        const urn = await publishPost(due.body);
        db.prepare("UPDATE posts SET status='posted', posted_urn=? WHERE id=?").run(urn, due.id);
        console.info(`[post] veröffentlicht (API): ${urn}`);
      } else {
        await publishPostBrowser(due.body);
        db.prepare("UPDATE posts SET status='posted' WHERE id=?").run(due.id);
        console.info("[post] veröffentlicht (Browser).");
      }
      return 1;
    } catch (e) {
      db.prepare("UPDATE posts SET status='failed' WHERE id=?").run(due.id);
      console.error(`[post] fehlgeschlagen (#${due.id}):`, (e as Error)?.message?.slice(0, 120));
    }
  }, 90),
);

// SELBST-CHECK alle 3 Stunden (rein lesend): prüft, ob der Sende-Weg (Login/Postfach/Eingabefeld/
// Senden-Knopf) technisch funktioniert. Bricht ein Selektor, wird der Sende-Weg als defekt markiert
// → Governor pausiert Nachrichten + Telegram-/Dashboard-Alarm, statt still Fehler zu produzieren.
cron.schedule(`15 ${START_STUNDE}-21/6 * * *`, () => einzeln("healthcheck", () => runReadJobWhenDue("healthcheck", 360, () => selbstCheck()), 75));

// Outreach-Tick alle 12 Minuten. Der Governor drosselt intern (Caps/Warm-up/Zeitfenster/Delays).
cron.schedule("*/12 * * * *", () => einzeln("outreach", () => outreachTick(), 30));

// Acceptance-Tracking alle ZWEI STUNDEN in der Arbeitszeit. Ein Sweep findet weiterhin jede
// Annahme, halbiert aber die wiederholten Aufrufe der Verbindungsseite.
// Rein lesend, kein Senden, kein Governor → kostet KEINE Sicherheit, spart aber Wartezeit:
// Jede erkannte Annahme erzeugt sofort den Erstnachricht-Entwurf. Vorher lag zwischen
// "hat angenommen" und "Entwurf liegt bereit" bis zu 8 Stunden, jetzt maximal 2.
cron.schedule(`5 ${START_STUNDE}-21/2 * * *`, () => einzeln("acceptance", () => runReadJobWhenDue("acceptance", 120, () => checkAcceptances()), 60));

// Lead-Fütterung 2x täglich: gespeicherte Such-Quellen abgrasen (rein lesend).
// Hält die Pipeline gefüllt, damit der Outreach nicht trockenläuft.
cron.schedule("0 10,16 * * *", () => einzeln("feed", () => runReadJobWhenDue("feed", 300, () => feedTick()), 20));

// Kampagnen sind stillgelegt (config.campaigns.enabled=false, siehe config.ts). Angeschrieben
// wird ausschliesslich individuell über die normale Strecke. Der Cron bleibt bewusst stehen,
// damit ein Zurückstellen des Schalters genügt – ohne ihn hier wieder einzubauen.
if (config.campaigns.enabled) cron.schedule("*/10 * * * *", () => einzeln("campaign", () => campaignTick(), 50));

// SOFORT-NACHSCHUB auf Knopfdruck: das Dashboard setzt "feed_now"=1 (neue Quelle oder
// "Jetzt Nachschub holen"). Der Loop prüft alle 2 Min und füttert dann gleich – so wirkt der
// Knopf zeitnah, ohne dass der Nutzer bis zum festen Termin wartet. Der Browser gehört der
// Engine, deshalb läuft das Scrapen hier (nicht im Dashboard-Prozess).
cron.schedule("*/2 * * * *", () =>
  einzeln("feed", async () => {
    if (getState("feed_now") !== "1") return;
    setState("feed_now", "");
    await feedTick();
  }, 40),
);

/**
 * NETZWERK REAKTIVIEREN. Zwei Wege:
 *  - auf Knopfdruck (Dashboard setzt "netzwerk_now"=1) – wird alle 2 Min abgeholt,
 *  - automatisch 1x pro Woche (Di 9:30), damit neue Verbindungen nachrutschen.
 * Das Einlesen ist rein LESEND (kein Governor); gesendet wird nur nach Freigabe.
 */
async function netzwerkLauf(entwuerfe: number) {
  await scanNetzwerk();
  await generateReaktivierung(entwuerfe);
}
cron.schedule("*/2 * * * *", () =>
  einzeln("netzwerk", async () => {
    if (getState("netzwerk_now") !== "1") return;
    setState("netzwerk_now", "");
    await netzwerkLauf(5);
  }, 45),
);
cron.schedule("30 9 * * 2", () => einzeln("netzwerk", () => netzwerkLauf(3), 35));

/**
 * OFFENE-ANTWORTEN-SCAN (Sinans Vorgabe 2026-07-27): geht ALLE Chats durch – auch alte, längst
 * gelesene – und legt für jeden, in dem eine Antwort von Sinan offen ist (die Person zuletzt
 * geschrieben hat), einen Entwurf zur Prüfung an. Der tiefe Listen-Scroll in fetchThreads erreicht
 * auch weit unten liegende Konversationen. Rein lesend + Entwurf; gesendet wird nur nach Freigabe.
 *  - auf Knopfdruck (Dashboard setzt "offene_now"=1) – alle 2 Min abgeholt,
 *  - automatisch 1x täglich (9:05), damit nichts liegen bleibt.
 * Läuft nur, wenn der Agent NICHT live antwortet (sonst doppelte Entwürfe zum selben Thread).
 */
/**
 * DECKEL: 40 → 100 (Vormittag 2026-08-05) → 25 (Abend desselben Tages).
 *
 * Die Anhebung auf 100 war ein Fehler mit Folgen. Der Lauf lud 240 Konversationen und öffnete
 * bis zu 100 davon einzeln – zweimal an einem Nachmittag. LinkedIn sperrte das Konto noch am
 * selben Tag mit der Begründung, es seien große Mengen an Profildaten abgerufen worden.
 *
 * Der ursprüngliche Zweck bleibt richtig: Chats sollen nicht liegen bleiben. Nur muss er über
 * VIELE KLEINE Läufe erreicht werden statt über einen großen. 25 Chats täglich sind in einer
 * Woche 175 – mehr als das Postfach hergibt – und fallen dabei nicht auf.
 * NICHT wieder hochsetzen. Das Lese-Budget (core/leseBudget.ts) bremst zusätzlich.
 */
async function offeneAntwortenScan(max = 25) {
  if (getAgentMode() !== "off") return;
  await generateInboxDrafts(max, false);
}
cron.schedule("*/2 * * * *", () =>
  einzeln("offene", async () => {
    if (getState("offene_now") !== "1") return;
    setState("offene_now", "");
    await offeneAntwortenScan(25);
  }, 85),
);
cron.schedule(`5 ${START_STUNDE} * * *`, () => einzeln("offene", () => offeneAntwortenScan(25), 80));

// PITCH Stufe 2 auf Knopfdruck: Dashboard setzt "pitch_now"={id,idee} → der Loop generiert aus dem
// gewählten Ansatz die Nachricht (neuer 'message'-Entwurf zur zweiten Freigabe). Nur LLM, kein Browser.
cron.schedule("*/2 * * * *", () =>
  einzeln("pitch", async () => {
    const raw = getState("pitch_now");
    if (!raw) return;
    setState("pitch_now", "");
    try {
      const { id, idee } = JSON.parse(raw);
      await pitchZuNachricht(Number(id), String(idee));
    } catch (e) {
      console.error(`[pitch] ${(e as Error)?.message?.slice(0, 90)}`);
    }
  }, 90),
);

// CHAT WIEDERBELEBEN auf Knopfdruck: Dashboard setzt "wiederbeleben_now"=<profil-url> → der Loop
// erzeugt einen Nachfass-Entwurf für genau diesen eingeschlafenen Chat (nur LLM, kein Browser).
cron.schedule("*/2 * * * *", () =>
  einzeln("wiederbeleben", async () => {
    const ziel = getState("wiederbeleben_now");
    if (!ziel) return;
    setState("wiederbeleben_now", "");
    await reviveChat(ziel).catch((e: Error) => console.error(`[wiederbeleben] ${e?.message?.slice(0, 90)}`));
  }, 90),
);

// REICHWEITE JETZT auf Knopfdruck: Dashboard setzt "comment_now"=1 → der Loop liked + erzeugt
// Kommentar-Entwürfe sofort (statt bis werktags 12:30 zu warten). Browser gehört der Engine.
cron.schedule("*/2 * * * *", () =>
  einzeln("comment", async () => {
    if (getState("comment_now") !== "1") return;
    setState("comment_now", "");
    await commentTick(3);
  }, 40),
);

// DM-Entwürfe 2x täglich generieren (rein lesend + Gemini, SENDET NICHT).
// Neue Entwürfe erscheinen als 'pending' im Dashboard zur Freigabe.
/**
 * Postfach ALLE 30 MINUTEN prüfen, solange der Bot läuft (vorher nur 2x täglich um 9:30/15:30 –
 * wer den Bot um 11:36 startete, sah bis 15:30 nichts passieren). Der Vorschau-Cache öffnet
 * veränderte Chats sofort im nächsten Lauf und spart unveränderte Einzel-Threads vollständig.
 *
 * Warum das trotz Gemini-Limit (~20/Tag) geht: Threads lesen kostet KEINEN KI-Aufruf. Die KI
 * läuft nur, wenn wirklich eine neue, unbeantwortete Nachricht da ist – und `hasOpenDraft`
 * überspringt Chats, für die schon ein Entwurf offen ist oder für die dieselbe Nachricht
 * bereits verworfen wurde. Die Kosten hängen also an der Zahl NEUER Nachrichten, nicht am Takt.
 * Ist das Gratis-Kontingent leer, springt Claude ein und meldet sich vorher (core/textLlm.ts).
 */
cron.schedule(`*/30 ${START_STUNDE}-22 * * *`, () =>
  einzeln("drafts", async () => {
    // Sobald der Sales-Agent aktiv ist (Test/Live), macht ER die Antworten – dann keine Alt-Entwürfe.
    if (getAgentMode() === "off") await runReadJobWhenDue("inbox", 30, () => generateInboxDrafts(8));
  }, 80),
);

// MORGEN-ROUTINE (zu Beginn der Geschäftszeit, seit 2026-09-22 7:00; Sinans Vorgabe): erst alle offenen Chats beantworten (Entwürfe
// erzeugen), dann die vom Nutzer freigegebenen Entwürfe abarbeiten (senden). So liegt morgens
// als Erstes die frische Antwort-Liste bereit und gestern Genehmigtes geht sofort raus.
cron.schedule(`0 ${START_STUNDE} * * *`, () =>
  einzeln("morgen", async () => {
    if (getAgentMode() === "off") await runReadJobWhenDue("inbox", 30, () => generateInboxDrafts(10));
    await sendApprovedDrafts(20);
  }, 95),
);

// Freigegebene Entwürfe regelmäßig senden (alle 10 Min in der Arbeitszeit). Governor-gedrosselt;
// Nachrichten sind werktags-gated, am Wochenende wartet also alles bis Montag.
// Läuft rund um die Uhr; ob wirklich gesendet wird, entscheidet der Governor (Zeitfenster-Schalter).
cron.schedule("*/10 * * * *", () => einzeln("sendApproved", () => sendApprovedDrafts(10), 100));

// Follow-ups 1x täglich: für Kontakte, die seit >=4 Tagen nicht geantwortet haben.
cron.schedule("0 11 * * *", () => einzeln("followup", () => generateFollowups(5), 55));

// SALES-AGENT = die EINZIGE Gesprächs-Engine (der alte Autopilot `runAutopilot` ist bewusst
// stillgelegt – es gibt nur noch EINEN Bot, das war vorher verwirrend). Der Cron läuft immer,
// `agentTick` prüft selbst die Automatik-Stufe (off/shadow/live) → per Klick umschaltbar ohne Neustart.
cron.schedule(`*/${config.agent.intervalMinutes} * * * *`, () => einzeln("agent", () => agentTick(), 90));

// KOMMENTARE: 1x täglich (12:30) Nischen-Posts finden und Kommentar-ENTWÜRFE erzeugen.
// Öffentlich → immer erst Freigabe (Telegram), nie autonom. Moderate Frequenz: Sichtbarkeit
// entsteht durch stetige, gute Kommentare, nicht durch Masse. Governor-gated erst beim Senden.
cron.schedule("30 12 * * 1-5", () => einzeln("comment", () => commentTick(3), 30));

// CONTENT: 1x pro Woche (Montag 8 Uhr) Post-Ideen erzeugen. Sie landen als Entwürfe und werden
// erst nach Freigabe veröffentlicht (öffentlich = nie autonom). Läuft für JEDEN – das Posten
// selbst geht per API oder Browser (siehe oben), deshalb nicht mehr an `hatPosting` gebunden.
cron.schedule("0 8 * * 1", () => einzeln("content", () => generatePostIdeas(3), 10));

// WOCHEN-BILANZ automatisch: Montag 9:05 Uhr per Telegram, ohne dass Sinan etwas tippt.
// "sowas muss automatisch passieren" – der Report kommt von allein, reife Kategorien
// mit Tap-Button zum Freischalten. events statt Direktaufruf (kein Import-Zyklus zu telegram).
cron.schedule(`5 ${START_STUNDE} * * 1`, () => events.emit("bilanz:woche"));

// TAGES- UND WOCHENBERICHT (Sinans Vorgabe 2026-09-22): Zahlen kommen von allein per Telegram.
// Tagesbericht nach Ende der Geschäftszeit (22:05), Wochenbericht Montag früh über die Vorwoche.
// Die Berechnung liegt in modules/berichte.ts, der Text wird dort gebaut; Telegram sendet nur.
cron.schedule("5 22 * * *", () => events.emit("bericht:tag"));
cron.schedule(`10 ${START_STUNDE} * * 1`, () => events.emit("bericht:woche"));
// KI-Lead-Bewertung: stündlich bis zu 60 neue Kontakte (3 KI-Aufrufe), damit die knappen
// Vernetzungsanfragen an die passendsten Leute gehen. Kein Profilaufruf, nur CRM-Daten.
cron.schedule(`40 ${START_STUNDE}-21 * * *`, () => einzeln("leadbewertung", () => kiLeadBewertung(60), 15));
// KI-Herausforderer für den Stil-Test: wöchentlich (Mo), passiert nur bei klarem Gewinner.
cron.schedule(`30 ${START_STUNDE} * * 1`, () => einzeln("kistile", () => kiNeueStile(), 10));
// KI-Wochenanalyse: montags nach dem Wochenbericht, ein Claude-Aufruf, Ergebnis per Telegram + Cockpit.
cron.schedule(`20 ${START_STUNDE} * * 1`, () => einzeln("kianalyse", async () => {
  const a = await kiWochenanalyse();
  events.emit("ki:analyse", a);
}, 10));

/**
 * STILLSTANDS-MELDUNG (2026-09-22). Telegram meldete bisher nur GESENDETES – also schwieg es
 * ausgerechnet dann, wenn man eine Erklärung braucht ("seit 2h nichts gehört, läuft der Bot?").
 * Alle Daten lagen vor: Cap, Warm-up, offene Entwürfe. Niemand hat sie zusammengesetzt.
 *
 * Stündlich in der Geschäftszeit prüfen; gemeldet wird nur, wenn seit STILLSTAND_STUNDEN nichts
 * rausging UND es einen benennbaren Grund gibt. Einmal je Grund pro Tag, damit die Meldung nicht
 * zur Tapete wird: wer dieselbe Zeile viermal liest, liest sie beim fünften Mal nicht mehr.
 */
const STILLSTAND_STUNDEN = 3;
cron.schedule(`20 ${START_STUNDE}-21 * * *`, () => {
  try {
    const stand = stillstandGrund();
    if (!stand.steht) return;
    if (stand.seitSek != null && stand.seitSek < STILLSTAND_STUNDEN * 3600) return;
    // EIN Merker, nicht einer pro Tag: ein Schlüssel je Datum würde `state` dauerhaft zumüllen.
    const merker = `${new Date().toISOString().slice(0, 10)}|${stand.grund}`;
    if (getState("stillstand_gemeldet") === merker) return; // heute schon mit diesem Grund gemeldet
    setState("stillstand_gemeldet", merker);
    events.emit("engine:stillstand", stand);
  } catch (e) {
    console.warn("[stillstand] Prüfung fehlgeschlagen:", (e as Error).message);
  }
});

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

/**
 * NEUSTARTS NACHMELDEN. Der Watchdog sitzt im Dashboard-Prozess und hat kein Telegram; die
 * frisch gestartete Engine holt seine Meldung deshalb nach. Kurz verzögert, damit der Bot
 * seine Verbindung aufgebaut hat. Gemeldet wird nur, was noch niemand gesehen hat.
 */
setTimeout(() => {
  try {
    const offen = offeneNeustartMeldungen();
    if (offen.length) {
      events.emit("engine:neustart", offen);
      markiereNeustartsBerichtet(offen.map((n) => n.id));
    }
    kuerzeNeustartProtokoll();
  } catch (e) {
    console.warn("[engine] Neustart-Meldung fehlgeschlagen:", (e as Error).message);
  }
}, 8_000).unref();

console.info("LinkedIn Command Center läuft. Posting-Scheduler + Outreach-Loop aktiv.");
console.info(governor.isPaused() ? "⚠ Governor ist pausiert." : "✓ Governor aktiv.");
