import { db, getState } from "../db/index.js";
import { governor } from "../core/safetyGovernor.js";
import { leseStand } from "../core/leseBudget.js";

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
  if (!g.withinWorkingHours) return fertig(`Ausserhalb der Arbeitszeit (${g.workingHoursText}).`, "");
  if (budget.erschoepft) return fertig("Das Lese-Budget für heute ist aufgebraucht.", "Setzt sich morgen früh von selbst zurück.");

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
