let state = null;
let activeView = "today";
let reviewKinds = null;
let reviewCampaign = null;
let reviewIndex = 0;
let missionGoal = null;
let planningInitialized = false;
let relationshipContact = null;
let relationshipExcludeArmed = false;
let contactWorkspaceId = null;

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const post = async (url, payload = {}, timeoutMs = 45000) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: controller.signal });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.error) throw new Error(result.error || result.reason || `HTTP ${response.status}`);
    return result;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("Der Vorgang dauert zu lange. Bitte erneut versuchen.");
    throw error;
  } finally { clearTimeout(timeout); }
};
const toast = (message) => { const el = $("toast"); el.textContent = message; el.classList.add("show"); setTimeout(() => el.classList.remove("show"), 2600); };
const pct = (a, b) => b > 0 ? Math.round(a / b * 100) : null;
const JOBS = {
  backup: ["Sicherung erstellen", "Datenbestand sichern"], healthcheck: ["Sendeweg prüfen", "LinkedIn-Zugang und Eingabefeld kontrollieren"],
  acceptance: ["Annahmen prüfen", "Neue Verbindungen erkennen"], outreach: ["Kontakte vernetzen", "Priorisierte Anfragen senden"],
  drafts: ["Postfach prüfen", "Antworten und Entwürfe vorbereiten"], sendApproved: ["Freigaben versenden", "Genehmigte Nachrichten sicher zustellen"],
  feed: ["Neue Kontakte suchen", "Gespeicherte Quellen weiter durchsuchen"], campaign: ["Kampagnen fortsetzen", "Zielgruppe und Event-Einladungen bearbeiten"],
  content: ["Inhalte vorbereiten", "Neue Beitragsideen erstellen"], post: ["Beiträge prüfen", "Fällige Beiträge veröffentlichen"],
  followup: ["Follow-ups vorbereiten", "Offene Gespräche freundlich nachfassen"], agent: ["Gespräche prüfen", "Neue Antworten einordnen"],
  netzwerk: ["Netzwerk prüfen", "Bestehende Verbindungen einordnen"], offene: ["Offene Antworten prüfen", "Liegengebliebene Gespräche erkennen"],
  comment: ["Beiträge prüfen", "Passende Interaktionen vorbereiten"], pitch: ["Chancen prüfen", "Gesprächsmöglichkeiten einordnen"],
  wiederbeleben: ["Kontakte reaktivieren", "Eingeschlafene Gespräche prüfen"], reichweite: ["Reichweite pflegen", "Passende Beiträge und Kontakte prüfen"],
  connect: ["Vernetzung gesendet", "Kontaktanfrage verschickt"], message: ["Nachricht gesendet", "Erstnachricht oder Follow-up zugestellt"],
  reply: ["Antwort gesendet", "Bestehendes Gespräch fortgeführt"], like: ["Beitrag geliked", "Passenden Beitrag unterstützt"],
};
const jobText = (job) => JOBS[job] || [String(job || "Bereit"), "Nächste Aufgabe wird automatisch priorisiert"];
const localDate = (value) => new Date(String(value || "").includes("T") ? value : `${String(value || "").replace(" ", "T")}Z`);
const relativeTime = (value) => {
  const seconds = Math.max(0, Math.round((Date.now() - localDate(value).getTime()) / 1000));
  if (!Number.isFinite(seconds)) return "gerade eben";
  if (seconds < 60) return "gerade eben";
  if (seconds < 3600) return `vor ${Math.floor(seconds / 60)} Min.`;
  if (seconds < 86400) return `vor ${Math.floor(seconds / 3600)} Std.`;
  return localDate(value).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
};

const VIEW_META = {
  today: ["DEIN ARBEITSTAG", "Heute"], campaigns: ["GEZIELTE AUFTRÄGE", "Kampagnen"],
  contacts: ["DEINE KONTAKTBASIS", "Kontakte"], insights: ["ZAHLEN MIT KONTEXT", "Auswertung"],
  settings: ["ARBEITSWEISE", "Einstellungen"],
};
function showView(view) {
  activeView = VIEW_META[view] ? view : "today";
  document.querySelectorAll(".view").forEach((el) => el.classList.toggle("active", el.id === `view-${activeView}`));
  document.querySelectorAll(".nav[data-view]").forEach((el) => el.classList.toggle("active", el.dataset.view === activeView));
  $("page-kicker").textContent = VIEW_META[activeView][0]; $("page-title").textContent = VIEW_META[activeView][1];
  window.scrollTo({ top: 0, behavior: "smooth" });
}
document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));

/**
 * ALLE CHATS PRÜFEN: stößt den tiefen Postfach-Scan an (Engine holt das Flag ab). Der Scan
 * geht auch alte, längst gelesene Unterhaltungen durch und legt für jeden Fall, in dem eine
 * Antwort offen ist, einen Entwurf an. Rein lesend – es wird nichts gesendet.
 * Der Knopf bleibt kurz gesperrt: der Lauf braucht Minuten, mehrfaches Klicken bringt nichts.
 */
// Optionaler Zugriff: Läuft je ein älteres HTML aus dem Cache, darf ein fehlendes Element
// nicht das gesamte Skript abbrechen (sonst steht das ganze Cockpit still).
$("scan-offene")?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const result = await post("/api/offene");
    toast(result.running
      ? "Alle Chats werden geprüft. Das dauert einige Minuten, neue Entwürfe erscheinen dann hier."
      : "Auftrag vorgemerkt. Er startet, sobald der Bot läuft.");
  } catch (error) {
    toast(`Konnte nicht starten: ${error.message}`);
    button.disabled = false;
    return;
  }
  setTimeout(() => { button.disabled = false; }, 90000);
});

function renderStatus() {
  const alive = !!state.engine?.alive, stopped = !!state.governor?.notAus, health = state.systemHealth?.sendeWeg;
  const okay = alive && !stopped && health === "ok";
  const critical = stopped || health === "broken";
  $("side-dot").style.background = okay ? "#58d19b" : critical ? "#ef7482" : "#e4ae54";
  $("side-state").textContent = stopped ? "Not-Aus aktiv" : alive ? "Arbeitet" : "Engine aus";
  $("side-detail").textContent = state.engine?.activeJob ? `Jetzt: ${state.engine.activeJob}` : alive ? "Aufgaben werden priorisiert" : "Keine Hintergrundarbeit";
  $("app-version").textContent = `Version ${state.app?.version || "unbekannt"} · ${state.app?.channel || ""}`;
  const strip = $("status-strip"); strip.className = `status-strip ${okay ? "ok" : critical ? "bad" : "warn"}`;
  const title = stopped ? "Jeder Versand ist gestoppt." : health === "broken" ? "Der Sendeweg braucht Aufmerksamkeit."
    : health !== "ok" ? "Der Sendeweg wird vor dem nächsten Versand geprüft."
    : alive ? "NextLead arbeitet im Hintergrund." : "NextLead ist gerade nicht gestartet.";
  const detail = state.engine?.activeJob ? `Aktuell: ${state.engine.activeJob}${state.engine.queuedJobs ? ` · ${state.engine.queuedJobs} weitere Aufgaben warten` : ""}` : alive ? "Nächster Lauf automatisch nach Zeitplan." : "In Einstellungen kannst du die Engine starten.";
  strip.innerHTML = `<strong>${esc(title)}</strong><span>${esc(detail)}</span>`;
  /**
   * "WARUM PASSIERT GERADE NICHTS?" – die Antwort gehört sichtbar nach oben, nicht in die
   * Datenbank. Jede Blockade heute (Checkpoint, Akzeptanzquote, leere Warteschlange, fehlende
   * Freigaben) war fachlich korrekt und trotzdem unsichtbar: Sinan sah nur einen stillen Bot.
   */
  const blockaden = state.blockaden || [];
  const box = $("blockaden");
  if (box) {
    box.classList.toggle("hidden", !blockaden.length);
    box.innerHTML = blockaden.length
      ? `<div class="section-head"><div><span class="eyebrow">Warum steht etwas still</span><h3>${blockaden.length} Sache${blockaden.length === 1 ? "" : "n"} bremsen gerade</h3></div></div>`
        + blockaden.map((b, i) => {
          const a = b.aktion || { art: "warten", text: b.tun };
          const knopf = a.art === "warten"
            ? `<em class="blockade-warten">${esc(a.text)}</em>`
            : `<button class="blockade-tun" data-blockade="${i}">${esc(a.text)} →</button>`;
          return `<div class="blockade"><b>${esc(b.was)}</b><span>${esc(b.grund)}</span>${knopf}</div>`;
        }).join("")
      : "";
    /**
     * Ein Klick behebt entweder direkt ("sofort") oder springt an die Stelle, wo es geht ("gehe").
     * Danach wird neu geladen – die Zeile verschwindet von selbst, sobald die Ursache weg ist.
     * Kein Wegklicken nötig: Die Liste wird bei jedem Abruf frisch aus dem Zustand berechnet.
     */
    box.querySelectorAll("[data-blockade]").forEach((button) => button.addEventListener("click", async () => {
      const a = (blockaden[Number(button.dataset.blockade)] || {}).aktion;
      if (!a) return;
      if (a.art === "gehe") return showView(a.ziel);
      if (a.art === "review") {
        showView("today"); reviewCampaign = null; reviewKinds = a.kinds; reviewIndex = 0; renderReviewer();
        return;
      }
      if (a.art === "campaignReview") {
        showView("campaigns"); reviewKinds = null; reviewCampaign = Number(a.id); reviewIndex = 0; renderReviewer();
        return;
      }
      if (a.art === "kampagne") {
        showView("campaigns");
        return openCampaignForm((state.campaigns || []).find((c) => c.id === a.id));
      }
      if (a.art === "job") {
        button.disabled = true;
        try {
          await post("/api/job-retry", { job: a.name });
          toast("Wartezeit aufgehoben. Die Aufgabe läuft beim nächsten Zeitfenster erneut.");
          await load(true);
        } catch (error) {
          toast(`Nicht geklappt: ${error.message}`);
          button.disabled = false;
        }
        return;
      }
      button.disabled = true;
      const alterText = button.textContent;
      button.textContent = "läuft…";
      try {
        if (a.befehl === "engine_start") await post("/api/engine", { action: "start" });
        if (a.befehl === "notaus_loesen") await post("/api/notaus", { an: false });
        if (a.befehl === "pause_loesen") await post("/api/pause", { an: false });
        toast("Erledigt. Der Bot arbeitet weiter.");
        // Engine-Start braucht einen Moment, bis der Heartbeat steht.
        setTimeout(() => load(true), a.befehl === "engine_start" ? 3000 : 600);
      } catch (error) {
        toast(`Nicht geklappt: ${error.message}`);
        button.disabled = false;
        button.textContent = alterText;
      }
    }));
  }
  const emergency = $("emergency"); emergency.classList.toggle("active", stopped); emergency.textContent = stopped ? "Not-Aus lösen" : "Not-Aus";
}

const GROUPS = [
  { key: "systemIssues", kinds: [], icon: "!", title: "Technisches Problem lösen", copy: "Sendeweg oder unklare Zustellungen zuerst prüfen.", cls: "urgent", view: "settings" },
  { key: "goalChanges", kinds: [], icon: "↗", title: "Gesprächsweg entscheiden", copy: "Ein Chat entwickelt sich weg vom gewählten Ziel.", cls: "urgent", view: "today" },
  { key: "replies", kinds: ["message", "pitchidee"], icon: "↩", title: "Antworten prüfen", copy: "Menschen haben geschrieben – diese Gespräche zuerst.", cls: "urgent" },
  { key: "meetings", kinds: [], icon: "✓", title: "Termine übernehmen", copy: "Persönliche Übergaben, die nicht warten sollten.", view: "contacts" },
  { key: "firstMessages", kinds: ["first"], icon: "+", title: "Erstnachrichten freigeben", copy: "Neue Vernetzungen persönlich eröffnen." },
  { key: "reactivations", kinds: ["reaktivierung"], icon: "◎", title: "Zusatz · bestehendes Netzwerk", copy: "Getrennt von der Akquise und immer nur nach deiner Freigabe." },
  { key: "followups", kinds: ["followup"], icon: "↻", title: "Follow-ups prüfen", copy: "Freundlich nachfassen, maximal zweimal." },
  { key: "comments", kinds: ["comment"], icon: "✦", title: "Kommentar prüfen", copy: "Öffentliche Kommentare werden nur nach deiner Freigabe veröffentlicht." },
];
function renderToday() {
  const attention = state.attention || {};
  $("nav-attention").textContent = attention.total || "";
  $("work-total").textContent = `${attention.total || 0} offene Entscheidungen`;
  $("attention-title").textContent = attention.total ? `${attention.total} Entscheidungen sind nach Wirkung sortiert.` : "Heute ist alles entschieden.";
  $("attention-copy").textContent = attention.systemIssues ? `${attention.systemIssues} technische Hinweise stehen vor neuer Akquise.` : "Antworten zuerst, dann Freigaben. NextLead erledigt den Rest im Hintergrund.";
  const automatic = Object.values(state.actionsToday || {}).reduce((sum, value) => sum + Number(value || 0), 0);
  $("today-auto").textContent = automatic;
  const groups = GROUPS.filter((group) => Number(attention[group.key] || 0) > 0);
  $("work-groups").innerHTML = groups.length ? groups.map((group) => `<button class="work-item ${group.cls || ""}" data-group="${group.key}"><span class="work-icon">${group.icon}</span><span class="work-copy"><b>${group.title}</b><span>${group.copy}</span></span><span class="work-count">${attention[group.key]}</span></button>`).join("") : `<div class="empty-work"><b>Arbeitskorb leer</b><br/>NextLead arbeitet weiter und meldet sich, sobald eine Entscheidung nötig ist.</div>`;
  document.querySelectorAll("[data-group]").forEach((button) => button.addEventListener("click", () => {
    const group = GROUPS.find((item) => item.key === button.dataset.group);
    if (group?.key === "goalChanges") return $("goal-alerts")?.scrollIntoView({ behavior: "smooth", block: "center" });
    if (group?.view) return showView(group.view);
    reviewCampaign = null; reviewKinds = group?.kinds || null; reviewIndex = 0; renderReviewer();
  }));
  renderGoalAlerts();
  const funnel = Object.fromEntries((state.funnel || []).map((item) => [item.stage, item.count]));
  const rows = [["Anfragen", funnel.eingeladen || 0, 100], ["Angenommen", funnel.angenommen || 0, pct(funnel.angenommen || 0, funnel.eingeladen || 0) || 0], ["Nachrichten", funnel.angeschrieben || 0, pct(funnel.angeschrieben || 0, funnel.eingeladen || 0) || 0], ["Antworten", funnel.geantwortet || 0, pct(funnel.geantwortet || 0, funnel.eingeladen || 0) || 0]];
  $("mini-funnel").innerHTML = rows.map(([label, count, width]) => `<div class="mini-row"><span>${label}</span><b>${count}</b><em><i style="width:${width}%"></i></em></div>`).join("");
  renderActivity();
}

