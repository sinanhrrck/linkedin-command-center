import { createHash, randomBytes } from "node:crypto";
import { db, getState, setState } from "../db/index.js";
import { config } from "../config.js";
import { events } from "../core/events.js";
import { generateText } from "../core/textLlm.js";
import { getProfil } from "../profil.js";
import { contactForConversation, recordCrmStage } from "./crmStages.js";

/**
 * TERMINE IN DEN KALENDER (2026-10-01, Sinans Vorgabe): Ist im Chat ein Termin bestätigt, trägt der
 * Bot ihn selbst in den Google Kalender ein – Titel „<Art> <Vorname Nachname>/<Name aus dem Profil>“,
 * z. B. „AEC Auswertung Dardan Recica/Sinan Harrack“ – und meldet es danach (Telegram mit Löschen).
 *
 * FÜR JEDEN NUTZER, nicht nur für Sinan: Jede Installation verbindet IHR eigenes Google-Konto
 * (Einstellungen → „Mit Google verbinden“), der Zugang liegt nur in IHRER Datenbank. Name und
 * Termin-Arten kommen aus Profil bzw. Einstellungen, nichts ist fest verdrahtet. Die OAuth-App
 * (GOOGLE_CLIENT_ID/SECRET, Typ „Desktop-App“) stellt der Herausgeber der Software bereit.
 *
 * Vorsicht vor Falscheinträgen: fester Vorfilter (ohne Uhrzeit/Wochentag kein KI-Aufruf), dann die
 * KI mit harter JSON-Form. Eingetragen wird nur bei `bestaetigt` UND `sicher`; ein erkannter, aber
 * unsicherer Termin wird nur gemeldet. Pro Kontakt + Art gibt es EINE offene Zeile – eine
 * Verschiebung ändert den bestehenden Eintrag.
 */

export type TerminArt = { name: string; dauer: number };
export const STANDARD_ARTEN: TerminArt[] = [
  { name: "AEC Auswertung", dauer: 60 },
  { name: "Erstgespräch", dauer: 30 },
];
const ZEITZONE = "Europe/Berlin";
const SCOPE = "https://www.googleapis.com/auth/calendar.events openid email";

// ---------------------------------------------------------------- Termin-Arten

export function terminArten(): TerminArt[] {
  try {
    const roh = JSON.parse(getState("termin_arten") || "null");
    if (Array.isArray(roh) && roh.length) return roh as TerminArt[];
  } catch { /* Standard */ }
  return STANDARD_ARTEN;
}

export function speichereTerminArten(eingabe: unknown): TerminArt[] {
  if (!Array.isArray(eingabe)) throw new Error("Bitte mindestens eine Termin-Art angeben.");
  const arten = eingabe
    .map((a) => ({ name: String((a as TerminArt)?.name ?? "").trim().slice(0, 60), dauer: Math.round(Number((a as TerminArt)?.dauer)) }))
    .filter((a) => a.name);
  if (!arten.length) throw new Error("Bitte mindestens eine Termin-Art angeben.");
  for (const a of arten) if (!Number.isFinite(a.dauer) || a.dauer < 10 || a.dauer > 480) throw new Error(`Dauer für „${a.name}“: 10 bis 480 Minuten.`);
  setState("termin_arten", JSON.stringify(arten));
  return arten;
}

// ---------------------------------------------------------------- Google-Anbindung

type GoogleZugang = { refresh_token: string; email: string | null; verbunden_at: string };

function googleClient() {
  return { id: process.env.GOOGLE_CLIENT_ID ?? "", secret: process.env.GOOGLE_CLIENT_SECRET ?? "" };
}
export function googleRedirectUri(): string {
  // Desktop-Clients erlauben jeden Loopback-Port. Läuft NextLead auf einem anderen Rechner, landet
  // der Browser auf einer Fehlerseite – dann wird die Adresse von dort ins Cockpit kopiert.
  return `http://localhost:${config.server.port}/api/google/callback`;
}
function zugang(): GoogleZugang | null {
  try { return JSON.parse(getState("google_kalender") || "null"); } catch { return null; }
}

