import { config } from "../config.js";
import { db, getStartDate, getState, setState } from "../db/index.js";
import { humanDelay } from "./humanize.js";
import { events } from "./events.js";

export type ActionType = "connect" | "message" | "comment" | "profileView" | "like";

type Decision = { ok: true } | { ok: false; reason: string };

/**
 * Der Governor. Zentrale Instanz, durch die JEDE sendende Aktion muss.
 * Er entscheidet nicht "ob eine Aktion sinnvoll ist", sondern nur, ob sie
 * JETZT ohne unnötiges Ban-Risiko erlaubt ist.
 */
class SafetyGovernor {
  /** Globaler Not-Aus. Wird vom Circuit-Breaker / Checkpoint-Detektor gesetzt. */
  isPaused(): boolean {
    return getState("paused") === "1";
  }

  pause(reason: string) {
    setState("paused", "1");
    setState("pause_reason", reason);
    console.warn(`[GOVERNOR] PAUSIERT: ${reason}`);
  }

  resume() {
    setState("paused", "0");
    setState("pause_reason", "");
    console.info("[GOVERNOR] fortgesetzt");
  }

  /** Wie viele Aktionen eines Typs heute schon liefen. */
  private countToday(type: ActionType): number {
    const row = db
      .prepare(
        "SELECT COUNT(*) AS n FROM actions WHERE type = ? AND date(created_at) = date('now','localtime')",
      )
      .get(type) as { n: number };
    return row.n;
  }

  private countThisWeek(type: ActionType): number {
    const row = db
      .prepare(
        "SELECT COUNT(*) AS n FROM actions WHERE type = ? AND created_at >= datetime('now','-7 days')",
      )
      .get(type) as { n: number };
    return row.n;
  }

  /** Warm-up-Faktor: an Tag 1 klein, linear hoch bis 1.0 nach warmupDays. */
  private warmupFactor(): number {
    const { warmupDays, warmupStartFactor } = config.safety;
    const days = (Date.now() - getStartDate().getTime()) / 86_400_000;
    if (days >= warmupDays) return 1;
    return warmupStartFactor + (1 - warmupStartFactor) * (days / warmupDays);
  }

  /** Effektive Tagesobergrenze inkl. Warm-up. */
  private effectiveCap(type: ActionType): number {
    return Math.max(1, Math.floor(config.safety.dailyCaps[type] * this.warmupFactor()));
  }

  /**
   * Zeitfenster-Prüfung. Für den Aktionstyp gilt am Wochenende eine Sonderregel: nur
   * `weekendActions` (Vernetzen/Like/Profilbesuch) sind Sa/So erlaubt, Direktnachrichten &
   * Kommentare NICHT – die sollen wie bei einem Menschen nur werktags kommen.
   */
  private withinWorkingHours(type?: ActionType): boolean {
    const now = new Date();
    const h = now.getHours();
    if (h < config.safety.workingHours.start || h >= config.safety.workingHours.end) return false;
    const weekend = now.getDay() === 0 || now.getDay() === 6;
    if (weekend) {
      // Ohne Typ (Telemetrie): Wochenende gilt als "aktiv", solange überhaupt etwas erlaubt ist.
      if (!type) return true;
      return (config.safety.weekendActions as readonly string[]).includes(type);
    }
    return true;
  }

