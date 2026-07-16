import { config } from "../config.js";
import { db, getStartDate, getState, setState } from "../db/index.js";
import { humanDelay } from "./humanize.js";
import { events } from "./events.js";

export type ActionType = "connect" | "message" | "comment" | "profileView";

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

  private withinWorkingHours(): boolean {
    const now = new Date();
    const day = now.getDay(); // 0 = So, 6 = Sa
    if (!config.safety.workOnWeekends && (day === 0 || day === 6)) return false;
    const h = now.getHours();
    return h >= config.safety.workingHours.start && h < config.safety.workingHours.end;
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

  /** Kernfrage: Darf ich JETZT eine Aktion dieses Typs ausführen? */
  canDoAction(type: ActionType): Decision {
    if (this.isPaused())
      return { ok: false, reason: `pausiert (${getState("pause_reason") ?? "unbekannt"})` };

    if (!this.withinWorkingHours())
      return { ok: false, reason: "außerhalb der Arbeitszeit" };

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

export const governor = new SafetyGovernor();
