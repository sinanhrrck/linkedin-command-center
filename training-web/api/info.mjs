// GET /api/info → Kontaktangaben für den Einwilligungstext und ob die Seite fertig eingerichtet ist.
// Werte kommen aus den Vercel-Umgebungsvariablen, nicht aus dem Code.
export default function handler(req, res) {
  const verantwortlich = String(process.env.VERANTWORTLICH_NAME || "").trim();
  const kontakt = String(process.env.VERANTWORTLICH_KONTAKT || "").trim();
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    verantwortlich, kontakt,
    bereit: Boolean(process.env.ANTHROPIC_API_KEY && process.env.RESEND_API_KEY && process.env.MAIL_TO && verantwortlich && kontakt),
  });
}