function renderGoalAlerts() {
  const alerts = state.goalAlerts || [];
  const box = $("goal-alerts");
  if (!box) return;
  box.classList.toggle("hidden", !alerts.length);
  box.innerHTML = alerts.length ? `<div class="goal-alert-head"><div><span class="eyebrow">Richtungswechsel</span><h3>Der Bot hat angehalten</h3></div><span>${alerts.length} offen</span></div>` + alerts.map((alert) => `
    <article class="goal-alert">
      <div class="goal-shift"><b>${esc(alert.currentGoal)}</b><i>→</i><strong>${esc(alert.suggestedGoal || "anderer Weg")}</strong></div>
      <div><h4>${esc(alert.participant || "Kontakt")}</h4><p>${esc(alert.summary)}</p>${alert.headline ? `<small>${esc(alert.headline)}</small>` : ""}</div>
      <div class="goal-alert-actions"><a href="${esc(alert.threadUrl)}" target="_blank" rel="noopener">Chat öffnen ↗</a>${alert.suggestedGoal ? `<button class="primary" data-goal-alert="${alert.id}" data-action="accepted">Auf ${esc(alert.suggestedGoal)} wechseln</button>` : ""}<button data-goal-alert="${alert.id}" data-action="dismissed">Beim Ziel bleiben</button></div>
    </article>`).join("") : "";
  box.querySelectorAll("[data-goal-alert]").forEach((button) => button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await post("/api/goal-alert", { id: Number(button.dataset.goalAlert), action: button.dataset.action });
      await load(true);
      toast(button.dataset.action === "accepted" ? "Gesprächsweg gewechselt." : "Der bestehende Gesprächsweg bleibt aktiv.");
    } catch (error) { toast(`Entscheidung nicht gespeichert: ${error.message}`); button.disabled = false; }
  }));
}

function renderActivity() {
  const activity = state.activity || {}, alive = !!state.engine?.alive;
  $("activity-live-label").textContent = activity.paused ? "Pausiert" : alive ? "Live" : "Aus";
  $("activity-live-label").parentElement.classList.toggle("stopped", activity.paused || !alive);
  const currentJob = activity.current?.job || state.engine?.activeJob;
  const current = jobText(currentJob);
  $("activity-current").innerHTML = currentJob
    ? `<div class="current-job"><span class="pulse-ring"></span><div><b>${esc(current[0])}</b><span>${esc(current[1])}</span><small>${activity.current?.started_at ? `gestartet ${relativeTime(activity.current.started_at)}` : "läuft gerade"}</small></div></div>`
    : `<div class="current-job idle"><span class="pulse-ring"></span><div><b>${activity.paused ? "Bot pausiert" : alive ? "Bereit für die nächste Aufgabe" : "Engine ist aus"}</b><span>${activity.paused ? "Not-Aus verhindert jede neue Aktion." : alive ? "Die Zeitpläne laufen. Gerade ist kein Browserjob aktiv." : "In Einstellungen kannst du die Engine starten."}</span></div></div>`;
  const upcoming = activity.upcoming || [];
  $("activity-next").innerHTML = upcoming.length
    ? upcoming.map((item, index) => { const label = jobText(item.job); return `<div class="activity-row ${item.blocked ? "blocked" : ""}"><span class="activity-index">${index + 1}</span><div><b>${esc(label[0])}</b><span>${esc(item.detail)}</span></div><small>${esc(item.timing)}</small></div>`; }).join("")
    : `<div class="activity-empty">${activity.paused ? "Keine Aktion geplant, solange der Not-Aus aktiv ist." : "Keine Aufgabe wartet."}</div>`;
  let recent = activity.recent || [];
  if (!recent.length) recent = (state.recentActions || []).slice(0, 6).map((item) => ({ job: item.type, detail: item.full_name || "LinkedIn-Aktion", finished_at: item.created_at, status: "done" }));
  $("activity-recent").innerHTML = recent.slice(0, 6).map((item) => { const label = jobText(item.job); const problem = item.status === "failed" || item.status === "timed_out"; return `<div class="activity-row compact ${problem ? "failed" : ""}"><span class="done-mark">${problem ? "!" : "✓"}</span><div><b>${esc(label[0])}</b><span>${esc(item.detail || label[1])}</span>${problem && item.id ? `<button class="report-error" data-report-error="${Number(item.id)}">Fehler melden</button>` : ""}</div><small>${relativeTime(item.finished_at || item.started_at)}</small></div>`; }).join("") || `<div class="activity-empty">Noch keine Aktivität protokolliert.</div>`;
  $("activity-recent").querySelectorAll("[data-report-error]").forEach((button) => button.addEventListener("click", () => openReport("error", Number(button.dataset.reportError))));
}

let reportKind = "feedback";
let reportActivityId = null;
let reportScreenshot = null;
let captureStart = null;
const plainPrivacy = "Dein Text, App-Version und Betriebssystem. Keine LinkedIn-Namen, Nachrichten, Links oder Zugangsdaten.";
const screenshotPrivacy = "Zusätzlich wird nur dein markierter Bildausschnitt angehängt. Prüfe die Vorschau: Sichtbare Namen oder Nachrichten können darin enthalten sein.";
function renderReportScreenshot() {
  const preview = $("report-shot-preview");
  preview.classList.toggle("hidden", !reportScreenshot);
  $("report-privacy-copy").textContent = reportScreenshot ? screenshotPrivacy : plainPrivacy;
  if (!reportScreenshot) { $("report-shot-image").removeAttribute("src"); return; }
  $("report-shot-image").src = `data:${reportScreenshot.mimeType};base64,${reportScreenshot.base64}`;
  $("report-shot-meta").textContent = `${reportScreenshot.width} × ${reportScreenshot.height} Pixel · ${Math.max(1, Math.round(reportScreenshot.bytes / 1024))} KB`;
}
function openReport(kind = "feedback", activityId = null) {
  reportKind = kind === "error" ? "error" : "feedback";
  reportActivityId = reportKind === "error" ? Number(activityId) : null;
  $("report-title").textContent = reportKind === "error" ? "Fehler melden" : "Feedback senden";
  $("report-copy").textContent = reportKind === "error"
    ? "Der technische Fehler wird automatisch ergänzt. Wenn du möchtest, beschreibe kurz, was du gerade tun wolltest."
    : "Was können wir verständlicher oder zuverlässiger machen?";
  $("report-message-label").textContent = reportKind === "error" ? "Deine Ergänzung (optional)" : "Dein Feedback";
  $("report-message").placeholder = reportKind === "error" ? "z. B. Der Fehler kam direkt nach dem Start der Kontaktsuche." : "Beschreibe kurz, was dir aufgefallen ist.";
  $("report-send").textContent = reportKind === "error" ? "Fehler melden" : "Feedback senden";
  $("report-message").value = "";
  $("report-note").textContent = "";
  reportScreenshot = null;
  renderReportScreenshot();
  $("report-modal").classList.remove("hidden");
  setTimeout(() => $("report-message").focus(), 20);
}
function closeReport() { $("report-modal").classList.add("hidden"); reportScreenshot = null; renderReportScreenshot(); }
function finishCapture(cancelled = false) {
  $("capture-overlay").classList.add("hidden");
  $("capture-overlay").classList.remove("selecting");
  captureStart = null;
  $("report-modal").classList.remove("hidden");
  if (cancelled) setTimeout(() => $("report-capture").focus(), 20);
}
function beginCapture() {
  if (!window.nextlead?.captureFeedbackRegion) { $("report-note").textContent = "Bereiche lassen sich nur in der installierten NextLead-App markieren."; return; }
  $("report-note").textContent = "";
  $("report-modal").classList.add("hidden");
  $("capture-overlay").classList.remove("hidden");
}

