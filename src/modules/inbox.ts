import { newPage, guardAgainstCheckpoint } from "../core/session.js";
import { humanScroll, humanDelay } from "../core/humanize.js";

/**
 * Liest die LinkedIn-Inbox – REIN LESEND, kein Governor, kein Senden.
 * Grundlage für DM-Entwürfe: Konversationen holen → Kontext → Gemini-Draft.
 *
 * Selektoren gebündelt (SEL) und gegen die aktuelle Messaging-UI verifiziert.
 * LinkedIn-Threads haben KEINEN Link im DOM – die stabile Thread-URL entsteht
 * erst durch Anklicken der Zeile (dann steht sie in der Browser-URL).
 */
export type ThreadMessage = { sender: string; text: string };

export type ThreadContext = {
  threadUrl: string;
  participant: string;
  unread: boolean;
  messages: ThreadMessage[];
  lastIncoming: string; // letzte Nachricht des Gegenübers (Kontext für den Draft)
  theirTurn: boolean;   // ist die PERSON am Zug? (zuverlässig aus der Listen-Vorschau, nicht nur "ungelesen")
};

const SEL = {
  listItem: "li.msg-conversation-listitem",
  name: ".msg-conversation-listitem__participant-names",
  snippet: ".msg-conversation-card__message-snippet",
  unread: ".notification-badge--show",
  threadTitle: "h2.msg-entity-lockup__entity-title",
  msgItem: ".msg-s-event-listitem",
  msgBody: ".msg-s-event-listitem__body",
  msgName: ".msg-s-message-group__name",
};

const MESSAGING_URL = "https://www.linkedin.com/messaging/";

/**
 * Holt die jüngsten Threads inkl. Verlauf. Klickt jede Ziel-Zeile an, um die
 * stabile Thread-URL und die Nachrichten aus dem geöffneten Pane zu lesen.
 * onlyUnread=true beschränkt auf ungelesene Konversationen.
 */
export async function fetchThreads(max = 8, onlyUnread = false): Promise<ThreadContext[]> {
  const page = await newPage();
  await page.goto(MESSAGING_URL, { waitUntil: "domcontentloaded" });
  if (await guardAgainstCheckpoint(page)) return [];
  await humanDelay(2500, 4000);
  await humanScroll(page);

  // Listen-Metadaten (Name, ungelesen, VORSCHAU) je Position einsammeln. Die Vorschau ist der
  // Schlüssel: LinkedIn stellt "Sie: …" voran, wenn DU zuletzt geschrieben hast. Fehlt das,
  // ist die PERSON am Zug – zuverlässig auch bei GELESENEN Alt-Chats (der frühere "ungelesen"-
  // Rückfall übersah genau die).
  const meta = (await page.$$eval(
    SEL.listItem,
    (items, sel) =>
      items.map((li) => ({
        participant: (li.querySelector(sel.name)?.textContent || "").trim().replace(/\s+/g, " "),
        unread:
          !!li.querySelector(sel.unread) || /is-unread|--unread/.test(li.className),
        snippet: (li.querySelector(sel.snippet)?.textContent || "").trim().replace(/\s+/g, " "),
      })),
    SEL,
  )) as { participant: string; unread: boolean; snippet: string }[];

  // Aus der Vorschau ableiten, ob die Person am Zug ist. "Sie:"/"Du:"/"You:" am Anfang = DU zuletzt.
  const personAmZug = (snippet: string) => {
    if (!snippet) return null; // unbekannt (leere Vorschau)
    return !/^\s*(sie|du|you)\s*:/i.test(snippet);
  };

  const targets = meta
    .map((m, index) => ({ ...m, index, amZug: personAmZug(m.snippet) }))
    // Nur Threads öffnen, bei denen die Person am Zug ist ODER ungelesen ODER unklar – spart Zeit
    // und verhindert, dass der Agent auf die eigene letzte Nachricht "antwortet".
    .filter((m) => (onlyUnread ? m.unread : m.amZug !== false))
    .slice(0, max);

  const out: ThreadContext[] = [];
  for (const t of targets) {
    await page.locator(SEL.listItem).nth(t.index).click();
    await humanDelay(1800, 3200);
    if (await guardAgainstCheckpoint(page)) break;

    const threadUrl = page.url();
    if (!threadUrl.includes("/messaging/thread/")) continue; // Thread nicht geöffnet – überspringen

    const participant =
      (await page.locator(SEL.threadTitle).first().innerText().catch(() => "")).trim() ||
      t.participant;

    const messages = (await page.$$eval(
      SEL.msgItem,
      (items, sel) =>
        items.map((el) => {
          const body = (el.querySelector(sel.msgBody)?.textContent || "").trim().replace(/\s+/g, " ");
          // Name steht als BEM-Element __name INNERHALB des event-listitem (kein __group-Container).
          const sender = (el.querySelector(sel.msgName)?.textContent || "").trim().replace(/\s+/g, " ");
          // Zweites Signal: LinkedIn markiert Nachrichten des GEGENÜBERS mit "--other".
          const other = /--other\b/.test(el.className) || !!el.closest(".msg-s-event-listitem--other");
          return { sender, text: body, other };
        }),
      SEL,
    )) as (ThreadMessage & { other: boolean })[];

    // Sender-Name fehlt bei Folgenachrichten derselben Gruppe → nach unten füllen.
    let lastSender = "";
    for (const m of messages) {
      if (m.sender) lastSender = m.sender;
      else m.sender = lastSender;
    }
    const clean = messages.filter((m) => m.text);
    // Letzte Nachricht des Gegenübers als Draft-Kontext.
    const lastIncoming =
      [...clean].reverse().find((m) => m.sender && m.sender === participant)?.text ||
      clean[clean.length - 1]?.text ||
      "";

    // Ist die Person am Zug? Drei unabhängige Signale in Prioritätsreihenfolge, damit die Erkennung
    // nicht an EINEM Selektor hängt (LinkedIn ändert die UI regelmäßig):
    //  1) Listen-Vorschau ("Sie:" = du zuletzt) – am zuverlässigsten, greift auch bei gelesenen Chats.
    //  2) letzte Nachricht trägt "--other" (= vom Gegenüber).
    //  3) Absender der letzten Nachricht == Teilnehmer.
    //  4) letzter Rückfall: ungelesen.
    const letzte = clean[clean.length - 1];
    const senderBekannt = clean.some((m) => m.sender);
    const theirTurn =
      t.amZug !== null ? t.amZug
      : letzte?.other ? true
      : senderBekannt ? letzte?.sender === participant
      : t.unread;

    // 'other' vor der Rückgabe entfernen (ThreadContext.messages = {sender,text}).
    const ausgabe = clean.slice(-12).map((m) => ({ sender: m.sender, text: m.text }));
    out.push({ threadUrl, participant, unread: t.unread, messages: ausgabe, lastIncoming, theirTurn });
  }

  return out;
}
