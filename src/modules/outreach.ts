import { newPage, guardAgainstCheckpoint } from "../core/session.js";
import { governor, GovernorBlocked } from "../core/safetyGovernor.js";
import { humanDelay, humanScroll, humanType, humanTypeInto } from "../core/humanize.js";
import { db } from "../db/index.js";

/**
 * Cold Outreach über die echte Browser-Session.
 * WICHTIG: Alles läuft über governor.execute(). Kein Direktweg.
 *
 * Selektoren sind bewusst als Konstanten gebündelt – LinkedIn ändert die UI
 * regelmäßig, dann nur hier anpassen.
 */
const SEL = {
  // Der "Vernetzen"-Button des HAUPTPROFILS ist oft ein <a> (nicht <button>) und
  // wird über aria-label identifiziert ("… als Kontakt einladen" / "Invite … to connect").
  // Sidebar-Vorschläge tragen dasselbe Label, stehen aber später im DOM → .first() = Hauptprofil.
  connectBtn:
    '[aria-label*="als Kontakt einladen"], [aria-label*="to connect"], [aria-label*="Invite"][aria-label*="connect"]',
  // Falls "Vernetzen" hinter dem "Mehr"-Menü versteckt ist.
  moreBtn: 'button[aria-label="Mehr Aktionen"], main button:has-text("Mehr")',
  // Auf den Modal-Dialog scopen, damit nicht versehentlich Hintergrund-Buttons getroffen werden.
  addNoteBtn: '[role="dialog"] button:has-text("Notiz hinzufügen"), [role="dialog"] button:has-text("Add a note")',
  noteField: '[role="dialog"] textarea',
  sendInvite:
    '[role="dialog"] button:has-text("Ohne Notiz senden"), [role="dialog"] button:has-text("Senden"), [role="dialog"] button:has-text("Send")',
  /**
   * "Nachricht"-Button auf dem Profil. LIVE VERIFIZIERT 2026-07-16 – hier lauerte ein Bug:
   * `button:has-text("Nachricht")` traf mit .first() den Umschalter des Nachrichten-OVERLAYS
   * (unten rechts), nicht das Profil → die Nachricht wäre in einen fremden Chat getippt worden.
   * Der echte Button ist ein <a> auf den Compose-Link MIT der profileUrn dieser Person.
   * `:not([aria-label])` schließt die Vorschlags-Kacheln fremder Leute aus (die tragen
   * aria-label="Nachricht an <fremder Name> senden"). Ergebnis: genau 2 Treffer je Profil
   * (Kopfbereich + Sticky-Header), beide mit identischer URN → .first() ist immer richtig.
   */
  messageBtn: 'main a[href*="/messaging/compose"]:not([aria-label])',
  messageBox: '.msg-form__contenteditable',
  sendButton: '.msg-form__send-button',
  // Einzelne Nachricht im Verlauf – dient als BELEG, dass wirklich gesendet wurde.
  threadItem: ".msg-s-event-listitem",
  // Ein einzelnes Chat-Fenster im Overlay. Nötig, um Prüfungen auf UNSER Fenster zu scopen
  // (LinkedIn stellt mehrere offene Fenster wieder her).
  bubble: ".msg-overlay-conversation-bubble",
  // Öffentliche Kommentare (feed.ts/comment.ts). Read-only verifiziert 2026-07-17.
  commentBtn: "button[aria-label*='ommentier']",
  commentBox: ".comments-comment-box__form .ql-editor, .comments-comment-texteditor .ql-editor, div[data-placeholder*='Kommentar']",
  commentSend: "button.comments-comment-box__submit-button, button[aria-label*='Kommentar posten'], button[class*='comments'][class*='submit']",
  commentItem: ".comments-comment-item, article.comments-comment-entity",
};

/** Findet den Vernetzen-Button – direkt oder nach Öffnen des "Mehr"-Menüs. */
async function findConnectButton(page: import("playwright").Page) {
  let btn = page.locator(SEL.connectBtn).first();
  if ((await btn.count()) === 0) {
    const more = page.locator(SEL.moreBtn).first();
    if (await more.count()) {
      await more.click();
      await humanDelay(500, 1200);
      btn = page.locator(SEL.connectBtn).first();
    }
  }
  return btn;
}

