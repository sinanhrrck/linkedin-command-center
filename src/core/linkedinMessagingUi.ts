/**
 * Stabile, gemeinsam genutzte Selektoren fuer LinkedIns Nachrichten-Editor.
 *
 * LinkedIn liefert nicht jedem Konto dasselbe Messaging-Layout (A/B-Tests, Sprache,
 * gestaffelte Rollouts). Deshalb darf weder der echte Versand noch der Selbst-Check
 * nur von einer einzigen, internen CSS-Klasse abhaengen. Die Fallbacks bleiben bewusst
 * auf editierbare Textboxen mit Nachrichten-Bezug beschraenkt, damit niemals ein Such-
 * oder Kommentar-Feld als Nachrichtenfeld erkannt wird.
 */
export const MESSAGE_BOX_SELECTORS = [
  ".msg-form__contenteditable",
  ".msg-form__msg-content-container [contenteditable='true']",
  "form.msg-form [role='textbox'][contenteditable='true']",
  "[role='textbox'][contenteditable='true'][aria-label*='Nachricht' i]",
  "[role='textbox'][contenteditable='true'][aria-label*='message' i]",
  "[role='textbox'][contenteditable='true'][data-placeholder*='Nachricht' i]",
  "[role='textbox'][contenteditable='true'][data-placeholder*='message' i]",
] as const;

export const SEND_BUTTON_SELECTORS = [
  ".msg-form__send-button",
  "form.msg-form button[type='submit']",
  "button[aria-label*='Nachricht senden' i]",
  "button[aria-label*='Send message' i]",
] as const;

export const MESSAGE_BOX_SELECTOR = MESSAGE_BOX_SELECTORS.join(", ");
export const SEND_BUTTON_SELECTOR = SEND_BUTTON_SELECTORS.join(", ");
export const MESSAGE_BOX_VISIBLE_SELECTOR = MESSAGE_BOX_SELECTORS.map((selector) => `${selector}:visible`).join(", ");
export const SEND_BUTTON_VISIBLE_SELECTOR = SEND_BUTTON_SELECTORS.map((selector) => `${selector}:visible`).join(", ");
