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

  // Listen-Metadaten (Name, ungelesen) je Position einsammeln.
  const meta = (await page.$$eval(
    SEL.listItem,
    (items, sel) =>
      items.map((li) => ({
        participant: (li.querySelector(sel.name)?.textContent || "").trim().replace(/\s+/g, " "),
        unread:
          !!li.querySelector(sel.unread) || /is-unread|--unread/.test(li.className),
      })),
    SEL,
  )) as { participant: string; unread: boolean }[];

  const targets = meta
    .map((m, index) => ({ ...m, index }))
    .filter((m) => (onlyUnread ? m.unread : true))
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
          return { sender, text: body };
        }),
      SEL,
    )) as ThreadMessage[];

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

    out.push({ threadUrl, participant, unread: t.unread, messages: clean.slice(-12), lastIncoming });
  }

  return out;
}