/** Eine Vernetzungsanfrage mit optionaler personalisierter Notiz. */
export async function sendConnectionRequest(profileUrl: string, note?: string) {
  try {
    return await governor.execute("connect", profileUrl, async () => {
      const page = await newPage();
      await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
      if (await guardAgainstCheckpoint(page)) throw new GovernorBlocked("Checkpoint");
      await humanScroll(page); // erst schauen, dann handeln – wie ein Mensch

      const connect = await findConnectButton(page);
      if ((await connect.count()) === 0) {
        // Kein Vernetzen-Button (z.B. schon vernetzt / Anfrage ausstehend) – überspringen.
        throw new GovernorBlocked("Kein Vernetzen-Button gefunden");
      }
      // WICHTIG: KEIN Koordinaten-Klick – die klebrige Top-Navi ("Marketing" → Campaign
      // Manager) liegt über dem Button und würde den Klick abfangen. Stattdessen den
      // JS-Klick-Handler des Elements direkt auslösen. Das öffnet das Vernetzen-Modal.
      await connect
        .evaluate((el) => el.scrollIntoView({ block: "center" }))
        .catch(() => {});
      await humanDelay(400, 900);
      await connect.evaluate((el) => (el as HTMLElement).click());
      await humanDelay(1000, 2200);

      if (note) {
        const addNote = page.locator(SEL.addNoteBtn).first();
        if (await addNote.count()) {
          await addNote.evaluate((el) => (el as HTMLElement).click());
          await humanDelay(500, 1200);
          await humanType(page, SEL.noteField, note.slice(0, 200)); // Notiz-Limit 200 Zeichen
        }
      }
      // Im Modal absenden ("Senden" oder "Ohne Notiz senden"; ohne Notiz teils direkt).
      const send = page.locator(SEL.sendInvite).first();
      if (await send.count()) {
        await send.evaluate((el) => (el as HTMLElement).click());
      }
      await humanDelay(600, 1400);

      db.prepare(
        "UPDATE contacts SET status='invited', invited_at=datetime('now') WHERE profile_url = ?",
      ).run(profileUrl);
      console.info(`[outreach] ✅ vernetzt mit ${profileUrl}`);
    });
  } catch (e) {
    if (e instanceof GovernorBlocked) {
      console.info(`[outreach] übersprungen (${profileUrl}): ${e.message}`);
      return;
    }
    throw e;
  }
}

/**
 * Tippt den Text, sendet ihn und VERIFIZIERT, dass er wirklich im Chat gelandet ist.
 *
 * WARUM: Ohne diese Prüfung hat der Bot gelogen. Real passiert am 2026-07-16: Jonas Jüppner
 * (09:43) und Ben Endress (10:06) wurden als 'messaged' markiert, die Aktion protokolliert und
 * ein Telegram-Push "Nachricht gesendet" verschickt – im Postfach kam nie etwas an. Der alte
 * Code tippte, drückte Enter und markierte bedingungslos als gesendet, ohne je nachzusehen.
 *
 * Zwei unabhängige Belege müssen stimmen:
 *  1. LinkedIn leert das Eingabefeld nach erfolgreichem Senden. Steht der Text noch drin,
 *     ging nichts raus.
 *  2. Der Text taucht im Nachrichtenverlauf auf.
 * Schlägt einer fehl, wird geworfen. Der Aufrufer macht daraus einen Entwurf. Lieber kein
 * Versand als eine Falschmeldung.
 */
async function tippenUndSenden(page: import("playwright").Page, text: string) {
  await page.waitForSelector(SEL.messageBox, { timeout: 15000 });

  // WICHTIG: LinkedIn stellt beim Laden ALLE zuletzt offenen Chat-Fenster wieder her – live
  // gemessen 2026-07-16: nach dem zweiten Profil lagen 2 Eingabefelder auf der Seite. Ein
  // Selektor-String wäre mehrdeutig (Playwright: "strict mode violation") und der Versand
  // würde ab der zweiten Nachricht scheitern. Das zuletzt geöffnete Fenster ist unseres,
  // deshalb .last() – und ALLE Prüfungen laufen auf genau demselben Element.
  const box = page.locator(SEL.messageBox).last();
  await humanTypeInto(box, text);
  await humanDelay(600, 1500);

  const sendBtn = page.locator(SEL.sendButton).last();
  if (await sendBtn.isEnabled().catch(() => false)) await sendBtn.click();
  else await page.keyboard.press("Enter"); // Fallback

  // Beleg 1: unser Eingabefeld muss leer sein.
  const geleert = await box
    .evaluate((el) => (el.textContent || "").trim().length === 0)
    .catch(() => false);
  if (!geleert) {
    await humanDelay(1500, 2500); // LinkedIn braucht manchmal einen Moment
    const nochmal = await box.evaluate((el) => (el.textContent || "").trim().length === 0).catch(() => false);
    if (!nochmal) throw new Error("Senden nicht bestätigt: Eingabefeld ist noch gefüllt");
  }

  // Beleg 2: Text steht im Verlauf – NUR im zuletzt geöffneten Fenster prüfen, sonst
  // könnte ein anderes offenes Fenster einen Treffer vortäuschen.
  const marker = text.replace(/\s+/g, " ").trim().slice(0, 40);
  const bubble = page.locator(SEL.bubble).last();
  const suchraum = (await bubble.count()) ? bubble : page.locator("body");
  const imVerlauf = await suchraum
    .locator(SEL.threadItem)
    .filter({ hasText: marker })
    .count()
    .catch(() => 0);
  if (imVerlauf === 0) throw new Error("Senden nicht bestätigt: Nachricht steht nicht im Verlauf");
}

