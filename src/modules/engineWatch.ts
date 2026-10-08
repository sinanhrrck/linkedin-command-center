import { db, getState } from "../db/index.js";
import { governor } from "../core/safetyGovernor.js";
import { leseStand } from "../core/leseBudget.js";
import { sendHealthStand } from "../core/sendHealth.js";
import { openJobFailures } from "../core/jobReliability.js";
import { JOB_TIMEOUT_MS, DEFAULT_JOB_TIMEOUT_MS } from "../core/jobTimeout.js";

/** Jobs, deren Stillstand bedeutet, dass nichts mehr rausgeht. Lese-Jobs (feed, acceptance) nicht. */
const SENDE_JOBS: ReadonlySet<string> = new Set(["sendApproved", "agent", "outreach", "morgen", "drafts", "healthcheck"]);

/**
 * HÄNGT EIN JOB? (2026-10-08) Jeder Job hat ein kooperatives Zeitlimit (core/jobTimeout.ts); danach
 * wird der Browser geschlossen und die Promise SOLL enden. Tut sie es nicht, steht die serielle
 * Warteschlange für immer – der Heartbeat läuft aber weiter, also merkt der Watchdog nichts.
 * Maßstab: die laufende Zeile in `bot_activity` ist älter als Zeitlimit + 10 Minuten Puffer.
 * Dient Diagnose UND Watchdog (crmServer.ts); beide Prozesse lesen dieselbe Tabelle.
 */
export function jobHaengt(now = Date.now()): { job: string; minuten: number } | null {
  const aktiv = getState("engine_active_job");
  if (!aktiv) return null;
  const row = db.prepare(
    "SELECT job, started_at FROM bot_activity WHERE status='running' AND job=? ORDER BY id DESC LIMIT 1",
  ).get(aktiv) as { job: string; started_at: string } | undefined;
  if (!row) return null;
  const alterMs = now - new Date(`${row.started_at.replace(" ", "T")}Z`).getTime();
  if (!Number.isFinite(alterMs)) return null;
  const limit = (JOB_TIMEOUT_MS[row.job] ?? DEFAULT_JOB_TIMEOUT_MS) + 10 * 60_000;
  return alterMs > limit ? { job: row.job, minuten: Math.round(alterMs / 60_000) } : null;
}

/**
 * WARUM DIESES MODUL EXISTIERT (2026-09-22)
 *
 * Zwei Fragen waren bisher nur per SSH zu beantworten:
 *  1. "Warum ist die Engine neu gestartet?" – Der Watchdog schrieb seinen Grund mit
 *     console.warn nach stdout. stdout landet in `docker logs` und wird bei jedem
 *     `docker compose up` weggeworfen. `engine.log` überlebt, sah die Meldung aber nie.
 *     Real gemessen: am 22.09. lief die Engine fünfmal an, zwei Neustarts (08:14, 11:48)
 *     hatten NIRGENDS eine Begründung.
 *  2. "Warum sendet der Bot gerade nichts?" – Alle Daten waren da (Cap, Warm-up, offene
 *     Entwürfe), aber niemand hat sie zusammengesetzt. Telegram meldet nur GESENDETES,
 *     also schweigt es ausgerechnet dann, wenn man eine Erklärung braucht.
 *
 * Die Datenbank ist der einzige Ort, den Dashboard-Prozess (Watchdog) und Engine-Prozess
 * (Telegram) teilen und der einen Container-Neubau überlebt. Deshalb läuft beides hierüber.
 */

export type NeustartGrund = "watchdog" | "absturz" | "autostart" | "manuell";

export type Neustart = {
  id: number;
  at: string;
  grund: NeustartGrund;
  detail: string | null;
  letzter_job: string | null;
  heartbeat_alter: number | null;
};

/** Sendende Aktionen – nur die beantworten "der Bot tut etwas nach aussen". */
const SENDEND = ["connect", "message", "campaign", "reply", "comment"] as const;

