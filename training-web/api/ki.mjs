// POST /api/ki  {aufgabe: "bot"|"lead", sitzung}
// "bot"  → der Bot schreibt Sinans nächste Nachricht (Rolle „Ich bin der Lead“, Bot schreibt zuerst)
// "lead" → die KI spielt den Azubi (Rolle „Ich bin der Bot“)
import { KI_MODEL, SCHEMAS, bot, botLlm, frageKi, kern, leadPrompt, leseJson, pruefeSitzung } from "./_prompts.mjs";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ fehler: "Nur POST." });
  try {
    const body = await leseJson(req);
    const s = pruefeSitzung(body.sitzung);
    if (s.ende) throw new Error("Das Gespräch ist schon zu Ende.");
    if (body.aufgabe === "bot") {
      if (s.modus !== "lead") throw new Error("Falsche Rolle.");
      // Erstnachricht: derselbe Ablauf wie drafts.createFirstMessageDraft (Prompt + Prüfungen).
      if (!s.verlauf.length) {
        // Live schluckt KI-Fehler hier (→ „kein Entwurf“). Für die Website: echten Grund zeigen.
        let kiFehler = null;
        const r = await kern.erstnachrichtWieLive(bot, s.lead, (p) => botLlm(p, false).catch((err) => { kiFehler = err; throw err; }));
        if (!r.text && kiFehler) throw kiFehler;
        if (!r.text) return res.status(200).json({ hinweis: `Live wäre hier keine Erstnachricht rausgegangen (${r.grund || "Prüfung nicht bestanden"}). Starte bitte eine neue Runde.`, ende: "abbruch" });
        return res.status(200).json({ nachricht: r.text, conv: kern.neueConversation(`sim:${s.id}`, s.lead.name, s.lead.name) });
      }
      // Antwort: dieselbe Pipeline wie agentRunner (handleIncomingMessage mit Live-Bausteinen).
      const conv = s.conv || kern.neueConversation(`sim:${s.id}`, s.lead.name, s.lead.name);
      const verlauf = s.verlauf.map((m) => ({ sender: m.rolle === "sinan" ? "Sinan" : s.lead.name, text: m.text }));
      const e = await kern.antwortWieLive(bot, s.ausrichtung, conv, verlauf, (p) => botLlm(p, true));
      if (e.typ === "senden") return res.status(200).json({ nachricht: e.text, conv: e.conversation });
      if (e.typ === "eskalieren") {
        if (e.conversation.status === "gebucht") return res.status(200).json({ hinweis: "Ab hier übernimmt Sinan persönlich.", ende: "uebergabe", conv: e.conversation });
        if (e.entwurf) return res.status(200).json({ nachricht: e.entwurf, entwurf: true, hinweis: "Diese Antwort wäre live nicht automatisch rausgegangen, sondern zuerst von Sinan geprüft worden.", conv: e.conversation });
        return res.status(200).json({ hinweis: "Live hätte der Bot hier an Sinan übergeben und nicht selbst geantwortet.", conv: e.conversation });
      }
      if (e.typ === "schweigen") {
        return e.art === "dauerhaft"
          ? res.status(200).json({ hinweis: "Live würde der Bot ab hier gar nicht mehr antworten.", ende: "stumm", conv: e.conversation })
          : res.status(200).json({ hinweis: "Live würde der Bot auf diese Nachricht bewusst nicht antworten. Du kannst trotzdem weiterschreiben.", conv: e.conversation });
      }
      return res.status(200).json({ hinweis: "Live hätte der Bot hier nicht geantwortet.", conv: e.conversation });
    }
    if (body.aufgabe === "lead") {
      if (s.modus !== "bot" || !s.verlauf.length) throw new Error("Falsche Rolle.");
      const r = await frageKi(leadPrompt(s), SCHEMAS.lead, { model: KI_MODEL, effort: "low", maxTokens: 4000 });
      const antwort = String(r.antwort || "").trim().slice(0, 1500);
      if (!antwort) throw new Error("Die KI hat keine Antwort geliefert. Versuch es nochmal.");
      return res.status(200).json({ antwort, stimmung: Math.max(-2, Math.min(2, Number(r.stimmung) || 0)), ende: r.ende === "offen" ? null : r.ende, gedanke: String(r.gedanke || "").slice(0, 240) });
    }
    return res.status(400).json({ fehler: "Unbekannte Aufgabe." });
  } catch (err) {
    return res.status(400).json({ fehler: err?.message || "Unbekannter Fehler." });
  }
}
