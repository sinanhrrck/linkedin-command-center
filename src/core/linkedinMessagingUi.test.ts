import assert from "node:assert/strict";
import test from "node:test";
import {
  MESSAGE_BOX_SELECTOR,
  MESSAGE_BOX_SELECTORS,
  MESSAGE_BOX_VISIBLE_SELECTOR,
  SEND_BUTTON_SELECTOR,
  SEND_BUTTON_SELECTORS,
  SEND_BUTTON_VISIBLE_SELECTOR,
} from "./linkedinMessagingUi.js";

test("Nachrichtenfeld erkennt altes und rollenbasiertes LinkedIn-Layout", () => {
  assert.ok(MESSAGE_BOX_SELECTORS.includes(".msg-form__contenteditable"));
  assert.match(MESSAGE_BOX_SELECTOR, /contenteditable/);
  assert.match(MESSAGE_BOX_SELECTOR, /aria-label/);
  assert.match(MESSAGE_BOX_SELECTOR, /data-placeholder/);
  assert.equal((MESSAGE_BOX_VISIBLE_SELECTOR.match(/:visible/g) ?? []).length, MESSAGE_BOX_SELECTORS.length);
});

test("Senden-Knopf erkennt Klasse, Formular und barrierefreie Beschriftung", () => {
  assert.ok(SEND_BUTTON_SELECTORS.includes(".msg-form__send-button"));
  assert.match(SEND_BUTTON_SELECTOR, /type='submit'/);
  assert.match(SEND_BUTTON_SELECTOR, /Send message/);
  assert.equal((SEND_BUTTON_VISIBLE_SELECTOR.match(/:visible/g) ?? []).length, SEND_BUTTON_SELECTORS.length);
});
