import { db, getState, setState } from "../db/index.js";
import { events } from "../core/events.js";
import { governor } from "../core/safetyGovernor.js";
import { aecAktiv } from "./ausrichtung.js";
import { reaktivierbareKontakte } from "./netzwerk.js";

/**
 * AEC-MONATSZIEL (2026-10-27, Sinan: „das Ding muss ein AEC-Beast werden. Ich will, dass man ein
 * Monatsziel eingeben kann und darauf hingearbeitet wird“).
 *
 * ZÄHLEN: eine AEC-Zusage = eine Person hat der Potenzialanalyse zugesagt. Automatisch aus zwei
 * Quellen – Übergabe des Agenten bei Ausrichtung AEC (agentRunner) und Kalendereintrag der Art
 * „AEC …“ (termine.ts) – plus von Hand. Jede Person zählt GENAU EINMAL (fachlicher Schlüssel wie bei
 * crm_stage_events, nie zeitlich), der Monat wird beim Schreiben eingefroren. „Durchgeführt“ und
 * „nicht erschienen“ setzt Sinan; das Ziel zählt Zusagen (seine Wahl).
 *
 * HINARBEITEN, aber nur innerhalb der Sicherheitsgrenzen: das Ziel hebt KEIN Tageslimit an (die
 * Linie, an der das Konto schon einmal gesperrt wurde). Es rechnet ehrlich vor, ob das Ziel mit dem
 * erlaubten Tempo erreichbar ist, benennt den größten Hebel und stößt selbst nur an, was ohnehin über
 * Freigabe und Governor läuft (Netzwerk-Reaktivierung → Entwürfe).
 */

export type AecStatus = "zugesagt" | "durchgefuehrt" | "nicht_erschienen" | "storniert";
const STATUS: AecStatus[] = ["zugesagt", "durchgefuehrt", "nicht_erschienen", "storniert"];

/** Monat in lokaler Zeit (Server läuft mit TZ=Europe/Berlin). Nie toISOString – das kippt abends. */
export function monatVon(zeit = new Date()): string {
  return `${zeit.getFullYear()}-${String(zeit.getMonth() + 1).padStart(2, "0")}`;
}

/** Werktage (Mo–Fr) eines Monats, aufgeteilt in vorbei (vor heute) und übrig (heute eingeschlossen). */
export function werktage(zeit = new Date()): { gesamt: number; vorbei: number; rest: number } {
  const jahr = zeit.getFullYear(), m = zeit.getMonth(), heute = zeit.getDate();
  const tage = new Date(jahr, m + 1, 0).getDate();
  let gesamt = 0, vorbei = 0;
  for (let d = 1; d <= tage; d++) {
    const wt = new Date(jahr, m, d).getDay();
    if (wt === 0 || wt === 6) continue;
    gesamt++;
    if (d < heute) vorbei++;
  }
  return { gesamt, vorbei, rest: gesamt - vorbei };
}

// ---------- Zusagen ----------

export type AecZusage = {
  id: number; schluessel: string; contact_id: number | null; thread_url: string | null; teilnehmer: string | null;
  quelle: string; monat: string; zugesagt_at: string; status: AecStatus; status_at: string | null;
};

function schluesselFuer(i: { contactId?: number | null; threadUrl?: string | null; teilnehmer?: string | null }): string {
  if (i.contactId) return `contact:${i.contactId}`;
  if (i.threadUrl) return `thread:${i.threadUrl}`;
  const name = String(i.teilnehmer || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!name) throw new Error("Für eine AEC-Zusage fehlt Name oder Kontakt.");
  return `manuell:${name}`;
}

/**
 * Erfasst eine Zusage. Idempotent: dieselbe Person ein zweites Mal (andere Quelle, Neustart, verschobener
 * Termin) ändert nichts. `neu` sagt, ob gerade gezählt wurde – nur dann wird gemeldet.
 */
