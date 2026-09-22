import { createServer } from "node:http";
import { spawn, execFile } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, openSync, rmSync, statSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getDashboardData } from "../modules/dashboard.js";
import { getAnalytics } from "../modules/analytics.js";
import { getDraft, setDraftStatus, sendDraft, approveDraft, rejectDraft, chooseDraftApproach, deleteDraft, retryBlockierte, pitchZuNachricht } from "../modules/drafts.js";
import type { RejectionReason } from "../modules/draftDirections.js";
import { getPost, approvePost, discardPost, generatePostDraft } from "../modules/content.js";
import { addSource, deleteSource } from "../modules/leadFeed.js";
import { deleteContact } from "../modules/crm.js";
import {
  createCampaign, updateCampaign, deleteCampaign, setCampaignActive, previewCampaign, recordOutcome, OUTCOME_STAGES, type OutcomeStage,
  addCampaignAsset, updateCampaignAsset, deleteCampaignAsset, getCampaignAsset, campaignAssetPath,
} from "../modules/campaigns.js";
import { addSalesTask, completeSalesTask, deleteSalesTask } from "../modules/salesDesk.js";
import { addContactNote, deleteContactNote } from "../modules/contactNotes.js";
import { heartbeatAlter, protokolliereNeustart } from "../modules/engineWatch.js";
import { createDatabaseBackup } from "../core/backups.js";
import { governor } from "../core/safetyGovernor.js";
import { createExperiment, setExperimentStatus, EXPERIMENT_METRICS, type ExperimentMetric } from "../modules/experiments.js";
import { getConversationWorkspace } from "../modules/conversationWorkspace.js";
import { db, getState, setState, setMode, setFocus, getFocus, setAgentMode, type Mode, type Focus, type AgentMode } from "../db/index.js";
import { LIVE_SHOT_PATH } from "../core/session.js";
import { createMission } from "../modules/missions.js";
import { resolveGoalAlert, GOAL_CODES } from "../modules/goals.js";
import { contactsForStage, funnelByCampaign, funnelBySource, funnelReport, type FunnelFilter } from "../modules/funnel.js";
import { FUNNEL_STAGES, setStageManually } from "../modules/crmStages.js";
import { flushPendingReports, queueUserReport } from "../modules/reporting.js";
import { retryJob } from "../core/jobReliability.js";
import { backfillRelationshipSignals, setRelationshipPolicy } from "../modules/relationshipPolicy.js";
import { backfillContactIdentities, resolveIdentityConflict } from "../modules/contactIdentity.js";
import { backfillContactTimeline } from "../modules/contactTimeline.js";
import { backfillCampaignWorkflows, retryCampaignTarget, retryFailedCampaignTargets } from "../modules/campaignWorkflow.js";
import { backfillConversationMemories, backfillDraftContexts } from "../modules/conversationMemory.js";
import { config } from "../config.js";
import { bericht, type BerichtArt } from "../modules/berichte.js";
import { anmeldungOk, istServerModus, logZeitzone, pruefeServerStartbedingungen, serverErststart } from "../core/serverMode.js";

// Server-Modus: ohne DASHBOARD_TOKEN gar nicht erst starten (siehe core/serverMode.ts).
pruefeServerStartbedingungen();

// Die Desktop-App startet zuerst das Cockpit; die eigentliche Engine kann bewusst ausgeschaltet
// bleiben. Historische Beziehungssignale muessen deshalb bereits hier uebernommen werden, sonst
// waeren geschuetzte Kontakte bis zum naechsten Engine-Start noch in offenen Kampagnen sichtbar.
const identityBackfill = backfillContactIdentities();
backfillContactTimeline();
backfillConversationMemories();
if (identityBackfill.unresolved) {
  console.info(`[kontaktidentitaet] ${identityBackfill.unresolved} Zuordnung(en) brauchen eine manuelle Pruefung.`);
}
const relationshipBackfill = backfillRelationshipSignals();
if (relationshipBackfill) {
  console.info(`[beziehungsschutz] ${relationshipBackfill} bestehende Wiedervorlage(n)/Sperre(n) uebernommen.`);
}
const draftContexts = backfillDraftContexts();
if (draftContexts.blocked) console.info(`[gesprächskontext] ${draftContexts.blocked} widersprüchliche proaktive Entwürfe blockiert.`);
const campaignBackfill = backfillCampaignWorkflows();
if (campaignBackfill.failed) console.info(`[kampagnen] ${campaignBackfill.failed} festgefahrene Ziele sind jetzt sichtbar und manuell wiederholbar.`);

/**
 * Lokales CRM-Cockpit. Nutzung: npm run crm
 * Startet einen kleinen HTTP-Server (kein Framework), der das Dashboard ausliefert
 * und den Zustand als JSON bereitstellt. Rein lesend – kein Senden, kein Governor-Bypass.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = join(__dirname, "..", "web", "command-center.html");
const SETUP_PATH = join(__dirname, "..", "web", "setup.html");
const PROJECT_ROOT = join(__dirname, "..", "..");
// WICHTIG: .env + Profil liegen im ARBEITSVERZEICHNIS, nicht im Code-Ordner. Im Dev ist das
// der Projekt-Ordner; in der gepackten App der beschreibbare userData-Ordner (main.cjs setzt
// cwd=userData). Vorher zeigten diese auf PROJECT_ROOT = app.asar (schreibgeschützt) → die App
// fand nie eine Konfig und der Setup-Assistent kam immer wieder / Speichern schlug fehl.
// Pfade kommen zentral aus config.ts: Datenordner im Server-Modus, sonst wie bisher cwd.
const ENV_PATH = config.paths.envPath;
const PROFIL_PATH = config.paths.profilPath;
const ENGINE_LOG = config.paths.engineLog;
const SESSION_LOCK = join(config.paths.sessionDir, "SingletonLock");
const PORT = config.server.port;
const HOST = config.server.host;

/** .env als Key→Value lesen (frisch von Platte, damit Änderungen ohne Neustart sichtbar sind). */
function readEnvFile(): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(ENV_PATH)) return out;
  for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

/** Einzelne Keys in .env setzen – bestehende Zeilen ersetzen, Rest (Kommentare/Struktur) bleibt. */
function updateEnv(updates: Record<string, string>) {
  let lines = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8").split("\n") : [];
  for (const [k, v] of Object.entries(updates)) {
    const line = `${k}=${v}`;
    const idx = lines.findIndex((l) => new RegExp(`^\\s*${k}\\s*=`).test(l));
    if (idx >= 0) lines[idx] = line;
    else lines.push(line);
  }
  writeFileSync(ENV_PATH, lines.join("\n"));
}

