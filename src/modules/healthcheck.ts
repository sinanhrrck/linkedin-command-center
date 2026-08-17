import { newPage, guardAgainstCheckpoint } from "../core/session.js";
import { humanDelay } from "../core/humanize.js";
import { setState, getState } from "../db/index.js";
import { events } from "../core/events.js";
import { MESSAGE_BOX_VISIBLE_SELECTOR, SEND_BUTTON_VISIBLE_SELECTOR } from "../core/linkedinMessagingUi.js";

/**
 * SELBST-CHECK gegen STILLE Fehler – der wichtigste Verlässlichkeits-Baustein.
 *
 * Der Kern der bisherigen Probleme: LinkedIn ändert die UI, ein Selektor greift nicht mehr, und
 * der Bot macht still weiter (verbucht Fehl-Sends als „gesendet", findet keine Threads, …). Dieser
 * Check testet regelmäßig, ob der SENDE-WEG technisch funktioniert:
 *   1. eingeloggt (kein Checkpoint)?
 *   2. Postfach-Liste lesbar?
 *   3. In einem Thread: Eingabefeld + Senden-Knopf vorhanden?
 *
 * Bricht etwas, wird der Sende-Weg als DEFEKT markiert (state `send_health`=„broken"). Der Governor
 * blockiert dann Nachrichten (statt Mist zu bauen) UND es geht eine Telegram-/Dashboard-Meldung raus.
 * Rein LESEND, kein Governor, keine Nachricht – wie acceptance.ts. Selektoren werden hier NUR geprüft,
 * die echten Werte leben weiter in inbox.ts/outreach.ts; hier gespiegelt, um sie zu testen.
 */

const MESSAGING_URL = "https://www.linkedin.com/messaging/";
// Kritische Selektoren des Sendewegs. Sie werden mit dem echten Versand geteilt, damit
// Selbsttest und Versand nach einer LinkedIn-Aenderung nie unterschiedliche Wahrheiten haben.
const SEL = {
  listItem: "li.msg-conversation-listitem",
  messageBox: MESSAGE_BOX_VISIBLE_SELECTOR,
  sendButton: SEND_BUTTON_VISIBLE_SELECTOR,
  threadTitle: "h2.msg-entity-lockup__entity-title",
};

export type HealthReport = {
  ts: string;
  login: boolean;
  inbox: boolean;
  messageBox: boolean;
  sendButton: boolean;
  ok: boolean;
  grund: string | null;
};