export function erfasseAecZusage(i: {
  contactId?: number | null; threadUrl?: string | null; teilnehmer?: string | null; quelle: "agent" | "kalender" | "manuell"; zeit?: Date;
}): { neu: boolean; zusage: AecZusage } {
  const schluessel = schluesselFuer(i);
  // Dieselbe Person kann zuerst über den Chat (thread:) und später mit Kontakt (contact:) auftauchen.
  const vorhanden = (i.contactId && i.threadUrl
    ? db.prepare("SELECT * FROM aec_zusagen WHERE schluessel=? OR schluessel=? OR (thread_url=? AND thread_url IS NOT NULL) OR contact_id=? LIMIT 1")
      .get(`contact:${i.contactId}`, `thread:${i.threadUrl}`, i.threadUrl, i.contactId)
    : db.prepare("SELECT * FROM aec_zusagen WHERE schluessel=? OR (thread_url=? AND thread_url IS NOT NULL) OR (contact_id=? AND contact_id IS NOT NULL) LIMIT 1")
      .get(schluessel, i.threadUrl ?? null, i.contactId ?? null)) as AecZusage | undefined;
  if (vorhanden) {
    // Fehlende Zuordnung nachtragen, belegte nie ändern (gleiche Regel wie crm_stage_events).
    db.prepare("UPDATE aec_zusagen SET contact_id=COALESCE(contact_id,?), thread_url=COALESCE(thread_url,?), teilnehmer=COALESCE(teilnehmer,?) WHERE id=?")
      .run(i.contactId ?? null, i.threadUrl ?? null, i.teilnehmer ?? null, vorhanden.id);
    return { neu: false, zusage: db.prepare("SELECT * FROM aec_zusagen WHERE id=?").get(vorhanden.id) as AecZusage };
  }
  const zeit = i.zeit ?? new Date();
  const id = Number(db.prepare(
    "INSERT INTO aec_zusagen(schluessel,contact_id,thread_url,teilnehmer,quelle,monat,zugesagt_at) VALUES(?,?,?,?,?,?,?)",
  ).run(schluessel, i.contactId ?? null, i.threadUrl ?? null, (i.teilnehmer ?? "").trim() || null, i.quelle, monatVon(zeit),
    zeit.toISOString().slice(0, 19).replace("T", " ")).lastInsertRowid);
  const zusage = db.prepare("SELECT * FROM aec_zusagen WHERE id=?").get(id) as AecZusage;
  events.emit("aec:zusage", { zusage, stand: aecStand() });
  return { neu: true, zusage };
}

export function setzeAecStatus(id: number, status: unknown): AecZusage {
  if (!STATUS.includes(status as AecStatus)) throw new Error("Unbekannter Status.");
  const r = db.prepare("UPDATE aec_zusagen SET status=?, status_at=datetime('now') WHERE id=?").run(status, id);
  if (!r.changes) throw new Error("Diese Zusage gibt es nicht.");
  return db.prepare("SELECT * FROM aec_zusagen WHERE id=?").get(id) as AecZusage;
}

export function aecZusageFuerThread(threadUrl: string): AecZusage | null {
  return (db.prepare("SELECT * FROM aec_zusagen WHERE thread_url=? LIMIT 1").get(threadUrl) as AecZusage | undefined) ?? null;
}

// ---------- Ziel ----------

/** Ziel des Monats; ohne eigenen Eintrag gilt das zuletzt gesetzte (ein Ziel muss nicht jeden Monat neu getippt werden). */
export function monatsziel(monat = monatVon()): number | null {
  const r = db.prepare("SELECT ziel FROM aec_ziele WHERE monat<=? ORDER BY monat DESC LIMIT 1").get(monat) as { ziel: number } | undefined;
  return r?.ziel ?? null;
}

export function setzeMonatsziel(ziel: unknown, monat = monatVon()): number {
  const n = Number(ziel);
  if (!Number.isInteger(n) || n < 1 || n > 500) throw new Error("Das Ziel muss eine ganze Zahl zwischen 1 und 500 sein.");
  db.prepare("INSERT INTO aec_ziele(monat,ziel) VALUES(?,?) ON CONFLICT(monat) DO UPDATE SET ziel=excluded.ziel, updated_at=datetime('now')").run(monat, n);
  return n;
}

// ---------- Stand, Hochrechnung, Hebel ----------

export type Hebel = { art: string; text: string; aktion?: "ausrichtung" | "entwuerfe" | "netzwerk" | "abhaken" };

const zahl = (sql: string, ...p: unknown[]) => Number((db.prepare(sql).get(...p) as { n: number | null } | undefined)?.n ?? 0);
function sicher<T>(fn: () => T, sonst: T): T { try { return fn(); } catch { return sonst; } }