$("feedback-open").onclick = () => openReport("feedback");
$("report-close").onclick = closeReport;
$("report-cancel").onclick = closeReport;
$("report-backdrop").onclick = closeReport;
$("report-capture").onclick = beginCapture;
$("report-shot-remove").onclick = () => { reportScreenshot = null; renderReportScreenshot(); };
$("capture-overlay").addEventListener("pointerdown", (event) => {
  captureStart = { x: event.clientX, y: event.clientY };
  const selection = $("capture-selection");
  selection.style.cssText = `left:${event.clientX}px;top:${event.clientY}px;width:0;height:0`;
  $("capture-overlay").classList.add("selecting");
  $("capture-overlay").setPointerCapture?.(event.pointerId);
});
$("capture-overlay").addEventListener("pointermove", (event) => {
  if (!captureStart) return;
  const x = Math.min(captureStart.x, event.clientX), y = Math.min(captureStart.y, event.clientY);
  const width = Math.abs(event.clientX - captureStart.x), height = Math.abs(event.clientY - captureStart.y);
  Object.assign($("capture-selection").style, { left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px` });
});
$("capture-overlay").addEventListener("pointerup", async (event) => {
  if (!captureStart) return;
  const rect = { x: Math.min(captureStart.x, event.clientX), y: Math.min(captureStart.y, event.clientY), width: Math.abs(event.clientX - captureStart.x), height: Math.abs(event.clientY - captureStart.y) };
  if (rect.width < 24 || rect.height < 24) { finishCapture(true); $("report-note").textContent = "Der markierte Bereich war zu klein."; return; }
  $("capture-overlay").classList.add("hidden");
  $("capture-overlay").classList.remove("selecting");
  captureStart = null;
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  try {
    reportScreenshot = await window.nextlead.captureFeedbackRegion(rect);
    renderReportScreenshot();
  } catch (error) { $("report-note").textContent = `Screenshot fehlgeschlagen: ${error.message}`; }
  $("report-modal").classList.remove("hidden");
});
$("report-send").onclick = async () => {
  const button = $("report-send"); const note = $("report-note");
  const message = $("report-message").value.trim();
  if (reportKind === "feedback" && message.length < 3) { note.textContent = "Bitte beschreibe dein Feedback kurz."; $("report-message").focus(); return; }
  button.disabled = true; note.textContent = "";
  try {
    const result = await post("/api/report", { kind: reportKind, activityId: reportActivityId, message, replyEmail: $("report-email").value.trim(), screenshot: reportScreenshot }, 20000);
    closeReport();
    toast(result.sent ? "Danke – die Meldung wurde gesendet." : "Meldung gespeichert. NextLead sendet sie, sobald der Dienst erreichbar ist.");
  } catch (error) { note.textContent = `Nicht gespeichert: ${error.message}`; }
  finally { button.disabled = false; }
};
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!$("capture-overlay").classList.contains("hidden")) finishCapture(true);
  else if (!$("report-modal").classList.contains("hidden")) closeReport();
  else if (!$("relationship-modal").classList.contains("hidden")) closeRelationshipModal();
  else if (!$("contact-workspace-modal").classList.contains("hidden")) closeContactWorkspace();
});

// Der Prüf-Bereich wird von zwei Stellen genutzt: "Heute" (nach Entwurfsart) und der Kampagne
// (alle Einladungen genau dieser Kampagne). reviewCampaign entscheidet, welcher Container zeichnet.
function reviewList() {
  const drafts = state.drafts || [];
  if (reviewCampaign) return drafts.filter((draft) => String(draft.incoming) === `campaign:${reviewCampaign}`);
  return drafts.filter((draft) => reviewKinds?.includes(draft.kind));
}
const reviewerHost = () => $(reviewCampaign ? "campaign-reviewer" : "reviewer");
function closeReviewer() { reviewKinds = null; reviewCampaign = null; $("reviewer").classList.add("hidden"); $("campaign-reviewer").classList.add("hidden"); }
function profileCard(draft) {
  const profile = draft.profile || {};
  const name = profile.fullName || draft.participant || "Kontakt";
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "?";
  const directProfileUrl = profile.profileUrl || (/linkedin\.com\/in\//i.test(draft.thread_url || "") ? draft.thread_url : "");
  const status = STATUS[profile.status] || profile.status || "Im Gespräch";
  const headline = profile.headline && !/^[-–—\s]+$/.test(profile.headline) ? profile.headline : "Noch keine Profil-Headline gespeichert.";
  return `<aside class="profile-preview"><span class="eyebrow">Profil zum Entwurf</span><div class="profile-avatar">${esc(initials)}</div><h4>${esc(name)}</h4><p>${esc(headline)}</p><div class="profile-facts"><div><span>Status</span><b>${esc(status)}</b></div>${profile.leadScore != null ? `<div><span>Lead-Score</span><b>${Number(profile.leadScore)} / 100</b></div>` : ""}${profile.campaignName ? `<div><span>Kampagne</span><b>${esc(profile.campaignName)}</b></div>` : ""}<div><span>Herkunft</span><b>${profile.networkContact ? "Bestehendes Netzwerk" : "Outreach"}</b></div></div>${directProfileUrl ? `<a class="profile-link" href="${esc(directProfileUrl)}" target="_blank" rel="noopener">LinkedIn-Profil öffnen ↗</a>` : `<small class="profile-missing">Für diesen Chat ist noch keine Profil-URL zugeordnet.</small>`}</aside>`;
}
function contextEvidenceCard(draft) {
  if (!["first", "followup", "reaktivierung", "event"].includes(draft.kind)) return "";
  let evidence = null;
  try { evidence = JSON.parse(draft.context_evidence_json || "null"); } catch { evidence = null; }
  const intentLabels = { later: "Später", busy: "Aktuell beschäftigt", not_interested: "Kein Interesse", do_not_contact: "Nicht mehr anschreiben", interested: "Interessiert", meeting: "Terminwunsch", question: "Offene Frage", neutral: "Neutral" };
  if (!evidence) return `<section class="context-evidence empty"><div class="context-evidence-head"><span>Gesprächsbeleg</span><b>Erstkontakt: noch nichts gesendet</b></div><p>An diese Person ging bisher keine Nachricht raus. Der Entwurf stützt sich auf Profil, Kampagnenziel und hinterlegte Fakten.</p></section>`;
  const blocked = draft.context_validation === "blocked" || draft.context_validation === "stale";
  const out = evidence.outbound || { count: 0 };
  const datum = (wert) => { try { return new Date(String(wert).replace(" ", "T")).toLocaleDateString("de-DE"); } catch { return String(wert); } };
  const facts = [
    // Zuerst: haben wir überhaupt schon geschrieben? Das entscheidet, ob eine Begrüßung passt.
    out.count ? ["Bereits gesendet", `${out.count}× · zuletzt ${out.lastKind || "Nachricht"}${out.lastAt ? ` am ${datum(out.lastAt)}` : ""}`] : ["Bereits gesendet", "Noch nichts – das ist der Erstkontakt"],
    out.lastText ? ["Zuletzt geschrieben", `„${out.lastText}“`] : null,
    evidence.lastStatement ? ["Letzte Aussage", `„${evidence.lastStatement}“`] : null,
    ["Erkannte Absicht", intentLabels[evidence.intent] || evidence.intent],
    evidence.commitment ? ["Zusage", evidence.commitment] : null,
    evidence.openPoint ? ["Offener Punkt", evidence.openPoint] : null,
  ].filter(Boolean);
  return `<section class="context-evidence ${blocked ? "conflict" : ""}"><div class="context-evidence-head"><span>${blocked ? "Konflikt im Gespräch" : "Warum passt diese Nachricht?"}</span><b>${blocked ? "Nicht freigeben" : out.count ? "Kein Erstkontakt" : "Kontext geprüft"}</b></div><div class="context-evidence-grid">${facts.map(([label, value]) => `<div><span>${esc(label)}</span><p>${esc(value)}</p></div>`).join("")}</div>${evidence.nextContactAt ? `<small>Nächste Ansprache frühestens: ${esc(new Date(evidence.nextContactAt.replace(" ", "T")).toLocaleDateString("de-DE"))}</small>` : ""}</section>`;
}
function bindDraftDelete(draft, reviewer) {
  const button = reviewer.querySelector('[data-review-action="delete"]');
  if (!button) return;
  let armed = false;
  button.onclick = async () => {
    if (!armed) {
      armed = true;
      button.classList.add("armed");
      button.textContent = "Wirklich löschen?";
      button.title = "Der Entwurf wird als erledigt markiert und für diese Nachricht nicht erneut erzeugt.";
      return;
    }
    button.disabled = true; button.textContent = "Wird gelöscht…";
    try {
      await post("/api/draft", { id: draft.id, action: "delete" }, 10000);
      toast("Entwurf gelöscht. Er wird nicht erneut erstellt.");
      await load(); renderReviewer();
    } catch (error) { toast(`Löschen fehlgeschlagen: ${error.message}`); renderReviewer(); }
  };
}
function renderReviewer() {
  const reviewer = reviewerHost(), list = reviewList();
  $(reviewCampaign ? "reviewer" : "campaign-reviewer").classList.add("hidden");
  if ((!reviewKinds && !reviewCampaign) || !list.length) { reviewer.classList.add("hidden"); return; }
  reviewIndex = Math.min(reviewIndex, list.length - 1);
  const draft = list[reviewIndex]; reviewer.classList.remove("hidden");
  if (draft.phase === "approach") {
    let options = []; try { options = JSON.parse(draft.draft || "[]"); } catch {}
    reviewer.innerHTML = `<div class="review-head"><div class="review-person"><span class="eyebrow">Neue Gesprächsrichtung</span><h3>${esc(draft.participant || "Kontakt")}</h3><p>Wähle zuerst die Idee. Danach schreibt NextLead einen komplett neuen Text.</p></div><span class="review-progress">${reviewIndex + 1} / ${list.length}</span></div><div class="review-context">${profileCard(draft)}<div class="review-compose">${draft.incoming && !String(draft.incoming).startsWith("campaign:") ? `<div class="incoming">${esc(draft.incoming)}</div>` : ""}<div class="approach-grid">${options.map((option, index) => `<button class="approach-card" data-approach="${esc(option.key)}"><span>0${index + 1}</span><b>${esc(option.title)}</b><small>${esc(option.description)}</small></button>`).join("")}</div><div class="review-actions"><button data-review-action="delete" class="delete-draft">Entwurf löschen</button></div></div></div>`;
    reviewer.querySelectorAll("[data-approach]").forEach((button) => button.addEventListener("click", async () => { button.disabled = true; await post("/api/draft", { id: draft.id, action: "choose_approach", text: { approachKey: button.dataset.approach } }); toast("Neue Richtung gewählt. Nachricht wurde neu geschrieben."); await load(); renderReviewer(); }));
    bindDraftDelete(draft, reviewer);
  } else if (draft.kind === "pitchidee") {
    let ideas = []; try { ideas = JSON.parse(draft.draft || "[]"); } catch {}
    reviewer.innerHTML = `<div class="review-head"><div class="review-person"><span class="eyebrow">Pitch-Richtung wählen</span><h3>${esc(draft.participant || "Kontakt")}</h3></div><span class="review-progress">${reviewIndex + 1} / ${list.length}</span></div><div class="review-context">${profileCard(draft)}<div class="review-compose"><div class="incoming">${esc(draft.incoming || "Kein Eingangstext gespeichert.")}</div><div class="work-groups">${ideas.map((idea, index) => `<button class="work-item${index === 0 ? " recommended" : ""}" data-pitch="${index}"><span class="work-icon">${index + 1}</span><span class="work-copy"><b>Ansatz ${index + 1}${index === 0 ? ' <em class="recommended-label">(Empfohlen)</em>' : ""}</b><span>${esc(idea)}</span></span></button>`).join("")}</div><div class="review-actions"><button data-review-action="delete" class="delete-draft">Entwurf löschen</button></div></div></div>`;
    reviewer.querySelectorAll("[data-pitch]").forEach((button) => button.addEventListener("click", async () => { button.disabled = true; await post("/api/pitch", { id: draft.id, idee: ideas[Number(button.dataset.pitch)] }); toast("Nachricht wird vorbereitet."); await load(); renderReviewer(); }));
    bindDraftDelete(draft, reviewer);
  } else {
    const label = { message: "Antwort", first: "Erstnachricht", followup: "Follow-up", reaktivierung: "Netzwerk-Zusatz · Freigabe erforderlich", event: "Event-Einladung" }[draft.kind] || "Entwurf";
    const reviewHint = draft.kind === "reaktivierung"
      ? "Zusätzlicher Kontakt – wird nur nach deiner Genehmigung gesendet."
      : draft.approach_key ? `Ansatz: ${draft.approach_key.replaceAll("_", " ")}` : draft.intent || "bereit zur Prüfung";
    reviewer.innerHTML = `<div class="review-head"><div class="review-person"><span class="eyebrow">${label}</span><h3>${esc(draft.participant || "Kontakt")}</h3><p>${esc(reviewHint)}</p></div><span class="review-progress">${reviewIndex + 1} / ${list.length}</span></div><div class="review-context">${profileCard(draft)}<div class="review-compose">${draft.incoming && !String(draft.incoming).startsWith("campaign:") ? `<div class="incoming">${esc(draft.incoming)}</div>` : ""}${contextEvidenceCard(draft)}<textarea data-review-field="text">${esc(draft.draft)}</textarea><div data-review-panel="reject" class="reject-feedback hidden"><span class="eyebrow">Was soll sich ändern?</span><div class="feedback-options"><button data-feedback="different_approach">Komplett anderer Ansatz</button><button data-feedback="artificial">Klingt künstlich</button><button data-feedback="too_personal">Zu persönlich</button><button data-feedback="too_salesy">Zu verkäuferisch</button></div><div class="custom-feedback"><input data-review-field="feedback" placeholder="Oder beschreibe kurz deine gewünschte Richtung…"/><button data-review-action="rewrite">Neu schreiben</button></div></div><div class="review-actions"><button data-review-action="delete" class="delete-draft">Entwurf löschen</button><button data-review-action="reject">Ablehnen</button><button data-review-action="approve" class="primary">Genehmigen</button></div></div></div>`;
    const approve = reviewer.querySelector('[data-review-action="approve"]');
    const reject = reviewer.querySelector('[data-review-action="reject"]');
    const textField = reviewer.querySelector('[data-review-field="text"]');
    const rejectPanel = reviewer.querySelector('[data-review-panel="reject"]');
    const feedbackField = reviewer.querySelector('[data-review-field="feedback"]');
    const rewrite = reviewer.querySelector('[data-review-action="rewrite"]');
    approve.onclick = async () => {
      const button = approve;
      button.disabled = true; reject.disabled = true; button.textContent = "Wird gespeichert…";
      try {
        await post("/api/draft", { id: draft.id, action: "approve", text: textField.value }, 10000);
        toast("Genehmigt – NextLead stellt sicher zu."); await load(); renderReviewer();
      } catch (error) { toast(`Genehmigen fehlgeschlagen: ${error.message}`); renderReviewer(); }
    };
    reject.onclick = () => { rejectPanel.classList.toggle("hidden"); rejectPanel.scrollIntoView({ behavior: "smooth", block: "nearest" }); };
    const rejectWith = async (reason, instruction = "") => {
      const buttons = reviewer.querySelectorAll("button");
      buttons.forEach((button) => { button.disabled = true; });
      const selected = reviewer.querySelector(`[data-feedback="${reason}"]`) || rewrite;
      if (selected) selected.textContent = reason === "different_approach" ? "Richtungen werden geladen…" : "Wird neu geschrieben…";
      try {
        await post("/api/draft", { id: draft.id, action: "reject", text: { reason, instruction } }, 90000);
        toast(reason === "different_approach" ? "Wähle jetzt eine neue Gesprächsrichtung." : "Feedback gespeichert. Nachricht wurde neu geschrieben.");
        await load(); renderReviewer();
      } catch (error) { toast(`Ablehnen fehlgeschlagen: ${error.message}`); renderReviewer(); }
    };
    reviewer.querySelectorAll("[data-feedback]").forEach((button) => button.addEventListener("click", () => rejectWith(button.dataset.feedback)));
    rewrite.onclick = () => { const instruction = feedbackField.value.trim(); if (!instruction) return feedbackField.focus(); rejectWith("custom", instruction); };
    bindDraftDelete(draft, reviewer);
  }
  if (reviewCampaign) {
    // In der Kampagne ist die Prüfung ein aufklappbarer Bereich – deshalb ein eigenes Schließen.
    const head = reviewer.querySelector(".review-head");
    if (head) {
      const close = document.createElement("button");
      close.className = "icon-btn"; close.textContent = "×"; close.setAttribute("aria-label", "Prüfung schließen");
      close.onclick = closeReviewer;
      head.appendChild(close);
    }
  }
  reviewer.scrollIntoView({ behavior: "smooth", block: "start" });
}

function campaignCandidates() {
  const terms = $("campaign-keywords").value.toLowerCase().split(/[,;]+/).map((term) => term.trim()).filter(Boolean);
  const region = $("campaign-region").value.toLowerCase().trim(); const min = Number($("campaign-score").value || 0); const scope = $("campaign-scope").value;
  return (state.contacts || []).filter((contact) => {
    if (["closed", "skipped"].includes(contact.status)) return false;
    const text = `${contact.full_name || ""} ${contact.headline || ""}`.toLowerCase(); if (terms.length && !terms.some((term) => text.includes(term))) return false; if (region && !text.includes(region)) return false; if ((contact.lead_score || 0) < min) return false;
    const connected = !!contact.aus_netzwerk || !!contact.accepted_at || ["accepted", "messaged", "replied"].includes(contact.status); return scope === "both" || (scope === "network" ? connected : !connected);
  });
}
let confirmedCampaignPreview = null;
function updateCampaignPreview() {
  confirmedCampaignPreview = null;
  const list = campaignCandidates(); const network = list.filter((contact) => !!contact.aus_netzwerk || !!contact.accepted_at || ["accepted", "messaged", "replied"].includes(contact.status)).length;
  $("preview-total").textContent = list.length; $("preview-network").textContent = network; $("preview-external").textContent = list.length - network;
  $("save-campaign").textContent = editingCampaign ? "Vorschau prüfen" : "Zielgruppe sicher prüfen";
}

// Kampagnen-Formular: dasselbe Formular legt an UND bearbeitet. editingCampaign hält die ID,
// solange eine bestehende Kampagne offen ist – nur dann ist auch das Material bearbeitbar,
// weil Dateien immer zu einer gespeicherten Kampagne gehören.
let editingCampaign = null;
function campaignFormValues() {
  return {
    name: $("campaign-name").value, kind: "event", eventUrl: $("campaign-url").value, eventDate: $("campaign-date").value,
    eventTime: $("campaign-time").value, location: $("campaign-location").value, briefing: $("campaign-briefing").value,
    valueProp: $("campaign-value").value, audienceScope: $("campaign-scope").value, audience: $("campaign-keywords").value,
    filters: { keywords: $("campaign-keywords").value, region: $("campaign-region").value, minScore: Number($("campaign-score").value) },
    messageTemplate: $("campaign-message").value, dailyLimit: Number($("campaign-limit").value), goal: "Event-Teilnahmen",
  };
}
function openCampaignForm(campaign) {
  editingCampaign = campaign ? campaign.id : null;
  confirmedCampaignPreview = null;
  let filters = {}; try { filters = JSON.parse(campaign?.filters_json || "{}"); } catch { filters = {}; }
  $("campaign-name").value = campaign?.name || "";
  $("campaign-url").value = campaign?.event_url || "";
  $("campaign-date").value = campaign?.event_date || "";
  $("campaign-time").value = campaign?.event_time || "";
  $("campaign-location").value = campaign?.location || "";
  $("campaign-briefing").value = campaign?.briefing || "";
  $("campaign-value").value = campaign?.value_prop || "";
  $("campaign-scope").value = campaign?.audience_scope || "both";
  $("campaign-keywords").value = filters.keywords || "";
  $("campaign-region").value = filters.region || "";
  $("campaign-score").value = campaign ? Number(filters.minScore || 0) : 50;
  $("campaign-limit").value = campaign?.daily_limit || 10;
  $("campaign-message").value = campaign?.message_template || "";
  $("campaign-form-eyebrow").textContent = campaign ? "Kampagne bearbeiten" : "Neue Event-Kampagne";
  $("campaign-form-title").textContent = campaign ? campaign.name : "Ziel und Zielgruppe festlegen";
  $("save-campaign").textContent = campaign ? "Änderungen speichern" : "Kampagne starten";
  $("campaign-note").textContent = ""; $("asset-note").textContent = "";
  $("campaign-form").classList.remove("hidden");
  renderAssets();
  updateCampaignPreview();
  $("campaign-form").scrollIntoView({ behavior: "smooth" });
}
function currentCampaign() { return (state.campaigns || []).find((campaign) => campaign.id === editingCampaign) || null; }
function renderAssets() {
  const campaign = currentCampaign();
  $("campaign-assets").classList.toggle("locked", !campaign);
  const assets = campaign?.assets || [];
  $("asset-list").innerHTML = !campaign
    ? `<p class="asset-hint">Speichere die Kampagne zuerst – danach kannst du Flyer und Links hinterlegen.</p>`
    : (assets.length ? assets.map((asset) => `<div class="asset-item"><div><b>${esc(asset.name)}</b>${asset.summary ? `<span>${esc(asset.summary)}</span>` : `<span class="asset-missing">Ohne Kernaussagen nutzt die KI dieses Material nicht.</span>`}</div><div class="asset-actions">${asset.file_name ? `<a href="/api/campaign-asset?id=${asset.id}" target="_blank" rel="noopener">Öffnen ↗</a>` : ""}${asset.url ? `<a href="${esc(asset.url)}" target="_blank" rel="noopener">Link ↗</a>` : ""}<button data-asset-delete="${asset.id}">Entfernen</button></div></div>`).join("")
      : `<p class="asset-hint">Noch kein Material hinterlegt.</p>`);
  document.querySelectorAll("[data-asset-delete]").forEach((button) => button.addEventListener("click", async () => {
    await post("/api/campaign-asset", { action: "delete", id: Number(button.dataset.assetDelete) });
    await load(); renderAssets(); toast("Material entfernt.");
  }));
}
const readFileBase64 = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onerror = () => reject(new Error("Datei konnte nicht gelesen werden."));
  reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
  reader.readAsDataURL(file);
});
/**
 * KAMPAGNEN-CRM (2026-08-05): eine eigene Kontaktliste je Kampagne. Die große Kontakte-Ansicht
 * zeigt alle 589 Kontakte – beim Arbeiten an einem Event will man nur die Zielgruppe DIESER
 * Kampagne sehen und dort das Ergebnis festhalten. Zuordnung über `campaignTargets`, weil ein
 * Kontakt in mehreren Kampagnen stecken kann.
 */
let crmCampaign = null;
let crmFilter = "all";

// Stufe des Kontakts INNERHALB der Kampagne. Der Ziel-Status sagt, wie weit die Kampagne ist,
// der Kontakt-Status, was daraus geworden ist. Die spätere Stufe gewinnt.
const CRM_STUFEN = {
  awaiting_connection: ["Wartet auf Vernetzung", "wait"],
  queued: ["Eingeplant", "wait"],
  generating: ["Entwurf wird erstellt", "draft"],
  drafted: ["Entwurf liegt bereit", "draft"],
  approved: ["Freigegeben", "draft"],
  sending: ["Wird gesendet", "draft"],
  sent: ["Eingeladen", "sent"],
  completed: ["Hat geantwortet", "reply"],
  snoozed: ["Wiedervorlage", "wait"],
  excluded: ["Ausgeschlossen", "wait"],
  failed: ["Prüfung nötig", "error"],
};
const OUTCOMES = [["", "– offen –"], ["qualified", "Qualifiziert"], ["meeting", "Termin"], ["won", "Gewonnen"], ["lost", "Verloren"], ["not_fit", "Passt nicht"]];

/**
 * Eine Antwort zählt für die Kampagne NUR, wenn sie nach der Einladung kam. `replied_at` ist ein
 * globaler CRM-Marker ("hat irgendwann mal geantwortet"); ihn ungeprüft als Kampagnen-Erfolg zu
 * zeigen war schlicht falsch – die erste Fassung meldete Juli-Antworten als Reaktion auf eine
 * Einladung von heute, teils für Kontakte, die noch gar keine bekommen hatten.
 */
function hatAufKampagneGeantwortet(target, contact) {
  return !!(contact.replied_at && target.invitedAt && contact.replied_at > target.invitedAt);
}
function crmStufe(target, contact) {
  if (hatAufKampagneGeantwortet(target, contact)) return ["Hat geantwortet", "reply"];
  const [label, cls] = CRM_STUFEN[target.status] || [target.status, "wait"];
  // Frühere Gespräche sind nützlicher Kontext, aber kein Kampagnen-Ergebnis.
  if (contact.replied_at) return [`${label} · früher im Kontakt`, cls];
  return [label, cls];
}

function renderCampaignCrm() {
  const box = $("campaign-crm");
  if (!box) return;
  const campaign = (state.campaigns || []).find((item) => item.id === crmCampaign);
  if (!campaign) { box.classList.add("hidden"); box.innerHTML = ""; return; }
  box.classList.remove("hidden");
  const byId = new Map((state.contacts || []).map((contact) => [contact.id, contact]));
  const alle = (state.campaignTargets || [])
    .filter((target) => target.campaignId === campaign.id)
    .map((target) => ({ target, contact: byId.get(target.contactId) }))
    .filter((row) => row.contact);
  const zaehler = {
    all: alle.length,
    sent: alle.filter((row) => row.target.status === "sent").length,
    drafted: alle.filter((row) => ["generating", "drafted", "approved", "sending"].includes(row.target.status)).length,
    failed: alle.filter((row) => row.target.status === "failed").length,
    offen: alle.filter((row) => ["queued", "awaiting_connection"].includes(row.target.status)).length,
    protected: alle.filter((row) => ["snoozed", "excluded"].includes(row.target.status)).length,
    reply: alle.filter((row) => hatAufKampagneGeantwortet(row.target, row.contact)).length,
  };
  const suche = ($("campaign-crm-search")?.value || "").toLowerCase().trim();
  let zeilen = alle;
  if (crmFilter === "sent") zeilen = zeilen.filter((row) => row.target.status === "sent");
  else if (crmFilter === "drafted") zeilen = zeilen.filter((row) => ["generating", "drafted", "approved", "sending"].includes(row.target.status));
  else if (crmFilter === "failed") zeilen = zeilen.filter((row) => row.target.status === "failed");
  else if (crmFilter === "offen") zeilen = zeilen.filter((row) => ["queued", "awaiting_connection"].includes(row.target.status));
  else if (crmFilter === "protected") zeilen = zeilen.filter((row) => ["snoozed", "excluded"].includes(row.target.status));
  else if (crmFilter === "reply") zeilen = zeilen.filter((row) => hatAufKampagneGeantwortet(row.target, row.contact));
  if (suche) zeilen = zeilen.filter((row) => `${row.contact.full_name || ""} ${row.contact.headline || ""}`.toLowerCase().includes(suche));
  const chips = [["all", "Alle"], ["offen", "Eingeplant"], ["protected", "Geschützt"], ["drafted", "Entwurf"], ["failed", "Prüfen"], ["sent", "Eingeladen"], ["reply", "Geantwortet"]]
    .map(([key, label]) => `<button class="crm-chip ${crmFilter === key ? "active" : ""}" data-crm-filter="${key}">${label} ${zaehler[key] ?? 0}</button>`).join("");
  box.innerHTML = `
    <div class="review-head"><div class="review-person"><span class="eyebrow">Kampagnen-CRM</span><h3>${esc(campaign.name)}</h3><p>Nur die Kontakte dieser Kampagne. Das Ergebnis pflegst du direkt hier.</p></div><button class="icon-btn" data-crm-close>×</button></div>
    <div class="crm-toolbar">${chips}<input id="campaign-crm-search" placeholder="Name oder Position suchen" value="${esc(suche)}"/></div>
    <div class="crm-rows">${zeilen.length ? zeilen.slice(0, 200).map(({ target, contact }) => {
      const [stufe, cls] = crmStufe(target, contact);
      const grund = target.lastError || target.reason || "";
      return `<div class="crm-row"><div class="contact-person"><b>${esc(contact.full_name || "Unbekannt")}</b><span>${esc(grund || contact.headline || "Keine Headline")}</span></div><span class="crm-stufe ${cls}">${esc(stufe)}</span><span class="muted">${target.route === "network" ? "Netzwerk" : "Außerhalb"}</span><select data-crm-outcome="${contact.id}">${OUTCOMES.map(([value, label]) => `<option value="${value}" ${((contact.outcome_stage || "") === value) ? "selected" : ""}>${label}</option>`).join("")}</select><a href="${esc(contact.profile_url)}" target="_blank" rel="noopener">Profil ↗</a></div>`;
    }).join("") : `<div class="empty-work">Kein Kontakt in diesem Filter.</div>`}</div>
    ${zeilen.length > 200 ? `<p class="muted">Erste 200 von ${zeilen.length} angezeigt – nutze die Suche.</p>` : ""}`;
  box.querySelector("[data-crm-close]").addEventListener("click", () => { crmCampaign = null; renderCampaignCrm(); });
  box.querySelectorAll("[data-crm-filter]").forEach((button) => button.addEventListener("click", () => { crmFilter = button.dataset.crmFilter; renderCampaignCrm(); }));
  const feld = $("campaign-crm-search");
  feld.addEventListener("input", () => renderCampaignCrm());
  if (suche) { feld.focus(); feld.setSelectionRange(suche.length, suche.length); }
  box.querySelectorAll("[data-crm-outcome]").forEach((select) => select.addEventListener("change", async () => {
    const stage = select.value;
    if (!stage) return toast("Ein gesetztes Ergebnis lässt sich hier nicht zurücknehmen.");
    select.disabled = true;
    try { await post("/api/outcome", { contactId: Number(select.dataset.crmOutcome), stage }); toast("Ergebnis gespeichert."); await load(true); renderCampaignCrm(); }
    catch (error) { toast(`Nicht gespeichert: ${error.message}`); select.disabled = false; }
  }));
}

function renderCampaigns() {
  const campaigns = state.campaigns || []; $("nav-campaigns").textContent = campaigns.filter((campaign) => campaign.active).length || "";
  $("campaign-list").innerHTML = campaigns.length ? campaigns.map((campaign) => {
    const facts = [campaign.event_date, campaign.event_time, campaign.location].filter(Boolean).join(" · ");
    const assets = (campaign.assets || []).length;
    const offen = (state.drafts || []).filter((draft) => String(draft.incoming) === `campaign:${campaign.id}`).length;
    const rail = [["Zielgruppe", campaign.targets || campaign.leads || 0], ["Vernetzen", campaign.target_waiting || 0], ["Bereit", (campaign.target_ready || 0) + (campaign.target_generating || 0)], ["Entwurf", campaign.target_drafted || 0], ["Gesendet", campaign.target_sent || 0], ["Antwort", campaign.target_completed || 0]];
    return `<article class="campaign-card ${campaign.goal_code ? "mission-card" : ""}"><div><div class="campaign-meta"><span class="pill ${campaign.active ? "live" : ""}">${campaign.active ? "Läuft" : "Pausiert"}</span>${campaign.goal_code ? `<span class="pill goal-code goal-${esc(String(campaign.goal_code).toLowerCase())}">${esc(campaign.goal_code)}</span>` : ""}<span class="pill">${campaign.kind === "event" ? "Event" : "Outreach"}</span><span class="pill">${campaign.audience_scope === "both" ? "Netzwerk + außerhalb" : campaign.audience_scope === "network" ? "Netzwerk" : "Außerhalb"}</span>${assets ? `<span class="pill">${assets} Material${assets === 1 ? "" : "ien"}</span>` : ""}</div><h3>${esc(campaign.name)}</h3><span class="muted">${esc(campaign.search_brief || facts || campaign.goal || "")}${campaign.event_url ? ` · <a href="${esc(campaign.event_url)}" target="_blank" rel="noopener">Event öffnen ↗</a>` : ""}</span>${campaign.briefing ? `<p class="campaign-briefing">${esc(String(campaign.briefing).slice(0, 220))}${String(campaign.briefing).length > 220 ? "…" : ""}</p>` : ""}<div class="workflow-rail">${rail.map(([label, count], index) => `<div class="workflow-step ${count ? "has-work" : ""}"><span>${index + 1}</span><b>${count}</b><small>${label}</small></div>`).join("")}</div>${campaign.target_snoozed ? `<p class="workflow-note">${campaign.target_snoozed} Kontakt${campaign.target_snoozed === 1 ? " ist" : "e sind"} durch Beziehungsschutz pausiert.</p>` : ""}${campaign.target_failed ? `<p class="workflow-error">${campaign.target_failed} Kontakt${campaign.target_failed === 1 ? " braucht" : "e brauchen"} eine Prüfung – kein stilles Festhängen mehr.</p>` : ""}</div><div class="campaign-actions">${offen ? `<button class="primary" data-campaign-review="${campaign.id}">${offen} Nachricht${offen === 1 ? "" : "en"} prüfen</button>` : `<span class="campaign-clear">Keine Nachricht offen</span>`}${campaign.target_failed ? `<button class="workflow-retry" data-campaign-retry-failed="${campaign.id}">Fehler erneut prüfen (${campaign.target_failed})</button>` : ""}<button data-campaign-crm="${campaign.id}">Kontakte ansehen</button>${campaign.goal_code ? "" : `<button data-campaign-edit="${campaign.id}">Bearbeiten</button>`}<button data-campaign-toggle="${campaign.id}" data-active="${campaign.active ? 1 : 0}">${campaign.active ? "Pausieren" : "Fortsetzen"}</button><button class="delete-draft" data-campaign-delete="${campaign.id}" data-name="${esc(campaign.name)}" data-offen="${offen}">Löschen</button></div></article>`;
  }).join("") : `<div class="empty-work"><b>Noch kein Auftrag.</b><br/>Beschreibe, wen NextLead finden soll, und wähle B1, P1 oder AEC.</div>`;
  document.querySelectorAll("[data-campaign-toggle]").forEach((button) => button.addEventListener("click", async () => { await post("/api/campaign", { action: button.dataset.active === "1" ? "pause" : "resume", id: Number(button.dataset.campaignToggle) }); await load(); toast("Kampagne aktualisiert."); }));
  document.querySelectorAll("[data-campaign-retry-failed]").forEach((button) => button.addEventListener("click", async () => {
    button.disabled = true;
    try { const result = await post("/api/campaign", { action: "retry_failed", id: Number(button.dataset.campaignRetryFailed) }); await load(); toast(`${result.retried} Kontakt${result.retried === 1 ? " wird" : "e werden"} kontrolliert erneut versucht.`); }
    catch (error) { toast(`Wiederholung fehlgeschlagen: ${error.message}`); button.disabled = false; }
  }));
  document.querySelectorAll("[data-campaign-edit]").forEach((button) => button.addEventListener("click", () => {
    openCampaignForm((state.campaigns || []).find((campaign) => campaign.id === Number(button.dataset.campaignEdit)));
  }));
  document.querySelectorAll("[data-campaign-crm]").forEach((button) => button.addEventListener("click", () => {
    const id = Number(button.dataset.campaignCrm);
    crmCampaign = crmCampaign === id ? null : id; // nochmal klicken schließt
    renderCampaignCrm();
  }));
  renderCampaignCrm();
  // Einladungen werden HIER geprüft, nicht in "Heute": Kontext und Texte bleiben zusammen.
  document.querySelectorAll("[data-campaign-review]").forEach((button) => button.addEventListener("click", () => {
    const id = Number(button.dataset.campaignReview);
    if (reviewCampaign === id) return closeReviewer();
    reviewKinds = null; reviewCampaign = id; reviewIndex = 0; renderReviewer();
  }));
  // Löschen ist endgültig und nimmt die Entwürfe mit – deshalb zweistufig mit klarer Ansage.
  document.querySelectorAll("[data-campaign-delete]").forEach((button) => {
    let armed = false;
    button.addEventListener("click", async () => {
      const id = Number(button.dataset.campaignDelete);
      const offen = Number(button.dataset.offen || 0);
      if (!armed) {
        armed = true; button.classList.add("armed");
        button.textContent = offen ? `„${button.dataset.name}“ mit ${offen} Nachricht${offen === 1 ? "" : "en"} löschen?` : `„${button.dataset.name}“ wirklich löschen?`;
        return;
      }
      button.disabled = true;
      const result = await post("/api/campaign", { action: "delete", id });
      if (reviewCampaign === id) closeReviewer();
      if (editingCampaign === id) { editingCampaign = null; $("campaign-form").classList.add("hidden"); }
      await load();
      toast(`Kampagne gelöscht – ${result.drafts || 0} Nachricht${result.drafts === 1 ? "" : "en"} und ${result.targets || 0} Zielkontakte entfernt.`);
    });
  });
  if (editingCampaign) renderAssets();
  updateCampaignPreview();
}

const STATUS = { new: "Neu", inviting: "Wird angefragt", invited: "Anfrage offen", accepted: "Angenommen", messaged: "Angeschrieben", replied: "Antwort erhalten", closed: "Abgeschlossen", skipped: "Ausgeschlossen" };
function relationshipLabel(contact) {
  if (contact.do_not_contact || contact.automation_status === "excluded") return "Nicht mehr anschreiben";
  if (contact.automation_status === "manual") return "Nur manuell";
  if (contact.automation_status === "paused") return contact.snooze_label ? `Pausiert bis ${contact.snooze_label}` : "Pausiert";
  return "";
}
function nextStep(contact) { const relationship = relationshipLabel(contact); if (relationship) return `${relationship}${contact.snooze_reason ? ` · ${contact.snooze_reason}` : ""}`; if (contact.open_draft_kind === "message") return "Antwort prüfen"; if (contact.open_draft_kind === "event") return "Event-Einladung prüfen"; if (contact.open_draft_kind === "reaktivierung") return "Netzwerk-Zusatz freigeben"; if (contact.open_draft_id) return "Entwurf prüfen"; if (contact.status === "replied") return "Ergebnis festhalten"; if (contact.status === "accepted" && contact.aus_netzwerk) return "Nur manuell im Netzwerk-Zusatz"; if (contact.status === "accepted") return "Erstkontakt vorbereiten"; if (contact.status === "invited") return "Wartet auf Annahme"; if (contact.status === "new") return "Wird automatisch priorisiert"; return "Kein Schritt offen"; }
function closeRelationshipModal() { relationshipContact = null; relationshipExcludeArmed = false; $("relationship-modal").classList.add("hidden"); $("relationship-note").textContent = ""; $("relationship-exclude").textContent = "Nicht mehr anschreiben"; }
function openRelationshipModal(contact) {
  relationshipContact = contact; relationshipExcludeArmed = false;
  const date = new Date(); date.setDate(date.getDate() + 30);
  $("relationship-name").textContent = contact.full_name || "Dieser Kontakt";
  $("relationship-until").value = date.toISOString().slice(0, 10);
  $("relationship-reason").value = contact.snooze_reason || "";
  $("relationship-note").textContent = ""; $("relationship-exclude").textContent = "Nicht mehr anschreiben";
  $("relationship-modal").classList.remove("hidden"); $("relationship-reason").focus();
}
function closeContactWorkspace() { contactWorkspaceId = null; $("contact-workspace-modal").classList.add("hidden"); }
const timelineDate = (value) => localDate(value).toLocaleString("de-DE", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
async function openContactWorkspace(contact) {
  contactWorkspaceId = contact.id;
  $("contact-workspace-title").textContent = contact.full_name || "Kontaktverlauf";
  $("contact-workspace-subtitle").textContent = contact.headline || "Gespräch und Kontaktstatus an einem Ort";
  $("contact-identity-state").innerHTML = `<span class="identity-pulse"></span><div><b>Kontakt wird geladen…</b><span>Profil und Nachrichten werden zusammengeführt.</span></div>`;
  $("contact-timeline").innerHTML = `<div class="timeline-empty">Kontaktspur wird aufgebaut…</div>`;
  $("contact-workspace-modal").classList.remove("hidden");
  try {
    const response = await fetch(`/api/conversation?contactId=${contact.id}`);
    const workspace = await response.json();
    if (!response.ok || workspace.error) throw new Error(workspace.error || `HTTP ${response.status}`);
    if (contactWorkspaceId !== contact.id) return;
    const identityCopy = workspace.conflicts?.length
      ? `<b>${workspace.conflicts.length} Zuordnung${workspace.conflicts.length === 1 ? "" : "en"} prüfen</b><span>NextLead hat bei einem Nachrichten-Thread nicht geraten. Ordne ihn nur zu, wenn dieser Kontakt wirklich gemeint ist.</span><div class="identity-decisions">${workspace.conflicts.map((conflict) => `<button data-identity-resolve="${conflict.id}">Thread „${esc(conflict.participant || "ohne Namen")}“ diesem Kontakt zuordnen</button>`).join("")}</div>`
      : workspace.threadCount
        ? `<b>Profil und ${workspace.threadCount} Gespräch${workspace.threadCount === 1 ? "" : "e"} verbunden</b><span>Alle neuen Nachrichten dieses Threads landen sicher bei diesem Kontakt.</span>`
        : `<b>Profil eindeutig gespeichert</b><span>Noch kein Nachrichten-Thread mit diesem Kontakt verbunden.</span>`;
    $("contact-identity-state").className = `contact-identity-state ${workspace.conflicts?.length ? "needs-review" : "linked"}`;
    $("contact-identity-state").innerHTML = `<span class="identity-pulse"></span><div>${identityCopy}</div>`;
    $("contact-identity-state").querySelectorAll("[data-identity-resolve]").forEach((button) => {
      let armed = false;
      button.addEventListener("click", async () => {
        if (!armed) { armed = true; button.textContent = "Wirklich diesem Kontakt zuordnen?"; return; }
        button.disabled = true;
        try {
          await post("/api/contact-identity", { conflictId: Number(button.dataset.identityResolve), contactId: contact.id });
          await load(); await openContactWorkspace(contact); toast("Nachrichten-Thread wurde eindeutig zugeordnet.");
        } catch (error) { button.disabled = false; toast(`Zuordnung nicht möglich: ${error.message}`); }
      });
    });
    const timeline = [...(workspace.timeline || [])].reverse();
    $("contact-timeline").innerHTML = timeline.length ? timeline.map((item) => `<article class="timeline-item ${esc(item.kind)}"><span class="timeline-mark"></span><div class="timeline-body"><div><b>${esc(item.title)}</b><time>${esc(timelineDate(item.ts))}</time></div>${item.text ? `<p>${esc(item.text)}</p>` : ""}<small>${esc(item.source || "NextLead")}</small></div></article>`).join("") : `<div class="timeline-empty"><b>Noch keine Aktivität gespeichert.</b><span>Sobald NextLead eine Aktion oder Nachricht zuordnet, erscheint sie hier.</span></div>`;
  } catch (error) {
    $("contact-timeline").innerHTML = `<div class="timeline-empty"><b>Kontaktspur konnte nicht geladen werden.</b><span>${esc(error.message)}</span></div>`;
  }
}
function renderContacts() {
  const query = $("contact-search").value.toLowerCase().trim(), filter = $("contact-filter").value;
  let rows = state.contacts || []; if (query) rows = rows.filter((contact) => `${contact.full_name || ""} ${contact.headline || ""}`.toLowerCase().includes(query)); if (filter === "attention") rows = rows.filter((contact) => contact.open_draft_id || contact.status === "replied" || contact.automation_status === "paused"); else if (filter === "paused" || filter === "excluded") rows = rows.filter((contact) => contact.automation_status === filter); else if (filter !== "all") rows = rows.filter((contact) => contact.status === filter);
  $("contact-count").textContent = `${rows.length} Kontakte`;
  const quality = state.identityQuality || {};
  $("identity-quality").className = `identity-quality ${quality.ambiguous ? "needs-review" : ""}`;
  $("identity-quality").textContent = quality.ambiguous
    ? `${quality.ambiguous} Zuordnung${quality.ambiguous === 1 ? "" : "en"} prüfen · ${quality.threads_linked || 0} verbunden`
    : quality.orphaned
      ? `${quality.threads_linked || 0} verbunden · ${quality.orphaned} alte Chats getrennt`
      : `${quality.threads_linked || 0} Gespräche sicher verbunden`;
  $("contact-rows").innerHTML = rows.slice(0, 300).map((contact) => { const protectedState = relationshipLabel(contact); return `<div class="contact-row"><div class="contact-person"><b>${esc(contact.full_name || "Unbekannt")}</b><span>${esc(contact.headline || "Keine Headline")}</span>${protectedState ? `<i class="relationship-state ${contact.automation_status === "excluded" ? "excluded" : ""}">${esc(protectedState)}</i>` : ""}</div><span class="status-pill ${esc(contact.status)}">${STATUS[contact.status] || esc(contact.status)}</span><span class="next-step">${esc(nextStep(contact))}</span><span class="contact-actions"><button class="contact-history" data-contact-history="${contact.id}">Verlauf</button><button class="contact-policy ${protectedState ? "resume" : ""}" data-contact-policy="${contact.id}">${protectedState ? "Freigeben" : "Pausieren"}</button><a href="${esc(contact.profile_url)}" target="_blank" rel="noopener">Profil ↗</a></span></div>`; }).join("") || `<div class="empty-work">Keine Kontakte in diesem Filter.</div>`;
  $("contact-rows").querySelectorAll("[data-contact-history]").forEach((button) => button.addEventListener("click", () => {
    const contact = (state.contacts || []).find((item) => item.id === Number(button.dataset.contactHistory));
    if (contact) openContactWorkspace(contact);
  }));
  $("contact-rows").querySelectorAll("[data-contact-policy]").forEach((button) => button.addEventListener("click", async () => {
    const contact = (state.contacts || []).find((item) => item.id === Number(button.dataset.contactPolicy)); if (!contact) return;
    if (relationshipLabel(contact)) { button.disabled = true; try { await post("/api/contact-policy", { contactId: contact.id, action: "resume" }); await load(); toast(`${contact.full_name || "Kontakt"} ist wieder freigegeben.`); } catch (error) { toast(`Nicht möglich: ${error.message}`); button.disabled = false; } }
    else openRelationshipModal(contact);
  }));
}

const plannerFormat = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 });
function plannerPrefs() { try { return JSON.parse(localStorage.getItem("nextlead-planner") || "{}"); } catch { return {}; } }
function savePlannerPrefs() {
  const prefs = plannerPrefs(), goal = $("planning-goal").value;
  prefs.goal = goal; prefs.results = $("planning-results").value; prefs.revenue = $("planning-revenue").value;
  prefs.goals = prefs.goals || {}; prefs.goals[goal] = {
    value: $("planning-value").value,
    rates: Object.fromEntries(["reply", "qualified", "meeting", "won"].map((key) => [key, $("rate-" + key).value])),
  };
  localStorage.setItem("nextlead-planner", JSON.stringify(prefs));
}
function calculatePlanner() {
  const goal = $("planning-goal").value;
  const rates = ["reply", "qualified", "meeting", "won"].map((key) => Math.max(0, Math.min(100, Number($("rate-" + key).value) || 0)));
  const rate = rates.reduce((total, value) => total * (value / 100), 1) * 100;
  const target = Math.max(0, Math.ceil(Number($("planning-results").value) || 0));
  const value = Number($("planning-value").value), revenue = Number($("planning-revenue").value);
  const messagesA = rate > 0 && target > 0 ? Math.ceil((target * 100) / rate) : null;
  const resultsB = value > 0 && revenue > 0 ? Math.ceil(revenue / value) : null;
  const messagesB = rate > 0 && resultsB ? Math.ceil((resultsB * 100) / rate) : null;
  $("planning-a-results").textContent = `${plannerFormat.format(target)} ${goal}`;
  $("planning-a-messages").textContent = messagesA ? plannerFormat.format(messagesA) : "–";
  $("planning-b-results").textContent = resultsB ? `${plannerFormat.format(resultsB)} ${goal}` : "Wert eintragen";
  $("planning-b-messages").textContent = messagesB ? plannerFormat.format(messagesB) : "–";
  $("planning-total-rate").textContent = `${rate.toLocaleString("de-DE", { maximumFractionDigits: 2 })}%`;
}
function applyPlannerGoal() {
  const goal = $("planning-goal").value, prefs = plannerPrefs(), saved = prefs.goals?.[goal] || {};
  const stats = (state.goalEconomics || []).find((item) => item.goal === goal) || {};
  $("planning-value").value = saved.value || stats.averageValueEur || 1500;
  const steps = [
    ["reply", "messaged", 25], ["qualified", "replied", 50], ["meeting", "qualified", 50], ["won", "meeting", 80],
  ];
  for (const [key, denominator, fallback] of steps) {
    const measured = Number(stats[denominator] || 0) >= 5 && stats.rates?.[key] != null;
    $("rate-" + key).value = saved.rates?.[key] || (measured ? stats.rates[key] : fallback);
  }
}
function renderPlanner() {
  const prefs = plannerPrefs();
  if (!planningInitialized) {
    $("planning-goal").value = ["B1", "P1", "AEC"].includes(prefs.goal) ? prefs.goal : "B1";
    $("planning-results").value = prefs.results || 10; $("planning-revenue").value = prefs.revenue || 10000;
    applyPlannerGoal();
    $("planning-goal").addEventListener("change", () => { applyPlannerGoal(); savePlannerPrefs(); renderPlanner(); });
    ["rate-reply", "rate-qualified", "rate-meeting", "rate-won", "planning-results", "planning-value", "planning-revenue"].forEach((id) => $(id).addEventListener("input", () => { savePlannerPrefs(); calculatePlanner(); }));
    planningInitialized = true;
  }
  const goal = $("planning-goal").value;
  const stats = (state.goalEconomics || []).find((item) => item.goal === goal) || { messaged: 0, replied: 0, qualified: 0, meeting: 0, won: 0, rates: {} };
  $("planning-evidence").textContent = stats.messaged
    ? `${stats.messaged} Kontakte im Zielweg ${goal}; jede Stufe zeigt ihre eigene Stichprobe.`
    : `Für ${goal} fehlen noch zugeordnete Versanddaten. Der Rechner kennzeichnet deshalb Annahmen.`;
  for (const key of ["messaged", "replied", "qualified", "meeting", "won"]) $("rail-" + key).textContent = plannerFormat.format(stats[key] || 0);
  const steps = [["reply", "messaged"], ["qualified", "replied"], ["meeting", "qualified"], ["won", "meeting"]];
  const saved = plannerPrefs().goals?.[goal]?.rates || {};
  for (const [key, denominator] of steps) {
    const source = $("source-" + key), sample = Number(stats[denominator] || 0), measured = sample >= 5 && stats.rates?.[key] != null && !saved[key];
    source.textContent = saved[key] ? "Eigene Planung" : measured ? `Gemessen · n=${sample}` : `Annahme · n=${sample}`;
    source.classList.toggle("measured", measured);
  }
  const q = state.crmDataQuality || {};
  $("planning-data-quality").textContent = `${q.assigned || 0} von ${q.messaged || 0} Versandkontakten einem Zielweg zugeordnet · CRM-Abdeckung ${q.coveragePct || 0}%`;
  calculatePlanner();
}

function renderInsights() {
  const historical = state.metrics?.historical || {}; const acceptance = pct(historical.accepted || 0, historical.invited || 0); const reply = pct(historical.replied || 0, historical.messaged || 0);
  const kpis = [["Anfragen", historical.invited || 0, "versendet"], ["Annahmequote", acceptance == null ? "–" : `${acceptance}%`, `${historical.accepted || 0} angenommen`], ["Antwortquote", reply == null ? "–" : `${reply}%`, `${historical.replied || 0} aus ${historical.messaged || 0} Nachrichten`], ["Termine", (state.bookedLeads || []).length, "persönlich übergeben"]];
  $("insight-kpis").innerHTML = kpis.map(([label, value, note]) => `<div class="kpi-card"><span>${label}</span><b>${value}</b><small>${note}</small></div>`).join("");
  // Die Wirkungs-Auswertung hat einen eigenen Ladepfad. Sie wird EINMAL geholt und danach nur
  // noch, wenn der Nutzer einen Filter ändert — der 30-Sekunden-Takt des Dashboards soll die
  // Ansicht nicht ständig unter den Händen neu aufbauen.
  fuelleWirkungFilter();
  if (!wirkungDaten) ladeWirkung();
  const actions = Object.entries(state.actionsToday || {}); $("today-actions").innerHTML = actions.length ? actions.map(([key, value]) => `<span><b>${value}</b> ${esc({ connect: "Anfragen", message: "Nachrichten", reply: "Antworten", like: "Likes", comment: "Kommentare" }[key] || key)}</span>`).join("") : `<span>Noch keine Aktionen heute.</span>`;
  const learning = state.learning || {}, rules = learning.rules || [], byGoal = learning.byGoal || [];
  $("learning-privacy").textContent = learning.privacy?.localOnly ? "Nur auf diesem PC" : "Anonym geteilt";
  $("learning-summary").innerHTML = `<div class="learning-stats"><span><b>${learning.total || 0}</b>Lernsignale</span><span><b>${learning.decisions || 0}</b>Entscheidungen</span>${byGoal.map((item) => `<span><b>${item.events}</b>${esc(item.goal)}</span>`).join("")}</div>`
    + (rules.length ? `<div class="learning-rules">${rules.map((rule) => `<div><b>${esc(rule.title)}</b><span>${esc(rule.instruction)}</span><small>${rule.evidence} Signale${rule.goalCode ? ` · ${esc(rule.goalCode)}` : ""}</small></div>`).join("")}</div>` : `<div class="empty-work">Noch keine belastbare Regel. Ab zwei gleichen Signalen passt NextLead seine Nachrichten automatisch an.</div>`)
    + `<p class="learning-note">Gespeichert werden nur Merkmale wie Länge, Zielweg und Ergebnis. Keine Namen, URLs oder Nachrichtentexte.</p>`;
  renderPlanner();
}

function automationLevel() { if (state.agentMode === "live") return "agent_live"; if (state.agentMode === "shadow") return "agent_test"; return state.mode === "semi" ? "halb" : "vorschlaege"; }
/* ===== WIRKUNG: Funnel, Antwortqualität und Vergleich (Phase 5.2/5.3) =====
   Eigener Ladepfad neben /api/state: die Filter sollen sofort reagieren, ohne den kompletten
   Dashboard-Zustand neu zu ziehen. Alle Werte stammen aus `crm_stage_events` — dieselbe Quelle,
   aus der auch der Drilldown liest. Deshalb kann die Kontaktliste nie von der Zahl abweichen. */
let wirkungGruppe = "";
let wirkungDaten = null;
/** Laufende Nummer statt einer Lade-Sperre: eine Filteränderung darf NIE verworfen werden, sonst
    zeigt die Ansicht Zahlen, die nicht zu den sichtbaren Einstellungen passen. Stattdessen gewinnt
    immer die zuletzt gestellte Anfrage; überholte Antworten werden verworfen. */
let wirkungAnfrage = 0;

const QUALITAET_LABEL = {
  interested: "Interessiert", question: "Konkrete Frage", meeting: "Termin vereinbart",
  later: "Später erneut", busy: "Aktuell keine Zeit", not_fit: "Nicht passend",
  not_interested: "Kein Interesse", neutral: "Neutral",
};
const POSITIVE_QUALITAETEN = ["interested", "question", "meeting"];

function wirkungFilter() {
  const wert = (id) => ($(id)?.value || "").trim();
  return {
    campaign: wert("wf-campaign"), goal: wert("wf-goal"), source: wert("wf-source"),
    zielgruppe: wert("wf-zielgruppe"), route: wert("wf-route"), automation: wert("wf-automation"),
    from: wert("wf-from"), to: wert("wf-to"),
  };
}

function wirkungQuery(extra = {}) {
  const params = new URLSearchParams();
  for (const [schluessel, wert] of Object.entries({ ...wirkungFilter(), ...extra })) if (wert) params.set(schluessel, wert);
  return params.toString();
}

/** Filter-Auswahllisten aus dem bereits geladenen Zustand füllen, ohne die Auswahl zu verlieren. */
function fuelleWirkungFilter() {
  const setze = (id, eintraege, alle) => {
    const el = $(id);
    if (!el) return;
    const vorher = el.value;
    el.innerHTML = `<option value="">${alle}</option>` + eintraege.map((e) => `<option value="${e.id}">${esc(e.label)}</option>`).join("");
    if (eintraege.some((e) => String(e.id) === vorher)) el.value = vorher;
  };
  setze("wf-campaign", (state.campaigns || []).map((c) => ({ id: c.id, label: c.name })), "Alle Kampagnen");
  setze("wf-source", (state.leadSources || []).map((s) => ({ id: s.id, label: s.label || s.search_url || `Quelle ${s.id}` })), "Alle Quellen");
}

async function ladeWirkung() {
  const meine = ++wirkungAnfrage;
  try {
    const query = wirkungQuery(wirkungGruppe ? { groupBy: wirkungGruppe } : {});
    const response = await fetch(`/api/funnel${query ? `?${query}` : ""}`, { cache: "no-store" });
    const daten = await response.json();
    if (meine !== wirkungAnfrage) return; // überholt: eine neuere Auswahl ist bereits unterwegs
    if (!response.ok || daten.error) throw new Error(daten.error || "Auswertung nicht ladbar");
    wirkungDaten = daten;
    renderWirkung();
  } catch (error) {
    if (meine !== wirkungAnfrage) return;
    $("wirkung-inhalt").innerHTML = `<div class="empty-work">${esc(error.message)}</div>`;
  }
}

/** Eine Quote nur dann als belastbar zeigen, wenn der Nenner groß genug ist. */
function quotenKachel(titel, quote, hinweis) {
  const wert = quote.pct == null ? "–" : `${quote.pct}%`;
  const klasse = quote.pct == null ? "" : quote.genugDaten ? "" : " schwach";
  const fuss = quote.nenner === 0 ? "noch keine Daten"
    : quote.genugDaten ? `${quote.zaehler} von ${quote.nenner}`
    : `${quote.zaehler} von ${quote.nenner} · zu wenig für eine Aussage`;
  return `<div class="wirkung-quote${klasse}"><span>${esc(titel)}</span><b>${wert}</b><small>${esc(hinweis || fuss)}</small></div>`;
}

function ketteHtml(report) {
  const kette = report.kette || [];
  const max = Math.max(1, ...kette.map((s) => s.count));
  return `<div class="wirkung-kette">` + kette.map((stufe) => `
    <button class="funnel-row" data-stage="${stufe.stage}" title="Kontakte hinter dieser Zahl anzeigen">
      <span>${esc(stufe.label)}</span>
      <div class="funnel-track"><div class="funnel-fill" style="width:${Math.round(stufe.count / max * 100)}%"></div></div>
      <span class="funnel-count">${stufe.count}</span>
      <span class="funnel-conv">${stufe.fromPreviousPct == null ? "Start" : `${stufe.fromPreviousPct}%`}</span>
    </button>`).join("") + `</div>`;
}

function antwortenHtml(report) {
  const antworten = report.antworten || { werte: {}, gesamt: 0 };
  const gesamt = antworten.gesamt || 0;
  if (!gesamt) return `<div class="empty-work">Noch keine eingeordnete Antwort. Sobald Antworten eingehen, erscheint hier, welche davon wirklich weiterführen.</div>`;
  return `<div class="wirkung-qualitaeten">` + Object.entries(QUALITAET_LABEL).map(([schluessel, label]) => {
    const n = antworten.werte?.[schluessel] || 0;
    const anteil = gesamt ? Math.round(n / gesamt * 100) : 0;
    return `<div class="qualitaet${POSITIVE_QUALITAETEN.includes(schluessel) ? " positiv" : ""}${n ? "" : " leer"}">
      <span>${esc(label)}</span><b>${n}</b><small>${anteil}%</small></div>`;
  }).join("") + `</div>`;
}

function berichtHtml(report) {
  const quoten = report.quoten || {};
  const pro100 = report.pro100Vernetzungen;
  const tempo = report.tempo || {};
  const kosten = report.vernetzungenProQualifiziert;
  return ketteHtml(report)
    + `<div class="wirkung-quoten">
        ${quotenKachel("Annahmequote", quoten.annahme)}
        ${quotenKachel("Antwortquote", quoten.antwort)}
        ${quotenKachel("Positive Antworten", quoten.positiveAntwort)}
        ${quotenKachel("Qualifizierung", quoten.qualifizierung)}
        ${quotenKachel("Termine", quoten.termin)}
       </div>`
    + `<div class="wirkung-oekonomie">
        <div><span>Je 100 Vernetzungen</span><b>${pro100 ? `${pro100.qualifiziert} qualifiziert` : "–"}</b><small>${pro100 ? `${pro100.termine} Termine · ${pro100.gewonnen} gewonnen` : "noch keine Vernetzung gemessen"}</small></div>
        <div><span>Aufwand je Qualifizierung</span><b>${kosten == null ? "–" : `${kosten} Anfragen`}</b><small>${report.vernetzungenProTermin == null ? "noch kein Termin" : `${report.vernetzungenProTermin} Anfragen je Termin`}</small></div>
        <div><span>Zeit bis Antwort</span><b>${tempo.tageBisAntwort == null ? "–" : `${tempo.tageBisAntwort} Tage`}</b><small>${tempo.nAntwort || 0} gemessene Fälle</small></div>
        <div><span>Erstkontakt bis Termin</span><b>${tempo.tageBisTermin == null ? "–" : `${tempo.tageBisTermin} Tage`}</b><small>${tempo.nTermin || 0} gemessene Fälle</small></div>
       </div>`
    + `<h4 class="wirkung-untertitel">Wie die Antworten ausfielen</h4>`
    + antwortenHtml(report);
}

/** Vergleichstabelle. Sortiert nach positiven Antworten je 100 Vernetzungen — nicht nach Menge:
    genau die Verwechslung, die eine schwache Quelle sonst gut aussehen lässt. */
function vergleichHtml(gruppen, art) {
  const zeilen = gruppen.map((eintrag) => {
    const name = art === "campaign" ? eintrag.campaign.name : eintrag.source.label;
    const report = eintrag.report;
    const positivPro100 = report.pro100Vernetzungen ? report.pro100Vernetzungen.positiv : null;
    return { name, report, positivPro100, meta: art === "campaign" ? (eintrag.campaign.goal_code || "–") : (eintrag.source.active ? "aktiv" : "pausiert") };
  }).sort((a, b) => (b.positivPro100 ?? -1) - (a.positivPro100 ?? -1));

  if (!zeilen.length) return `<div class="empty-work">Noch nichts zu vergleichen.</div>`;
  return `<div class="wirkung-vergleich">
    <div class="vergleich-row vergleich-head"><span>${art === "campaign" ? "Kampagne" : "Quelle"}</span><span>Kontakte</span><span>Vernetzt</span><span>Antworten</span><span>Positiv</span><span>Qualifiziert</span><span>Positiv je 100</span></div>
    ${zeilen.map((z) => `<div class="vergleich-row">
      <span><b>${esc(z.name)}</b><small>${esc(z.meta)}</small></span>
      <span>${z.report.counts.found}</span>
      <span>${z.report.counts.invited}</span>
      <span>${z.report.counts.replied}</span>
      <span>${z.report.antworten.positiv}</span>
      <span>${z.report.counts.qualified}</span>
      <span class="vergleich-kennzahl">${z.positivPro100 == null ? "–" : z.positivPro100}</span>
    </div>`).join("")}
  </div>
  <p class="wirkung-note">Sortiert nach positiven Antworten je 100 Vernetzungen. Eine Quelle mit vielen Kontakten, aber wenig positiven Antworten steht deshalb unten — unabhängig davon, wie groß sie ist.</p>`;
}

function renderWirkung() {
  if (!wirkungDaten) return;
  const ziel = $("wirkung-inhalt");
  if (!ziel) return;
  ziel.innerHTML = wirkungDaten.gruppen
    ? vergleichHtml(wirkungDaten.gruppen, wirkungGruppe)
    : berichtHtml(wirkungDaten);
  ziel.querySelectorAll("[data-stage]").forEach((button) => button.addEventListener("click", () => zeigeWirkungKontakte(button.dataset.stage)));
}

/** ABNAHME 5.1: Jede Zahl lässt sich auf konkrete Kontakte zurückführen. */
async function zeigeWirkungKontakte(stage) {
  const box = $("wirkung-drill");
  box.classList.remove("hidden");
  box.innerHTML = `<div class="empty-work">Kontakte werden geladen …</div>`;
  try {
    const response = await fetch(`/api/funnel/contacts?${wirkungQuery({ stage })}`, { cache: "no-store" });
    const daten = await response.json();
    if (!response.ok || daten.error) throw new Error(daten.error || "Kontakte nicht ladbar");
    const stufe = (wirkungDaten?.kette || []).find((s) => s.stage === stage);
    box.innerHTML = `<div class="section-head"><div><span class="eyebrow">Nachweis</span><h3>${esc(stufe?.label || stage)} · ${daten.count} Kontakte</h3></div><button class="wirkung-reset" id="wirkung-drill-close" type="button">Schließen</button></div>`
      + (daten.kontakte.length
        ? `<div class="drill-list">${daten.kontakte.map((k) => `<a class="drill-row" href="${esc(k.profile_url)}" target="_blank" rel="noopener">
            <span><b>${esc(k.full_name || "Ohne Namen")}</b><small>${esc(k.headline || "")}</small></span>
            <span class="drill-meta">${esc(localDate(k.occurred_at).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit" }))}${k.reply_quality ? ` · ${esc(QUALITAET_LABEL[k.reply_quality] || k.reply_quality)}` : ""}</span>
          </a>`).join("")}</div>`
        : `<div class="empty-work">Keine Kontakte in dieser Auswahl.</div>`);
    $("wirkung-drill-close").onclick = () => box.classList.add("hidden");
    box.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (error) {
    box.innerHTML = `<div class="empty-work">${esc(error.message)}</div>`;
  }
}

document.querySelectorAll(".wirkung-tab").forEach((tab) => tab.addEventListener("click", () => {
  wirkungGruppe = tab.dataset.group;
  document.querySelectorAll(".wirkung-tab").forEach((el) => el.classList.toggle("active", el === tab));
  $("wirkung-drill").classList.add("hidden");
  ladeWirkung();
}));
["wf-campaign", "wf-goal", "wf-source", "wf-zielgruppe", "wf-route", "wf-automation", "wf-from", "wf-to"]
  .forEach((id) => $(id)?.addEventListener("change", () => { $("wirkung-drill").classList.add("hidden"); ladeWirkung(); }));
$("wf-reset").onclick = () => {
  ["wf-campaign", "wf-goal", "wf-source", "wf-zielgruppe", "wf-route", "wf-automation", "wf-from", "wf-to"].forEach((id) => { if ($(id)) $(id).value = ""; });
  $("wirkung-drill").classList.add("hidden");
  ladeWirkung();
};

function renderSettings() {
  const alive = !!state.engine?.alive; $("engine-title").textContent = alive ? "Engine arbeitet" : "Engine ist aus"; $("engine-copy").textContent = alive ? "Vernetzung, Kampagnen und freigegebene Nachrichten laufen in einer gemeinsamen Prioritätsqueue." : "Ohne Engine werden keine Hintergrundaufgaben ausgeführt."; $("engine-toggle").textContent = alive ? "Engine stoppen" : "Engine starten";
  const level = automationLevel(); document.querySelectorAll("[data-level]").forEach((button) => button.classList.toggle("active", button.dataset.level === level));
  $("automation-copy").textContent = { vorschlaege: "NextLead vernetzt automatisch. Jede Nachricht bleibt ein Entwurf.", halb: "Azubi-Erstnachrichten werden automatisch gesendet, Antworten bleiben zur Prüfung.", agent_test: "Der Gesprächsagent denkt mit, sendet aber nicht selbst.", agent_live: "Der Gesprächsagent führt Routinegespräche selbst und übergibt wichtige Fälle." }[level] + " Bestehende Netzwerk-Kontakte brauchen in jeder Stufe deine Freigabe.";
  const g = state.governor || {}, connect = g.connect || {};
  const acceptance = g.acceptance || {};
  const warning = $("acceptance-warning");
  const lowAcceptance = !!acceptance.armed && !!acceptance.low;
  warning.classList.toggle("hidden", !lowAcceptance);
  warning.classList.toggle("protection-off", lowAcceptance && !acceptance.protectionActive);
  if (lowAcceptance) {
    $("acceptance-warning-rate").textContent = `${Math.round((acceptance.rate || 0) * 100)} %`;
    $("acceptance-warning-threshold").textContent = `Warnschwelle ${Math.round((acceptance.minRate || 0) * 100)} %`;
    $("acceptance-warning-effect").textContent = acceptance.protectionActive
      ? `Aktiv: NextLead sendet höchstens ${acceptance.reducedCap} statt ${acceptance.normalCap} Vernetzungsanfragen pro Tag. Nachrichten und Antworten laufen normal weiter.`
      : `Aus: NextLead darf bis zu ${acceptance.normalCap} Vernetzungsanfragen pro Tag senden. Empfohlen sind aktuell höchstens ${acceptance.reducedCap}.`;
    const toggle = $("acceptance-protection-toggle");
    toggle.setAttribute("aria-checked", String(!!acceptance.protectionActive));
    toggle.classList.toggle("active", !!acceptance.protectionActive);
    $("acceptance-protection-state").textContent = acceptance.protectionActive ? `Aktiv · max. ${acceptance.reducedCap}/Tag` : `Aus · max. ${acceptance.normalCap}/Tag`;
  }
  /**
   * Das Lese-Budget steht bewusst GANZ OBEN und mit Warnfarbe: Es ist die Kennzahl, wegen der
   * LinkedIn am 05.08.2026 das Konto gesperrt hat ("große Menge an Profildaten abgerufen").
   * Sendezahlen waren nie das Problem – sichtbar war aber jahrelang nur die Sendeseite.
   */
  const lese = state.leseBudget || {};
  const lowRead = state.lowRead || { total: 0, byKind: {} };
  const quote = (teil) => (teil?.cap ? Math.round((teil.heute / teil.cap) * 100) : 0);
  const farbe = (teil) => quote(teil) >= 90 ? "var(--red)" : quote(teil) >= 70 ? "var(--amber)" : "var(--ink)";
  $("safety-summary").innerHTML =
    `<div class="safety-line"><span>Profile heute abgerufen</span><b style="color:${farbe(lese.profile)}">${lese.profile?.heute ?? 0} / ${lese.profile?.cap ?? "–"}</b></div>`
    + `<div class="safety-line"><span>Seiten heute abgerufen</span><b style="color:${farbe(lese.seiten)}">${lese.seiten?.heute ?? 0} / ${lese.seiten?.cap ?? "–"}</b></div>`
    + `<div class="safety-line"><span>Low-Read eingespart</span><b style="color:var(--green)">${lowRead.total || 0} Aufrufe heute</b></div>`
    + (lese.erschoepft ? `<div class="safety-line"><span>Lesen pausiert</span><b style="color:var(--red)">${esc(lese.grund || "Budget erreicht")}</b></div>` : "")
    + `<div class="safety-line"><span>Anfragen heute</span><b>${connect.today || 0} / ${connect.effectiveCap || connect.hardCap || "–"}</b></div>`
    + `<div class="safety-line"><span>Diese Woche</span><b>${connect.week || 0} / ${connect.weeklyCap || "–"}</b></div>`
    + `<div class="safety-line"><span>Geschäftszeiten</span><b>${g.zeitfenster === false ? "Aus" : "Aktiv"}</b></div>`
    + `<div class="safety-line"><span>Sendeweg</span><b>${esc(({ ok: "Geprüft", broken: "Defekt", stale: "Prüfung fällig", unknown: "Noch nicht geprüft" })[state.systemHealth?.sendeWeg] || "Unbekannt")}</b></div>`;
  $("source-list").innerHTML = (state.leadSources || []).map((source) => `<div class="source-item"><b>${esc(source.label || "Quelle")}</b><span>${source.active ? "aktiv" : "pausiert"} · zuletzt ${source.last_added || 0} Leads</span></div>`).join("") || `<p>Noch keine Quellen hinterlegt.</p>`;
  renderTechnischeFaelle();
}

/**
 * Blockierte/unklare Entwürfe zum Abhaken. Ohne diese Ansicht war die Zahl im Arbeitskorb eine
 * Sackgasse: sichtbar, aber weder einsehbar noch erledigbar – sie konnte nur wachsen.
 * "Verwerfen" hakt ab, "Neu schreiben" erzeugt einen frischen Entwurf zur normalen Prüfung.
 */
/**
 * "Alle erneut prüfen" nutzt `retryBlockierte()`: Jeder Fall wird gegen den AKTUELLEN CRM-Stand
 * geprüft. Wer inzwischen angeschrieben wurde oder geantwortet hat, wird verworfen (ein erneuter
 * Versand wäre ein Duplikat); alles andere geht als Entwurf zurück in die normale Freigabe –
 * mit dem BESTEHENDEN Text, ohne neuen KI-Aufruf. Das ist der richtige Weg, nachdem eine Ursache
 * behoben wurde (z.B. die "selbstständig"-Fehlblockade): erneut senden hieße sonst, in denselben
 * Fehler zu laufen.
 */
$("faelle-retry")?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const r = await post("/api/retry-blocked");
    toast(`${r.entwuerfe || 0} zurück zur Freigabe, ${r.verworfen || 0} als hinfällig verworfen.`);
    await load(true);
  } catch (error) {
    toast(`Nicht möglich: ${error.message}`);
  }
  button.disabled = false;
});

function renderTechnischeFaelle() {
  const faelle = state.technischeFaelle || [];
  $("faelle-title").textContent = faelle.length ? `${faelle.length} vom Schutz gestoppt` : "Nichts offen";
  $("faelle-liste").innerHTML = faelle.length
    ? faelle.map((f) => `<div class="fall"><div><b>${esc(f.participant || "Unbekannt")}</b><span class="fall-status">${esc(f.blockiert_grund || (f.status === "unknown" ? "Versand unklar – im LinkedIn-Verlauf prüfen" : "Von der Sicherheitsprüfung gestoppt"))}</span><p>${esc(String(f.draft || "").slice(0, 140))}${String(f.draft || "").length > 140 ? "…" : ""}</p></div><div class="fall-actions"><button data-fall-neu="${f.id}">Neu schreiben</button><button class="delete-draft" data-fall-weg="${f.id}">Verwerfen</button></div></div>`).join("")
    : `<p>Alles erledigt. Hier landen Nachrichten, bei denen eine Sicherung eingegriffen hat.</p>`;
  $("faelle-liste").querySelectorAll("[data-fall-weg]").forEach((button) => button.addEventListener("click", async () => {
    button.disabled = true;
    try { await post("/api/draft", { id: Number(button.dataset.fallWeg), action: "delete" }); toast("Abgehakt."); await load(true); }
    catch (error) { toast(`Nicht möglich: ${error.message}`); button.disabled = false; }
  }));
  $("faelle-liste").querySelectorAll("[data-fall-neu]").forEach((button) => button.addEventListener("click", async () => {
    button.disabled = true;
    try { await post("/api/draft", { id: Number(button.dataset.fallNeu), action: "reject" }); toast("Wird neu geschrieben."); await load(true); }
    catch (error) { toast(`Nicht möglich: ${error.message}`); button.disabled = false; }
  }));
}

/**
 * `reviewerBehalten` lässt den geöffneten Prüfbereich unangetastet und zeichnet nur den Rest neu.
 * Nötig fürs Auto-Refresh (2026-08-05): Vorher pausierte die Aktualisierung KOMPLETT, solange ein
 * Prüfer offen war – damit fror die ganze Seite ein. Zahlen im Arbeitskorb und auf den
 * Kampagnenkarten blieben minutenlang auf altem Stand stehen, was wie ein stehender Bot aussah.
 * Der Prüfer selbst darf sich nicht unter den Fingern verändern, alles andere schon.
 */
function render(reviewerBehalten = false) {
  renderStatus(); renderToday(); renderCampaigns(); renderContacts(); renderInsights(); renderSettings();
  $("updated-at").textContent = `Stand ${new Date(state.generatedAt).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}`; $("footer-count").textContent = `${state.totals?.contacts || 0} eindeutige Kontakte`;
  if (!reviewerBehalten && (reviewKinds || reviewCampaign)) renderReviewer();
}
async function load(reviewerBehalten = false) { try { const response = await fetch("/api/state", { cache: "no-store" }); const data = await response.json(); if (!response.ok || data.error) throw new Error(data.error || "Laden fehlgeschlagen"); state = data; render(reviewerBehalten); } catch (error) { toast(`Dashboard nicht erreichbar: ${error.message}`); } }

$("emergency").onclick = async () => { await post("/api/notaus", { an: !state.governor?.notAus }); await load(); };
$("new-campaign").onclick = () => { $("mission-form").classList.toggle("hidden"); if (!$("mission-form").classList.contains("hidden")) $("mission-search").focus(); };
document.querySelectorAll("[data-mission-goal]").forEach((button) => button.addEventListener("click", () => {
  missionGoal = button.dataset.missionGoal;
  document.querySelectorAll("[data-mission-goal]").forEach((item) => item.classList.toggle("active", item === button));
  $("mission-rail-goal").textContent = `${missionGoal} erreichen`;
  $("mission-note").textContent = "";
}));
$("mission-advanced").onclick = () => { $("mission-form").classList.add("hidden"); openCampaignForm(null); };
$("mission-start").onclick = async () => {
  const button = $("mission-start"); const note = $("mission-note"); note.textContent = "";
  const searchBrief = $("mission-search").value.trim();
  if (!searchBrief) { note.textContent = "Beschreibe zuerst, wen NextLead finden soll."; return; }
  if (!missionGoal) { note.textContent = "Wähle B1, P1 oder AEC."; return; }
  button.disabled = true; button.textContent = "Suchen werden geplant…";
  try {
    const result = await post("/api/mission", { searchBrief, goalCode: missionGoal });
    $("mission-search").value = ""; $("mission-form").classList.add("hidden");
    document.querySelectorAll("[data-mission-goal]").forEach((item) => item.classList.remove("active"));
    missionGoal = null; $("mission-rail-goal").textContent = "Ziel wählen";
    await load();
    toast(`${result.routes.length} LinkedIn-Suche${result.routes.length === 1 ? "" : "n"} erstellt. Der Auftrag läuft.`);
  } catch (error) { note.textContent = error.message; }
  finally { button.disabled = false; button.textContent = "Auftrag starten"; }
};
$("close-campaign").onclick = () => { $("campaign-form").classList.add("hidden"); editingCampaign = null; };
["campaign-keywords", "campaign-region", "campaign-score", "campaign-scope"].forEach((id) => $(id).addEventListener(id === "campaign-scope" ? "change" : "input", updateCampaignPreview));
$("save-campaign").onclick = async () => {
  const button = $("save-campaign"); button.disabled = true; $("campaign-note").textContent = "";
  try {
    const editing = editingCampaign;
    const values = campaignFormValues();
    const signature = JSON.stringify(values);
    if (confirmedCampaignPreview !== signature) {
      const result = await post("/api/campaign", { ...values, action: "preview" });
      const preview = result.preview; const excluded = preview.exclusions || {};
      $("preview-total").textContent = preview.total; $("preview-network").textContent = preview.network; $("preview-external").textContent = preview.external;
      $("campaign-note").classList.add("preview-confirmation");
      $("campaign-note").textContent = `${preview.total} Kontakte werden aufgenommen. Geschützt: ${excluded.protected || 0}, laufendes Gespräch: ${excluded.activeConversation || 0}, abgeschlossen: ${excluded.closed || 0}. Bitte noch einmal bestätigen.`;
      confirmedCampaignPreview = signature;
      button.textContent = editing ? `Änderungen für ${preview.total} Kontakte bestätigen` : `Mit ${preview.total} Kontakten starten`;
      return;
    }
    const result = await post("/api/campaign", { ...values, action: editing ? "update" : "create", id: editing });
    await load();
    if (editing) {
      renderAssets();
      toast("Kampagne aktualisiert. Neue Entwürfe folgen der neuen Vorgabe.");
    } else {
      // Direkt in den Bearbeiten-Modus wechseln: Material braucht eine gespeicherte Kampagne.
      openCampaignForm((state.campaigns || []).find((campaign) => campaign.id === Number(result.id)) || null);
      toast("Kampagne gestartet. Jetzt kannst du Flyer und Infos ergänzen.");
    }
  } catch (error) { $("campaign-note").textContent = error.message; } finally { button.disabled = false; }
};
$("asset-add").onclick = async () => {
  const button = $("asset-add"); const note = $("asset-note"); note.textContent = "";
  if (!editingCampaign) { note.textContent = "Speichere die Kampagne zuerst."; return; }
  const file = $("asset-file").files[0] || null;
  if (file && file.size > 8 * 1024 * 1024) { note.textContent = "Die Datei ist größer als 8 MB."; return; }
  button.disabled = true;
  try {
    await post("/api/campaign-asset", {
      action: "add", campaignId: editingCampaign, name: file ? file.name : ($("asset-url").value || "Material"),
      fileName: file ? file.name : "", mime: file ? file.type : "", data: file ? await readFileBase64(file) : "",
      url: $("asset-url").value, summary: $("asset-summary").value,
    });
    $("asset-file").value = ""; $("asset-url").value = ""; $("asset-summary").value = "";
    await load(); renderAssets(); toast("Material gespeichert.");
  } catch (error) { note.textContent = error.message; } finally { button.disabled = false; }
};
$("contact-search").addEventListener("input", renderContacts); $("contact-filter").addEventListener("change", renderContacts);
$("contact-workspace-close").onclick = closeContactWorkspace; $("contact-workspace-backdrop").onclick = closeContactWorkspace;
$("relationship-close").onclick = closeRelationshipModal; $("relationship-cancel").onclick = closeRelationshipModal; $("relationship-backdrop").onclick = closeRelationshipModal;
$("relationship-save").onclick = async () => {
  if (!relationshipContact) return;
  const button = $("relationship-save"); button.disabled = true; $("relationship-note").textContent = "";
  try {
    await post("/api/contact-policy", { contactId: relationshipContact.id, action: "pause", until: $("relationship-until").value, reason: $("relationship-reason").value });
    const name = relationshipContact.full_name || "Kontakt"; closeRelationshipModal(); await load(); toast(`${name} wurde zurückgestellt.`);
  } catch (error) { $("relationship-note").textContent = error.message; }
  finally { button.disabled = false; }
};
$("relationship-exclude").onclick = async () => {
  if (!relationshipContact) return;
  const button = $("relationship-exclude");
  if (!relationshipExcludeArmed) { relationshipExcludeArmed = true; button.textContent = "Wirklich dauerhaft ausschließen?"; return; }
  button.disabled = true; $("relationship-note").textContent = "";
  try {
    await post("/api/contact-policy", { contactId: relationshipContact.id, action: "exclude", reason: $("relationship-reason").value || "Manuell dauerhaft ausgeschlossen" });
    const name = relationshipContact.full_name || "Kontakt"; closeRelationshipModal(); await load(); toast(`${name} wird nicht mehr automatisch angeschrieben.`);
  } catch (error) { $("relationship-note").textContent = error.message; }
  finally { button.disabled = false; }
};
$("engine-toggle").onclick = async () => { await post("/api/engine", { action: state.engine?.alive ? "stop" : "start" }); toast(state.engine?.alive ? "Engine wird gestoppt." : "Engine startet."); setTimeout(load, 1800); };
$("acceptance-protection-toggle").onclick = async (event) => {
  const button = event.currentTarget;
  const an = !state.governor?.acceptance?.protectionActive;
  button.disabled = true;
  try {
    await post("/api/acceptance-protection", { an });
    await load();
    toast(an ? "Weniger Anfragen sind aktiviert." : "Reduzierung ist ausgeschaltet.");
  } catch (error) { toast(`Nicht möglich: ${error.message}`); }
  finally { button.disabled = false; }
};
$("backup-now").onclick = async () => { await post("/api/backup"); toast("Sicherung erstellt."); };
document.querySelectorAll("[data-level]").forEach((button) => button.addEventListener("click", async () => { await post("/api/automatik", { level: button.dataset.level }); await load(); toast("Automatik aktualisiert."); }));
$("source-add").onclick = async () => { await post("/api/source", { action: "add", label: $("source-label").value, url: $("source-url").value }); $("source-label").value = ""; $("source-url").value = ""; await load(); toast("Quelle gespeichert. Nachschub wird geholt."); };

// Alle 20s aktualisieren. Ist ein Prüfbereich offen, bleibt NUR dieser stehen – der Rest der
// Seite (Arbeitskorb, Kampagnen, Status) zieht trotzdem nach.
load(); setInterval(() => load(!!(reviewKinds || reviewCampaign)), 20000);
