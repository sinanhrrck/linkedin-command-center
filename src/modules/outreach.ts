import { newPage, guardAgainstCheckpoint } from "../core/session.js";
import { governor, GovernorBlocked, DuplikatBlockiert } from "../core/safetyGovernor.js";
import { humanDelay, humanScroll, humanType, humanTypeInto } from "../core/humanize.js";
import { istPlausibleNachricht, UnsichereNachricht } from "../core/nachrichtCheck.js";
import { db } from "../db/index.js";

/** Whitespace/Unsichtbares normalisieren, damit Soll/Ist-Vergleich fair ist. */
function normText(s: string): string {
  return (s || "").replace(/​/g, "").replace(/\s+/g, " ").trim();
}

/**
 * DOPPEL-VERSAND-SPERRE (universell, greift für JEDEN Sendeweg über tippenUndSenden).
 * Ein persistentes Ledger merkt sich (Empfänger + Text-Fingerabdruck + Zeit). Bevor etwas
 * rausgeht, wird geprüft, ob GENAU diese Nachricht kürzlich schon an diese Person ging –
 * egal welcher Codepfad (Agent, Entwurf-Freigabe, alte Autopilot-Reste, Überlappung, Retry).
 * Der eigentliche Root-Cause kann variieren; DIESE Sperre fängt sie alle ab.
 */
db.exec(
  "CREATE TABLE IF NOT EXISTS sent_ledger (recipient TEXT NOT NULL, fingerprint TEXT NOT NULL, at TEXT NOT NULL DEFAULT (datetime('now')))",
);
/** Kurzer, stabiler Fingerabdruck des normalisierten Textes (djb2, kein Crypto-Import nötig). */
function fingerprint(text: string): string {
  const s = normText(text).toLowerCase();
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `${h}:${s.length}`;
}
/** True, wenn dieselbe Nachricht in den letzten 24 h schon an diese Person ging. */
function schonGesendet(empfaenger: string, text: string): boolean {
  const row = db
    .prepare(
      "SELECT 1 AS x FROM sent_ledger WHERE recipient = ? AND fingerprint = ? AND at >= datetime('now','-1 day') LIMIT 1",
    )
    .get(empfaenger.trim().toLowerCase(), fingerprint(text)) as { x: number } | undefined;
  return !!row;
}
function ledgerEintragen(empfaenger: string, text: string) {
  db.prepare("INSERT INTO sent_ledger (recipient, fingerprint) VALUES (?, ?)").run(
    empfaenger.trim().toLowerCase(),
    fingerprint(text),
  );
}

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
  // Like-Button des Haupt-Posts. aria-pressed wechselt false→true = unser Beleg. Read-only
  // verifiziert 2026-07-17: Label "Mit „Gefällt mir" reagieren", aria-pressed anfangs false.
  likeBtn: "button[aria-label*='efällt mir'][aria-pressed], button[aria-label='Like'][aria-pressed]",
  // EIGENEN Beitrag posten (Browser-Weg, ohne API). Der "Beitrag starten"-Knopf im Feed öffnet
  // den Post-Dialog. Selektoren defensiv mit Fallbacks – NICHT automatisiert testbar (realer
  // öffentlicher Post), beim ersten echten Lauf engine.log prüfen.
  startPostBtn:
    "button.share-box-feed-entry__trigger, .share-box-feed-entry__trigger, button[aria-label*='Beitrag'], button:has-text('Beitrag starten'), button:has-text('Start a post')",
  postEditor:
    "div[role='dialog'] .ql-editor, .share-creation-state__text-editor .ql-editor, div[role='textbox'][contenteditable='true']",
  postSubmit:
    "div[role='dialog'] .share-actions__primary-action, div[role='dialog'] button.share-actions__primary-action, div[role='dialog'] button:has-text('Posten'), div[role='dialog'] button:has-text('Post')",
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

/** True, wenn diese Person in den letzten 24 h schon eine Vernetzungsanfrage bekam. */
function schonVernetzt(profileUrl: string): boolean {
  const row = db
    .prepare(
      "SELECT 1 AS x FROM actions WHERE type='connect' AND target=? AND created_at >= datetime('now','-1 day') LIMIT 1",
    )
    .get(profileUrl) as { x: number } | undefined;
  return !!row;
}