/** Führt den Selbst-Check aus, speichert das Ergebnis und meldet Defekte. Gibt den Report zurück. */
export async function selbstCheck(): Promise<HealthReport> {
  const r: HealthReport = { ts: new Date().toISOString(), login: true, inbox: false, messageBox: false, sendButton: false, ok: false, grund: null };
  try {
    const page = await newPage();
    await page.goto(MESSAGING_URL, { waitUntil: "domcontentloaded" });
    await humanDelay(2500, 4000);

    if (await guardAgainstCheckpoint(page)) {
      r.login = false;
      r.grund = "Nicht eingeloggt / Checkpoint – bitte einmal manuell anmelden (npm run login).";
      finalisieren(r);
      return r;
    }

    // LinkedIn liefert nach `domcontentloaded` oft erst Shell/Navi und baut die Gesprächsliste
    // einige Sekunden später auf. Der frühere einmalige `count()` nach 2,5–4 s erklärte einen
    // langsamen Start fälschlich zum Selektorbruch und legte dadurch den gesamten Versand lahm.
    // Auf das echte Element warten; bei einem temporären Ladefehler genau einmal sauber neu laden.
    const warteAufInbox = async (timeout: number) =>
      page.locator(SEL.listItem).first().waitFor({ state: "visible", timeout }).then(() => true).catch(() => false);
    r.inbox = await warteAufInbox(15_000);
    if (!r.inbox) {
      await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
      await humanDelay(1500, 2500);
      if (await guardAgainstCheckpoint(page)) {
        r.login = false;
        r.grund = "Nicht eingeloggt / Checkpoint – bitte einmal manuell anmelden (npm run login).";
        finalisieren(r);
        return r;
      }
      r.inbox = await warteAufInbox(15_000);
    }
    if (!r.inbox) {
      r.grund = "Postfach-Liste auch nach erneutem Laden nicht lesbar (LinkedIn/Netz oder Selektor).";
      finalisieren(r);
      return r;
    }

    /**
     * Nicht blind nur den ersten Thread testen: Oben koennen LinkedIn-Systemmeldungen,
     * gesperrte Konten oder nicht beantwortbare Unterhaltungen stehen. Der alte Check
     * erklaerte dann den KOMPLETTEN Versand faelschlich fuer defekt. Wir pruefen bis zu
     * sechs vorhandene Threads und akzeptieren den ersten mit sichtbarem Nachrichtenfeld.
     * Rein lesend: Es wird weder Text eingegeben noch gesendet.
     */
    const threads = page.locator(SEL.listItem);
    const pruefAnzahl = Math.min(await threads.count().catch(() => 0), 6);
    let titelOk = false;
    for (let i = 0; i < pruefAnzahl; i++) {
      const thread = threads.nth(i);
      if (!(await thread.click().then(() => true).catch(() => false))) continue;
      await humanDelay(900, 1600);

      // Nur der Haupt-Thread zaehlt. Eventuell offene Overlay-Chats duerfen den Test
      // nicht versehentlich gruen machen.
      const hauptbereich = page.locator("main").first();
      const box = hauptbereich.locator(SEL.messageBox);
      const sichtbar = await box.first().waitFor({ state: "visible", timeout: 4_000 }).then(() => true).catch(() => false);
      if (!sichtbar) continue;

      r.messageBox = true;
      r.sendButton = (await hauptbereich.locator(SEL.sendButton).count().catch(() => 0)) > 0;
      titelOk = (await hauptbereich.locator(SEL.threadTitle).count().catch(() => 0)) > 0;
      break;
    }

    if (!r.messageBox) r.grund = "Kein beantwortbarer Chat mit sichtbarem Eingabefeld gefunden (mehrere Layout-Varianten geprüft).";
    else if (!r.sendButton) r.grund = "Senden-Knopf nicht gefunden (mehrere Layout-Varianten geprüft).";
    else if (!titelOk) r.grund = "Thread-Titel nicht lesbar (Empfänger-Absicherung eingeschränkt).";
    finalisieren(r);
    return r;
  } catch (e) {
    r.grund = `Selbst-Check-Fehler: ${(e as Error)?.message?.slice(0, 80)}`;
    finalisieren(r);
    return r;
  }
}

/** Ergebnis bewerten, speichern, bei Zustandswechsel melden. */
function finalisieren(r: HealthReport): void {
  // „ok" = der Sende-Weg funktioniert komplett. threadTitle ist nur Zusatz, blockiert nicht.
  r.ok = r.login && r.inbox && r.messageBox && r.sendButton;

  const vorher = getState("send_health"); // "ok" | "broken" | undefined
  setState("send_health", r.ok ? "ok" : "broken");
  setState("send_health_grund", r.grund ?? "");
  setState("send_health_ts", r.ts);

  // Nur bei ZUSTANDSWECHSEL melden (nicht bei jedem Lauf spammen).
  if (!r.ok && vorher !== "broken") {
    console.error(`[healthcheck] ⚠ Sende-Weg DEFEKT: ${r.grund}`);
    events.emit("health:broken", { grund: r.grund ?? "unbekannt" });
  } else if (r.ok && vorher === "broken") {
    console.info("[healthcheck] ✅ Sende-Weg wieder in Ordnung.");
    events.emit("health:ok", {});
  }
}

/** True, wenn der Selbst-Check den Sende-Weg als defekt markiert hat (Governor liest das). */
export function sendWegDefekt(): boolean {
  return getState("send_health") === "broken";
}
