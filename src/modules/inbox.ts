import { newPage, guardAgainstCheckpoint } from "../core/session.js";
import { humanScroll, humanDelay } from "../core/humanize.js";
import { rememberConversationPreview, shouldOpenConversation } from "./lowRead.js";

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

  /**
   * TIEFER SCAN (für "alle offenen Antworten prüfen"): LinkedIn rendert nur die obersten Zeilen
   * der Konversationsliste; ältere Chats kommen erst nach, wenn man die LISTE (nicht die Seite)
   * scrollt. Was nicht im DOM steht, existiert für diesen Scan nicht.
   *
   * MIT ERFOLGSKONTROLLE seit 2026-08-05. Vorher wurde eine feste Rundenzahl (max/8) BLIND
   * gescrollt, ohne je zu prüfen, ob dabei Zeilen nachgeladen wurden. Lud LinkedIn langsamer
   * nach als die 5 Runden dauerten, meldete der Scan "nichts offen", obwohl weiter unten Chats
   * auf Antwort warteten – live nachgewiesen an einem Chat vom 27.07., der nie wieder auftauchte.
   * Jetzt wird gescrollt, bis genug Zeilen geladen sind ODER die Liste nachweislich zu Ende ist.
   */
  const scrollSchritt = () =>
    page.evaluate((sel) => {
      const li = document.querySelector(sel);
      if (!li) return { geladen: 0, bewegt: false };
      // Das wirklich scrollbare Element suchen – die <ul> selbst ist es nicht immer.
      let el = li.parentElement as HTMLElement | null;
      while (el && el.scrollHeight <= el.clientHeight + 4) el = el.parentElement as HTMLElement | null;
      const ziel = el || (document.scrollingElement as HTMLElement);
      const vorher = ziel.scrollTop;
      ziel.scrollTop = ziel.scrollHeight; // ans Ende springen → lädt die nächste Seite nach
      return { geladen: document.querySelectorAll(sel).length, bewegt: ziel.scrollTop !== vorher };
    }, SEL.listItem);

  /**
   * OBERGRENZE 2026-08-05 (Abend): war `min(250, max*3)` und lud real 240 Konversationen –
   * mit ein Auslöser der Kontosperre am selben Tag. Jetzt eng am tatsächlichen Bedarf:
   * etwas mehr Zeilen als Ziele, weil der Vorschau-Filter danach welche wegwirft, aber
   * nie mehr als 60. Wer alle Chats sehen will, bekommt sie über mehrere Tage statt in
   * einem auffälligen Rutsch.
   */
  const zeilenZiel = Math.min(60, Math.ceil(max * 1.5));
  let geladen = 0;
  let stagniert = 0;
  for (let runde = 0; runde < 12; runde++) {
    const r = await scrollSchritt().catch(() => null);
    await humanDelay(700, 1300);
    const jetzt = r?.geladen ?? 0;
    if (jetzt >= zeilenZiel) break;
    // Drei Runden ohne Zuwachs = Ende der Liste (eine Runde Toleranz reicht nicht, LinkedIn
    // lädt spürbar verzögert nach).
    if (jetzt <= geladen) {
      if (++stagniert >= 3) break;
    } else {
      stagniert = 0;
    }
    geladen = Math.max(geladen, jetzt);
  }
  if (geladen) console.info(`[inbox] ${geladen} Konversationen geladen (Ziel ${zeilenZiel}).`);

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
  const nameCounts = new Map<string, number>();
  for (const item of meta) {
    const key = item.participant.trim().toLowerCase();
    nameCounts.set(key, (nameCounts.get(key) || 0) + 1);
  }

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
    // Gleiche Namen können zu unterschiedlichen Menschen gehören. In diesem seltenen Fall
    // niemals anhand des Namens-Caches überspringen – Genauigkeit geht vor Einsparung.
    .map((m) => ({ ...m, cache: shouldOpenConversation(
      m.participant, m.snippet, m.unread, m.amZug,
      (nameCounts.get(m.participant.trim().toLowerCase()) || 0) === 1,
    ) }))
    .filter((m) => m.cache.open)
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

    // Ist die Person am Zug? KONSERVATIV (2026-07-25, gegen Doppel-Texten): der Agent sendet nur,
    // wenn ein SICHERES Signal sagt "die Person schrieb zuletzt". Im Zweifel FALSE → lieber eine
    // Antwort verpassen (der Mensch kann sie manuell geben) als eine zweite Nachricht hinterher
    // schicken, ohne dass die Person geantwortet hat (das sieht nach Bot aus, beschädigt Vertrauen).
    //  1) Listen-Vorschau: beginnt sie mit "Sie:/Du:/You:" → DU zuletzt → NICHT am Zug (am robustesten).
    //  2) letzte Nachricht trägt "--other" (= eindeutig vom Gegenüber) → am Zug.
    //  3) Absender der letzten Nachricht ist eindeutig der Teilnehmer → am Zug.
    //  Sonst (kein sicheres Signal, z.B. Selektoren greifen nicht): NICHT senden.
    const letzte = clean[clean.length - 1];
    const theirTurn =
      t.amZug !== null ? t.amZug               // Vorschau vorhanden → sie ist maßgeblich
      : letzte?.other === true ? true          // letzte Nachricht klar vom Gegenüber
      : !!(letzte?.sender && letzte.sender === participant); // Absender klar = Person; sonst false

    rememberConversationPreview(t.cache.participantKey, t.cache.snippetHash, threadUrl, theirTurn);

    // 'other' vor der Rückgabe entfernen (ThreadContext.messages = {sender,text}).
    const ausgabe = clean.slice(-12).map((m) => ({ sender: m.sender, text: m.text }));
    out.push({ threadUrl, participant, unread: t.unread, messages: ausgabe, lastIncoming, theirTurn });
  }

  return out;
}