/** Eine Vernetzungsanfrage mit optionaler personalisierter Notiz. */
export async function sendConnectionRequest(profileUrl: string, note?: string) {
  try {
    // DOPPEL-VERNETZUNGS-SPERRE: greift auch, wenn versehentlich zwei Engines laufen (z.B. alte
    // Version aus einem DMG neben der installierten App). Dann bekommt dieselbe Person NIE zweimal
    // eine Anfrage. Vor dem Governor geprüft → kostet kein Kontingent, keine Falschmeldung.
    if (schonVernetzt(profileUrl)) {
      console.info(`[outreach] Vernetzung übersprungen (${profileUrl}) – schon in den letzten 24h angefragt.`);
      return;
    }
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
/**
 * Findet das Konversations-FENSTER (Overlay-Bubble oder Haupt-Thread), das dem erwarteten
 * Empfänger gehört – über den Namen im Fenster-Kopf. Gibt es NICHT genau EIN Fenster mit diesem
 * Namen, wird null zurückgegeben (mehrdeutig/nicht gefunden → der Aufrufer bricht ab).
 *
 * WARUM (kritischer Vorfall 2026-07-23): `.last()` traf das falsche der mehreren offenen
 * Chat-Fenster → eine Nachricht ("Hey Jack …") ging an die FALSCHE Person. Der Inhalts-Abgleich
 * prüfte nur den Text, nie den Empfänger. Diese Zuordnung schließt die Lücke.
 */
async function fensterFuerEmpfaenger(page: import("playwright").Page, empfaenger: string) {
  const ziel = empfaenger.trim().toLowerCase();
  if (!ziel) return null;
  const fenster = page
    .locator(`${SEL.bubble}, .scaffold-layout__detail, .msg-thread`)
    .filter({ has: page.locator(SEL.messageBox) });
  const anzahl = await fenster.count();
  const treffer: import("playwright").Locator[] = [];
  for (let i = 0; i < anzahl; i++) {
    const f = fenster.nth(i);
    // Kopf/Titel des Fensters lesen (dort steht der Name); Fallback: Anfang des Fenstertexts.
    const kopf = (await f
      .locator("[class*='bubble-header'], [class*='overlay-bubble-header'], [class*='entity-lockup__title'], h2, a[href*='/in/']")
      .first()
      .innerText()
      .catch(() => "")) || (await f.innerText().catch(() => "")).slice(0, 150);
    if (kopf.toLowerCase().includes(ziel)) treffer.push(f);
  }
  return treffer.length === 1 ? treffer[0] : null; // eindeutig ODER gar nicht (fail-safe)
}

async function tippenUndSenden(page: import("playwright").Page, text: string, empfaenger: string) {
  // SICHERHEITSSCHLEIFE 1: kein Kauderwelsch/Fehler-Text. Im Zweifel gar nicht senden.
  const plaus = istPlausibleNachricht(text);
  if (!plaus.ok) throw new UnsichereNachricht(plaus.grund ?? "unplausibel");

  await page.waitForSelector(SEL.messageBox, { timeout: 15000 });

  /**
   * SICHERHEITSSCHLEIFE 0 (NEU, wichtigste): EMPFÄNGER VERIFIZIEREN. Statt blind `.last()` das
   * Fenster nehmen, das eindeutig dem erwarteten Namen gehört. Ohne eindeutige Zuordnung →
   * ABBRUCH. Lieber eine Nachricht nicht senden als an die falsche Person.
   */
  if (!empfaenger || !empfaenger.trim())
    throw new UnsichereNachricht("Kein Empfängername übergeben – Versand abgebrochen (Schutz vor Fehlleitung)");

  // DOPPEL-VERSAND-SPERRE: identische Nachricht ging kürzlich schon an diese Person → NICHT nochmal.
  if (schonGesendet(empfaenger, text)) {
    console.warn(`[send] Duplikat verhindert – "${empfaenger}" hat diese Nachricht schon bekommen.`);
    throw new DuplikatBlockiert(empfaenger);
  }

  const fenster = await fensterFuerEmpfaenger(page, empfaenger);
  if (!fenster)
    throw new UnsichereNachricht(`Empfänger-Fenster für "${empfaenger}" nicht eindeutig gefunden – Versand abgebrochen (Schutz vor Fehlleitung)`);

  // AB HIER ist alles auf GENAU DIESES Fenster gescopt (Eingabefeld, Senden-Knopf, Prüfungen).
  const box = fenster.locator(SEL.messageBox).last();

  const sollNorm = normText(text);

  /**
   * SICHERHEITSSCHLEIFE 2 – der eigentliche Fix für "Entwurf richtig, aber auf LinkedIn kommt
   * was anderes raus": Zeichen-für-Zeichen-Tippen (el.type) hat LinkedIns Rich-Text-Editor
   * verstümmelt (Zeichen verschluckt/vertauscht → Kauderwelsch). Jetzt: Feld KOMPLETT leeren,
   * Text in EINEM Rutsch einfügen, dann ZURÜCKLESEN und exakt mit dem Soll vergleichen. Erst
   * wenn Ist == Soll, wird gesendet. Bis zu 2 Versuche, sonst Abbruch (kein Versand).
   */
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  let feldOk = false;
  for (let versuch = 1; versuch <= 2 && !feldOk; versuch++) {
    await box.click();
    await humanDelay(200, 500);
    await page.keyboard.press(`${mod}+A`);
    await page.keyboard.press("Backspace");
    await humanDelay(150, 400);
    await box.focus();
    await page.keyboard.insertText(text); // zuverlässig, kein Editor-Race
    await humanDelay(400, 900);
    const ist = normText(await box.evaluate((el) => el.textContent || "").catch(() => ""));
    if (ist === sollNorm) feldOk = true;
    else console.warn(`[send] Feld-Inhalt weicht ab (Versuch ${versuch}) – steht: "${ist.slice(0, 45)}"`);
  }
  if (!feldOk) throw new UnsichereNachricht("Feld-Inhalt stimmte nach 2 Versuchen nicht mit dem Entwurf überein");

  const sendBtn = fenster.locator(SEL.sendButton).last();
  if (await sendBtn.isEnabled().catch(() => false)) await sendBtn.click();
  else await page.keyboard.press("Enter"); // Fallback

  /**
   * BELEG = Feld leer. Das ist die AUTORITÄT für "gesendet": LinkedIn leert das Eingabefeld
   * nur bei erfolgreichem Senden. Steht der Text noch drin → NICHT gesendet → werfen (der
   * Aufrufer darf gefahrlos neu versuchen, kein Duplikat).
   */
  let geleert = false;
  for (let i = 0; i < 3 && !geleert; i++) {
    geleert = await box.evaluate((el) => (el.textContent || "").trim().length === 0).catch(() => false);
    if (!geleert) await humanDelay(1000, 1800);
  }
  if (!geleert) throw new Error("Senden nicht bestätigt: Eingabefeld ist noch gefüllt (nicht gesendet)");

  // BESTÄTIGT gesendet → ins Ledger, damit derselbe Text nie ein zweites Mal an diese Person geht.
  ledgerEintragen(empfaenger, text);

  /**
   * Verlaufs-Prüfung nur noch als WARNUNG, nicht als Abbruch. Früher wurde hier geworfen,
   * wenn der Text nicht im Verlauf gefunden wurde – aber da das Feld schon geleert war (=
   * gesendet), führte das Werfen zu einem ERNEUTEN Versand = Duplikat. Genau das war der
   * Doppel-Nachrichten-Bug. Feld-leer zählt, die Verlaufssuche ist nur noch Zusatz-Info.
   */
  const marker = normText(text).slice(0, 40);
  const imVerlauf = await fenster.locator(SEL.threadItem).filter({ hasText: marker }).count().catch(() => 0);
  if (imVerlauf === 0)
    console.warn("[send] Feld geleert (= gesendet), aber Text nicht im Verlauf gefunden – Verlaufsprüfung unsicher, kein erneuter Versand.");
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

      // Erwarteten Empfänger aus dem CRM holen → Empfänger-Verifikation im tippenUndSenden.
      const c = db.prepare("SELECT full_name FROM contacts WHERE profile_url = ?").get(profileUrl) as { full_name?: string } | undefined;
      const empfaenger = (c?.full_name ?? "").trim();

      // Wirft, wenn der Versand nicht nachweisbar ODER der Empfänger nicht eindeutig ist.
      await tippenUndSenden(page, text, empfaenger);

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
export async function sendThreadReply(threadUrl: string, text: string, empfaenger: string) {
  return governor.execute("message", threadUrl, async () => {
    const page = await newPage();
    await page.goto(threadUrl, { waitUntil: "domcontentloaded" });
    if (await guardAgainstCheckpoint(page)) throw new GovernorBlocked("Checkpoint");
    await humanDelay(1200, 2500);
    await tippenUndSenden(page, text, empfaenger); // Empfänger-Verifikation: nie ans falsche Fenster
  });
}

/**
 * Post autonom LIKEN (governor-gated, ActionType 'like'). Ein Like ist harmlos (kann nicht
 * peinlich werden) → darf ohne Freigabe. Trotzdem über den Governor: Masse-Liken ist ein
 * Bot-Signal, der 20-75s-Abstand + Cap verhindern das. Beleg: aria-pressed wechselt auf true.
 * Wirft still (kein Drama, wenn ein Like mal nicht klappt).
 */
export async function likePost(postUrl: string): Promise<boolean> {
  try {
    return await governor.execute("like", postUrl, async () => {
      const page = await newPage();
      await page.goto(postUrl, { waitUntil: "domcontentloaded" });
      if (await guardAgainstCheckpoint(page)) throw new GovernorBlocked("Checkpoint");
      await humanDelay(1500, 3000);
      const btn = page.locator(SEL.likeBtn).first();
      if ((await btn.count()) === 0) throw new Error("Like-Button nicht gefunden");
      if ((await btn.getAttribute("aria-pressed")) === "true") return true; // schon geliked
      await btn.evaluate((el) => (el as HTMLElement).click());
      await humanDelay(800, 1600);
      const jetzt = await page.locator(SEL.likeBtn).first().getAttribute("aria-pressed").catch(() => null);
      if (jetzt !== "true") throw new Error("Like nicht bestätigt");
      return true;
    });
  } catch (e) {
    if (e instanceof GovernorBlocked) return false; // Limit/Arbeitszeit – kein Drama
    console.info(`[like] übersprungen (${postUrl.slice(0, 50)}): ${(e as Error).message}`);
    return false;
  }
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

/**
 * EIGENEN BEITRAG posten über die BROWSER-SESSION (ohne LinkedIn-API-Schlüssel). Damit funktioniert
 * das Posten für jeden – der offizielle API-Weg (posting.ts) bleibt als Alternative, wenn ein Token
 * da ist. Beitrag ist eigener Inhalt unter eigenem Namen → geringes Ban-Risiko, deshalb NICHT über
 * die connect/message-Caps des Governors (wie beim API-Weg bewusst getrennt), aber mit menschlichem
 * Delay + DOPPEL-POST-SPERRE (dasselbe Ledger wie bei DMs, Schlüssel "__eigener_post__").
 * Beleg für "gepostet": der Post-Dialog schließt sich nach erfolgreichem Klick (Editor verschwindet).
 * HINWEIS: der scharfe Versand ist nicht automatisiert testbar – Selektoren defensiv, beim ersten
 * echten Lauf prüfen (engine.log).
 */
export async function publishPostBrowser(body: string): Promise<void> {
  const text = normText(body);
  if (text.length < 20) throw new UnsichereNachricht("Post-Text zu kurz – nicht gepostet");
  if (schonGesendet("__eigener_post__", text)) {
    console.warn("[post] Duplikat verhindert – identischer Beitrag ging kürzlich schon raus.");
    throw new DuplikatBlockiert("__eigener_post__");
  }

  const page = await newPage();
  await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded" });
  if (await guardAgainstCheckpoint(page)) throw new GovernorBlocked("Checkpoint");
  await humanScroll(page); // erst schauen wie ein Mensch
  await humanDelay(1500, 3000);

  const start = page.locator(SEL.startPostBtn).first();
  if ((await start.count()) === 0) throw new Error("Beitrag-starten-Knopf nicht gefunden (Selektor prüfen)");
  await start.evaluate((el) => (el as HTMLElement).click());
  await humanDelay(1500, 3000);

  const editor = page.locator(SEL.postEditor).first();
  await editor.waitFor({ timeout: 12000 });
  await editor.click();
  await humanDelay(300, 700);
  await page.keyboard.insertText(body); // Original mit Absätzen, nicht normalisiert
  await humanDelay(800, 1800);

  // Rücklesen: steht unser Text wirklich im Editor? Sonst NICHT posten.
  const ist = normText(await editor.evaluate((el) => (el as HTMLElement).innerText || "").catch(() => ""));
  if (!ist.includes(text.slice(0, 40)))
    throw new UnsichereNachricht("Post-Editor-Inhalt stimmt nicht mit dem Entwurf überein – nicht gepostet");

  const submit = page.locator(SEL.postSubmit).first();
  if ((await submit.count()) === 0) throw new Error("Posten-Knopf nicht gefunden (Selektor prüfen)");
  if (!(await submit.isEnabled().catch(() => false))) throw new Error("Posten-Knopf nicht aktiv");
  await submit.click();

  // BELEG: der Dialog/Editor schließt sich nach erfolgreichem Posten.
  let zu = false;
  for (let i = 0; i < 4 && !zu; i++) {
    await humanDelay(1000, 1800);
    zu = (await page.locator(SEL.postEditor).count().catch(() => 1)) === 0;
  }
  if (!zu) throw new Error("Posten nicht bestätigt: Editor ist noch offen (vermutlich nicht gepostet)");

  ledgerEintragen("__eigener_post__", text);
  console.info("[post] Beitrag über Browser gepostet.");
}
