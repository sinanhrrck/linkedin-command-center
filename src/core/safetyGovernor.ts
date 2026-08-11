import { config } from "../config.js";
import { db, getStartDate, getState, setState } from "../db/index.js";
import { humanDelay } from "./humanize.js";
import { events } from "./events.js";
import { sendHealthStand } from "./sendHealth.js";

// "message" = KALTE Erstnachricht/Follow-up an neue Kontakte (riskant, eng gecappt).
// "reply"   = Antwort in einem bestehenden Gespräch (jemand schrieb DIR) – risikoarm, eigener,
//             großzügiger Cap, damit Antworten an heiße Leads nie durch kalte Outreach blockiert werden.
/**
 * `campaign` = Event-/Kampagnen-Einladung an eine bestehende Verbindung. Bewusst ein eigener
 * Topf neben `message` (kalte Erstnachricht) und `reply` (Antwort im laufenden Gespräch), damit
 * eine Kampagne die Akquise nicht aushungert. Für Arbeitszeit und Wochenende gilt dieselbe
 * strenge Regel wie für `message`: nur werktags, nur im Zeitfenster.
 */
export type ActionType = "connect" | "message" | "campaign" | "reply" | "comment" | "profileView" | "like";

type Decision = { ok: true } | { ok: false; reason: string };

/**
 * Der Governor. Zentrale Instanz, durch die JEDE sendende Aktion muss.
 * Er entscheidet nicht "ob eine Aktion sinnvoll ist", sondern nur, ob sie
 * JETZT ohne unnötiges Ban-Risiko erlaubt ist.
 */
