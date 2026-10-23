// POST /api/abschluss  {sitzung, ergebnis, teilnehmer}
// Wertet das Training aus (ein KI-Aufruf) und schickt Sinan eine E-Mail mit Zusammenfassung, Chat und
// einer Importdatei für das Cockpit (Training → „Trainings-Dateien importieren“).
// Gespeichert wird nirgends etwas: das Postfach ist die Ablage.
import { GRENZEN, KI_MODEL, SCHEMAS, auswertungsPrompt, frageKi, leseJson, pruefeSitzung, saubern } from "./_prompts.mjs";

const txt = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const ALTER = ["18–20", "21–25", "26–35", "36 oder älter"];
const TAETIGKEIT = ["Schule", "Ausbildung", "Studium", "berufstätig", "anderes"];
const SKALEN = {
  menschlich: "Die Nachrichten wirkten wie von einem echten Menschen",
  bedraengt: "Ich fühlte mich bedrängt oder verkauft",
  interesse: "Die Person schien sich wirklich für mich zu interessieren",
};

function pruefeErgebnis(s, roh) {
  const e = roh && typeof roh === "object" ? roh : {};
  const zusage = s.modus === "bot"
    ? (s.ende === "zusage" ? "ja" : s.ende === "absage" ? "nein" : "vielleicht")
    : (["ja", "vielleicht", "nein"].includes(e.zusage) ? e.zusage : null);
  const note = Number.isInteger(e.note) && e.note >= 1 && e.note <= 5 ? e.note : null;
  if (s.modus === "lead" && (!zusage || !note)) throw new Error("Bitte gib an, ob du zugesagt hättest, und vergib eine Note.");
  const skalen = Object.fromEntries(Object.keys(SKALEN).map((k) => [k, Number.isInteger(e.skalen?.[k]) && e.skalen[k] >= 1 && e.skalen[k] <= 5 ? e.skalen[k] : null]).filter(([, v]) => v));
  return { zusage, note, skalen, feedback: txt(e.feedback, GRENZEN.feedback) };
}

function pruefeTeilnehmer(roh) {
  const t = roh && typeof roh === "object" ? roh : {};
  if (t.art === "team") return { art: "team", name: txt(t.name, 40) || "Kollege/Kollegin" };
  return { art: "studie", alter: ALTER.includes(t.alter) ? t.alter : "keine Angabe", taetigkeit: TAETIGKEIT.includes(t.taetigkeit) ? t.taetigkeit : "keine Angabe" };
}

const testerText = (t) => t.art === "team" ? t.name : `Studie · ${t.alter} · ${t.taetigkeit}`;