export function protokolliereNeustart(input: {
  grund: NeustartGrund;
  detail?: string | null;
  letzterJob?: string | null;
  heartbeatAlterSek?: number | null;
}): number {
  return Number(db.prepare(
    "INSERT INTO engine_neustarts(grund,detail,letzter_job,heartbeat_alter) VALUES(?,?,?,?)",
  ).run(
    input.grund,
    input.detail ? String(input.detail).slice(0, 2000) : null,
    input.letzterJob || null,
    input.heartbeatAlterSek == null ? null : Math.round(input.heartbeatAlterSek),
  ).lastInsertRowid);
}

/** Sekunden seit dem letzten Heartbeat – `null`, wenn nie einer geschrieben wurde. */
export function heartbeatAlter(): number | null {
  const hb = getState("engine_heartbeat");
  if (!hb) return null;
  const alter = (Date.now() - new Date(hb).getTime()) / 1000;
  return Number.isFinite(alter) ? alter : null;
}

/**
 * Neustarts, die noch niemand gemeldet hat. Der Watchdog läuft im Dashboard-Prozess, Telegram
 * im Engine-Prozess – die frisch gestartete Engine holt die Meldung deshalb nach.
 * `autostart` wird bewusst NICHT gemeldet: ein gewollter Start ist keine Störung.
 */
export function offeneNeustartMeldungen(limit = 5): Neustart[] {
  return db.prepare(
    `SELECT id,at,grund,detail,letzter_job,heartbeat_alter FROM engine_neustarts
      WHERE berichtet_at IS NULL AND grund <> 'autostart'
      ORDER BY at DESC LIMIT ?`,
  ).all(limit) as Neustart[];
}

export function markiereNeustartsBerichtet(ids: number[]): void {
  if (!ids.length) return;
  const markiere = db.prepare("UPDATE engine_neustarts SET berichtet_at=datetime('now') WHERE id=?");
  db.transaction((liste: number[]) => { for (const id of liste) markiere.run(id); })(ids);
}

/**
 * Räumt alte Zeilen weg. Das Protokoll ist ein Diagnosewerkzeug, kein Safety-Protokoll –
 * anders als `actions`, das nie beschnitten werden darf.
 */
export function kuerzeNeustartProtokoll(behalte = 200): number {
  return db.prepare(
    "DELETE FROM engine_neustarts WHERE id NOT IN (SELECT id FROM engine_neustarts ORDER BY at DESC LIMIT ?)",
  ).run(behalte).changes;
}

export type Stillstand = {
  /** true = es gibt einen erklärbaren Grund, warum gerade nichts rausgeht. */
  steht: boolean;
  /** Kurzer Klartext für Telegram/Cockpit. */
  grund: string;
  /** Was der Nutzer dagegen tun kann – leer, wenn es nur Warten ist. */
  tun: string;
  /** Sekunden seit der letzten sendenden Aktion; null = noch nie gesendet. */
  seitSek: number | null;
};

/**
 * Setzt zusammen, WARUM gerade nichts rausgeht – in der Reihenfolge, in der die Sperren
 * tatsächlich greifen (Not-Aus vor Pause vor Zeitfenster vor Cap vor Freigabe). Die erste
 * zutreffende Erklärung gewinnt; alles andere wäre Rätselraten für den Leser.
 */
