import { db } from "../db/index.js";
import { generateText } from "../core/textLlm.js";
import { promptKontext, saubern } from "../context.js";
import { events } from "../core/events.js";

/**
 * CONTENT / SICHTBARKEIT – der stärkste Inbound-Hebel (Sinans Second Brain: "kein Kaltakquise,
 * Inbound durch Content"). Der Bot schlägt eigene LinkedIn-Posts vor; Sinan gibt frei; das
 * Posten läuft über die OFFIZIELLE API (modules/posting.ts, kein Selektor-Risiko, kein Ban).
 *
 * Posts sind ÖFFENTLICH und stehen unter Sinans Namen → immer erst Freigabe, nie autonom.
 * Es gelten dieselben Tabus wie für DMs (kein Pitch, Mehrwert-first) plus Sinans echter Ton.
 */

/**
 * Themen-Winkel für die Posts. Bewusst aus Sinans Welt: seine Bank-Ausbildung, sein Weg in
 * die Selbstständigkeit, ehrliche Finanz-Basics für Berufseinsteiger – NICHT werblich.
 * Zielgruppe liest mit: kaufmännische Azubis und junge Berufseinsteiger.
 */
const WINKEL: string[] = [
  "Eine ehrliche Lektion aus Sinans eigener Bankausbildung, die ihm damals keiner gesagt hat.",
  "Ein häufiger Denkfehler von Azubis/Berufseinsteigern rund ums erste Gehalt – klar erklärt, ohne zu belehren.",
  "Warum Sinan nach der Ausbildung den unbequemen Weg gegangen ist, und was er dabei über sich gelernt hat.",
  "Eine kleine, konkrete Sache, die junge Leute früh übers Geld verstehen sollten – alltagsnah, kein Fachchinesisch.",
  "Ein ehrlicher Gedanke zu 'was kommt nach der Ausbildung', der Mut macht statt Druck.",
];

/** Erzeugt EINEN Post-Entwurf zu einem Winkel und legt ihn als 'draft' ab. */
export async function generatePostDraft(winkel?: string): Promise<number | null> {
  const w = winkel ?? WINKEL[Math.floor(Math.random() * WINKEL.length)];
  const prompt = `Schreibe einen LinkedIn-Post für Sinan.
${promptKontext()}
Thema/Winkel: ${w}

Regeln für den Post:
- Erste Zeile ist ein Haken, der neugierig macht (kurz, konkret, kein Clickbait).
- Danach kurze Absätze, je 1-2 Sätze, mit Leerzeilen dazwischen (LinkedIn-tauglich).
- Erzählend und persönlich, aus Sinans echter Erfahrung. Kein Ratgeber-Ton von oben herab.
- 80 bis 150 Wörter. Kein Hashtag-Spam (höchstens 2-3 am Ende, wenn überhaupt).
- KEIN Verkauf, KEIN Aufruf zur Beratung, keine Erwähnung von Fin.Co als Werbung.
- Ende mit einer offenen Frage an die Leser, die zum Kommentieren einlädt.
Gib NUR den Post-Text aus, ohne Anführungszeichen, ohne Vorrede.`;
  try {
    const text = saubern(await generateText(prompt));
    if (!text || text.length < 60) return null;
    const info = db.prepare("INSERT INTO posts(body, status) VALUES(?, 'draft')").run(text);
    const id = Number(info.lastInsertRowid);
    events.emit("post:new", { id, body: text });
    return id;
  } catch (e) {
    console.error("[content] Post-Generierung fehlgeschlagen:", (e as Error)?.message?.slice(0, 90));
    return null;
  }
}

/** Mehrere Post-Ideen auf einmal (z.B. wöchentlicher Vorrat). */
export async function generatePostIdeas(n = 3): Promise<number> {
  let done = 0;
  const winkel = [...WINKEL].sort(() => Math.random() - 0.5).slice(0, n);
  for (const w of winkel) if (await generatePostDraft(w)) done++;
  if (done) console.info(`[content] ${done} Post-Idee(n) erzeugt (zur Freigabe).`);
  return done;
}

export type Post = { id: number; body: string; status: string; scheduled_for: string | null; created_at: string };

export function pendingPosts(): Post[] {
  return db.prepare("SELECT id, body, status, scheduled_for, created_at FROM posts WHERE status='draft' ORDER BY created_at DESC").all() as Post[];
}

export function getPost(id: number): Post | undefined {
  return db.prepare("SELECT id, body, status, scheduled_for, created_at FROM posts WHERE id=?").get(id) as Post | undefined;
}

/**
 * Post freigeben → 'approved' + fällig ab jetzt. Der bestehende Cron in index.ts veröffentlicht
 * fällige, freigegebene Posts über die offizielle API. Optional ein Zeitpunkt (ISO) zum Planen.
 */
export function approvePost(id: number, scheduledFor?: string): boolean {
  const r = db
    .prepare("UPDATE posts SET status='approved', scheduled_for=COALESCE(?, datetime('now')) WHERE id=? AND status='draft'")
    .run(scheduledFor ?? null, id);
  return r.changes > 0;
}

export function discardPost(id: number): boolean {
  return db.prepare("UPDATE posts SET status='discarded' WHERE id=? AND status='draft'").run(id).changes > 0;
}