function mailHtml(s, e, t, a) {
  const z = { ja: "Zusage", vielleicht: "offen", nein: "Absage" }[e.zusage] || "offen";
  const zeile = (k, v) => v ? `<tr><td style="padding:4px 14px 4px 0;color:#5d6b80;vertical-align:top">${esc(k)}</td><td style="padding:4px 0">${esc(v)}</td></tr>` : "";
  const skalen = Object.entries(e.skalen).map(([k, v]) => zeile(SKALEN[k], `${v} von 5`)).join("");
  const chat = s.verlauf.map((m) => {
    const bot = m.rolle === "sinan";
    const wer = bot ? (s.modus === "bot" ? "Bot (Mensch)" : "Bot") : (s.modus === "lead" ? `${s.lead.name} (Mensch)` : `${s.lead.name} (KI)`);
    return `<div style="margin:6px 0;${bot ? "" : "text-align:right"}"><div style="font-size:11px;color:#5d6b80">${esc(wer)}</div><div style="display:inline-block;max-width:85%;text-align:left;padding:8px 11px;border-radius:12px;background:${bot ? "#2557a7;color:#fff" : "#eef1f6;color:#142033"}">${esc(m.text)}</div></div>`;
  }).join("");
  const vor = a.vorschlaege.map((v) => `<li style="margin:6px 0"><b>${esc({ beispiel: "Beispiel", erstnachricht: "Regel · Erstnachricht", gespraech: "Regel · Gespräch" }[v.bereich])}:</b> ${esc(v.text)}<br><span style="color:#5d6b80">${esc(v.begruendung)}</span></li>`).join("");
  return `<div style="font-family:-apple-system,Segoe UI,sans-serif;font-size:14px;color:#142033;max-width:640px">
<h2 style="margin:0 0 4px">Neues Training: ${esc(testerText(t))}</h2>
<p style="margin:0 0 14px;color:#5d6b80">${s.modus === "bot" ? "Hat als Bot geschrieben" : "Hat den Lead gespielt"} · ${esc(s.lead.name)} · Ausrichtung ${s.ausrichtung === "aec" ? "AEC" : "Standard"}</p>
<table style="border-collapse:collapse;margin-bottom:14px">${zeile("Ergebnis", z)}${zeile("Note für den Bot", e.note ? `${e.note} von 5` : "")}${skalen}${zeile("Kommentar", e.feedback)}${zeile("Einschätzung der KI", a.urteil)}</table>
${vor ? `<h3 style="margin:16px 0 4px">Vorschläge für den Bot</h3><ul style="padding-left:18px;margin:0">${vor}</ul>` : `<p style="color:#5d6b80">Keine neuen Vorschläge.</p>`}
<h3 style="margin:18px 0 6px">Chat</h3>${chat}
<p style="margin-top:20px;color:#5d6b80;font-size:12px">Im Anhang: Importdatei fürs Cockpit (Training → „Trainings-Dateien importieren“). Vorschläge wirken erst, wenn du sie dort annimmst.</p>
</div>`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ fehler: "Nur POST." });
  try {
    const body = await leseJson(req);
    const s = pruefeSitzung(body.sitzung);
    if (!s.verlauf.some((m) => m.quelle === "mensch")) throw new Error("Schreib mindestens eine Nachricht, bevor du auswertest.");
    const e = pruefeErgebnis(s, body.ergebnis);
    const t = pruefeTeilnehmer(body.teilnehmer);
    const skalenText = Object.entries(e.skalen).map(([k, v]) => `${SKALEN[k]}: ${v}/5`).join("; ");

    let a = { urteil: "", vorschlaege: [] };
    try {
      const r = await frageKi(auswertungsPrompt(s, { ...e, skalen: skalenText }), SCHEMAS.auswertung, { model: KI_MODEL, effort: "medium", maxTokens: 8000 });
      const menschTexte = new Set(s.verlauf.filter((m) => m.rolle === "sinan" && m.quelle === "mensch").map((m) => m.text));
      a = {
        urteil: txt(r.urteil, 600),
        vorschlaege: (r.vorschlaege || []).slice(0, 4).map((v) => ({ bereich: v.bereich, text: v.bereich === "beispiel" ? txt(v.text, 500) : saubern(txt(v.text, 200)), begruendung: txt(v.begruendung, 300) }))
          .filter((v) => v.text.length >= 8 && (v.bereich !== "beispiel" || (s.modus === "bot" && menschTexte.has(v.text)))),
      };
    } catch (err) { a.urteil = `Keine KI-Auswertung möglich: ${err.message}`; }

    const jetzt = new Date().toISOString();
    const sitzung = {
      id: s.id, modus: s.modus, ausrichtung: s.ausrichtung, tester: testerText(t), erstellt: s.erstellt || jetzt, beendet: jetzt,
      lead: s.lead, verlauf: s.verlauf,
      ergebnis: { zusage: e.zusage, note: e.note, feedback: [e.feedback, skalenText].filter(Boolean).join(" · "), kiUrteil: a.urteil },
      vorschlaege: a.vorschlaege,
    };
    const datei = { format: "nextlead-training", version: 1, exportiert: jetzt, sitzungen: [sitzung] };

    let mailOk = false;
    if (process.env.RESEND_API_KEY && process.env.MAIL_TO) {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: process.env.MAIL_FROM || "NextLead Training <onboarding@resend.dev>",
          to: [process.env.MAIL_TO],
          subject: `Training: ${testerText(t)} · ${s.modus === "bot" ? "als Bot" : "als Lead"} · ${{ ja: "Zusage", vielleicht: "offen", nein: "Absage" }[e.zusage] || "offen"}`,
          html: mailHtml(s, e, t, a),
          attachments: [{ filename: `nextlead-training-${s.id}.json`, content: Buffer.from(JSON.stringify(datei, null, 2)).toString("base64") }],
        }),
      });
      mailOk = r.ok;
      if (!r.ok) console.error("[mail]", r.status, (await r.text()).slice(0, 300));
    } else console.error("[mail] RESEND_API_KEY oder MAIL_TO fehlt");

    return res.status(200).json({ ok: true, gesendet: mailOk, urteil: a.urteil, vorschlaege: a.vorschlaege });
  } catch (err) {
    return res.status(400).json({ fehler: err?.message || "Unbekannter Fehler." });
  }
}
