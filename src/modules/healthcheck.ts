import { newPage, guardAgainstCheckpoint } from "../core/session.js";
import { humanDelay } from "../core/humanize.js";
import { setState, getState } from "../db/index.js";
import { events } from "../core/events.js";

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
// Kritische Selektoren des SENDE-Wegs (gespiegelt aus inbox.ts/outreach.ts – bei Änderung dort auch hier).
const SEL = {
  listItem: "li.msg-conversation-listitem",
  messageBox: ".msg-form__contenteditable",
  sendButton: ".msg-form__send-button",
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

    r.inbox = (await page.locator(SEL.listItem).count().catch(() => 0)) > 0;
    if (!r.inbox) {
      r.grund = "Postfach-Liste nicht lesbar (Selektor listItem greift nicht – LinkedIn-UI geändert?).";
      finalisieren(r);
      return r;
    }

    // Ersten Thread öffnen und die Sende-Elemente prüfen (rein lesend, kein Versand).
    await page.locator(SEL.listItem).first().click().catch(() => {});
    await humanDelay(1800, 3000);
    r.messageBox = (await page.locator(SEL.messageBox).count().catch(() => 0)) > 0;
    r.sendButton = (await page.locator(SEL.sendButton).count().catch(() => 0)) > 0;
    // threadTitle nur informativ (Empfänger-Absicherung hängt daran).
    const titelOk = (await page.locator(SEL.threadTitle).count().catch(() => 0)) > 0;

    if (!r.messageBox) r.grund = "Eingabefeld nicht gefunden (messageBox-Selektor greift nicht).";
    else if (!r.sendButton) r.grund = "Senden-Knopf nicht gefunden (sendButton-Selektor greift nicht).";
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
