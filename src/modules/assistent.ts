import { db, getMode, getAgentMode } from "../db/index.js";
import { generateText } from "../core/textLlm.js";
import { governor } from "../core/safetyGovernor.js";
import { leseStand } from "../core/leseBudget.js";
import { openJobFailures } from "../core/jobReliability.js";
import { warteschlange } from "./warteschlange.js";
import { stillstandGrund } from "./engineWatch.js";
import { followupPlan } from "./playbook.js";
import { autoFreigabeStand } from "./freigabe.js";
import { variantenStatistik } from "./varianten.js";
import { funnelReport } from "./funnel.js";
import { getProfil } from "../profil.js";
import { leadMagnete } from "./angebot.js";

/**
 * KI-ASSISTENT IM COCKPIT (2026-09-23, Sinan: „ein KI-Bot unten rechts, der alles über das Tool weiß“).
 *
 * Zwei Wissensquellen, bewusst getrennt:
 *  1. HANDBUCH – was das Tool kann und wo man was einstellt, in Alltagssprache (kein Entwickler-
 *     wissen wie Tabellennamen – das würde die Antworten für Laien unverständlich machen).
 *  2. LAGE – eine frische Momentaufnahme bei JEDER Frage (Warteschlange, Stillstandsgrund,
 *     Limits, Entwürfe, Angebot, Nachfass-Plan, Varianten, Funnel). Dieselben Funktionen, die das
 *     Cockpit anzeigt – der Assistent kann also nichts anderes behaupten, als dort steht.
 *
 * Rein lesend: Er führt nichts aus, sondern sagt, wo man klickt. Sendende Aktionen laufen weiter
 * ausschließlich über den Governor.
 */