export function googleStatus() {
  const c = googleClient();
  const z = zugang();
  return { eingerichtet: !!(c.id && c.secret), verbunden: !!z?.refresh_token, email: z?.email ?? null, redirectUri: googleRedirectUri() };
}

/** Anmelde-Link mit PKCE. Der Prüfwert wird bis zum Rücksprung im state gemerkt. */
export function googleAnmeldeLink(): string {
  const c = googleClient();
  if (!c.id) throw new Error("Die Google-Anbindung ist für diese Installation noch nicht eingerichtet (GOOGLE_CLIENT_ID fehlt).");
  const verifier = randomBytes(32).toString("base64url");
  const status = randomBytes(12).toString("hex");
  setState("google_pkce", JSON.stringify({ verifier, status }));
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const p = new URLSearchParams({
    client_id: c.id, redirect_uri: googleRedirectUri(), response_type: "code", scope: SCOPE,
    access_type: "offline", prompt: "consent", code_challenge: challenge, code_challenge_method: "S256", state: status,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

/** Nimmt die Rücksprung-Adresse (oder nur den Code) entgegen und speichert den Dauer-Zugang. */
export async function googleVerbinden(eingabe: string): Promise<{ email: string | null }> {
  const roh = String(eingabe || "").trim();
  let code = roh, status: string | null = null;
  if (/^https?:\/\//i.test(roh)) {
    const u = new URL(roh);
    if (u.searchParams.get("error")) throw new Error(`Google hat abgelehnt: ${u.searchParams.get("error")}`);
    code = u.searchParams.get("code") ?? "";
    status = u.searchParams.get("state");
  }
  if (!code) throw new Error("Kein Anmelde-Code gefunden. Bitte die komplette Adresse aus der Browserzeile einfügen.");
  const pkce = JSON.parse(getState("google_pkce") || "null") as { verifier: string; status: string } | null;
  if (!pkce) throw new Error("Anmeldung abgelaufen. Bitte noch einmal auf „Mit Google verbinden“ klicken.");
  if (status && status !== pkce.status) throw new Error("Die Anmeldung passt nicht zu diesem Vorgang. Bitte neu starten.");
  const c = googleClient();
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: c.id, client_secret: c.secret, redirect_uri: googleRedirectUri(), grant_type: "authorization_code", code_verifier: pkce.verifier }),
  });
  const j = (await res.json().catch(() => ({}))) as { refresh_token?: string; access_token?: string; expires_in?: number; id_token?: string; error_description?: string; error?: string };
  if (!res.ok || !j.refresh_token) throw new Error(`Google-Anmeldung fehlgeschlagen: ${j.error_description || j.error || res.status}`);
  let email: string | null = null;
  try { email = JSON.parse(Buffer.from(String(j.id_token).split(".")[1], "base64url").toString("utf8")).email ?? null; } catch { /* ohne E-Mail weiter */ }
  setState("google_kalender", JSON.stringify({ refresh_token: j.refresh_token, email, verbunden_at: new Date().toISOString() } satisfies GoogleZugang));
  setState("google_pkce", "");
  if (j.access_token) zugriff = { token: j.access_token, bis: Date.now() + ((j.expires_in ?? 3600) - 120) * 1000 };
  return { email };
}

export function googleTrennen(): void {
  setState("google_kalender", "");
  zugriff = null;
}

