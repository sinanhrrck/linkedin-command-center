import { db } from "../db/index.js";
import { generateText } from "../core/textLlm.js";
import { ARME, armeFuer, gewinnChancen } from "./varianten.js";

/**
 * KI ERFINDET NEUE STILE (2026-09-23): der Varianten-Test verbessert sich selbst.
 *
 * Hat ein Slot einen KLAREN Gewinner (≥ MIN_REIF ausgewertete Versände, ≥ 80 % Chance der Beste),
 * schreibt die KI EINEN Herausforderer, der das Erfolgsprinzip des Gewinners aufgreift und in
 * einem Punkt mutiger ist. Verliert ein KI-Herausforderer mit genug Daten klar (< 5 % Chance),
 * wird er beendet. Höchstens ein aktiver KI-Arm je Slot – sonst verteilen sich die wenigen
 * Versände (~16/Tag) auf zu viele Stile und nichts wird je belastbar.
 *
 * Die erfundene Anweisung steuert nur den STIL. Jeder daraus erzeugte Text läuft weiterhin durch
 * Ausgangsprüfung, Ausbildungs-Check und – je nach Automatik – durch Sinans Freigabe.
 */

export const MIN_REIF = 30;
export const GEWINNER_CHANCE = 0.8;
export const VERLIERER_CHANCE = 0.05;
export const MIN_REIF_BEENDEN = 40;

const SLOT_TITEL: Record<string, string> = {
  first: "Erstnachricht nach angenommener Vernetzung", "followup:wert": "Nachfassung mit Angebot",
  "followup:abschied": "letzte Nachfassung (Schlussstrich, keine Frage)", reaktivierung: "erste Nachricht an eine stille, bestehende Verbindung",
};

export type StilAenderung = { slot: string; art: "neu" | "beendet"; titel: string };

export async function kiNeueStile(rng: () => number = Math.random): Promise<StilAenderung[]> {
  const aenderungen: StilAenderung[] = [];
  for (const slot of Object.keys(ARME)) {
    const chancen = gewinnChancen(slot, 2000, rng);
    const kiAktiv = db.prepare("SELECT key, titel FROM variant_arme_ki WHERE slot=? AND status='aktiv'").all(slot) as { key: string; titel: string }[];

    // 1. Klare Verlierer unter den KI-Armen beenden.
    for (const k of kiAktiv) {
      const c = chancen.find((x) => x.arm === k.key);
      if (c && c.reif >= MIN_REIF_BEENDEN && c.chance < VERLIERER_CHANCE) {
        db.prepare("UPDATE variant_arme_ki SET status='beendet', beendet_at=datetime('now'), grund=? WHERE key=?")
          .run(`${c.positiv} positive aus ${c.reif}, Chance der Beste ${Math.round(c.chance * 100)} %`, k.key);
        aenderungen.push({ slot, art: "beendet", titel: k.titel });
      }
    }
    if ((db.prepare("SELECT COUNT(*) n FROM variant_arme_ki WHERE slot=? AND status='aktiv'").get(slot) as { n: number }).n > 0) continue;

    // 2. Klaren Gewinner suchen – ohne ihn gibt es nichts, worauf ein Herausforderer aufbauen kann.
    const gewinner = chancen.filter((x) => x.reif >= MIN_REIF).sort((a, b) => b.chance - a.chance)[0];
    if (!gewinner || gewinner.chance < GEWINNER_CHANCE) continue;
    const arme = armeFuer(slot);
    const g = arme.find((a) => a.key === gewinner.arm);
    if (!g) continue;
    const andere = chancen.filter((x) => x.arm !== gewinner.arm).map((x) => {
      const a = arme.find((y) => y.key === x.arm);
      return `- ${a?.titel ?? x.arm}: ${x.positiv} positive Antworten aus ${x.reif} (Anweisung: ${a?.anweisung ?? "?"})`;
    }).join("\n");

    const prompt = `Du optimierst LinkedIn-Nachrichten per A/B-Test. Nachrichtenart: ${SLOT_TITEL[slot] ?? slot}.
GEWINNER: "${g.titel}" – ${gewinner.positiv} positive Antworten aus ${gewinner.reif} (Chance der Beste: ${Math.round(gewinner.chance * 100)} %).
Anweisung des Gewinners: ${g.anweisung}
ANDERE STILE:
${andere}

Erfinde GENAU EINEN neuen Stil (Herausforderer), der das Erfolgsprinzip des Gewinners behält und in EINEM Punkt mutiger oder klarer ist.
Die Anweisung beschreibt nur Aufbau und Ton für die KI, die später die Nachricht schreibt: höchstens 2 Sätze, keine Beispielnachricht, keine Links, keine Zahlen- oder Gehaltsversprechen, nichts, was Emojis, mehrere Fragen oder Druck verlangt.

Antworte AUSSCHLIESSLICH mit JSON: {"titel":"höchstens 5 Wörter","anweisung":"…"}`;
    const roh = await generateText(prompt, 600);
    const s = roh.indexOf("{"), e = roh.lastIndexOf("}");
    if (s < 0 || e <= s) continue;
    let x: { titel?: unknown; anweisung?: unknown };
    try { x = JSON.parse(roh.slice(s, e + 1)); } catch { continue; }
    const titel = String(x.titel ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
    const anweisung = String(x.anweisung ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
    if (!titel || anweisung.length < 20 || /https?:\/\//i.test(anweisung)) continue;
    db.prepare("INSERT INTO variant_arme_ki(slot,key,titel,anweisung,vorbild_arm) VALUES(?,?,?,?,?)")
      .run(slot, `ki-${slot.replace(/[^a-z]/g, "")}-${Date.now().toString(36)}`, titel, anweisung, gewinner.arm);
    aenderungen.push({ slot, art: "neu", titel });
  }
  if (aenderungen.length) console.info(`[kistile] ${aenderungen.map((a) => `${a.art}: ${a.titel} (${a.slot})`).join("; ")}`);
  return aenderungen;
}