export const HANDBUCH = `# NextLead – Handbuch
NextLead ist ein LinkedIn-Vertriebsassistent. Er findet passende Leute (vor allem Azubis und Berufseinsteiger aus Banken), vernetzt sich, schreibt Nachrichten und führt Gespräche bis zum Termin. Alles läuft auf einem Heimserver, rund um die Uhr, innerhalb strenger Sicherheitsgrenzen.

## Bereiche im Cockpit (linke Leiste)
- Heute: oben rechts der Bot-Status (sendet / wartet bis … / aus). Darunter bei echten Störungen "Warum steht etwas still" mit Knopf zum Beheben, dann vier Zahlen (Entscheidungen für dich, Nachrichten und Anfragen heute, Warteschlange) und die Liste "Deine Entscheidungen" – wichtigstes zuerst, ein Klick öffnet den Entwurf. Knopf "Alle schnell prüfen": alle offenen Entwürfe als Liste mit Häkchen, mehrere auf einmal genehmigen. Grünes "geprüft" heißt: besteht die automatische Textprüfung. Ganz unten aufklappbar "Was der Bot gerade macht" (Warteschlange je Kanal mit nächsten Kontakten, Jetzt/Danach/Zuletzt erledigt).
- Einzelprüfung eines Entwurfs: Genehmigen (der Bot sendet dann selbst, gedrosselt), Ablehnen (mit Grund, dann schreibt die KI neu), Löschen. Tastenkürzel: A genehmigen, R ablehnen, J/K weiterblättern.
- Kontakte: eine Liste aller Kontakte wie in einem CRM, sortierbar (Kontakt, Status mit Stufe, Score, letzte Berührung, nächster Schritt). Je Kontakt über "Verlauf": Stufe von Hand setzen (nur qualifiziert, Termin, gewonnen, verloren, passt nicht), Aufgaben, Notizen, pausieren.
- Auswertung in vier Reitern: Überblick (Kennzahlen, KI-Wochenanalyse, Funnel "Von der Quelle zum Ergebnis"), Was wirkt (Stil-Test, Lernen aus deinen Entscheidungen), Rechner (Zielweg vom Monatsziel zur nötigen Kontaktzahl), Berichte (Tages-/Wochenbericht, Aktivität).
- Einstellungen: Engine starten/stoppen, Automatik-Stufe, globale Grenzen, "Dein Angebot", "Nachfass-Plan", "Automatische Freigabe", technische Fälle, Lead-Quellen.

## Automatik-Stufen (Einstellungen → Wer entscheidet?)
- Ich prüfe alles: Vernetzen läuft automatisch, jede Nachricht ist ein Entwurf zur Freigabe.
- Erstkontakt automatisch: Erstnachrichten nach angenommener Vernetzung gehen automatisch raus, Antworten bleiben zur Prüfung.
- Gespräche testen: der Gesprächs-Agent denkt mit, sendet aber nicht.
- Gespräche automatisch: der Agent führt Routinegespräche selbst und übergibt wichtige Fälle (Termin, Einwand) an dich.

## Sicherheit (warum der Bot manchmal "nichts tut")
- Tageslimits für Vernetzungen und Nachrichten, Wochenlimit für Vernetzungen, langsamer Start (Warm-up) bei neuem Gerät.
- Arbeitszeitfenster (einstellbar). Sonntags keine Nachrichten, Vernetzen läuft 7 Tage.
- Lese-Budget: LinkedIn zählt, wie viele Profile abgerufen werden. Ist es aufgebraucht, pausiert fast alles bis zum nächsten Morgen. Das ist die Grenze, an der das Konto früher gesperrt wurde. Nicht erhöhen.
- Not-Aus (roter Knopf) stoppt jeden Versand sofort. Sicherheitspause bei Auffälligkeiten (z. B. Checkpoint).
- Annahmequoten-Schutz: bei schlechter Annahmequote weniger Vernetzungsanfragen.
- Doppel-Versand-Sperre: dieselbe Nachricht geht nie zweimal an dieselbe Person.

## Nachrichten
- Erstnachricht nach angenommener Vernetzung: persönlicher Bezug, ein nützlicher Gedanke, eine leichte Frage. Kein Pitch.
- Nachfassen (Einstellungen → Nachfass-Plan): 1 bis 3 Stufen, Tage frei wählbar. Jede Stufe hat einen Zweck (Wert + Angebot, echte Geschichte, locker anknüpfen). Die letzte ist immer ein ehrlicher Schlussstrich, danach nie wieder. Ungeprüfte Nachfassungen verfallen nach 10 Tagen und werden bei Fälligkeit neu geschrieben.
- Jede Nachricht wird vor dem Entwurf geprüft (höchstens eine Frage, kein Emoji, keine Floskel, richtiger Name, kein erfundener Link). Fällt sie durch, schreibt die KI einmal neu, sonst entsteht kein Entwurf.
- Ausbildungsstand: "Bankkaufmann bei X" gilt als fertig, nicht als Azubi. Beim Vernetzen liest der Bot Rolle, Firma und einen Auszug aus "Info" mit, das ist aktueller als die Headline.

## Angebot (Einstellungen → Dein Angebot)
- Kostenlose Einstiegsangebote (Lead Magnets), je passend zu Karriere- oder Geldfragen. Der Bot bietet sie in Nachfassungen und im Gespräch an, passend zum Signal der Person. Nur aktive Angebote werden genutzt.
- "KI-Vorschläge holen": drei neue Angebote von der KI. "Mit KI schärfen": ein Angebot nach der Wertformel verbessern. Wirksam erst nach "Angebot speichern".
- Echte Belege (eigene Geschichten) eintragen – der Bot erwähnt Erfolge nur, wenn sie dort stehen.
- Buchungslink optional; ohne Link schlägt der Bot zwei feste Termine vor.

## Automatische Freigabe (Einstellungen)
Standard aus. Eingeschaltet genehmigt NextLead nur Entwürfe, die die Prüfung bestehen, frühestens nach einer Wartezeit, höchstens X pro Tag und erst, wenn du diese Art vorher mindestens 10-mal entschieden und zu 80 % unverändert genehmigt hast.

## Selbstlernen ("Was wirkt")
Je Nachrichtenart testet der Bot 2 bis 3 Stile und bevorzugt den, der mehr positive Antworten bringt. Gibt es einen klaren Gewinner, erfindet die KI montags einen neuen Herausforderer (mit "KI" markiert); verliert er klar, wird er beendet. Ein Versand zählt erst nach 10 Tagen ohne Antwort als Misserfolg. Stile, die du oft ablehnst, pausieren.

## Telegram
/status, /warum (warum steht der Bot), /entwuerfe (freigeben per Knopf), /leads, /pause, /resume, /tag, /woche, /vorwoche, /bilanz.
Hat der Bot mehrere Ansätze statt einer fertigen Nachricht (z. B. wenn jemand Interesse zeigt), kommen sie nummeriert mit je einem Knopf "Ansatz 1/2/3". Ein Tipp darauf lässt den Bot daraus die Nachricht schreiben; die kommt danach als eigener Entwurf mit "Senden"/"Verwerfen".

## Störungen beheben
Jede Zeile unter "Warum steht etwas still" hat einen Knopf: "Jetzt prüfen" beim Sendeweg startet sofort eine Prüfung (Ergebnis nach ein bis zwei Minuten), "Kommen an – schließen" bei der Versandbestätigung schließt die Warnung für drei Tage, nachdem man in LinkedIn gesehen hat, dass die Nachrichten angekommen sind (kamen sie NICHT an: Not-Aus drücken). "Erneut versuchen" startet eine angehaltene Hintergrundaufgabe neu. Andere Knöpfe springen direkt zur passenden Karte.`;