let zugriff: { token: string; bis: number } | null = null;
async function zugriffsToken(): Promise<string> {
  if (zugriff && zugriff.bis > Date.now()) return zugriff.token;
  const z = zugang();
  if (!z?.refresh_token) throw new Error("Kein Google-Kalender verbunden.");
  const c = googleClient();
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.id, client_secret: c.secret, refresh_token: z.refresh_token, grant_type: "refresh_token" }),
  });
  const j = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !j.access_token) {
    // Widerrufen oder abgelaufen: Verbindung als getrennt melden, statt bei jedem Termin zu scheitern.
    if (j.error === "invalid_grant") googleTrennen();
    throw new Error(`Google-Zugang ungültig (${j.error || res.status}) – bitte in den Einstellungen neu verbinden.`);
  }
  zugriff = { token: j.access_token, bis: Date.now() + ((j.expires_in ?? 3600) - 120) * 1000 };
  return zugriff.token;
}

async function kalender(method: "POST" | "PATCH" | "DELETE", pfad: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events${pfad}`, {
    method, headers: { Authorization: `Bearer ${await zugriffsToken()}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (method === "DELETE" && (res.status === 204 || res.status === 410 || res.status === 404)) return {};
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`Google Kalender: ${(j.error as { message?: string })?.message || res.status}`);
  return j;
}

/** "2026-10-06T17:00" + Minuten → "2026-10-06T18:00" (reine Uhrzeitrechnung, Zone bleibt Europe/Berlin). */
export function plusMinuten(startLokal: string, minuten: number): string {
  const [d, t] = startLokal.split("T");
  const [y, mo, da] = d.split("-").map(Number);
  const [h, mi] = t.split(":").map(Number);
  const x = new Date(Date.UTC(y, mo - 1, da, h, mi + minuten));
  return x.toISOString().slice(0, 16);
}

function ereignis(t: { titel: string; start_lokal: string; dauer_min: number; thread_url: string }) {
  return {
    summary: t.titel,
    description: `Vereinbart im LinkedIn-Chat: ${t.thread_url}\nEingetragen von NextLead.`,
    start: { dateTime: `${t.start_lokal}:00`, timeZone: ZEITZONE },
    end: { dateTime: `${plusMinuten(t.start_lokal, t.dauer_min)}:00`, timeZone: ZEITZONE },
    reminders: { useDefault: true },
  };
}

// ---------------------------------------------------------------- Erkennung

export type Nachricht = { sender: string; text: string; vonMir?: boolean };

/**
 * Billiger Vorfilter: Ohne Uhrzeit, Wochentag oder Datum in den letzten Nachrichten gibt es nichts
 * zu prüfen – dann kein KI-Aufruf. Rein, für Tests exportiert.
 */
export function moeglicherTermin(nachrichten: Nachricht[]): boolean {
  const text = nachrichten.slice(-4).map((m) => m.text).join(" ").toLowerCase();
  const uhrzeit = /\b([01]?\d|2[0-3])([:.][0-5]\d)?\s*uhr\b|\b([01]?\d|2[0-3])[:.][0-5]\d\b/.test(text);
  const tag = /\b(montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|morgen|übermorgen|\d{1,2}\.\s?\d{1,2}\.)/.test(text);
  return uhrzeit && tag;
}

const WOCHENTAG = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];

function heuteText(jetzt: Date): string {
  const f = new Intl.DateTimeFormat("de-DE", { timeZone: ZEITZONE, year: "numeric", month: "2-digit", day: "2-digit", weekday: "long" });
  return f.format(jetzt);
}

type KiBefund = { bestaetigt?: boolean; sicher?: boolean; datum?: string; uhrzeit?: string; art?: string; grund?: string };

