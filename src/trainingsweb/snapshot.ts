/**
 * Momentaufnahme der Live-Daten für die Trainings-Website (src/trainingsweb/kern.ts). Liest nur.
 * Gleiche Bausteine wie agentRunner (gespraechsKontext, angebotsWahl, Vertriebswissen) und
 * createFirstMessageDraft (Zielgruppen-Aufbau, Stil-Varianten, Lernregeln).
 */
import { config } from "../config.js";
import { promptKontext } from "../context.js";
import { ausrichtungsBlock } from "../modules/ausrichtung.js";
import { angebotsWahl, ctaAnweisung, erlaubteLinks } from "../modules/angebot.js";
import { getProfil } from "../profil.js";
import { trainingsRegelnBlock } from "../modules/trainingsRegeln.js";
import { vertriebswissen } from "../core/vertriebswissen.js";
import { learningGuidance } from "../modules/learning.js";
import { alleZielgruppen } from "../modules/zielgruppen.js";
import { armeFuer } from "../modules/varianten.js";
import { STANDARD_ERSTNACHRICHT } from "../modules/erstnachrichtPrompt.js";
import { CTA_PLATZHALTER, type TrainingsSnapshot } from "./kern.js";

export function baueSnapshot(jetzt = new Date()): TrainingsSnapshot {
  const p = getProfil();
  const mitPlatzhalter = (text: string) => {
    const cta = ctaAnweisung(jetzt, p);
    if (!text.includes(cta)) throw new Error("Termin-Zeile im Angebotsblock nicht gefunden – angebotsWahl hat sich geändert.");
    return text.replace(cta, CTA_PLATZHALTER);
  };
  // Live bekommen Kontakte die Erstnachricht ihrer Zielgruppe. Für das Training: die erste aktive.
  const zg = alleZielgruppen().find((z) => z.aktiv) ?? null;
  const eigene = zg?.erstnachricht?.trim() || "";

  return {
    version: 2,
    erzeugt: jetzt.toISOString(),
    quelle: process.env.NEXTLEAD_SERVER === "1" ? "server" : "lokal",
    modell: config.llm.model,
    gespraech: {
      persona: {
        standard: promptKontext() + ausrichtungsBlock("standard") + trainingsRegelnBlock("gespraech"),
        aec: promptKontext() + ausrichtungsBlock("aec") + trainingsRegelnBlock("gespraech"),
      },
      angebot: {
        standard: mitPlatzhalter(angebotsWahl(jetzt, p)),
        aec: mitPlatzhalter(angebotsWahl(jetzt, p, { nurAec: true })),
      },
      buchungslink: p.buchungslink?.trim() || "",
      wissen: vertriebswissen("gespraech") || "",
    },
    erstnachricht: {
      gruppe: zg?.name ?? null,
      aufbau: eigene || STANDARD_ERSTNACHRICHT,
      eigeneAnleitung: !!eigene,
      varianten: armeFuer("first").map((a) => ({ slot: "first", arm: a.key, anweisung: a.anweisung })),
      learning: learningGuidance(null),
      regeln: trainingsRegelnBlock("erstnachricht"),
      erlaubteLinks: erlaubteLinks(),
    },
  };
}
