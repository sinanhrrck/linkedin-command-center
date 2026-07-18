import { db } from "../db/index.js";
import { generateText } from "../core/textLlm.js";
import { promptKontext, saubern } from "../context.js";
import { events } from "../core/events.js";
import { fetchNichePosts, NISCHE_KEYWORDS, type FeedPost } from "./feed.js";
import { getDraft } from "./drafts.js";

/**
 * REICHWEITEN-KOMMENTARE für Sichtbarkeit. Der Bot findet Nischen-Posts (feed.ts), lässt die KI
 * entscheiden, ob ein Post ueberhaupt kommentierwuerdig ist, und schreibt ggf. einen Kommentar
 * in Sinans Ton. ÖFFENTLICH → immer erst Freigabe (drafts kind='comment'), nie autonom.
 *
 * Warum die KI ueber Relevanz entscheidet statt ein Regex: der Content-Reader liefert gemischtes
 * Material (auch Stellenausschreibungen, reine Werbung). Ein Kommentar drunter waere peinlich.
 * Die KI versteht den Kontext und gibt bei Muell "skip" zurueck – robuster als jeder Filter.
 */
type CommentStep = { relevant: boolean; comment: string; grund: string };

async function bewertenUndKommentieren(post: FeedPost): Promise<CommentStep | null> {
  const prompt = `Du bist Sinan und ueberlegst, ob du einen fremden LinkedIn-Post kommentierst.
${promptKontext()}

Der Post von ${post.autor || "jemandem"}:
"${post.text.slice(0, 500)}"

Zuerst: Lohnt sich ein Kommentar? NICHT kommentieren bei: Stellenausschreibungen, reiner Werbung,
Verkaufsposts, belanglosem Smalltalk, oder Themen fernab von Ausbildung/Berufseinstieg/Finanzen
fuer junge Leute. Nur kommentieren, wenn Sinan echten Mehrwert oder eine ehrliche Perspektive
beitragen kann und seine Zielgruppe (kaufm. Azubis, Berufseinsteiger) dort mitliest.

Wenn ja, schreibe einen Kommentar:
- KURZ (1-2 Saetze), wie man wirklich kommentiert, nicht wie ein Aufsatz.
- Echter Beitrag zum Thema aus Sinans Erfahrung, KEIN Pitch, keine Eigenwerbung, kein "meldet euch".
- Kein Anbiedern ("toller Post!"), sondern ein eigener Gedanke.

Antworte AUSSCHLIESSLICH mit JSON:
{"relevant": true/false, "comment": "der Kommentar oder leer", "grund": "1 Satz warum (nicht) kommentiert"}`;
  try {
    const raw = await generateText(prompt);
    const json = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
    const p = JSON.parse(json) as CommentStep;
    p.comment = saubern(p.comment || "");
    p.relevant = !!p.relevant && p.comment.length > 10;
    return p;
  } catch {
    return null;
  }
}

/** Schon ein offener/gesendeter Kommentar-Entwurf fuer diesen Post? (kein Doppelkommentar) */
function hatKommentar(url: string): boolean {
  return !!db
    .prepare("SELECT 1 FROM drafts WHERE thread_url=? AND kind='comment' AND status IN ('pending','approved','sent') LIMIT 1")
    .get(url);
}

/**
 * Ein Durchlauf: Nischen-Posts holen, die kommentierwuerdigen mit einem Entwurf versehen,
 * an Sinan zur Freigabe geben. maxDrafts begrenzt die KI-Aufrufe (Gemini-Kontingent).
 */
export async function commentTick(maxDrafts = 3): Promise<number> {
  const keyword = NISCHE_KEYWORDS[Math.floor(Math.random() * NISCHE_KEYWORDS.length)];
  const posts = await fetchNichePosts(keyword, 8);
  let erstellt = 0;
  for (const post of posts) {
    if (erstellt >= maxDrafts) break;
    if (hatKommentar(post.url)) continue;
    const step = await bewertenUndKommentieren(post);
    if (!step || !step.relevant) continue;
    const info = db
      .prepare(
        "INSERT INTO drafts(kind, thread_url, participant, incoming, draft, ki_original, intent) VALUES('comment',?,?,?,?,?,'comment')",
      )
      .run(post.url, post.autor || "—", post.text.slice(0, 300), step.comment, step.comment);
    const d = getDraft(Number(info.lastInsertRowid));
    events.emit("comment:new", { draft: d, autor: post.autor, postText: post.text.slice(0, 160), url: post.url });
    erstellt++;
  }
  if (erstellt) console.info(`[comment] ${erstellt} Kommentar-Entwurf/-Entwuerfe (Thema "${keyword}") zur Freigabe.`);
  return erstellt;
}