export function aecStand(zeit = new Date()) {
  const monat = monatVon(zeit);
  const ziel = monatsziel(monat);
  const liste = db.prepare("SELECT * FROM aec_zusagen WHERE monat=? AND status<>'storniert' ORDER BY zugesagt_at DESC, id DESC").all(monat) as AecZusage[];
  const zusagen = liste.length;
  const durchgefuehrt = liste.filter((z) => z.status === "durchgefuehrt").length;
  const nichtErschienen = liste.filter((z) => z.status === "nicht_erschienen").length;
  const tage = werktage(zeit);

  // Quote aus echten Daten der letzten 60 Tage: wie viele Erstnachrichten brauchte eine Zusage?
  // Solange es noch keine 3 AEC-Zusagen gibt, dienen Termine allgemein (CRM-Stufe „meeting“) als Ersatz.
  const erst60 = zahl("SELECT COUNT(*) n FROM crm_stage_events WHERE stage='messaged' AND COALESCE(occurred_at,created_at)>=datetime('now','-60 days')");
  const aec60 = zahl("SELECT COUNT(*) n FROM aec_zusagen WHERE status<>'storniert' AND zugesagt_at>=datetime('now','-60 days')");
  const termine60 = zahl("SELECT COUNT(DISTINCT contact_id) n FROM crm_stage_events WHERE stage='meeting' AND COALESCE(occurred_at,created_at)>=datetime('now','-60 days')");
  const basis = aec60 >= 3 ? aec60 : termine60;
  const jeZusage = basis > 0 && erst60 > 0 ? Math.max(1, Math.round(erst60 / basis)) : null;
  const quelleQuote = aec60 >= 3 ? "aec" : basis > 0 ? "termine" : "keine";

  // Erstnachrichten pro Werktag zuletzt (20 Werktage ≈ 28 Kalendertage) und was die Grenze heute erlaubt.
  const erst28 = zahl("SELECT COUNT(*) n FROM crm_stage_events WHERE stage='messaged' AND COALESCE(occurred_at,created_at)>=datetime('now','-28 days')");
  const tempoErst = Math.round((erst28 / 20) * 10) / 10;
  const snap = sicher(() => governor.snapshot(), null);
  const kapazitaet = snap?.message?.effectiveCap ?? null;
  const heuteErst = snap?.message?.today ?? 0;

  // Hochrechnung: ab 5 Werktagen das eigene Monatstempo, davor die gemessene Quote.
  let hochrechnung: number | null = null;
  if (tage.vorbei >= 5) hochrechnung = Math.round(zusagen + (zusagen / tage.vorbei) * tage.rest);
  else if (jeZusage) hochrechnung = Math.round(zusagen + (tempoErst * tage.rest) / jeZusage);
  else if (tage.vorbei > 0) hochrechnung = Math.round(zusagen + (zusagen / tage.vorbei) * tage.rest);

  const fehlend = ziel ? Math.max(0, ziel - zusagen) : 0;
  const erstNoetig = jeZusage ? fehlend * jeZusage : null;
  const erstProTag = erstNoetig !== null && tage.rest > 0 ? Math.ceil(erstNoetig / tage.rest) : null;
  const zusagenProTag = ziel && tage.rest > 0 ? Math.round((fehlend / tage.rest) * 10) / 10 : null;

  const status = !ziel ? "kein_ziel"
    : zusagen >= ziel ? "erreicht"
    : hochrechnung === null ? "offen"
    : hochrechnung >= ziel ? "auf_kurs"
    : hochrechnung >= ziel * 0.8 ? "knapp" : "zurueck";

  // ---- Hebel: was gerade am meisten bringt, in der Reihenfolge, in der es wirkt ----
  const hebel: Hebel[] = [];
  const ausr = sicher(() => aecAktiv(), false);
  if (ziel && !ausr) hebel.push({ art: "ausrichtung", aktion: "ausrichtung", text: "Die Ausrichtung steht auf Standard. Gespräche führen damit nicht gezielt zur Potenzialanalyse. Auf AEC umstellen." });
  const wartend = zahl("SELECT COUNT(*) n FROM drafts WHERE status='pending' AND kind IN ('message','first','followup','reaktivierung') AND COALESCE(phase,'')<>'approach'");
  if (wartend > 0) hebel.push({ art: "entwuerfe", aktion: "entwuerfe", text: `${wartend} Nachricht${wartend === 1 ? "" : "en"} warte${wartend === 1 ? "t" : "n"} auf deine Freigabe. Jede davon kann ein Gespräch Richtung Analyse bringen.` });
  const heiss = sicher(() => zahl("SELECT COUNT(*) n FROM agent_conversations WHERE status='aktiv' AND stage IN ('bedarf','validierung','call_angebot','nummer','termin') AND updated_at>=datetime('now','-14 days')"), 0);
  if (heiss > 0) hebel.push({ art: "pipeline", text: `${heiss} Gespräch${heiss === 1 ? "" : "e"} steh${heiss === 1 ? "t" : "en"} kurz vor dem Angebot. Das ist der schnellste Weg zur nächsten Zusage.` });
  if (ziel && kapazitaet !== null && erstProTag !== null && erstProTag > kapazitaet && status !== "erreicht") {
    hebel.push({ art: "grenze", text: `Mit der aktuellen Quote (eine Zusage je ${jeZusage} Erstnachrichten) bräuchte es ${erstProTag} Erstnachrichten pro Tag, die Sicherheitsgrenze erlaubt ${kapazitaet}. Mehr Zusagen kommen jetzt nur über eine bessere Antwortquote (Training) und dein bestehendes Netzwerk, nicht über mehr Tempo.` });
  }
  const reaktivierbar = sicher(() => reaktivierbareKontakte(50).length, 0);
  if (reaktivierbar > 0 && ziel && status !== "erreicht") hebel.push({ art: "netzwerk", aktion: "netzwerk", text: `${reaktivierbar >= 50 ? "Mindestens 50" : reaktivierbar} bestehende Verbindungen wurden nie angeschrieben. Sie kosten kein Vernetzungs-Kontingent.` });
  const offenAlt = liste.filter((z) => z.status === "zugesagt" && z.zugesagt_at <= sqlZeit(new Date(zeit.getTime() - 7 * 86_400_000))).length;
  if (offenAlt > 0) hebel.push({ art: "abhaken", aktion: "abhaken", text: `${offenAlt} Zusage${offenAlt === 1 ? " ist" : "n sind"} älter als eine Woche und noch nicht als durchgeführt markiert.` });

  return {
    monat, ziel, zusagen, durchgefuehrt, nichtErschienen, offen: zusagen - durchgefuehrt - nichtErschienen,
    werktage: tage, hochrechnung, status, fehlend, zusagenProTag,
    quote: { jeZusage, quelle: quelleQuote, erstnachrichten60: erst60 },
    tempo: { erstnachrichtenProTag: tempoErst, heute: heuteErst, kapazitaet, noetigProTag: erstProTag },
    ausrichtungAec: ausr, hebel, liste: liste.slice(0, 50),
  };
}
export type AecStand = ReturnType<typeof aecStand>;

