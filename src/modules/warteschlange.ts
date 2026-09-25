import { zgBedingung } from "../core/zielgruppenRegel.js";
import { db, getState, getMode } from "../db/index.js";
import { governor, type ActionType } from "../core/safetyGovernor.js";
import { leseStand } from "../core/leseBudget.js";
import { openJobFailures } from "../core/jobReliability.js";
import { config } from "../config.js";

/**
 * WARTESCHLANGE (2026-09-23, Sinans Vorgabe: „Ich sehe nicht, was in der Warteschlange ist,
 * und ob er überhaupt arbeitet.“)
 *
 * Beantwortet je Kanal (Nachrichten, Vernetzungsanfragen) genau vier Fragen an EINER Stelle:
 *   1. Wie viele warten, und wer kommt als Nächstes?
 *   2. Läuft der Kanal gerade – und wenn nicht: warum?
 *   3. Wann ist der nächste Versuch?
 *   4. Wie weit ist das heutige Limit ausgeschöpft?
 *
 * Rein lesend. Der Grund kommt aus `governor.canDoAction()` – derselben Prüfung, an der der
 * echte Versand scheitert. Eine eigene Nachbau-Logik würde früher oder später etwas anderes
 * anzeigen, als der Bot tatsächlich tut (genau der Fehler aus 2026-08-17).
 */

export type KanalStatus = "laeuft" | "wartet" | "gestoppt" | "leer";

export type WarteEintrag = { name: string; art: string; seit: string | null };

export type Kanal = {
  kanal: "nachrichten" | "anfragen";
  titel: string;
  status: KanalStatus;
  statusText: string;
  /** ISO-Zeitpunkt des nächsten Versuchs; null = hängt am Nutzer oder ist unklar. */
  naechsterVersuch: string | null;
  heute: number;
  tagesLimit: number;
  woche: number | null;
  wochenLimit: number | null;
  /** Wird von selbst gesendet, sobald der Kanal frei ist. */
  bereit: number;
  /** Braucht zuerst deine Freigabe (nur Nachrichten). */
  wartetAufDich: number;
  /** Angenommene Kontakte, deren Erstnachricht noch entsteht (nur Nachrichten). */
  inVorbereitung: number;
  /** Tage, bis die Warteschlange beim heutigen Limit leer ist. */
  reichtTage: number | null;
  naechste: WarteEintrag[];
  zuletzt: { name: string; at: string } | null;
};

const JOB_JE_KANAL = { nachrichten: ["sendApproved", "morgen"], anfragen: ["outreach"] } as const;
const TAKT_MIN = { nachrichten: 10, anfragen: 12 } as const; // Cron-Takt in index.ts

const ART_TEXT: Record<string, string> = {
  first: "Erstnachricht", followup: "Nachfassen", message: "Antwort", pitchidee: "Antwort",
  reaktivierung: "Reaktivierung", comment: "Kommentar", event: "Einladung",
};

const sqlZeit = (s: string | null) => (s ? `${s.replace(" ", "T")}${/[zZ+]/.test(s.slice(10)) ? "" : "Z"}` : null);

/** Nächste volle Takt-Minute (z. B. alle 10 Min → :00, :10, …). */
function naechsterTakt(now: Date, minuten: number): Date {
  const d = new Date(now);
  d.setSeconds(0, 0);
  d.setMinutes(Math.floor(d.getMinutes() / minuten) * minuten + minuten);
  return d;
}

/** Beginn des nächsten erlaubten Zeitfensters für diesen Aktionstyp (Sonntag-Regel inklusive). */
function naechstesFenster(now: Date, type: ActionType): Date {
  const start = config.safety.workingHours.start;
  const end = config.safety.workingHours.end;
  const sonntagErlaubt = (config.safety.weekendActions as readonly string[]).includes(type);
  const zeitfenster = governor.zeitfensterAktiv();
  for (let tag = 0; tag < 8; tag++) {
    const d = new Date(now);
    d.setDate(d.getDate() + tag);
    if (d.getDay() === 0 && !sonntagErlaubt) continue;
    if (!zeitfenster) return tag === 0 ? now : (d.setHours(0, 0, 0, 0), d);
    if (tag === 0) {
      if (now.getHours() < start) return (d.setHours(start, 0, 0, 0), d);
      if (now.getHours() < end) return now;
      continue;
    }
    d.setHours(start, 0, 0, 0);
    return d;
  }
  return now;
}

/** Nächster Morgen im erlaubten Fenster – für Tageslimit und Lese-Budget. */
function morgenFrueh(now: Date, type: ActionType): Date {
  const morgen = new Date(now);
  morgen.setDate(morgen.getDate() + 1);
  morgen.setHours(0, 0, 0, 0);
  return naechstesFenster(morgen, type);
}