/** Ist das Tool eingerichtet? (Gemini-Key + Profil vorhanden). Steuert die Setup-Weiche. */
function setupStatus() {
  const env = readEnvFile();
  const hasGemini = !!(env.GEMINI_API_KEY || process.env.GEMINI_API_KEY);
  const hasProfile = existsSync(PROFIL_PATH);
  const hasPosting = !!(env.LINKEDIN_ACCESS_TOKEN || env.LINKEDIN_CLIENT_ID);
  const linkedInConnected = getState("linkedin_connected") === "1";
  return { configured: hasGemini && hasProfile, hasGemini, hasProfile, hasPosting, linkedInConnected };
}

/**
 * Prozess-Start für Engine/Login/Login-Prüfung – funktioniert in BEIDEN Welten:
 *  - Dev (`npm run crm`): startet die .ts über `tsx` (mit caffeinate für die Engine auf Mac).
 *  - Paketierte App (Electron): main.cjs setzt NEXTLEAD_PACKAGED=1 + NEXTLEAD_APP_DIR und startet
 *    dann die KOMPILIERTE Version (dist/*.js) über Electrons eingebautes Node (ELECTRON_RUN_AS_NODE).
 * So braucht die verteilte App weder Node noch tsx im System.
 */
const PACKAGED = process.env.NEXTLEAD_PACKAGED === "1";
const APP_DIR = process.env.NEXTLEAD_APP_DIR || PROJECT_ROOT;
const JOB_ENTRY = {
  engine: PACKAGED ? join(APP_DIR, "dist/index.js") : "src/index.ts",
  login: PACKAGED ? join(APP_DIR, "dist/scripts/login.js") : "src/scripts/login.ts",
  checkLogin: PACKAGED ? join(APP_DIR, "dist/scripts/checkLogin.js") : "src/scripts/checkLogin.ts",
} as const;
type JobStdio = "ignore" | "pipe";
function spawnJob(
  job: keyof typeof JOB_ENTRY,
  opts: { detached?: boolean; logFd?: number; pipe?: boolean; extraEnv?: Record<string, string>; keepAwake?: boolean } = {},
) {
  const env = { ...process.env, ...(opts.extraEnv ?? {}) };
  const out = opts.logFd ?? (opts.pipe ? "pipe" : "ignore");
  const stdio: [JobStdio, JobStdio | number, JobStdio | number] = ["ignore", out as never, out as never];
  if (PACKAGED) {
    return spawn(process.execPath, [JOB_ENTRY[job]], {
      cwd: process.cwd(), detached: opts.detached, stdio, env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
    });
  }
  const useCaf = opts.keepAwake && process.platform === "darwin";
  const cmd = useCaf ? "caffeinate" : "npx";
  const args = useCaf ? ["-i", "npx", "tsx", JOB_ENTRY[job]] : ["tsx", JOB_ENTRY[job]];
  return spawn(cmd, args, { cwd: PROJECT_ROOT, detached: opts.detached, stdio, env });
}

/**
 * SENDE-WARTESCHLANGE. Klickt Sinan mehrere "Senden"-Knöpfe, kommen mehrere HTTP-Requests
 * gleichzeitig an. Ohne Serialisierung wäre das gefährlich:
 *  1. `session.newPage()` liefert IMMER dieselbe Seite (`ctx.pages()[0]`) – zwei parallele
 *     Versände würden denselben Tab gleichzeitig navigieren und ineinander tippen.
 *     Ergebnis: Nachricht an die falsche Person.
 *  2. Der Governor hält seinen 20-75s-Abstand nur INNERHALB eines Durchlaufs. Parallele
 *     Sends warten jeder für sich und feuern dann fast gleichzeitig – die Taktung, die den
 *     Account schützt, wäre ausgehebelt (derselbe Bug wie bei den überlappenden Cron-Ticks).
 * Deshalb hängt jeder Versand hinten an eine Promise-Kette. Auch nach einem Fehler läuft
 * die Kette weiter, sonst blockiert ein kaputter Entwurf alle folgenden.
 */
let sendeKette: Promise<unknown> = Promise.resolve();
let inWarteschlange = 0;

function nacheinander<T>(fn: () => Promise<T>): Promise<T> {
  inWarteschlange++;
  const naechster = sendeKette.then(fn, fn);
  sendeKette = naechster.then(
    () => inWarteschlange--,
    () => inWarteschlange--,
  );
  return naechster;
}

const ENGINE_MUSTER = PACKAGED ? "dist/index.js" : "tsx src/index.ts";

/**
 * Engine starten. NEUESTER START GEWINNT (Fix 2026-07-29): eine evtl. noch laufende – auch
 * VERWAISTE, veraltete – Engine ZUERST killen, dann frisch starten. Sonst blockiert eine Alt-Waise
 * (Parent-PID 1 aus einer Vorversion) über den Portlock dauerhaft die neue Engine, und Updates
 * greifen nie (genau das Symptom "Nachrichten gehen nicht raus"). pkill ist versionsunabhängig;
 * der frische Spawn lädt garantiert den aktuellen Code.
 */
/**
 * ROTATION FÜR engine.log. docker-compose.yml begrenzt sorgfältig `max-size: 10m / max-file: 3` –
 * das gilt aber nur für stdout, und die Engine schreibt praktisch alles in DIESE Datei. Ohne
 * Rotation wächst sie unbegrenzt auf einem 16-GB-Server. Eine Vorgängerdatei reicht: älteres
 * als den letzten Lauf hat noch nie jemand gebraucht.
 */
const ENGINE_LOG_MAX = 8 * 1024 * 1024;
function rotiereEngineLog(): void {
  try {
    if (!existsSync(ENGINE_LOG) || statSync(ENGINE_LOG).size < ENGINE_LOG_MAX) return;
    renameSync(ENGINE_LOG, `${ENGINE_LOG}.1`);
  } catch { /* Rotation darf den Start nie verhindern */ }
}

function starteEngine(): void {
  setState("engine_heartbeat", ""); // während des Neustarts als offline markieren
  execFile("pkill", ["-f", ENGINE_MUSTER], () => {
    setTimeout(() => {
      // Loop-Ausgabe in engine.log schreiben (statt still) – fürs Debuggen.
      rotiereEngineLog();
      const logFd = openSync(ENGINE_LOG, "a");
      // keepAwake: hält den Rechner im Dev via caffeinate wach (Mac), damit der Loop nicht stirbt.
      const child = spawnJob("engine", { detached: true, logFd, keepAwake: true });
      child.unref();
    }, 1200); // kurz warten, bis der alte Prozess weg ist und Port 43217 frei wird
  });
}

/** Engine stoppen: Loop-Prozess per Muster killen (egal wie gestartet), Lock aufräumen. */
function stoppeEngine(): void {
  execFile("pkill", ["-f", ENGINE_MUSTER], () => {
    try { rmSync(SESSION_LOCK, { force: true }); } catch { /* egal */ }
  });
  setState("engine_heartbeat", ""); // sofort als offline markieren
}

