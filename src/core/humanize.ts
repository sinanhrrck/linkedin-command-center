import type { Page } from "playwright";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const randInt = (min: number, max: number) =>
  Math.floor(Math.random() * (max - min + 1)) + min;

/** Zufällige Pause in einem Bereich – gegen robotisch-gleichmäßige Muster. */
export const humanDelay = (min: number, max: number) => sleep(randInt(min, max));

/**
 * Tippt Text mit variabler Verzögerung pro Zeichen statt page.fill().
 * page.fill() setzt Text instant und sieht für LinkedIn nicht menschlich aus.
 */
export async function humanType(page: Page, selector: string, text: string) {
  await humanTypeInto(page.locator(selector), text);
}

/**
 * Wie humanType, aber auf einem bereits eingegrenzten Element. Nötig, weil LinkedIn beim
 * Laden ALLE zuletzt offenen Chat-Fenster wiederherstellt: dann gibt es mehrere
 * `.msg-form__contenteditable` auf der Seite und ein Selektor-String ist mehrdeutig
 * (Playwright wirft "strict mode violation"). Der Aufrufer entscheidet mit .last() o.ä.,
 * welches Feld gemeint ist.
 */
export async function humanTypeInto(el: import("playwright").Locator, text: string) {
  await el.click();
  await humanDelay(200, 600);
  for (const ch of text) {
    await el.type(ch, { delay: randInt(40, 140) });
    if (Math.random() < 0.04) await humanDelay(300, 900); // gelegentliches "Nachdenken"
  }
}

/** Etwas scrollen, um Nutzung glaubhaft zu machen. */
export async function humanScroll(page: Page) {
  const steps = randInt(2, 5);
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, randInt(200, 600));
    await humanDelay(400, 1200);
  }
}