function zuletzt(type: ActionType): Kanal["zuletzt"] {
  const r = db.prepare(
    `SELECT a.created_at at, COALESCE(c.full_name, d.participant) name
       FROM actions a
       LEFT JOIN contacts c ON c.profile_url=a.target
       LEFT JOIN drafts d ON d.thread_url=a.target AND d.participant IS NOT NULL
      WHERE a.type=? ORDER BY a.id DESC LIMIT 1`,
  ).get(type) as { at: string; name: string | null } | undefined;
  return r ? { name: r.name || "Unbekannt", at: sqlZeit(r.at)! } : null;
}

/**
 * Status in der Reihenfolge, in der die Sperren wirklich greifen: Engine → technischer
 * Job-Fehler → Governor (Not-Aus, Pause, Sendeweg, Zeitfenster, Limits) → Lese-Budget →
 * leere Warteschlange. Die erste zutreffende Erklärung gewinnt.
 */
function status(kanal: Kanal["kanal"], type: ActionType, hatArbeit: boolean, now: Date) {
  const heartbeat = getState("engine_heartbeat");
  const engineAn = heartbeat ? now.getTime() - new Date(heartbeat).getTime() < 150_000 : false;
  if (!engineAn) return { status: "gestoppt" as const, statusText: "Die Engine läuft nicht – es wird nichts gesendet.", naechsterVersuch: null };

  const fehler = openJobFailures().find((f) => (JOB_JE_KANAL[kanal] as readonly string[]).includes(f.job));
  if (fehler?.status === "dead") {
    return { status: "gestoppt" as const, statusText: `Nach ${fehler.consecutiveFailures} technischen Fehlern angehalten: ${kurz(fehler.lastError)}`, naechsterVersuch: null };
  }

  const d = governor.canDoAction(type);
  if (!d.ok) {
    const r = d.reason || "";
    if (/Not-Aus/.test(r)) return { status: "gestoppt" as const, statusText: "Not-Aus ist aktiv.", naechsterVersuch: null };
    if (/^pausiert/.test(r)) return { status: "gestoppt" as const, statusText: `Sicherheitspause: ${r.replace(/^pausiert \(|\)$/g, "")}`, naechsterVersuch: null };
    if (/Selbst-Check/.test(r)) return { status: "gestoppt" as const, statusText: "Sendeweg nicht bestätigt – Nachrichten bleiben liegen, bis der Selbst-Check wieder grün ist.", naechsterVersuch: null };
    if (/Arbeitszeit|Wochenende/.test(r)) {
      return { status: "wartet" as const, statusText: kanal === "nachrichten" && now.getDay() === 0 ? "Sonntag: keine Nachrichten, es geht Montag früh weiter." : `Außerhalb der Sendezeit (${config.safety.workingHours.start}–${config.safety.workingHours.end} Uhr).`, naechsterVersuch: naechstesFenster(now, type).toISOString() };
    }
    if (/Wochenlimit/.test(r)) return { status: "wartet" as const, statusText: "Wochenlimit erreicht – nächste Woche geht es weiter.", naechsterVersuch: null };
    return { status: "wartet" as const, statusText: `Tageslimit erreicht${/Akzeptanzrate/.test(r) ? ` (${r})` : ""} – morgen geht es weiter.`, naechsterVersuch: morgenFrueh(now, type).toISOString() };
  }

  if (leseStand().erschoepft) return { status: "wartet" as const, statusText: "Lese-Budget für heute aufgebraucht – morgen geht es weiter.", naechsterVersuch: morgenFrueh(now, type).toISOString() };

  if (fehler?.status === "backoff") {
    return { status: "wartet" as const, statusText: `Technischer Fehler, neuer Versuch nach Wartezeit: ${kurz(fehler.lastError)}`, naechsterVersuch: fehler.nextAttemptAt };
  }

  if (!hatArbeit) return { status: "leer" as const, statusText: "Nichts in der Warteschlange.", naechsterVersuch: null };
  return { status: "laeuft" as const, statusText: "Läuft – der nächste Versand kommt im nächsten Takt.", naechsterVersuch: naechsterTakt(now, TAKT_MIN[kanal]).toISOString() };
}

function kurz(fehler: string | null): string {
  const f = String(fehler || "Ursache unbekannt");
  if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/.test(f)) return "LinkedIn nicht erreichbar (Internet/DNS des Servers).";
  if (/Timeout \d+ms exceeded/.test(f)) return "LinkedIn antwortet nicht (Zeitüberschreitung).";
  return f.split("\n")[0].slice(0, 140);
}