  /** Akzeptanzrate der letzten 7 Tage (accepted / invited). */
  /**
   * Akzeptanzrate über eine KOHORTE: von den Einladungen, die alt genug sind, um
   * angenommen worden zu sein, wie viele wurden es?
   *
   * Vorher war das kaputt (gefixt 2026-07-16): der Nenner zählte ALLE Anfragen der letzten
   * 7 Tage – auch die von vor 5 Minuten, die niemand annehmen konnte. Menschen brauchen 1-3
   * Tage. Ein fleißiger Bot sah dadurch zwangsläufig schlecht aus und der Circuit-Breaker
   * hätte ihn grundlos pausiert (real: 13% bei n=15, Pause ab n=20). Zweiter Fehler: Zähler
   * und Nenner kamen aus verschiedenen Gruppen (eine Annahme von heute zählte oben mit, auch
   * wenn die Einladung 10 Tage alt war und unten fehlte).
   *
   * Jetzt: nur Einladungen aus dem Fenster [heute-7d ... heute-{maturityDays}d] und von
   * genau DIESEN wird gezählt, wie viele accepted_at haben. Gleiche Gruppe oben wie unten.
   */
  acceptanceRate(): { rate: number; sample: number } {
    const reif = config.safety.acceptanceMaturityDays;
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n,
                SUM(CASE WHEN accepted_at IS NOT NULL THEN 1 ELSE 0 END) AS ok
           FROM contacts
          WHERE invited_at IS NOT NULL
            AND invited_at >= datetime('now','-7 days')
            AND invited_at <= datetime('now', ?)`,
      )
      .get(`-${reif} days`) as { n: number; ok: number | null };
    const invited = row.n;
    const accepted = row.ok ?? 0;
    return { rate: invited === 0 ? 1 : accepted / invited, sample: invited };
  }

  /** MANUELLER Not-Aus (Dashboard-Knopf). Unabhängig vom Auto-Circuit-Breaker (`paused`),
   *  damit ein automatisches „resume" den vom Menschen gesetzten Stopp NICHT aufhebt. */
  notAusAktiv(): boolean {
    return getState("send_stop") === "1";
  }
  setNotAus(an: boolean) {
    setState("send_stop", an ? "1" : "0");
    console.warn(`[GOVERNOR] Not-Aus ${an ? "AKTIV – jeder Versand blockiert" : "gelöst"}`);
  }

  /** Kernfrage: Darf ich JETZT eine Aktion dieses Typs ausführen? */
  canDoAction(type: ActionType): Decision {
    // NOT-AUS zuerst: härter als alles andere, kann nur vom Menschen gelöst werden.
    if (this.notAusAktiv())
      return { ok: false, reason: "Not-Aus aktiv – Versand manuell gestoppt" };

    if (this.isPaused())
      return { ok: false, reason: `pausiert (${getState("pause_reason") ?? "unbekannt"})` };

    if (!this.withinWorkingHours(type)) {
      const now = new Date();
      const inHours = now.getHours() >= config.safety.workingHours.start && now.getHours() < config.safety.workingHours.end;
      const weekend = now.getDay() === 0 || now.getDay() === 6;
      return {
        ok: false,
        reason: inHours && weekend ? "am Wochenende keine Nachrichten (nur Vernetzungen)" : "außerhalb der Arbeitszeit",
      };
    }

    if (this.countToday(type) >= this.effectiveCap(type))
      return { ok: false, reason: `Tageslimit erreicht (${type})` };

    if (type === "connect" && this.countThisWeek("connect") >= config.safety.weeklyConnectCap)
      return { ok: false, reason: "Wochenlimit Vernetzungen erreicht" };

    // Circuit-Breaker Akzeptanzrate
    if (type === "connect") {
      const { rate, sample } = this.acceptanceRate();
      if (sample >= config.safety.acceptanceRateMinSample && rate < config.safety.minAcceptanceRate) {
        this.pause(`Akzeptanzrate ${(rate * 100).toFixed(0)}% < ${config.safety.minAcceptanceRate * 100}%`);
        return { ok: false, reason: "Akzeptanzrate zu niedrig – automatisch pausiert" };
      }
    }

    return { ok: true };
  }

  /**
   * Read-only Telemetrie für Dashboard/Telegram. Ändert nichts, sendet nichts –
   * bündelt nur den aktuellen Zustand (Caps, Warm-up, Akzeptanzrate, Pause).
   */
  snapshot() {
    const { rate, sample } = this.acceptanceRate();
    const warmup = this.warmupFactor();
    return {
      notAus: this.notAusAktiv(),
      paused: this.isPaused(),
      pauseReason: getState("pause_reason") || null,
      withinWorkingHours: this.withinWorkingHours(),
      workingHours: config.safety.workingHours,
      warmup: {
        factor: warmup,
        days: config.safety.warmupDays,
        elapsedDays: (Date.now() - getStartDate().getTime()) / 86_400_000,
      },
      connect: {
        today: this.countToday("connect"),
        effectiveCap: this.effectiveCap("connect"),
        hardCap: config.safety.dailyCaps.connect,
        week: this.countThisWeek("connect"),
        weeklyCap: config.safety.weeklyConnectCap,
      },
      acceptance: {
        rate,
        sample,
        minRate: config.safety.minAcceptanceRate,
        minSample: config.safety.acceptanceRateMinSample,
        armed: sample >= config.safety.acceptanceRateMinSample,
      },
    };
  }

  /**
   * Aktion protokollieren, nachdem sie erfolgreich lief.
   * Das ist der EINZIGE Punkt, durch den jede erfolgreiche Sendeaktion läuft – deshalb wird
   * hier das Event für die Telegram-Benachrichtigung gefeuert. So kann keine Aktion
   * unbemerkt durchrutschen, egal welches Modul sie ausgelöst hat.
   */
  record(type: ActionType, target?: string) {
    db.prepare("INSERT INTO actions(type, target) VALUES(?, ?)").run(type, target ?? null);
    events.emit("action:done", { type, target: target ?? null });
  }

  /**
   * Führt eine sendende Aktion sicher aus: prüft, wartet human-jitter, führt aus,
   * protokolliert. Wirft, wenn nicht erlaubt – der Aufrufer fängt das ab.
   */
  async execute<T>(type: ActionType, target: string, fn: () => Promise<T>): Promise<T> {
    const decision = this.canDoAction(type);
    if (!decision.ok) throw new GovernorBlocked(decision.reason);

    const { min, max } = config.safety.delayBetweenActionsMs;
    await humanDelay(min, max); // Abstand VOR der Aktion, variabel

    const result = await fn();
    this.record(type, target);
    return result;
  }
}

export class GovernorBlocked extends Error {
  constructor(reason: string) {
    super(`Governor hat Aktion blockiert: ${reason}`);
    this.name = "GovernorBlocked";
  }
}

/**
 * Wird geworfen, wenn EXAKT dieselbe Nachricht schon an dieselbe Person ging (Doppel-Versand-
 * Schutz). Erbt bewusst von GovernorBlocked: jeder Aufrufer, der `instanceof GovernorBlocked`
 * prüft, behandelt das automatisch als „übersprungen, kein Drama" – KEIN erneuter Versand,
 * KEINE Falschmeldung, KEINE record()-Zählung (fn wirft vor governor.record()).
 */
export class DuplikatBlockiert extends GovernorBlocked {
  constructor(empfaenger: string) {
    super(`Duplikat – identische Nachricht ging kürzlich schon an "${empfaenger}"`);
    this.name = "DuplikatBlockiert";
  }
}

export const governor = new SafetyGovernor();
