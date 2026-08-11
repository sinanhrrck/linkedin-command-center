import { createServer } from "node:http";

const PORT = Number(process.env.PORT || 8787);
const REPORT_TO = process.env.REPORT_TO || "sinan.harrack@koenigswege.com";
const REPORT_FROM = process.env.REPORT_FROM || "NextLead Meldungen <meldungen@koenigswege.com>";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 12;
const visits = new Map();

const clean = (value, max = 2000) => String(value ?? "")
  .replace(/https?:\/\/\S+/gi, "[Link entfernt]")
  .replace(/((?:api[_-]?key|token|secret|password)\s*)[:=]\s*\S+/gi, "$1=[entfernt]")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);
const html = (value) => clean(value, 4000).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

function clientIp(req) {
  return String(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
}

function rateLimited(ip) {
  const now = Date.now();
  const recent = (visits.get(ip) || []).filter((ts) => now - ts < WINDOW_MS);
  recent.push(now); visits.set(ip, recent);
  return recent.length > MAX_PER_WINDOW;
}

async function sendMail(payload) {
  if (!RESEND_API_KEY) throw new Error("RESEND_API_KEY fehlt");
  const kind = payload.kind === "error" ? "Fehlerbericht" : "Feedback";
  const shot = payload.screenshot && typeof payload.screenshot === "object" ? payload.screenshot : null;
  const screenshot = shot?.mimeType === "image/jpeg" && String(shot.base64 || "").startsWith("/9j/") && /^[A-Za-z0-9+/]+={0,2}$/.test(String(shot.base64 || "")) && String(shot.base64).length <= 1_470_000
    ? { filename: "nextlead-feedback-ausschnitt.jpg", content: String(shot.base64) }
    : null;
  const activity = payload.activity && typeof payload.activity === "object" ? payload.activity : null;
  const replyTo = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(payload.replyEmail || "")) ? String(payload.replyEmail).slice(0, 180) : undefined;
  const rows = [
    ["Art", kind], ["Meldungs-ID", payload.reportId], ["Installation", payload.installationId],
    ["Version", payload.appVersion], ["System", `${payload.platform || "?"} / ${payload.arch || "?"}`],
    ["Zeit", payload.createdAt], ["Aufgabe", activity?.job], ["Fehler", activity?.detail],
    ["Ergänzung", payload.message], ["Rückfrage an", replyTo],
    ["Screenshot", screenshot ? "Markierter Ausschnitt im Anhang" : null],
  ].filter(([, value]) => value);
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `nextlead/${String(payload.reportId).slice(0, 80)}`,
    },
    body: JSON.stringify({
      from: REPORT_FROM,
      to: [REPORT_TO],
      ...(replyTo ? { reply_to: replyTo } : {}),
      subject: `[NextLead] ${kind}${activity?.job ? ` · ${clean(activity.job, 80)}` : ""}`,
      ...(screenshot ? { attachments: [screenshot] } : {}),
      html: `<h2>${kind}</h2><table>${rows.map(([label, value]) => `<tr><th style="text-align:left;padding:6px 12px 6px 0;vertical-align:top">${html(label)}</th><td style="padding:6px 0">${html(value)}</td></tr>`).join("")}</table><p style="color:#68758a;font-size:12px">Automatisch bereinigte, bewusst abgesendete NextLead-Meldung.</p>`,
    }),
  });
  if (!response.ok) throw new Error(`Mailanbieter HTTP ${response.status}`);
}

const server = createServer((req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method !== "POST" || url.pathname !== "/api/nextlead-report") {
    res.writeHead(404).end(); return;
  }
  const ip = clientIp(req);
  if (rateLimited(ip)) { res.writeHead(429).end(); return; }
  let body = "";
  let tooLarge = false;
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 1_600_000 && !tooLarge) {
      tooLarge = true;
      res.writeHead(413).end();
    }
  });
  req.on("end", async () => {
    if (tooLarge) return;
    try {
      const payload = JSON.parse(body || "{}");
      if (!/^[0-9a-f-]{36}$/i.test(String(payload.reportId || ""))) throw new Error("Ungültige Meldungs-ID");
      if (payload.kind !== "error" && payload.kind !== "feedback") throw new Error("Ungültige Meldungsart");
      await sendMail(payload);
      res.writeHead(202, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
    } catch (error) {
      console.error("[report-relay]", error?.message || error);
      res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Meldung nicht angenommen" }));
    }
  });
});

server.listen(PORT, "0.0.0.0", () => console.info(`[report-relay] Port ${PORT} → ${REPORT_TO}`));