const reicht = (anzahl: number, proTag: number) => (anzahl && proTag ? Math.ceil(anzahl / proTag) : null);

export function warteschlange(now = new Date()): Kanal[] {
  const g = governor.snapshot();

  // ---------- Nachrichten ----------
  const bereitListe = db.prepare(
    `SELECT COALESCE(c.full_name, d.participant, 'Unbekannt') name, d.kind art, d.created_at seit
       FROM drafts d LEFT JOIN contacts c ON c.profile_url=d.thread_url
      WHERE d.status='approved' ORDER BY d.created_at LIMIT 5`,
  ).all() as { name: string; art: string; seit: string | null }[];
  const bereit = (db.prepare("SELECT COUNT(*) n FROM drafts WHERE status='approved'").get() as { n: number }).n;
  const wartetAufDich = (db.prepare(
    "SELECT COUNT(*) n FROM drafts WHERE status='pending' AND phase IS NOT 'approach' AND kind NOT IN ('event','comment')",
  ).get() as { n: number }).n;
  // Angenommen, aber noch ohne Erstnachricht (gleiche Bedingung wie der Nachhol-Lauf in acceptance.ts).
  const inVorbereitung = (db.prepare(
    `SELECT COUNT(*) n FROM contacts c
      WHERE c.status='accepted' AND COALESCE(c.aus_netzwerk,0)=0 AND c.messaged_at IS NULL
        AND COALESCE(c.do_not_contact,0)=0
        AND NOT EXISTS (SELECT 1 FROM drafts d WHERE d.thread_url=c.profile_url AND d.kind='first'
                         AND d.status IN ('pending','approved','sent'))
        AND ${zgBedingung("c")}`,
  ).get() as { n: number }).n;
  // Im Halb-Automatik-Modus gehen Erstnachrichten ohne Freigabe raus → zählen als „bereit".
  const autoErst = getMode() === "manual" ? 0 : inVorbereitung;
  const nachrichtenArbeit = bereit + autoErst;
  const nachrichten: Kanal = {
    kanal: "nachrichten",
    titel: "Nachrichten",
    ...status("nachrichten", "message", nachrichtenArbeit > 0, now),
    heute: g.message.today,
    tagesLimit: g.message.effectiveCap,
    woche: null,
    wochenLimit: null,
    bereit: nachrichtenArbeit,
    wartetAufDich,
    inVorbereitung: autoErst ? 0 : inVorbereitung,
    reichtTage: reicht(nachrichtenArbeit, g.message.effectiveCap),
    naechste: bereitListe.map((r) => ({ name: r.name, art: ART_TEXT[r.art] || r.art, seit: sqlZeit(r.seit) })),
    zuletzt: zuletzt("message"),
  };
  if (!nachrichtenArbeit && wartetAufDich && nachrichten.status === "leer") {
    nachrichten.statusText = `Nichts freigegeben – ${wartetAufDich} Entwürfe warten auf dich.`;
  }

  // ---------- Vernetzungsanfragen ----------
  // Gleiche Auswahl wie crm.nextNewContacts(), damit „als Nächstes" wirklich als Nächstes kommt.
  const offenBedingung = `status='new' AND COALESCE(do_not_contact,0)=0
      AND COALESCE(automation_status,'active')='active'
      AND (snoozed_until IS NULL OR snoozed_until<=datetime('now'))
      AND (retry_after IS NULL OR retry_after<=datetime('now'))
      AND ${zgBedingung("contacts")}`;
  const anfragenOffen = (db.prepare(`SELECT COUNT(*) n FROM contacts WHERE ${offenBedingung}`).get() as { n: number }).n;
  const anfragenListe = db.prepare(
    `SELECT full_name name, created_at seit FROM contacts WHERE ${offenBedingung}
      ORDER BY COALESCE(ki_score,lead_score,50) DESC, created_at LIMIT 5`,
  ).all() as { name: string | null; seit: string }[];
  const tagesLimit = g.connect.allowedCap || g.connect.effectiveCap;
  const anfragen: Kanal = {
    kanal: "anfragen",
    titel: "Vernetzungsanfragen",
    ...status("anfragen", "connect", anfragenOffen > 0, now),
    heute: g.connect.today,
    tagesLimit,
    woche: g.connect.week,
    wochenLimit: g.connect.weeklyCap,
    bereit: anfragenOffen,
    wartetAufDich: 0,
    inVorbereitung: 0,
    reichtTage: reicht(anfragenOffen, tagesLimit),
    naechste: anfragenListe.map((r) => ({ name: r.name || "Unbekannt", art: "Anfrage", seit: sqlZeit(r.seit) })),
    zuletzt: zuletzt("connect"),
  };

  return [nachrichten, anfragen];
}