/** Prüft einen Chat auf einen BEIDSEITIG bestätigten Termin und trägt ihn ein. Wirft nie. */
export async function pruefeTermin(ctx: { threadUrl: string; participant: string; messages: Nachricht[] }, jetzt = new Date()): Promise<void> {
  try {
    if (!googleStatus().verbunden) return; // ohne Kalender keine Kosten
    if (!ctx.threadUrl || !moeglicherTermin(ctx.messages)) return;
    const ich = getProfil().name || "Ich";
    const arten = terminArten();
    const verlauf = ctx.messages.slice(-10)
      .map((m) => `${m.vonMir === true ? `${ich} (ich)` : m.vonMir === false ? ctx.participant : m.sender || "?"}: ${m.text}`)
      .join("\n");
    const prompt = `Du prüfst einen LinkedIn-Chat zwischen ${ich} und ${ctx.participant}: Haben BEIDE einen konkreten Termin (Tag UND Uhrzeit) verbindlich bestätigt?
Heute ist ${heuteText(jetzt)} (Zeitzone Europe/Berlin). Relative Angaben („Dienstag“, „nächste Woche Dienstag“, „morgen“) beziehen sich auf den Zeitpunkt der Nachricht; die letzten Nachrichten sind von heute, wenn nichts anderes erkennbar ist. Ein Termin liegt nie in der Vergangenheit.

Termin-Arten: ${arten.map((a) => `"${a.name}"`).join(", ")}. Wähle die passende; passt keine, nimm "${arten[0].name}".

Bestätigt heißt: eine Seite schlägt eine konkrete Zeit vor und die andere sagt klar zu (oder eine Seite wählt aus angebotenen Zeiten und die andere bestätigt). Mehrere Optionen ohne Auswahl, „vielleicht“, „ich melde mich“ = NICHT bestätigt.
"sicher" nur, wenn das Kalenderdatum eindeutig bestimmbar ist.

CHAT (älteste zuerst):
${verlauf}

Antworte AUSSCHLIESSLICH mit JSON:
{"bestaetigt":true|false,"sicher":true|false,"datum":"YYYY-MM-DD","uhrzeit":"HH:MM","art":"…","grund":"ein kurzer Satz"}`;
    const roh = await generateText(prompt, 300);
    const s = roh.indexOf("{"), e = roh.lastIndexOf("}");
    if (s < 0 || e <= s) return;
    const b = JSON.parse(roh.slice(s, e + 1)) as KiBefund;
    if (!b.bestaetigt) return;
    await verarbeiteBefund(ctx, b, jetzt);
  } catch (err) {
    console.error(`[termine] Prüfung fehlgeschlagen (${ctx.participant}): ${String((err as Error)?.message ?? err).slice(0, 120)}`);
  }
}