const zahl = (sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { n: number }).n;

/** Frische Momentaufnahme als kompakter Text – nur Kennzahlen, keine Nachrichteninhalte. */
export function lageBericht(): string {
  const g = governor.snapshot();
  const lese = leseStand();
  const still = stillstandGrund();
  const kanaele = warteschlange().map((k) =>
    `- ${k.titel}: ${k.status} – ${k.statusText}${k.naechsterVersuch ? ` Nächster Versuch: ${new Date(k.naechsterVersuch).toLocaleString("de-DE", { timeZone: "Europe/Berlin", weekday: "short", hour: "2-digit", minute: "2-digit" })}.` : ""} Heute ${k.heute}/${k.tagesLimit}${k.wochenLimit ? `, Woche ${k.woche}/${k.wochenLimit}` : ""}. Bereit: ${k.bereit}, warten auf Freigabe: ${k.wartetAufDich}. Als Nächstes: ${k.naechste.map((e) => e.name).join(", ") || "–"}.`);
  const offen = db.prepare("SELECT kind, COUNT(*) n FROM drafts WHERE status='pending' AND COALESCE(phase,'message')='message' GROUP BY kind").all() as { kind: string; n: number }[];
  const fehler = openJobFailures().map((f) => `${f.job} (${f.status === "dead" ? "angehalten" : "wartet"}: ${String(f.lastError || "").split("\n")[0].slice(0, 80)})`);
  const plan = followupPlan().map((s, i) => `${i + 1}. nach ${s.nachTagen} Tagen: ${s.zweck}`).join("; ");
  const auto = autoFreigabeStand();
  const angebote = leadMagnete().map((m) => `${m.titel} (${m.route})`).join(", ");
  const f = funnelReport();
  const q = f.quoten;
  const pct = (x: { pct: number | null; zaehler: number; nenner: number }) => x.pct == null ? "–" : `${x.pct} % (${x.zaehler}/${x.nenner})`;
  const varianten = variantenStatistik().map((s) => `${s.slot}: ${s.arme.map((a) => `${a.titel} ${a.gesendet} gesendet, ${a.positiv} positiv`).join(" | ")}`).join("\n  ");
  return `# Aktuelle Lage (Stand ${new Date().toLocaleString("de-DE", { timeZone: "Europe/Berlin" })})
Automatik: ${getMode()} / Agent: ${getAgentMode()}. Not-Aus: ${g.notAus ? "AN" : "aus"}. Sicherheitspause: ${g.paused ? `JA (${g.pauseReason || "?"})` : "nein"}. Arbeitszeit jetzt: ${g.withinWorkingHours ? "ja" : "nein"} (${g.workingHoursText}).
Warm-up: ${Math.round(g.warmup.factor * 100)} %. Annahmequote: ${g.acceptance.sample >= g.acceptance.minSample ? `${Math.round(g.acceptance.rate * 100)} % aus ${g.acceptance.sample} reifen Einladungen` : `noch zu wenig Daten (${g.acceptance.sample} reife Einladungen, belastbar ab ${g.acceptance.minSample})`}.
Lese-Budget: Profile ${lese.profile?.heute ?? "?"}/${lese.profile?.cap ?? "?"}, Seiten ${lese.seiten?.heute ?? "?"}/${lese.seiten?.cap ?? "?"}${lese.erschoepft ? " – AUFGEBRAUCHT" : ""}.
Stillstand: ${still.steht ? `${still.grund} ${still.tun}` : "kein Hinderungsgrund"}.
Warteschlange:
${kanaele.join("\n")}
Offene Entwürfe: ${offen.map((o) => `${o.kind} ${o.n}`).join(", ") || "keine"}. Freigegeben, warten auf Versand: ${zahl("SELECT COUNT(*) n FROM drafts WHERE status='approved'")}.
Technische Probleme: ${fehler.join("; ") || "keine"}.
Kontakte gesamt: ${zahl("SELECT COUNT(*) n FROM contacts")}, neu (noch nicht angefragt): ${zahl("SELECT COUNT(*) n FROM contacts WHERE status='new'")}.
Funnel gesamt: Annahme ${pct(q.annahme)}, Antwort ${pct(q.antwort)}, positive Antwort ${pct(q.positiveAntwort)}, Termine ${f.counts.meeting}, gewonnen ${f.counts.won}.
Nachfass-Plan: ${plan}.
Aktive Angebote: ${angebote || "keine strukturierten (nur Fließtext im Profil)"}. Belege hinterlegt: ${(getProfil().beweise || []).length}.
Automatische Freigabe: Nachfassungen ${auto.einstellung.followup ? "an" : "aus"}, Erstnachrichten ${auto.einstellung.first ? "an" : "aus"}; Vertrauen Nachfassungen ${auto.vertrauen.followup.unveraendert}/${auto.vertrauen.followup.entscheidungen} unverändert, Erstnachrichten ${auto.vertrauen.first.unveraendert}/${auto.vertrauen.first.entscheidungen}.
Varianten-Test:
  ${varianten}`;
}

