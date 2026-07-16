import { EventEmitter } from "node:events";

/**
 * Interner Event-Bus. Entkoppelt Module (z.B. drafts → telegram) ohne Import-Zyklen.
 * Events:
 *   "draft:new"   (draft)              – ein neuer Entwurf wurde erzeugt (Push nach Telegram).
 *   "lead:booked" ({participant,...})  – Autopilot hat einen Termin klargemacht (Handoff).
 *   "action:done" ({type, target})     – eine Sendeaktion lief erfolgreich durch (aus
 *                                        governor.record, dem einzigen Choke-Point → keine
 *                                        Aktion kann unbemerkt bleiben).
 */
export const events = new EventEmitter();