class SafetyGovernor {
  constructor() {
    // Migration von v0.2.0/v0.2.1: Der alte Akzeptanz-Breaker setzte fälschlich die GLOBALE
    // Pause und blockierte damit sogar Antworten, Entwürfe und Posts. Nur genau diese alte,
    // eindeutig erkennbare Pause lösen; Not-Aus und andere Sicherheitsgründe bleiben bestehen.
    if (getState("paused") === "1" && (getState("pause_reason") || "").startsWith("Akzeptanzrate")) {
      this.resume();
      console.info("[migration] Globale Akzeptanz-Pause gelöst; die Quote bremst nur noch Vernetzungen.");
    }
  }

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
        "SELECT COUNT(*) AS n FROM actions WHERE type = ? AND date(created_at,'localtime') = date('now','localtime')",
      )
      .get(type) as { n: number };
    return row.n;
  }

  /**
   * Kalendwoche nach lokaler Zeit (Mo 00:00 bis So 23:59), NICHT „letzte 7 Tage“.
   *
   * Das alte rollierende Fenster ließ die Einladungen vom vorherigen Dienstag bis Sonntag
   * noch am neuen Montag zählen. Dadurch blieb der Zähler fälschlich bei 100/100. Die DB
   * speichert UTC-Zeitstempel; der lokal berechnete Wochenanfang wird deshalb als UTC-String
   * übergeben, damit Sommerzeit und Zeitzone korrekt bleiben.
   */
  private countThisWeek(type: ActionType): number {
    const now = new Date();
    const daysSinceMonday = (now.getDay() + 6) % 7; // Mo=0, So=6
    const mondayLocal = new Date(now);
    mondayLocal.setHours(0, 0, 0, 0);
    mondayLocal.setDate(mondayLocal.getDate() - daysSinceMonday);
    const weekStartUtc = mondayLocal.toISOString().slice(0, 19).replace("T", " ");
    const row = db
      .prepare(
        "SELECT COUNT(*) AS n FROM actions WHERE type = ? AND created_at >= ?",
      )
      .get(type, weekStartUtc) as { n: number };
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
  /** Ist die Uhrzeit-Begrenzung (9–22 Uhr) EINGESCHALTET? Per Dashboard umschaltbar.
   *  Default: AN (state ungesetzt). "1" = AUS → rund um die Uhr senden. Alle übrigen
   *  Schutz-Mechanismen (Caps, Pausen, Circuit-Breaker) bleiben davon UNBERÜHRT. */
  zeitfensterAktiv(): boolean {
    return getState("working_hours_off") !== "1";
  }
  setZeitfenster(an: boolean) {
    setState("working_hours_off", an ? "0" : "1");
    console.warn(`[GOVERNOR] Zeitfenster ${an ? "AN (9–22 Uhr)" : "AUS (rund um die Uhr)"}`);
  }

  private withinWorkingHours(type?: ActionType): boolean {
    const now = new Date();
    // Uhrzeit-Fenster NUR prüfen, wenn eingeschaltet. Ist es aus, darf zu jeder Stunde gesendet werden.
    if (this.zeitfensterAktiv()) {
      const h = now.getHours();
      if (h < config.safety.workingHours.start || h >= config.safety.workingHours.end) return false;
    }
    // NACHRICHTEN-Regel: nur am SONNTAG gesperrt (Sinans Vorgabe 2026-07-25: Mo–Sa senden).
    // Vernetzen/Liken/Profilbesuche laufen 7 Tage; Direktnachrichten & Kommentare gehen Mo–Sa,
    // am Sonntag nicht (ein reiner Ruhetag wirkt menschlicher als 7 Tage Dauerfeuer).
    const sonntag = now.getDay() === 0;
    if (sonntag) {
      if (!type) return true; // Ohne Typ (Telemetrie): Sonntag gilt als "aktiv" (Vernetzen läuft).
      return (config.safety.weekendActions as readonly string[]).includes(type);
    }
    return true;
  }

  /** Akzeptanzrate des rollierenden, geglätteten Fensters (accepted / invited). */
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
   * Jetzt: nur Einladungen aus dem konfigurierten Fenster
   * [heute-windowDays ... heute-{maturityDays}d] und von
   * genau DIESEN wird gezählt, wie viele accepted_at haben. Gleiche Gruppe oben wie unten.
   */
  acceptanceRate(): { rate: number; sample: number } {
    const reif = config.safety.acceptanceMaturityDays;
    const fenster = config.safety.acceptanceWindowDays;
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n,
                SUM(CASE WHEN accepted_at IS NOT NULL THEN 1 ELSE 0 END) AS ok
           FROM contacts
          WHERE invited_at IS NOT NULL
            AND invited_at >= datetime('now', ?)
            AND invited_at <= datetime('now', ?)`,
      )
      .get(`-${fenster} days`, `-${reif} days`) as { n: number; ok: number | null };
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

    // SELBST-CHECK: Ist der Sende-Weg als defekt gemeldet (Selektor gebrochen o.ä.), gehen
    // Nachrichten/Kommentare NICHT raus (sonst still Mist bauen). Vernetzen nutzt einen anderen
    // Weg und läuft weiter. Der Nutzer wurde bereits per Telegram/Dashboard gewarnt.
    if (type === "message" || type === "reply" || type === "campaign" || type === "comment") {
      const health = sendHealthStand();
      if (health.status !== "ok") return { ok: false, reason: health.status === "broken"
        ? "Selbst-Check: Sende-Weg defekt – pausiert, bis wieder funktionsfähig"
        : `Selbst-Check ausstehend: ${health.reason}` };
    }

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

    // Akzeptanz-Bremse: Eine schwache Quote stoppt NUR weitere Vernetzungen. Der alte globale
    // pause()-Aufruf legte auch Antworten, Entwürfe, Posts und Hot Leads still – genau die Arbeit,
    // die trotz schlechter Lead-Quelle weiterlaufen muss.
    /**
     * GESTAFFELT statt hart (Sinans Vorgabe 2026-08-06). Vorher stoppte eine Quote unter 30%
     * JEDE weitere Vernetzung – und konnte sich selbst nicht mehr auflösen: ohne neue
     * Einladungen keine neuen Annahmen, also blieb die Quote, wo sie war. Real legte das
     * bei 23% den kompletten Betrieb still, inklusive der Event-Kampagne, deren Kontakte auf
     * eine Vernetzung warteten. Der Nutzer sah nur einen Bot, der nichts tut.
     *
     * Jetzt: unter `hardStopAcceptance` nur das kleine Recovery-Kontingent, dazwischen das
     * halbe Tageskontingent. Weniger Anfragen bei schwacher Quote ist sachlich richtig; ein
     * Totalstillstand könnte die Quote dagegen nicht mit besseren Kontakten reparieren.
     */
    if (type === "connect") {
      const { rate, sample } = this.acceptanceRate();
      if (sample >= config.safety.acceptanceRateMinSample) {
        if (rate < config.safety.hardStopAcceptance && this.countToday("connect") >= config.safety.recoveryConnectCap) {
          return {
            ok: false,
            reason: `Akzeptanzrate ${(rate * 100).toFixed(0)}% – Recovery-Kontingent ${config.safety.recoveryConnectCap}/${config.safety.recoveryConnectCap} für heute erreicht`,
          };
        }
        if (rate < config.safety.minAcceptanceRate && this.countToday("connect") >= Math.ceil(this.effectiveCap("connect") / 2)) {
          return { ok: false, reason: `Akzeptanzrate ${(rate * 100).toFixed(0)}% unter ${(config.safety.minAcceptanceRate * 100).toFixed(0)}% – heute nur halbes Kontingent` };
        }
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
    const recovery = sample >= config.safety.acceptanceRateMinSample && rate < config.safety.hardStopAcceptance;
    const connectCap = this.effectiveCap("connect");
    return {
      notAus: this.notAusAktiv(),
      zeitfenster: this.zeitfensterAktiv(),
      workingHoursText: `${config.safety.workingHours.start}–${config.safety.workingHours.end} Uhr`,
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
        effectiveCap: connectCap,
        allowedCap: recovery ? Math.min(connectCap, config.safety.recoveryConnectCap) : connectCap,
        hardCap: config.safety.dailyCaps.connect,
        week: this.countThisWeek("connect"),
        weeklyCap: config.safety.weeklyConnectCap,
      },
      // Nachrichten-Töpfe getrennt sichtbar: "Kampagne blockiert" und "Akquise blockiert" sind
      // zwei verschiedene Diagnosen und dürfen nicht hinter einer Zahl verschwinden.
      message: {
        today: this.countToday("message"),
        effectiveCap: this.effectiveCap("message"),
        hardCap: config.safety.dailyCaps.message,
      },
      campaign: {
        today: this.countToday("campaign"),
        effectiveCap: this.effectiveCap("campaign"),
        hardCap: config.safety.dailyCaps.campaign,
      },
      acceptance: {
        rate,
        sample,
        windowDays: config.safety.acceptanceWindowDays,
        minRate: config.safety.minAcceptanceRate,
        minSample: config.safety.acceptanceRateMinSample,
        armed: sample >= config.safety.acceptanceRateMinSample,
        recovery,
        recoveryCap: config.safety.recoveryConnectCap,
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