/** Plausibilisiert den KI-Befund und legt an bzw. verschiebt. Exportiert für Tests. */
export async function verarbeiteBefund(ctx: { threadUrl: string; participant: string }, b: KiBefund, jetzt = new Date()): Promise<"eingetragen" | "verschoben" | "unveraendert" | "unsicher"> {
  const datumOk = /^\d{4}-\d{2}-\d{2}$/.test(b.datum ?? "") && /^([01]\d|2[0-3]):[0-5]\d$/.test(b.uhrzeit ?? "");
  const start = datumOk ? `${b.datum}T${b.uhrzeit}` : "";
  const heute = new Intl.DateTimeFormat("sv-SE", { timeZone: ZEITZONE }).format(jetzt); // YYYY-MM-DD
  const inZukunft = !!start && start.slice(0, 10) >= heute && start.slice(0, 10) <= plusMinuten(`${heute}T00:00`, 120 * 24 * 60).slice(0, 10);
  if (!b.sicher || !inZukunft) {
    events.emit("termin:unsicher", { participant: ctx.participant, threadUrl: ctx.threadUrl, grund: b.grund || (start ? `Datum ${start} unplausibel` : "Datum nicht eindeutig") });
    return "unsicher";
  }
  const arten = terminArten();
  const art = arten.find((a) => a.name.toLowerCase() === String(b.art ?? "").toLowerCase()) ?? arten[0];
  const kontakt = contactForConversation(ctx.threadUrl, ctx.participant);
  const name = ((kontakt && (db.prepare("SELECT full_name FROM contacts WHERE id=?").get(kontakt.id) as { full_name: string | null } | undefined)?.full_name) || ctx.participant).trim();
  const titel = `${art.name} ${name}/${getProfil().name}`.trim();
  const bisher = db.prepare(
    "SELECT * FROM termine WHERE thread_url=? AND art=? AND status='eingetragen' AND start_lokal>=? ORDER BY id DESC LIMIT 1",
  ).get(ctx.threadUrl, art.name, `${heute}T00:00`) as { id: number; start_lokal: string; kalender_id: string | null; dauer_min: number } | undefined;

  if (bisher && bisher.start_lokal === start) return "unveraendert"; // derselbe Termin, schon im Kalender

  if (bisher) {
    const neu = { titel, start_lokal: start, dauer_min: art.dauer, thread_url: ctx.threadUrl };
    if (bisher.kalender_id) await kalender("PATCH", `/${encodeURIComponent(bisher.kalender_id)}`, ereignis(neu));
    db.prepare("UPDATE termine SET start_lokal=?, dauer_min=?, titel=?, updated_at=datetime('now') WHERE id=?").run(start, art.dauer, titel, bisher.id);
    events.emit("termin:eingetragen", { id: bisher.id, titel, start, verschoben: true, vorher: bisher.start_lokal, threadUrl: ctx.threadUrl });
    console.info(`[termine] verschoben: ${titel} ${bisher.start_lokal} → ${start}`);
    return "verschoben";
  }

  const id = Number(db.prepare(
    "INSERT INTO termine(contact_id, thread_url, teilnehmer, art, start_lokal, dauer_min, titel, status, quelle) VALUES(?,?,?,?,?,?,?,'eingetragen','chat')",
  ).run(kontakt?.id ?? null, ctx.threadUrl, name, art.name, start, art.dauer, titel).lastInsertRowid);
  try {
    const ev = await kalender("POST", "", ereignis({ titel, start_lokal: start, dauer_min: art.dauer, thread_url: ctx.threadUrl }));
    db.prepare("UPDATE termine SET kalender_id=? WHERE id=?").run(String(ev.id ?? ""), id);
  } catch (err) {
    db.prepare("UPDATE termine SET status='fehler', fehler=? WHERE id=?").run(String((err as Error).message).slice(0, 200), id);
    events.emit("termin:fehler", { titel, start, grund: (err as Error).message });
    throw err;
  }
  if (kontakt) recordCrmStage(kontakt.id, "meeting", "bot");
  events.emit("termin:eingetragen", { id, titel, start, verschoben: false, threadUrl: ctx.threadUrl });
  console.info(`[termine] eingetragen: ${titel} am ${start}`);
  return "eingetragen";
}

/** Löschen aus Telegram/Cockpit („der Bot hat sich vertan“). */
export async function terminLoeschen(id: number): Promise<boolean> {
  const t = db.prepare("SELECT id, kalender_id, status FROM termine WHERE id=?").get(id) as { id: number; kalender_id: string | null; status: string } | undefined;
  if (!t || t.status === "geloescht") return false;
  if (t.kalender_id) await kalender("DELETE", `/${encodeURIComponent(t.kalender_id)}`);
  db.prepare("UPDATE termine SET status='geloescht', updated_at=datetime('now') WHERE id=?").run(id);
  return true;
}

export function kommendeTermine(limit = 10) {
  const heute = new Intl.DateTimeFormat("sv-SE", { timeZone: ZEITZONE }).format(new Date());
  return db.prepare(
    "SELECT id, teilnehmer, art, start_lokal, dauer_min, titel, status, thread_url FROM termine WHERE status IN ('eingetragen','fehler') AND start_lokal>=? ORDER BY start_lokal LIMIT ?",
  ).all(`${heute}T00:00`, limit) as { id: number; teilnehmer: string; art: string; start_lokal: string; dauer_min: number; titel: string; status: string; thread_url: string }[];
}

export function wochentagVon(startLokal: string): string {
  const [y, m, d] = startLokal.slice(0, 10).split("-").map(Number);
  return WOCHENTAG[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}