function sqlZeit(d: Date) { return d.toISOString().slice(0, 19).replace("T", " "); }

const MONATE = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
export const monatName = (monat: string) => MONATE[Number(monat.slice(5, 7)) - 1] ?? monat;
const STATUS_TEXT: Record<string, string> = {
  erreicht: "✅ Ziel erreicht", auf_kurs: "🟢 auf Kurs", knapp: "🟡 knapp", zurueck: "🔴 hinter dem Ziel", offen: "⚪ noch zu früh für eine Hochrechnung", kein_ziel: "kein Ziel gesetzt",
};

/** Kurzer Text für Telegram (Morgenmeldung, /aecstand, nach jeder Zusage). */
export function aecStandText(s: AecStand = aecStand()): string {
  if (!s.ziel) return `🎯 AEC ${monatName(s.monat)}: ${s.zusagen} Zusage${s.zusagen === 1 ? "" : "n"}. Noch kein Monatsziel. Setzen mit /aecziel 20`;
  const zeilen = [
    `🎯 AEC ${monatName(s.monat)}: ${s.zusagen} von ${s.ziel} Zusagen · ${STATUS_TEXT[s.status]}`,
    s.hochrechnung !== null ? `Hochrechnung bis Monatsende: ${s.hochrechnung}` : "",
    s.status !== "erreicht" && s.zusagenProTag !== null ? `Nötig: ${String(s.zusagenProTag).replace(".", ",")} Zusagen pro Werktag (${s.werktage.rest} Werktage übrig)` : "",
    s.durchgefuehrt || s.nichtErschienen ? `Durchgeführt: ${s.durchgefuehrt} · nicht erschienen: ${s.nichtErschienen}` : "",
    s.hebel.length ? `\nGrößter Hebel: ${s.hebel[0].text}` : "",
  ];
  return zeilen.filter(Boolean).join("\n");
}

/**
 * STEUERUNG (Engine, Mo–Fr morgens und mittags). Liegt das Ziel nicht auf Kurs und gibt es nie
 * angeschriebene Verbindungen, wird die Netzwerk-Reaktivierung angestoßen (höchstens alle 3 Tage).
 * Daraus entstehen ENTWÜRFE – gesendet wird nur nach Freigabe und über den Governor. Mehr tut die
 * Steuerung bewusst nicht: Tageslimits, Automatik-Stufe und Freigabe-Einstellungen bleiben Sinans.
 */
export function aecSteuerung(zeit = new Date()): { angestossen: boolean; grund: string } {
  const s = aecStand(zeit);
  if (!s.ziel) return { angestossen: false, grund: "kein Ziel" };
  if (s.status === "erreicht" || s.status === "auf_kurs") return { angestossen: false, grund: s.status };
  if (!s.hebel.some((h) => h.art === "netzwerk")) return { angestossen: false, grund: "keine unberührten Verbindungen" };
  const zuletzt = Number(getState("aec_netzwerk_at") || 0);
  if (zeit.getTime() - zuletzt < 3 * 86_400_000) return { angestossen: false, grund: "Reaktivierung lief vor weniger als 3 Tagen" };
  setState("aec_netzwerk_at", String(zeit.getTime()));
  setState("netzwerk_now", "1");
  return { angestossen: true, grund: `Ziel ${s.status}: Netzwerk-Reaktivierung angestoßen` };
}