/** Läuft der Engine-Loop? (Heartbeat < 150s alt) */
function engineAlive(): boolean {
  const hb = getState("engine_heartbeat");
  return hb ? Date.now() - new Date(hb).getTime() < 150_000 : false;
}

const server = createServer((req, res) => {
  // BASIC-AUTH (nur wenn DASHBOARD_TOKEN gesetzt; im Server-Modus Pflicht). Vor JEDER Route,
  // auch vor statischen Dateien – es gibt keinen anonymen Pfad.
  if (!anmeldungOk(req)) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="NextLead", charset="UTF-8"', "Content-Type": "text/plain; charset=utf-8" })
      .end("Anmeldung nötig: Benutzername beliebig, Passwort = DASHBOARD_TOKEN aus der .env.");
    return;
  }
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  // Fehlerberichte und allgemeines Feedback gehen über den zentralen Relay. Die Browserseite
  // darf bei Fehlern nur die lokale Aktivitäts-ID nennen; der Server holt den echten Fehler
  // selbst aus der DB und bereinigt ihn vor dem Versand.
  if (url.pathname === "/api/report" && req.method === "POST") {
    let body = "";
    let tooLarge = false;
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_600_000 && !tooLarge) {
        tooLarge = true;
        res.writeHead(413, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Meldung ist zu groß." }));
      }
    });
    req.on("end", async () => {
      if (tooLarge) return;
      try {
        const input = JSON.parse(body || "{}") as {
          kind?: "error" | "feedback"; message?: string; replyEmail?: string; activityId?: number;
          screenshot?: { mimeType?: string; base64?: string; width?: number; height?: number } | null;
        };
        if (input.kind !== "error" && input.kind !== "feedback") throw new Error("Ungültige Meldung.");
        const result = await queueUserReport({ ...input, kind: input.kind });
        res.writeHead(202, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify({ ok: true, ...result }));
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" })
          .end(JSON.stringify({ error: String((error as Error)?.message || error) }));
      }
    });
    return;
  }

  // Eine Dead-Letter-Aufgabe wird nur durch eine konkrete Nutzeraktion wieder freigegeben.
  // Der nächste reguläre Zeitplan führt sie dann durch dieselbe serielle Queue aus; dieser
  // Endpunkt startet bewusst keinen parallelen Browserjob.
  if (url.pathname === "/api/job-retry" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { job } = JSON.parse(body || "{}");
        if (!job || typeof job !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]{0,40}$/.test(job)) throw new Error("Ungültige Aufgabe.");
        const ok = retryJob(job);
        res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" }).end(JSON.stringify({ ok, job }));
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: String((error as Error)?.message || error) }));
      }
    });
    return;
  }

  // ===== MESSMODELL (Phase 5) =====
  // Rein lesend. `/api/funnel` liefert die Kette und die Quoten, `/api/funnel/contacts` genau die
  // Kontakte hinter einem einzelnen Wert. Beide nutzen dieselben Filter und dieselbe Tabelle,
  // damit die Liste nie von der Kennzahl abweichen kann.
  // TAGES-/WOCHENBERICHT: art=tag|woche, datum=YYYY-MM-DD (ein Tag im Zeitraum, Standard heute).
  if (url.pathname === "/api/bericht") {
    try {
      const art = (url.searchParams.get("art") === "woche" ? "woche" : "tag") as BerichtArt;
      const datum = url.searchParams.get("datum") || undefined;
      if (datum && !/^\d{4}-\d{2}-\d{2}$/.test(datum)) throw new Error("datum muss YYYY-MM-DD sein");
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(bericht(art, datum)));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify({ error: String((e as Error).message || e) }));
    }
    return;
  }

  if (url.pathname === "/api/funnel" || url.pathname === "/api/funnel/contacts") {
    try {
      const zahl = (name: string) => {
        const roh = url.searchParams.get(name);
        if (roh === null || roh === "") return null;
        const wert = Number(roh);
        if (!Number.isInteger(wert)) throw new Error(`Ungültiger Wert für ${name}.`);
        return wert;
      };
      const auswahl = <T extends string>(name: string, erlaubt: readonly T[]): T | null => {
        const roh = url.searchParams.get(name);
        if (!roh) return null;
        if (!erlaubt.includes(roh as T)) throw new Error(`Ungültiger Wert für ${name}.`);
        return roh as T;
      };
      const datum = (name: string) => {
        const roh = url.searchParams.get(name);
        if (!roh) return null;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(roh)) throw new Error(`Ungültiges Datum für ${name}.`);
        return roh;
      };
      const filter: FunnelFilter = {
        campaignId: zahl("campaign"),
        sourceId: zahl("source"),
        goalCode: auswahl("goal", GOAL_CODES),
        zielgruppe: auswahl("zielgruppe", ["azubi", "student"] as const),
        route: auswahl("route", ["network", "external"] as const),
        automation: auswahl("automation", ["active", "paused", "excluded"] as const),
        from: datum("from"),
        to: datum("to"),
      };

      if (url.pathname === "/api/funnel/contacts") {
        const stage = auswahl("stage", FUNNEL_STAGES);
        if (!stage) throw new Error("Parameter 'stage' fehlt.");
        const kontakte = contactsForStage(stage, filter);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ stage, filter, count: kontakte.length, kontakte }));
        return;
      }

      const gruppierung = auswahl("groupBy", ["campaign", "source"] as const);
      const daten = gruppierung === "campaign" ? { gruppen: funnelByCampaign(filter) }
        : gruppierung === "source" ? { gruppen: funnelBySource(filter) }
        : funnelReport(filter);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(daten));
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: String((error as Error)?.message || error) }));
    }
    return;
  }

  // ===== SETUP-ASSISTENT (Onboarding ohne Terminal, für Laien) =====
  // Status: ist alles eingerichtet? Steuert die Weiche "/" → Dashboard oder Setup.
  if (url.pathname === "/api/setup/status") {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(setupStatus()));
    return;
  }

  // Keys + Profil speichern. Keys → .env (strukturschonend), Profil → profil.local.json.
  if (url.pathname === "/api/setup/save" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { keys, profil } = JSON.parse(body || "{}") as { keys?: Record<string, string>; profil?: unknown };
        if (keys && typeof keys === "object") {
          const erlaubt = ["GEMINI_API_KEY", "ANTHROPIC_API_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "LINKEDIN_ACCESS_TOKEN", "LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET", "LINKEDIN_PERSON_URN"];
          const upd: Record<string, string> = {};
          for (const [k, v] of Object.entries(keys)) if (erlaubt.includes(k) && typeof v === "string" && v.trim()) upd[k] = v.trim();
          if (Object.keys(upd).length) updateEnv(upd);
        }
        if (profil && typeof profil === "object") {
          writeFileSync(PROFIL_PATH, JSON.stringify(profil, null, 2));
        }
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, ...setupStatus() }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, error: String(e) }));
      }
    });
    return;
  }

  // Aktuelles Profil laden (fürs Vorbefüllen des Formulars, falls schon eins existiert).
  if (url.pathname === "/api/setup/profil") {
    try {
      const roh = existsSync(PROFIL_PATH) ? readFileSync(PROFIL_PATH, "utf8") : "{}";
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }).end(roh);
    } catch {
      res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
    }
    return;
  }

  // LinkedIn verbinden: öffnet ein SICHTBARES Browserfenster zum Einloggen (wie `npm run login`).
  if (url.pathname === "/api/setup/login" && req.method === "POST") {
    try {
      const logFd = openSync(ENGINE_LOG, "a");
      const child = spawnJob("login", { detached: true, logFd, extraEnv: { BROWSER_MODE: "visible" } });
      child.unref();
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, error: String(e) }));
    }
    return;
  }

  // Login prüfen: schließt das Login-Fenster, öffnet versteckt den Feed und prüft, ob eingeloggt.
  if (url.pathname === "/api/setup/verify-login" && req.method === "POST") {
    execFile("pkill", ["-f", PACKAGED ? "dist/scripts/login.js" : "tsx src/scripts/login.ts"], () => {
      try { rmSync(SESSION_LOCK, { force: true }); } catch { /* egal */ }
      setTimeout(() => {
        const child = spawnJob("checkLogin", { pipe: true });
        let ausgabe = "";
        child.stdout?.on("data", (d) => (ausgabe += d));
        child.stderr?.on("data", (d) => (ausgabe += d));
        child.on("exit", (code) => {
          const ok = code === 0;
          setState("linkedin_connected", ok ? "1" : "0");
          res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok, hinweis: ok ? "" : ausgabe.slice(-200) }));
        });
      }, 2000);
    });
    return;
  }

  // Entwurf editieren, verwerfen ODER senden. Der Versand lief früher bewusst nur per CLI
  // (`npm run send -- <id>`), weil dem Sendeweg nicht zu trauen war. Seit er verifiziert ist
  // (outreach.tippenUndSenden: Feld leer + Text im Verlauf) geht er auch hier – wie in Telegram.
  // sendDraft läuft über den Governor, es gibt also keinen Bypass.
  if (url.pathname === "/api/draft" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { id, action, text } = JSON.parse(body || "{}");
        const d = getDraft(Number(id));
        if (!d) {
          res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "not found" }));
          return;
        }
        if (action === "save" && typeof text === "string") {
          db.prepare("UPDATE drafts SET draft=? WHERE id=?").run(text.trim(), Number(id));
        } else if (action === "discard") {
          setDraftStatus(Number(id), "discarded");
        } else if (action === "delete") {
          // Endgültig löschen – KEIN Ersatz (anders als "reject"). Zeile ist danach weg.
          deleteDraft(Number(id));
        } else if (action === "approve") {
          // Genehmigen: der Bot sendet beim nächsten Lauf (governor-gedrosselt). Kein Direktversand.
          const ok = approveDraft(Number(id), typeof text === "string" ? text : undefined);
          if (!ok) {
            const blocked = getDraft(Number(id));
            res.writeHead(409, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, reason: blocked?.blockiert_grund || "Entwurf kann nicht freigegeben werden." }));
            return;
          }
        } else if (action === "reject") {
          // Ablehnen speichert den Grund. Bei „anderer Ansatz" folgt zuerst eine echte
          // Richtungswahl; bei Qualitätsfeedback entsteht direkt ein korrigierter Text.
          rejectDraft(Number(id), String(text?.reason || "different_approach") as RejectionReason, String(text?.instruction || ""))
            .then((r) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(r)))
            .catch((e) => res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, reason: String(e?.message ?? e).slice(0, 160) })));
          return; // Antwort kommt asynchron
        } else if (action === "choose_approach") {
          chooseDraftApproach(Number(id), String(text?.approachKey || ""))
            .then((ok) => res.writeHead(ok ? 200 : 409, { "Content-Type": "application/json" }).end(JSON.stringify({ ok })))
            .catch((e) => res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, reason: String(e?.message ?? e).slice(0, 160) })));
          return;
        } else if (action === "send") {
          // Vorher speichern, falls im Feld editiert wurde – sonst geht der alte Text raus.
          if (typeof text === "string" && text.trim()) {
            db.prepare("UPDATE drafts SET draft=? WHERE id=?").run(text.trim(), Number(id));
          }
          // Während die Engine läuft, besitzt sie den Browser exklusiv. Der Klick wird daher
          // sicher in ihre Warteschlange gelegt statt einen zweiten Playwright-Prozess gegen
          // dieselbe LinkedIn-Session zu starten.
          if (engineAlive()) {
            approveDraft(Number(id));
            res.writeHead(202, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, queued: true, reason: "Engine sendet den Entwurf sicher aus ihrer Warteschlange." }));
            return;
          }
          // Reiht sich ein: mehrere Klicks sind erlaubt, laufen aber garantiert nacheinander.
          nacheinander(() => sendDraft(Number(id)))
            .then((r) => {
              res
                .writeHead(r.ok ? 200 : 409, { "Content-Type": "application/json" })
                .end(JSON.stringify(r));
            })
            .catch((e) => {
              // Ehrlich bleiben: Fehler durchreichen statt Erfolg vorgaukeln.
              res
                .writeHead(500, { "Content-Type": "application/json" })
                .end(JSON.stringify({ ok: false, reason: String(e?.message ?? e).slice(0, 160) }));
            });
          return; // Antwort kommt asynchron
        } else {
          res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "bad action" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: String(e) }));
      }
    });
    return;
  }

  // Eigene Post-Entwuerfe freigeben/verwerfen. Freigabe setzt 'approved' + faellig ab jetzt;
  // der Cron in index.ts veroeffentlicht ihn ueber die OFFIZIELLE API (kein Governor noetig,
  // kein Selektor-Risiko). Editierter Text wird vorher gespeichert.
  if (url.pathname === "/api/post" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { id, action, text } = JSON.parse(body || "{}");
        const p = getPost(Number(id));
        if (!p) {
          res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "not found" }));
          return;
        }
        if (typeof text === "string" && text.trim() && p.status === "draft") {
          db.prepare("UPDATE posts SET body=? WHERE id=? AND status='draft'").run(text.trim(), Number(id));
        }
        if (action === "approve") {
          const ok = approvePost(Number(id));
          res.writeHead(ok ? 200 : 409, { "Content-Type": "application/json" }).end(JSON.stringify({ ok }));
        } else if (action === "discard") {
          const ok = discardPost(Number(id));
          res.writeHead(ok ? 200 : 409, { "Content-Type": "application/json" }).end(JSON.stringify({ ok }));
        } else if (action === "save") {
          res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "bad action" }));
        }
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: String(e) }));
      }
    });
    return;
  }

  // Automatik-Modus umschalten (manual | semi | full).
  if (url.pathname === "/api/mode" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { mode } = JSON.parse(body || "{}");
        if (!["manual", "semi", "full"].includes(mode)) {
          res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "bad mode" }));
          return;
        }
        setMode(mode as Mode);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, mode }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: String(e) }));
      }
    });
    return;
  }

  // FOKUS umschalten: auf welche Zielgruppe geht der Bot? Steuert, aus welchen Quellen er
  // sich Nachschub holt (leadFeed). Sinan stellt nur das ein, der Rest laeuft von allein.
  if (url.pathname === "/api/focus" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { focus } = JSON.parse(body || "{}");
        if (!["azubi", "student", "beides"].includes(focus)) {
          res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "bad focus" }));
          return;
        }
        setFocus(focus as Focus);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, focus }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: String(e) }));
      }
    });
    return;
  }

  // SALES-AGENT umschalten (off/shadow/live) – der neue intelligente Kern. Greift ohne Neustart.
  if (url.pathname === "/api/agent-mode" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { mode } = JSON.parse(body || "{}");
        if (!["off", "shadow", "live"].includes(mode)) {
          res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "bad agent mode" }));
          return;
        }
        setAgentMode(mode as AgentMode);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, mode }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: String(e) }));
      }
    });
    return;
  }

  // AUTOMATIK-STUFE: EIN Schalter statt zwei. Jede Stufe setzt Modus + Agent zusammen. Damit
  // gibt es nur noch EINEN Bot-Regler (der Sales-Agent ist die Gesprächs-Engine der oberen Stufen).
  if (url.pathname === "/api/automatik" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { level } = JSON.parse(body || "{}");
        const STUFEN: Record<string, { mode: Mode; agent: AgentMode }> = {
          vorschlaege: { mode: "manual", agent: "off" },
          halb: { mode: "semi", agent: "off" },
          agent_test: { mode: "semi", agent: "shadow" },
          agent_live: { mode: "semi", agent: "live" },
        };
        const s = STUFEN[level as string];
        if (!s) {
          res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "bad level" }));
          return;
        }
        setMode(s.mode);
        setAgentMode(s.agent);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, level }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: String(e) }));
      }
    });
    return;
  }

  // BEITRAG SCHREIBEN LASSEN: sofort einen neuen Post-Entwurf erzeugen (nur Gemini + DB, KEIN
  // Browser nötig → der Dashboard-Prozess kann das direkt). Erscheint danach in "Post-Entwürfe".
  // BLOCKIERTE erneut senden: behebbare Fehler zurück in die Warteschlange, Duplikate verwerfen.
  if (url.pathname === "/api/retry-blocked" && req.method === "POST") {
    try {
      const r = retryBlockierte();
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, ...r }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, error: String(e) }));
    }
    return;
  }

  if (url.pathname === "/api/generate-post" && req.method === "POST") {
    generatePostDraft()
      .then((id) => {
        if (id) res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, id }));
        else res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, error: "Konnte gerade keinen Beitrag schreiben (evtl. KI-Tageslimit erreicht)." }));
      })
      .catch((e) => res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, error: String(e) })));
    return;
  }

  // NETZWERK REAKTIVIEREN: bestehende Verbindungen einlesen + Entwürfe für alle erzeugen, die
  // nie angeschrieben wurden. Braucht den Browser der Engine → Flag setzen, Loop holt es ab.
  if (url.pathname === "/api/netzwerk" && req.method === "POST") {
    setState("netzwerk_now", "1");
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, running: engineAlive() }));
    return;
  }

  // OFFENE ANTWORTEN PRÜFEN: alle Chats durchgehen (auch alte) und für jeden offenen einen
  // Entwurf zur Prüfung anlegen. Braucht den Browser der Engine → Flag setzen, Loop holt es ab.
  if (url.pathname === "/api/offene" && req.method === "POST") {
    setState("offene_now", "1");
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, running: engineAlive() }));
    return;
  }

  // REICHWEITE JETZT: Liken + Kommentar-Entwürfe sofort anstoßen. Braucht den Browser der Engine →
  // wir setzen nur ein Flag, das der Loop beim nächsten Tick (alle 2 Min) abholt (wie feed_now).
  if (url.pathname === "/api/reichweite" && req.method === "POST") {
    setState("comment_now", "1");
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, running: engineAlive() }));
    return;
  }

  // ZEITFENSTER an/aus: schaltet die Uhrzeit-Begrenzung (9–22 Uhr) ein oder aus. Aus = rund um
  // die Uhr senden; Caps/Pausen/Circuit-Breaker bleiben unberührt. Governor liest das Flag live.
  if (url.pathname === "/api/zeitfenster" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { an } = JSON.parse(body || "{}");
        setState("working_hours_off", an ? "0" : "1");
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, an: !!an }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: String(e) }));
      }
    });
    return;
  }

  // ANNAHMEQUOTEN-SCHUTZ: reduziert bei schwacher Quote nur neue Vernetzungsanfragen.
  // Harte Tages-/Wochenlimits und alle übrigen Sicherungen bleiben auch bei "Aus" aktiv.
  if (url.pathname === "/api/acceptance-protection" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { an } = JSON.parse(body || "{}");
        governor.setAcceptanceProtection(!!an);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, an: !!an }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: String(e) }));
      }
    });
    return;
  }

  /**
   * SICHERHEITSPAUSE LÖSEN (2026-08-06). Der Circuit-Breaker (Checkpoint, Fehlerserie) pausiert
   * den Governor und verlangt bewusst manuelles Eingreifen. Bisher gab es dafür KEINEN Weg im
   * Cockpit – die Pause musste von Hand in der Datenbank gelöst werden, während der Nutzer nur
   * einen stillen Bot sah. Jetzt ein Klick aus dem "Warum steht etwas still"-Kasten.
   */
  if (url.pathname === "/api/pause" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { an } = JSON.parse(body || "{}");
        if (an) governor.pause("Manuell im Cockpit pausiert");
        else governor.resume();
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, paused: !!an }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: String(e) }));
      }
    });
    return;
  }

  // NOT-AUS: mit EINEM Klick jeden Versand blockieren (ohne die Engine zu stoppen). Setzt das
  // Flag, das der Governor VOR jeder sendenden Aktion prüft. Wirkt sofort für alle Sendewege.
  if (url.pathname === "/api/notaus" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { an } = JSON.parse(body || "{}");
        setState("send_stop", an ? "1" : "0");
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, an: !!an }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: String(e) }));
      }
    });
    return;
  }

  // Lead-Quellen: hinzufügen / löschen / sofort Nachschub anfordern. Ersetzt `npm run source`.
  // Das eigentliche Scrapen macht die ENGINE (sie besitzt den Browser) – hier wird nur die
  // Quelle gespeichert und ein "feed_now"-Flag gesetzt, das der Loop beim nächsten Tick abholt.
  if (url.pathname === "/api/source" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { action, url: srcUrl, label, zielgruppe, campaignId, id } = JSON.parse(body || "{}");
        if (action === "add") {
          if (typeof srcUrl !== "string" || !/linkedin\.com/i.test(srcUrl)) {
            res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, error: "Bitte eine LinkedIn-Such-Adresse einfügen (beginnt mit linkedin.com)." }));
            return;
          }
          const zg = ["azubi", "student"].includes(zielgruppe) ? zielgruppe : undefined;
          const campaign = Number.isInteger(Number(campaignId)) && Number(campaignId) > 0 ? Number(campaignId) : undefined;
          addSource(srcUrl.trim(), (typeof label === "string" && label.trim()) || undefined, undefined, zg, campaign);
          setState("feed_now", "1"); // Bot holt beim nächsten Tick Nachschub aus der neuen Quelle
          res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, running: engineAlive() }));
        } else if (action === "delete") {
          deleteSource(Number(id));
          res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
        } else if (action === "feednow") {
          setState("feed_now", "1");
          res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, running: engineAlive() }));
        } else {
          res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "bad action" }));
        }
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: String(e) }));
      }
    });
    return;
  }

  // EINFACHER AUFTRAG: Nutzer beschreibt nur die Menschen und wählt B1/P1/AEC. Suchbegriffe,
  // LinkedIn-URLs, Quellen und Kampagnenzuordnung entstehen automatisch. Bestehende manuelle
  // Quellen und Event-Kampagnen bleiben davon vollständig unberührt.
  if (url.pathname === "/api/mission" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      void (async () => {
        try {
          const result = await createMission(JSON.parse(body || "{}"));
          res.writeHead(201, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, ...result, running: engineAlive() }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, error: String((e as Error).message || e) }));
        }
      })();
    });
    return;
  }

  if (url.pathname === "/api/goal-alert" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const input = JSON.parse(body || "{}");
        const action = input.action === "accepted" ? "accepted" : input.action === "dismissed" ? "dismissed" : null;
        if (!action) throw new Error("Ungültige Entscheidung.");
        const ok = resolveGoalAlert(Number(input.id), action);
        res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" }).end(JSON.stringify({ ok }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, error: String((e as Error).message || e) }));
      }
    });
    return;
  }

  // KAMPAGNEN: strategischer Rahmen für Quellen und spätere Ergebnisse. Diese Endpunkte ändern
  // keine Automatik – sie organisieren und messen ausschließlich die vorhandene Vertriebsarbeit.
  if (url.pathname === "/api/campaign" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const input = JSON.parse(body || "{}");
        const { action, id } = input;
        if (action === "preview") {
          const preview = previewCampaign(input);
          res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, preview }));
        } else if (action === "create") {
          const campaignId = createCampaign(input);
          res.writeHead(201, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, id: campaignId }));
        } else if (action === "update") {
          const ok = updateCampaign(Number(id), input);
          res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" }).end(JSON.stringify({ ok }));
        } else if (action === "delete") {
          const result = deleteCampaign(Number(id));
          res.writeHead(result.ok ? 200 : 404, { "Content-Type": "application/json" }).end(JSON.stringify(result));
        } else if (action === "pause" || action === "resume") {
          const ok = setCampaignActive(Number(id), action === "resume");
          res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" }).end(JSON.stringify({ ok }));
        } else if (action === "retry_target") {
          const ok = retryCampaignTarget(Number(id), Number(input.contactId));
          res.writeHead(ok ? 200 : 409, { "Content-Type": "application/json" }).end(JSON.stringify({ ok }));
        } else if (action === "retry_failed") {
          const retried = retryFailedCampaignTargets(Number(id));
          res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, retried }));
        } else {
          res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "bad action" }));
        }
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, error: String((e as Error).message || e) }));
      }
    });
    return;
  }

  // BEZIEHUNGSSCHUTZ: bewusst eigene Kontaktsteuerung. Pausieren oder Ausschließen entfernt
  // proaktive Entwürfe sofort; direkte Antworten auf neue Nachrichten bleiben möglich.
  if (url.pathname === "/api/contact-policy" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const input = JSON.parse(body || "{}");
        if (!["pause", "resume", "exclude", "manual"].includes(input.action)) throw new Error("Ungültige Kontaktregel.");
        const ok = setRelationshipPolicy({
          contactId: Number(input.contactId), action: input.action, until: input.until, reason: input.reason,
        });
        res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" }).end(JSON.stringify({ ok }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, error: String((e as Error).message || e) }));
      }
    });
    return;
  }

  if (url.pathname === "/api/contact-identity" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const input = JSON.parse(body || "{}");
        const ok = resolveIdentityConflict(Number(input.conflictId), Number(input.contactId));
        if (!ok) throw new Error("Die Zuordnung ist nicht mehr offen oder passt nicht zu diesem Kontakt.");
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify({ ok: true }));
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify({ error: String((error as Error).message || error) }));
      }
    });
    return;
  }

  // KAMPAGNEN-MATERIAL: Flyer, Agenda, Links samt Kernaussagen. Der Upload läuft als JSON mit
  // Base64-Inhalt, damit kein Multipart-Parser nötig ist; die Datei bleibt rein lokal.
  if (url.pathname === "/api/campaign-asset" && req.method === "POST") {
    let body = "";
    let zuGross = false;
    req.on("data", (c) => {
      body += c;
      // 16 MB Rohgrenze: 8 MB Datei werden als Base64 rund 11 MB groß.
      if (body.length > 16 * 1024 * 1024 && !zuGross) {
        zuGross = true;
        res.writeHead(413, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Datei zu groß (max. 8 MB)." }));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (zuGross) return;
      try {
        const input = JSON.parse(body || "{}");
        const { action, id } = input;
        if (action === "add") {
          const assetId = addCampaignAsset(input);
          res.writeHead(201, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, id: assetId }));
        } else if (action === "update") {
          const ok = updateCampaignAsset(Number(id), input);
          res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" }).end(JSON.stringify({ ok }));
        } else if (action === "delete") {
          const ok = deleteCampaignAsset(Number(id));
          res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" }).end(JSON.stringify({ ok }));
        } else {
          res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "bad action" }));
        }
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, error: String((e as Error).message || e) }));
      }
    });
    return;
  }

  // Hochgeladenes Material wieder anzeigen/herunterladen (nur lokal, nur aus dem Kampagnenordner).
  if (url.pathname === "/api/campaign-asset" && req.method === "GET") {
    const asset = getCampaignAsset(Number(url.searchParams.get("id")));
    const path = asset ? campaignAssetPath(asset) : null;
    if (!asset || !path) {
      res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "not found" }));
      return;
    }
    res
      .writeHead(200, {
        "Content-Type": asset.mime || "application/octet-stream",
        "Content-Disposition": `inline; filename="${(asset.name || "material").replace(/[^\w.\- ]+/g, "_")}"`,
        "Cache-Control": "no-store",
      })
      .end(readFileSync(path));
    return;
  }

  // ERGEBNIS ERFASSEN: menschliche Entscheidung nach einem echten Gespräch. So wird aus dem
  // Bot-Funnel eine vertriebliche Kennzahl – ohne den LinkedIn-Versand oder Agenten zu verändern.
  if (url.pathname === "/api/outcome" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { contactId, stage, note, valueEur } = JSON.parse(body || "{}");
        if (!OUTCOME_STAGES.includes(stage)) {
          res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, error: "bad stage" }));
          return;
        }
        const eur = typeof valueEur === "number" ? valueEur : Number(String(valueEur).replace(",", "."));
        recordOutcome(Number(contactId), stage as OutcomeStage, note, Number.isFinite(eur) ? eur * 100 : undefined);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, error: String((e as Error).message || e) }));
      }
    });
    return;
  }

  // NÄCHSTER SCHRITT: persönliche Vertriebsaufgabe zu einem Lead. Komplett unabhängig vom Bot-
  // Versand, damit Verantwortung, Fälligkeit und Beziehung beim Menschen bleiben.
  if (url.pathname === "/api/task" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { action, id, contactId, title, dueAt } = JSON.parse(body || "{}");
        if (action === "create") {
          const taskId = addSalesTask(Number(contactId), title, dueAt);
          res.writeHead(201, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, id: taskId }));
        } else if (action === "complete") {
          const ok = completeSalesTask(Number(id));
          res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" }).end(JSON.stringify({ ok }));
        } else if (action === "delete") {
          const ok = deleteSalesTask(Number(id));
          res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" }).end(JSON.stringify({ ok }));
        } else {
          res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, error: "bad action" }));
        }
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, error: String((e as Error).message || e) }));
      }
    });
    return;
  }

  // NOTIZEN: alles, was nach einem Telefonat festgehalten werden muss. Landet mit Zeitstempel
  // in der Kontaktspur, damit später nachvollziehbar ist, WANN es notiert wurde.
  if (url.pathname === "/api/note" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { action, id, contactId, text } = JSON.parse(body || "{}");
        if (action === "create") {
          const noteId = addContactNote(Number(contactId), text);
          res.writeHead(201, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, id: noteId }));
        } else if (action === "delete") {
          const ok = deleteContactNote(Number(id));
          res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" }).end(JSON.stringify({ ok }));
        } else {
          res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, error: "bad action" }));
        }
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, error: String((e as Error).message || e) }));
      }
    });
    return;
  }

  // VERTRIEBSSTUFE VON HAND. Geht durch setStageManually und damit durch recordCrmStage: gleicher
  // fachlicher Dedupe-Schlüssel, gleiches Einfrieren der Zuordnung. Beobachtete Bot-Tatsachen
  // (invited/accepted/...) lehnt die Funktion ab – sonst liessen sich die Quoten schönklicken.
  if (url.pathname === "/api/stage" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { contactId, stage } = JSON.parse(body || "{}");
        const result = setStageManually(Number(contactId), stage);
        // `reason` mitgeben: der Client wirft bei HTTP 400 und liest genau diesen Schlüssel –
        // sonst sähe der Nutzer nur "HTTP 400" statt des eigentlichen Grundes.
        const payload = result.ok ? result : { ...result, reason: result.grund };
        res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json" }).end(JSON.stringify(payload));
      } catch (e) {
        const grund = String((e as Error).message || e);
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, grund, reason: grund }));
      }
    });
    return;
  }

  // EXPERIMENTE: A/B-Vergleich zweier Kampagnen. Es wird nichts am Versand automatisiert;
  // das System misst nur echte Funnel-Daten und zeigt ab ausreichender Stichprobe einen Vorsprung.
  if (url.pathname === "/api/experiment" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { action, id, name, hypothesis, metric, campaignA, campaignB, status } = JSON.parse(body || "{}");
        if (action === "create") {
          if (!EXPERIMENT_METRICS.includes(metric)) throw new Error("Ungültige Erfolgsmetrik.");
          const experimentId = createExperiment({ name, hypothesis, metric: metric as ExperimentMetric, campaignA: Number(campaignA), campaignB: Number(campaignB) });
          res.writeHead(201, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, id: experimentId }));
        } else if (action === "status" && ["active", "paused", "finished"].includes(status)) {
          const ok = setExperimentStatus(Number(id), status);
          res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" }).end(JSON.stringify({ ok }));
        } else {
          res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, error: "bad action" }));
        }
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, error: String((e as Error).message || e) }));
      }
    });
    return;
  }

  // MANUELLES BACKUP: erzeugt einen lokalen, konsistenten SQLite-Snapshot. Kein Export nach
  // außen und kein Zugriff auf LinkedIn – die Daten bleiben vollständig auf diesem Rechner.
  if (url.pathname === "/api/backup" && req.method === "POST") {
    createDatabaseBackup("manual")
      .then((result) => res.writeHead(result.ok ? 200 : 500, { "Content-Type": "application/json" }).end(JSON.stringify(result)))
      .catch((e) => res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, error: String(e) })));
    return;
  }

  // Engine (Loop) starten/stoppen – ersetzt "npm run dev" im Terminal.
  if (url.pathname === "/api/engine" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { action } = JSON.parse(body || "{}");
        if (action === "start") {
          setState("engine_gewollt", "1"); // Server-Modus: Watchdog + Autostart nach Neustart
          starteEngine();
          res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, restarting: true }));
        } else if (action === "stop") {
          setState("engine_gewollt", "0");
          stoppeEngine();
          res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "bad action" }));
        }
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: String(e) }));
      }
    });
    return;
  }

  // Kontakt aus dem CRM entfernen.
  if (url.pathname === "/api/contact" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { id, action } = JSON.parse(body || "{}");
        if (action !== "delete") {
          res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "bad action" }));
          return;
        }
        const ok = deleteContact(Number(id));
        res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" }).end(JSON.stringify({ ok }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: String(e) }));
      }
    });
    return;
  }

  // PITCH Stufe 2: Sinan hat einen Pitch-Ansatz gewählt → daraus SOFORT die Nachricht generieren
  // (reiner KI-Aufruf, kein Browser nötig) und als neuen 'message'-Entwurf zur zweiten Freigabe
  // ablegen. Direkt hier statt über einen Engine-Cron, damit die Nachricht in Sekunden erscheint
  // (der 2-Min-Cron wirkte tot). Die Antwort kommt erst zurück, wenn der Entwurf steht.
  if (url.pathname === "/api/pitch" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { id, idee } = JSON.parse(body || "{}");
        if (!id || !idee) {
          res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "id/idee fehlt" }));
          return;
        }
        const generated = await pitchZuNachricht(Number(id), String(idee));
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, generated }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: String(e) }));
      }
    });
    return;
  }

  // CHAT WIEDERBELEBEN: eingeschlafenen Chat anstoßen → Engine erzeugt einen Nachfass-Entwurf.
  // Kein Browser hier – nur Flag setzen (mit der Profil-URL des Kontakts), Loop holt es ab.
  if (url.pathname === "/api/wiederbeleben" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { url: profilUrl } = JSON.parse(body || "{}");
        if (!profilUrl) {
          res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "keine url" }));
          return;
        }
        setState("wiederbeleben_now", String(profilUrl));
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, running: engineAlive() }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: String(e) }));
      }
    });
    return;
  }

  // Live-Ansicht: letzter Schnappschuss des versteckten Browsers (von der Engine geschrieben).
  // Getrennte Prozesse → Umweg über Datei. 404, solange die Engine noch keinen geschrieben hat.
  if (url.pathname === "/api/live.jpg") {
    try {
      const img = readFileSync(LIVE_SHOT_PATH);
      res
        .writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "no-store" })
        .end(img);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("noch kein Bild");
    }
    return;
  }

  if (url.pathname === "/api/analytics") {
    try {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(getAnalytics()));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: String(e) }));
    }
    return;
  }

  if (url.pathname === "/api/conversation") {
    try {
      const contactId = Number(url.searchParams.get("contactId"));
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(getConversationWorkspace(contactId)));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify({ error: String(e) }));
    }
    return;
  }

  if (url.pathname === "/api/state") {
    try {
      const data = JSON.stringify(getDashboardData());
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }).end(data);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" }).end(
        JSON.stringify({ error: String(e) }),
      );
    }
    return;
  }

  // Setup-Seite (der Assistent selbst).
  if (url.pathname === "/setup") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(readFileSync(SETUP_PATH, "utf-8"));
    return;
  }

  // Statische Bild-Assets (Logo/Marke) aus web/assets/. Pfad gehärtet (nur Dateiname, kein ../).
  if (url.pathname.startsWith("/assets/") && /\.(png|jpg|jpeg|svg)$/.test(url.pathname)) {
    try {
      const name = url.pathname.slice("/assets/".length).replace(/[^a-zA-Z0-9._-]/g, "");
      const buf = readFileSync(join(__dirname, "..", "web", "assets", name));
      const typ = name.endsWith(".svg") ? "image/svg+xml" : name.endsWith(".jpg") || name.endsWith(".jpeg") ? "image/jpeg" : "image/png";
      res.writeHead(200, { "Content-Type": typ, "Cache-Control": "max-age=86400" }).end(buf);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("nicht gefunden");
    }
    return;
  }

  if (url.pathname === "/command-center.css" || url.pathname === "/command-center.js") {
    try {
      const name = url.pathname.slice(1);
      const body = readFileSync(join(__dirname, "..", "web", name));
      const type = name.endsWith(".css") ? "text/css" : "text/javascript";
      res.writeHead(200, { "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "no-store" }).end(body);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("nicht gefunden");
    }
    return;
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    // Weiche: noch nicht eingerichtet → Setup-Assistent, sonst das Dashboard.
    if (!setupStatus().configured) {
      res.writeHead(302, { Location: "/setup" }).end();
      return;
    }
    // In dev bei jedem Request frisch lesen, damit Design-Änderungen sofort greifen.
    const html = readFileSync(HTML_PATH, "utf-8");
    // no-store: nach einem Server-Update darf der Browser nie die alte Seite zeigen (2026-09-22:
    // neues Bericht-Panel war im Cockpit unsichtbar, bis hart neu geladen wurde).
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(html);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" }).end("Nicht gefunden");
});

server.listen(PORT, HOST, () => {
  console.info(`\n  CRM-Cockpit läuft →  http://${HOST === "0.0.0.0" ? "<server-ip>" : "localhost"}:${PORT}\n`);
  console.info("  Beenden mit STRG+C.\n");
  if (istServerModus()) {
    logZeitzone("server");
    console.info(`[server] Datenordner: ${config.paths.dataDir} · Basic-Auth aktiv (DASHBOARD_TOKEN).`);
    serverErststart(); // Not-Aus AN + Warm-up zurück – nur beim allerersten Start je Datenordner
    /**
     * AUTOSTART + WATCHDOG (nur Server-Modus). Auf dem Mac startet der Nutzer die Engine per Knopf;
     * ein Server hat keinen Nutzer, der nach einem Neustart klickt. Deshalb: Engine starten, wenn
     * sie zuletzt gewollt war (Standard: ja – sie sitzt ohnehin hinter dem Not-Aus). Stirbt sie,
     * startet der Watchdog sie alle 2 Minuten neu, solange `engine_gewollt` nicht 0 ist.
     */
    if (getState("engine_gewollt") !== "0") {
      setState("engine_gewollt", "1");
      setTimeout(starteEngine, 1500);
      setInterval(() => {
        if (getState("engine_gewollt") === "1" && !engineAlive()) {
          const alter = heartbeatAlter();
          const job = getState("engine_active_job") || null;
          // IN DIE DATENBANK, nicht nur nach stdout: stdout ist `docker logs` und wird bei
          // jedem `docker compose up` weggeworfen. Genau deshalb waren am 22.09. zwei
          // Neustarts (08:14, 11:48) nirgends begründet. Die Engine meldet das beim
          // nächsten Start per Telegram nach – Telegram läuft in ihrem Prozess, nicht hier.
          protokolliereNeustart({
            grund: "watchdog",
            detail: `Kein Heartbeat seit ${alter == null ? "unbekannt" : `${Math.round(alter)}s`}.`,
            letzterJob: job,
            heartbeatAlterSek: alter,
          });
          console.warn(`[server] Engine antwortet nicht (kein Heartbeat seit ${alter == null ? "?" : Math.round(alter)}s${job ? `, zuletzt: ${job}` : ""}) – Watchdog startet sie neu.`);
          starteEngine();
        }
      }, 120_000).unref();
    }
  }
});

// Funktioniert auch bei ausgeschalteter Engine: Der Dashboard-Prozess versucht Offline-Meldungen
// regelmäßig erneut und hält den Timer nicht künstlich am Leben, wenn die App beendet wird.
const reportRetryTimer = setInterval(() => flushPendingReports().catch(() => {}), 5 * 60_000);
reportRetryTimer.unref();
setTimeout(() => flushPendingReports().catch(() => {}), 8_000).unref();