export function stillstandGrund(): Stillstand {
  const letzte = db.prepare(
    `SELECT MAX(created_at) AS at FROM actions WHERE type IN (${SENDEND.map(() => "?").join(",")})`,
  ).get(...SENDEND) as { at: string | null };
  const seitSek = letzte.at ? Math.max(0, (Date.now() - new Date(`${letzte.at.replace(" ", "T")}Z`).getTime()) / 1000) : null;

  const g = governor.snapshot();
  const offeneEntwuerfe = (db.prepare(
    "SELECT COUNT(*) n FROM drafts WHERE status='pending' AND phase IS NOT 'approach'",
  ).get() as { n: number }).n;
  const freigegeben = (db.prepare("SELECT COUNT(*) n FROM drafts WHERE status='approved'").get() as { n: number }).n;
  const budget = leseStand();

  const fertig = (grund: string, tun = "") => ({ steht: true, grund, tun, seitSek });

  if (g.notAus) return fertig("Der Not-Aus ist aktiv.", "Im Cockpit unter „Not-Aus“ wieder freigeben.");
  if (g.paused) return fertig(`Der Sicherheits-Stopp hat ausgelöst${g.pauseReason ? `: ${g.pauseReason}` : "."}`, "In den Einstellungen prüfen und fortsetzen.");
  // HÄNGENDER JOB (2026-10-08): der Heartbeat tickt unabhängig von der Job-Warteschlange. Hängt ein
  // Job, läuft nichts mehr – und der Watchdog sah einen gesunden Prozess. Das ist der stillste Stillstand.
  const haengt = jobHaengt();
  if (haengt) return fertig(`Der Job „${haengt.job}“ hängt seit ${haengt.minuten} Minuten – dahinter staut sich alles.`, "Engine im Cockpit neu starten; der Watchdog tut es auf dem Server von selbst.");
  if (!g.withinWorkingHours) return fertig(`Ausserhalb der Arbeitszeit (${g.workingHoursText}).`, "");
  if (budget.erschoepft) return fertig("Das Lese-Budget für heute ist aufgebraucht.", "Setzt sich morgen früh von selbst zurück.");
  // SENDEWEG (2026-10-08): der Governor blockiert Nachrichten bei „defekt“ und bei einer Prüfung,
  // die älter als 8 h ist. Beides hieß in dieser Diagnose bisher „kein Hinderungsgrund“.
  const health = sendHealthStand();
  if (health.status === "broken") return fertig(`Der Selbst-Check meldet den Sendeweg als defekt: ${health.reason ?? "unbekannt"}.`, "Im Cockpit „Sendeweg jetzt prüfen“ – ist LinkedIn umgebaut, müssen die Selektoren angepasst werden.");
  if (health.status !== "ok") {
    const fehler = getState("send_health_check_fehler");
    return fertig(`Der Sendeweg ist nicht frisch geprüft (${health.reason ?? health.status})${fehler ? `; letzte Prüfung: ${fehler.slice(25, 140)}` : ""}.`, "Im Cockpit „Sendeweg jetzt prüfen“ auslösen.");
  }
  // TOTE JOBS (2026-10-08): nach drei Fehlern hält `jobReliability` einen Job an – bis jemand ihn
  // im Cockpit freigibt. Ohne diese Zeile sah das nach einem Bot aus, der grundlos nichts tut.
  const tot = openJobFailures().filter((j) => j.status === "dead" && SENDE_JOBS.has(j.job));
  if (tot.length) return fertig(`Angehalten nach wiederholten Fehlern: ${tot.map((j) => `${j.job} (${(j.lastError ?? "").slice(0, 60)})`).join("; ")}.`, "Im Cockpit unter Betrieb den Job erneut freigeben.");

  const connectVoll = g.connect.today >= (g.connect.allowedCap || g.connect.effectiveCap);
  const messageVoll = g.message.today >= g.message.effectiveCap;

  // Freigeben ist der Hebel, den NUR der Nutzer hat – deshalb vor den Caps nennen, sobald
  // Nachrichten-Kontingent frei ist. Sonst liest er "Cap erreicht" und wartet auf den Bot,
  // obwohl der auf ihn wartet.
  if (!messageVoll && !freigegeben && offeneEntwuerfe) {
    return fertig(
      `${offeneEntwuerfe} Entwürfe warten auf deine Freigabe (${g.message.today}/${g.message.effectiveCap} Nachrichten heute).`,
      "Im Cockpit unter „Heute“ freigeben – danach sendet die Engine von selbst.",
    );
  }
  if (connectVoll && messageVoll) {
    const warm = g.warmup.factor < 1
      ? ` Warm-up steht bei Tag ${g.warmup.elapsedDays.toFixed(1)} von ${g.warmup.days}, deshalb die kleineren Grenzen.`
      : "";
    return fertig(`Tageslimit erreicht: ${g.connect.today} Anfragen, ${g.message.today} Nachrichten.${warm}`, "");
  }
  if (connectVoll && !offeneEntwuerfe && !freigegeben) {
    return fertig(`Anfrage-Limit erreicht (${g.connect.today}), und es liegt kein Entwurf zum Senden bereit.`, "");
  }

  return { steht: false, grund: "Es gibt gerade keinen Hinderungsgrund.", tun: "", seitSek };
}