/** Erstnachricht an einen bereits verbundenen Kontakt. */
export async function sendMessage(profileUrl: string, text: string) {
  try {
    return await governor.execute("message", profileUrl, async () => {
      const page = await newPage();
      await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
      if (await guardAgainstCheckpoint(page)) throw new GovernorBlocked("Checkpoint");

      // Sicherheitsnetz: lieber gar nicht senden als an die falsche Person. Wenn der
      // Profil-Button fehlt (LinkedIn-Umbau), abbrechen statt blind irgendwo zu klicken.
      const msgBtn = page.locator(SEL.messageBtn).first();
      if ((await msgBtn.count()) === 0) {
        throw new Error("Nachricht-Button auf dem Profil nicht gefunden (Selektor prüfen)");
      }
      await msgBtn.evaluate((el) => (el as HTMLElement).click()); // JS-Klick: React-Handler, kein Nav
      await humanDelay(1000, 2500);

      // Wirft, wenn der Versand nicht nachweisbar ist – dann NICHT als gesendet markieren.
      await tippenUndSenden(page, text);

      db.prepare(
        "UPDATE contacts SET status='messaged', messaged_at=datetime('now') WHERE profile_url = ?",
      ).run(profileUrl);
    });
  } catch (e) {
    if (e instanceof GovernorBlocked) {
      console.info(`[outreach] Nachricht übersprungen (${profileUrl}): ${e.message}`);
      return;
    }
    throw e;
  }
}

/**
 * Antwort in einen BESTEHENDEN Thread (für freigegebene DM-Entwürfe).
 * Navigiert direkt zur Thread-URL und sendet über `tippenUndSenden` – inklusive Beweis,
 * dass die Nachricht wirklich im Verlauf steht. Governor-gated.
 */
export async function sendThreadReply(threadUrl: string, text: string) {
  return governor.execute("message", threadUrl, async () => {
    const page = await newPage();
    await page.goto(threadUrl, { waitUntil: "domcontentloaded" });
    if (await guardAgainstCheckpoint(page)) throw new GovernorBlocked("Checkpoint");
    await humanDelay(1200, 2500);
    await tippenUndSenden(page, text);
  });
}

/**
 * ÖFFENTLICHEN KOMMENTAR unter einem fremden Post posten (governor-gated, ActionType 'comment').
 * Nur ueber freigegebene Kommentar-Entwuerfe (kind='comment'). Wie bei DMs mit VERIFIKATION:
 * ein oeffentlicher Kommentar, der als "gepostet" gemeldet wird aber nicht ankam, waere eine
 * Falschmeldung – und ein doppelter waere peinlich. Deshalb Beleg: der Text steht danach im
 * Kommentarbereich. HINWEIS: der scharfe Versand ist nicht automatisiert testbar (System sperrt
 * reale oeffentliche Sends) – Selektoren read-only verifiziert, beim ersten echten Lauf pruefen.
 */
export async function sendComment(postUrl: string, text: string) {
  return governor.execute("comment", postUrl, async () => {
    const page = await newPage();
    await page.goto(postUrl, { waitUntil: "domcontentloaded" });
    if (await guardAgainstCheckpoint(page)) throw new GovernorBlocked("Checkpoint");
    await humanDelay(2000, 3500);

    // Kommentarbereich oeffnen
    const kbtn = page.locator(SEL.commentBtn).first();
    if ((await kbtn.count()) === 0) throw new Error("Kommentar-Button nicht gefunden");
    await kbtn.evaluate((el) => (el as HTMLElement).click());
    await humanDelay(1200, 2500);

    const box = page.locator(SEL.commentBox).first();
    await box.waitFor({ timeout: 12000 });
    await humanTypeInto(box, text);
    await humanDelay(700, 1600);

    const send = page.locator(SEL.commentSend).first();
    if (await send.isEnabled().catch(() => false)) await send.click();
    else throw new Error("Kommentar-Senden-Button nicht aktiv");

    // Beleg: unser Text steht jetzt im Kommentarbereich.
    const marker = text.replace(/\s+/g, " ").trim().slice(0, 35);
    const drin = await page
      .locator(SEL.commentItem)
      .filter({ hasText: marker })
      .count()
      .catch(() => 0);
    if (drin === 0) throw new Error("Kommentar nicht bestätigt: steht nicht im Kommentarbereich");
  });
}