export type Turn = { rolle: "du" | "assistent"; text: string };

export async function frageAssistent(frage: string, verlauf: Turn[] = []): Promise<string> {
  const f = String(frage || "").trim().slice(0, 1500);
  if (!f) throw new Error("Bitte eine Frage eingeben.");
  const bisher = (Array.isArray(verlauf) ? verlauf : []).slice(-8)
    .map((t) => `${t.rolle === "assistent" ? "Assistent" : "Nutzer"}: ${String(t.text || "").slice(0, 800)}`).join("\n");
  const prompt = `Du bist der NextLead-Assistent im Cockpit. Du hilfst ${getProfil().name}, sein Vertriebstool zu verstehen und besser zu nutzen, und denkst dabei wie ein erfahrener Vertriebscoach.

${HANDBUCH}

${lageBericht()}

REGELN:
- Antworte auf Deutsch, per Du, kurz und konkret: höchstens etwa 120 Wörter, außer der Nutzer bittet um Details. Lieber eine kurze Liste als Absätze. Keine Überschriften, keine Emojis. Fett (**so**) nur für das Wichtigste.
- Zahlen mit zu wenig Daten nicht als Ergebnis verkaufen, sondern sagen, dass es noch zu früh ist.
- Belege und Beispiele für Nachrichten: nur echte Erfahrungen des Nutzers, keine Verdienst- oder Renditeversprechen.
- Stütze dich NUR auf Handbuch und aktuelle Lage. Was dort nicht steht, weißt du nicht – sag das ehrlich, statt zu raten.
- Du kannst selbst nichts ausführen oder ändern. Sag stattdessen genau, wo man klickt (Bereich → Karte → Knopf).
- Bei "warum passiert nichts"-Fragen: zuerst Stillstand und Warteschlange lesen und die konkrete Ursache nennen.
- Sicherheitsgrenzen (Limits, Lese-Budget, Arbeitszeit) niemals als Problem darstellen, das man durch Hochdrehen löst.
- Vertriebsfragen: konkret und umsetzbar, mit Bezug auf die echten Zahlen oben.

${bisher ? `BISHERIGES GESPRÄCH:\n${bisher}\n` : ""}
FRAGE: ${f}`;
  return (await generateText(prompt, 1500)).trim();
}
