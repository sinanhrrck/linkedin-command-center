let state = null;
let activeView = "today";
let reviewKinds = null;
let reviewCampaign = null;
let reviewIndex = 0;
let missionGoal = null;

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const post = async (url, payload = {}) => {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.error) throw new Error(result.error || result.reason || `HTTP ${response.status}`);
  return result;
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
  const okay = alive && !stopped && health !== "broken";
  $("side-dot").style.background = okay ? "#58d19b" : stopped || health === "broken" ? "#ef7482" : "#e4ae54";
  $("side-state").textContent = stopped ? "Not-Aus aktiv" : alive ? "Arbeitet" : "Engine aus";
  $("side-detail").textContent = state.engine?.activeJob ? `Jetzt: ${state.engine.activeJob}` : alive ? "Aufgaben werden priorisiert" : "Keine Hintergrundarbeit";
  const strip = $("status-strip"); strip.className = `status-strip ${okay ? "ok" : stopped || health === "broken" ? "bad" : "warn"}`;
  const title = stopped ? "Jeder Versand ist gestoppt." : health === "broken" ? "Der Sendeweg braucht Aufmerksamkeit." : alive ? "NextLead arbeitet im Hintergrund." : "NextLead ist gerade nicht gestartet.";
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
      if (a.art === "kampagne") {
        showView("campaigns");
        return openCampaignForm((state.campaigns || []).find((c) => c.id === a.id));
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
  $("activity-recent").innerHTML = recent.slice(0, 6).map((item) => { const label = jobText(item.job); return `<div class="activity-row compact ${item.status === "failed" ? "failed" : ""}"><span class="done-mark">${item.status === "failed" ? "!" : "✓"}</span><div><b>${esc(label[0])}</b><span>${esc(item.detail || label[1])}</span></div><small>${relativeTime(item.finished_at || item.started_at)}</small></div>`; }).join("") || `<div class="activity-empty">Noch keine Aktivität protokolliert.</div>`;
}

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
function bindDraftDelete(draft) {
  const button = $("review-delete");
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
    button.disabled = true;
    await post("/api/draft", { id: draft.id, action: "delete" });
    toast("Entwurf gelöscht. Er wird nicht erneut erstellt.");
    await load();
    renderReviewer();
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
    reviewer.innerHTML = `<div class="review-head"><div class="review-person"><span class="eyebrow">Neue Gesprächsrichtung</span><h3>${esc(draft.participant || "Kontakt")}</h3><p>Wähle zuerst die Idee. Danach schreibt NextLead einen komplett neuen Text.</p></div><span class="review-progress">${reviewIndex + 1} / ${list.length}</span></div><div class="review-context">${profileCard(draft)}<div class="review-compose">${draft.incoming && !String(draft.incoming).startsWith("campaign:") ? `<div class="incoming">${esc(draft.incoming)}</div>` : ""}<div class="approach-grid">${options.map((option, index) => `<button class="approach-card" data-approach="${esc(option.key)}"><span>0${index + 1}</span><b>${esc(option.title)}</b><small>${esc(option.description)}</small></button>`).join("")}</div><div class="review-actions"><button id="review-delete" class="delete-draft">Entwurf löschen</button></div></div></div>`;
    reviewer.querySelectorAll("[data-approach]").forEach((button) => button.addEventListener("click", async () => { button.disabled = true; await post("/api/draft", { id: draft.id, action: "choose_approach", text: { approachKey: button.dataset.approach } }); toast("Neue Richtung gewählt. Nachricht wurde neu geschrieben."); await load(); renderReviewer(); }));
    bindDraftDelete(draft);
  } else if (draft.kind === "pitchidee") {
    let ideas = []; try { ideas = JSON.parse(draft.draft || "[]"); } catch {}
    reviewer.innerHTML = `<div class="review-head"><div class="review-person"><span class="eyebrow">Pitch-Richtung wählen</span><h3>${esc(draft.participant || "Kontakt")}</h3></div><span class="review-progress">${reviewIndex + 1} / ${list.length}</span></div><div class="review-context">${profileCard(draft)}<div class="review-compose"><div class="incoming">${esc(draft.incoming || "Kein Eingangstext gespeichert.")}</div><div class="work-groups">${ideas.map((idea, index) => `<button class="work-item" data-pitch="${index}"><span class="work-icon">${index + 1}</span><span class="work-copy"><b>Ansatz ${index + 1}</b><span>${esc(idea)}</span></span></button>`).join("")}</div><div class="review-actions"><button id="review-delete" class="delete-draft">Entwurf löschen</button></div></div></div>`;
    reviewer.querySelectorAll("[data-pitch]").forEach((button) => button.addEventListener("click", async () => { button.disabled = true; await post("/api/pitch", { id: draft.id, idee: ideas[Number(button.dataset.pitch)] }); toast("Nachricht wird vorbereitet."); await load(); renderReviewer(); }));
    bindDraftDelete(draft);
  } else {
    const label = { message: "Antwort", first: "Erstnachricht", followup: "Follow-up", reaktivierung: "Netzwerk-Zusatz · Freigabe erforderlich", event: "Event-Einladung" }[draft.kind] || "Entwurf";
    const reviewHint = draft.kind === "reaktivierung"
      ? "Zusätzlicher Kontakt – wird nur nach deiner Genehmigung gesendet."
      : draft.approach_key ? `Ansatz: ${draft.approach_key.replaceAll("_", " ")}` : draft.intent || "bereit zur Prüfung";
    reviewer.innerHTML = `<div class="review-head"><div class="review-person"><span class="eyebrow">${label}</span><h3>${esc(draft.participant || "Kontakt")}</h3><p>${esc(reviewHint)}</p></div><span class="review-progress">${reviewIndex + 1} / ${list.length}</span></div><div class="review-context">${profileCard(draft)}<div class="review-compose">${draft.incoming && !String(draft.incoming).startsWith("campaign:") ? `<div class="incoming">${esc(draft.incoming)}</div>` : ""}<textarea id="review-text">${esc(draft.draft)}</textarea><div id="reject-feedback" class="reject-feedback hidden"><span class="eyebrow">Was soll sich ändern?</span><div class="feedback-options"><button data-feedback="different_approach">Komplett anderer Ansatz</button><button data-feedback="artificial">Klingt künstlich</button><button data-feedback="too_personal">Zu persönlich</button><button data-feedback="too_salesy">Zu verkäuferisch</button></div><div class="custom-feedback"><input id="custom-feedback-text" placeholder="Oder beschreibe kurz deine gewünschte Richtung…"/><button id="custom-feedback-send">Neu schreiben</button></div></div><div class="review-actions"><button id="review-delete" class="delete-draft">Entwurf löschen</button><button id="review-reject">Ablehnen</button><button id="review-approve" class="primary">Genehmigen</button></div></div></div>`;
    $("review-approve").onclick = async () => { await post("/api/draft", { id: draft.id, action: "approve", text: $("review-text").value }); toast("Genehmigt – NextLead stellt sicher zu."); await load(); renderReviewer(); };
    $("review-reject").onclick = () => { $("reject-feedback").classList.toggle("hidden"); $("reject-feedback").scrollIntoView({ behavior: "smooth", block: "nearest" }); };
    const rejectWith = async (reason, instruction = "") => { reviewer.querySelectorAll("[data-feedback],#custom-feedback-send").forEach((button) => { button.disabled = true; }); await post("/api/draft", { id: draft.id, action: "reject", text: { reason, instruction } }); toast(reason === "different_approach" ? "Wähle jetzt eine neue Gesprächsrichtung." : "Feedback gespeichert. Nachricht wurde neu geschrieben."); await load(); renderReviewer(); };
    reviewer.querySelectorAll("[data-feedback]").forEach((button) => button.addEventListener("click", () => rejectWith(button.dataset.feedback)));
    $("custom-feedback-send").onclick = () => { const instruction = $("custom-feedback-text").value.trim(); if (!instruction) return $("custom-feedback-text").focus(); rejectWith("custom", instruction); };
    bindDraftDelete(draft);
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
function updateCampaignPreview() { const list = campaignCandidates(); const network = list.filter((contact) => !!contact.aus_netzwerk || !!contact.accepted_at || ["accepted", "messaged", "replied"].includes(contact.status)).length; $("preview-total").textContent = list.length; $("preview-network").textContent = network; $("preview-external").textContent = list.length - network; }

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
  drafted: ["Entwurf liegt bereit", "draft"],
  sent: ["Eingeladen", "sent"],
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
    drafted: alle.filter((row) => row.target.status === "drafted").length,
    offen: alle.filter((row) => ["queued", "awaiting_connection"].includes(row.target.status)).length,
    reply: alle.filter((row) => hatAufKampagneGeantwortet(row.target, row.contact)).length,
  };
  const suche = ($("campaign-crm-search")?.value || "").toLowerCase().trim();
  let zeilen = alle;
  if (crmFilter === "sent") zeilen = zeilen.filter((row) => row.target.status === "sent");
  else if (crmFilter === "drafted") zeilen = zeilen.filter((row) => row.target.status === "drafted");
  else if (crmFilter === "offen") zeilen = zeilen.filter((row) => ["queued", "awaiting_connection"].includes(row.target.status));
  else if (crmFilter === "reply") zeilen = zeilen.filter((row) => hatAufKampagneGeantwortet(row.target, row.contact));
  if (suche) zeilen = zeilen.filter((row) => `${row.contact.full_name || ""} ${row.contact.headline || ""}`.toLowerCase().includes(suche));
  const chips = [["all", "Alle"], ["offen", "Eingeplant"], ["drafted", "Entwurf"], ["sent", "Eingeladen"], ["reply", "Geantwortet"]]
    .map(([key, label]) => `<button class="crm-chip ${crmFilter === key ? "active" : ""}" data-crm-filter="${key}">${label} ${zaehler[key] ?? 0}</button>`).join("");
  box.innerHTML = `
    <div class="review-head"><div class="review-person"><span class="eyebrow">Kampagnen-CRM</span><h3>${esc(campaign.name)}</h3><p>Nur die Kontakte dieser Kampagne. Das Ergebnis pflegst du direkt hier.</p></div><button class="icon-btn" data-crm-close>×</button></div>
    <div class="crm-toolbar">${chips}<input id="campaign-crm-search" placeholder="Name oder Position suchen" value="${esc(suche)}"/></div>
    <div class="crm-rows">${zeilen.length ? zeilen.slice(0, 200).map(({ target, contact }) => {
      const [stufe, cls] = crmStufe(target, contact);
      return `<div class="crm-row"><div class="contact-person"><b>${esc(contact.full_name || "Unbekannt")}</b><span>${esc(contact.headline || "Keine Headline")}</span></div><span class="crm-stufe ${cls}">${esc(stufe)}</span><span class="muted">${target.route === "network" ? "Netzwerk" : "Außerhalb"}</span><select data-crm-outcome="${contact.id}">${OUTCOMES.map(([value, label]) => `<option value="${value}" ${((contact.outcome_stage || "") === value) ? "selected" : ""}>${label}</option>`).join("")}</select><a href="${esc(contact.profile_url)}" target="_blank" rel="noopener">Profil ↗</a></div>`;
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
    return `<article class="campaign-card ${campaign.goal_code ? "mission-card" : ""}"><div><div class="campaign-meta"><span class="pill ${campaign.active ? "live" : ""}">${campaign.active ? "Läuft" : "Pausiert"}</span>${campaign.goal_code ? `<span class="pill goal-code goal-${esc(String(campaign.goal_code).toLowerCase())}">${esc(campaign.goal_code)}</span>` : ""}<span class="pill">${campaign.kind === "event" ? "Event" : "Outreach"}</span><span class="pill">${campaign.audience_scope === "both" ? "Netzwerk + außerhalb" : campaign.audience_scope === "network" ? "Netzwerk" : "Außerhalb"}</span>${assets ? `<span class="pill">${assets} Material${assets === 1 ? "" : "ien"}</span>` : ""}</div><h3>${esc(campaign.name)}</h3><span class="muted">${esc(campaign.search_brief || facts || campaign.goal || "")}${campaign.event_url ? ` · <a href="${esc(campaign.event_url)}" target="_blank" rel="noopener">Event öffnen ↗</a>` : ""}</span>${campaign.briefing ? `<p class="campaign-briefing">${esc(String(campaign.briefing).slice(0, 220))}${String(campaign.briefing).length > 220 ? "…" : ""}</p>` : ""}<div class="campaign-stats"><div><b>${campaign.targets || campaign.leads || 0}</b><span>Zielgruppe</span></div><div><b>${campaign.sources || 0}</b><span>Suchen</span></div><div><b>${campaign.target_external || 0}</b><span>Zu vernetzen</span></div><div><b>${campaign.target_drafted || 0}</b><span>Entwürfe</span></div><div><b>${campaign.replied || 0}</b><span>Antworten</span></div><div><b>${campaign.meetings || 0}</b><span>Termine</span></div></div></div><div class="campaign-actions">${offen ? `<button class="primary" data-campaign-review="${campaign.id}">${offen} Nachricht${offen === 1 ? "" : "en"} prüfen</button>` : `<span class="campaign-clear">Keine Nachricht offen</span>`}<button data-campaign-crm="${campaign.id}">Kontakte ansehen</button>${campaign.goal_code ? "" : `<button data-campaign-edit="${campaign.id}">Bearbeiten</button>`}<button data-campaign-toggle="${campaign.id}" data-active="${campaign.active ? 1 : 0}">${campaign.active ? "Pausieren" : "Fortsetzen"}</button><button class="delete-draft" data-campaign-delete="${campaign.id}" data-name="${esc(campaign.name)}" data-offen="${offen}">Löschen</button></div></article>`;
  }).join("") : `<div class="empty-work"><b>Noch kein Auftrag.</b><br/>Beschreibe, wen NextLead finden soll, und wähle B1, P1 oder AEC.</div>`;
  document.querySelectorAll("[data-campaign-toggle]").forEach((button) => button.addEventListener("click", async () => { await post("/api/campaign", { action: button.dataset.active === "1" ? "pause" : "resume", id: Number(button.dataset.campaignToggle) }); await load(); toast("Kampagne aktualisiert."); }));
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
function nextStep(contact) { if (contact.open_draft_kind === "message") return "Antwort prüfen"; if (contact.open_draft_kind === "event") return "Event-Einladung prüfen"; if (contact.open_draft_kind === "reaktivierung") return "Netzwerk-Zusatz freigeben"; if (contact.open_draft_id) return "Entwurf prüfen"; if (contact.status === "replied") return "Ergebnis festhalten"; if (contact.status === "accepted" && contact.aus_netzwerk) return "Nur manuell im Netzwerk-Zusatz"; if (contact.status === "accepted") return "Erstkontakt vorbereiten"; if (contact.status === "invited") return "Wartet auf Annahme"; if (contact.status === "new") return "Wird automatisch priorisiert"; return "Kein Schritt offen"; }
function renderContacts() {
  const query = $("contact-search").value.toLowerCase().trim(), filter = $("contact-filter").value;
  let rows = state.contacts || []; if (query) rows = rows.filter((contact) => `${contact.full_name || ""} ${contact.headline || ""}`.toLowerCase().includes(query)); if (filter === "attention") rows = rows.filter((contact) => contact.open_draft_id || contact.status === "replied"); else if (filter !== "all") rows = rows.filter((contact) => contact.status === filter);
  $("contact-count").textContent = `${rows.length} Kontakte`;
  $("contact-rows").innerHTML = rows.slice(0, 300).map((contact) => `<div class="contact-row"><div class="contact-person"><b>${esc(contact.full_name || "Unbekannt")}</b><span>${esc(contact.headline || "Keine Headline")}</span></div><span class="status-pill ${esc(contact.status)}">${STATUS[contact.status] || esc(contact.status)}</span><span class="next-step">${esc(nextStep(contact))}</span><a href="${esc(contact.profile_url)}" target="_blank" rel="noopener">Profil ↗</a></div>`).join("") || `<div class="empty-work">Keine Kontakte in diesem Filter.</div>`;
}

function renderInsights() {
  const historical = state.metrics?.historical || {}; const acceptance = pct(historical.accepted || 0, historical.invited || 0); const reply = pct(historical.replied || 0, historical.messaged || 0);
  const kpis = [["Anfragen", historical.invited || 0, "versendet"], ["Annahmequote", acceptance == null ? "–" : `${acceptance}%`, `${historical.accepted || 0} angenommen`], ["Antwortquote", reply == null ? "–" : `${reply}%`, `${historical.replied || 0} aus ${historical.messaged || 0} Nachrichten`], ["Termine", (state.bookedLeads || []).length, "persönlich übergeben"]];
  $("insight-kpis").innerHTML = kpis.map(([label, value, note]) => `<div class="kpi-card"><span>${label}</span><b>${value}</b><small>${note}</small></div>`).join("");
  const funnel = state.funnel || [], max = Math.max(1, ...funnel.map((item) => item.count)); $("funnel-bars").innerHTML = funnel.map((item, index) => { const previous = funnel[index - 1]; const conversion = previous?.count ? pct(item.count, previous.count) : null; return `<div class="funnel-row"><span>${esc(item.label)}</span><div class="funnel-track"><div class="funnel-fill" style="width:${Math.round(item.count / max * 100)}%"></div></div><span class="funnel-count">${item.count}</span><span class="funnel-conv">${conversion == null ? "Start" : `${conversion}%`}</span></div>`; }).join("");
  const actions = Object.entries(state.actionsToday || {}); $("today-actions").innerHTML = actions.length ? actions.map(([key, value]) => `<span><b>${value}</b> ${esc({ connect: "Anfragen", message: "Nachrichten", reply: "Antworten", like: "Likes", comment: "Kommentare" }[key] || key)}</span>`).join("") : `<span>Noch keine Aktionen heute.</span>`;
}

function automationLevel() { if (state.agentMode === "live") return "agent_live"; if (state.agentMode === "shadow") return "agent_test"; return state.mode === "semi" ? "halb" : "vorschlaege"; }
function renderSettings() {
  const alive = !!state.engine?.alive; $("engine-title").textContent = alive ? "Engine arbeitet" : "Engine ist aus"; $("engine-copy").textContent = alive ? "Vernetzung, Kampagnen und freigegebene Nachrichten laufen in einer gemeinsamen Prioritätsqueue." : "Ohne Engine werden keine Hintergrundaufgaben ausgeführt."; $("engine-toggle").textContent = alive ? "Engine stoppen" : "Engine starten";
  const level = automationLevel(); document.querySelectorAll("[data-level]").forEach((button) => button.classList.toggle("active", button.dataset.level === level));
  $("automation-copy").textContent = { vorschlaege: "NextLead vernetzt automatisch. Jede Nachricht bleibt ein Entwurf.", halb: "Azubi-Erstnachrichten werden automatisch gesendet, Antworten bleiben zur Prüfung.", agent_test: "Der Gesprächsagent denkt mit, sendet aber nicht selbst.", agent_live: "Der Gesprächsagent führt Routinegespräche selbst und übergibt wichtige Fälle." }[level] + " Bestehende Netzwerk-Kontakte brauchen in jeder Stufe deine Freigabe.";
  const g = state.governor || {}, connect = g.connect || {};
  /**
   * Das Lese-Budget steht bewusst GANZ OBEN und mit Warnfarbe: Es ist die Kennzahl, wegen der
   * LinkedIn am 05.08.2026 das Konto gesperrt hat ("große Menge an Profildaten abgerufen").
   * Sendezahlen waren nie das Problem – sichtbar war aber jahrelang nur die Sendeseite.
   */
  const lese = state.leseBudget || {};
  const quote = (teil) => (teil?.cap ? Math.round((teil.heute / teil.cap) * 100) : 0);
  const farbe = (teil) => quote(teil) >= 90 ? "var(--red)" : quote(teil) >= 70 ? "var(--amber)" : "var(--ink)";
  $("safety-summary").innerHTML =
    `<div class="safety-line"><span>Profile heute abgerufen</span><b style="color:${farbe(lese.profile)}">${lese.profile?.heute ?? 0} / ${lese.profile?.cap ?? "–"}</b></div>`
    + `<div class="safety-line"><span>Seiten heute abgerufen</span><b style="color:${farbe(lese.seiten)}">${lese.seiten?.heute ?? 0} / ${lese.seiten?.cap ?? "–"}</b></div>`
    + (lese.erschoepft ? `<div class="safety-line"><span>Lesen pausiert</span><b style="color:var(--red)">${esc(lese.grund || "Budget erreicht")}</b></div>` : "")
    + `<div class="safety-line"><span>Anfragen heute</span><b>${connect.today || 0} / ${connect.effectiveCap || connect.hardCap || "–"}</b></div>`
    + `<div class="safety-line"><span>Diese Woche</span><b>${connect.week || 0} / ${connect.weeklyCap || "–"}</b></div>`
    + `<div class="safety-line"><span>Geschäftszeiten</span><b>${g.zeitfenster === false ? "Aus" : "Aktiv"}</b></div>`
    + `<div class="safety-line"><span>Sendeweg</span><b>${esc(state.systemHealth?.sendeWeg || "unbekannt")}</b></div>`;
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
  $("faelle-title").textContent = faelle.length ? `${faelle.length} nicht zugestellt` : "Nichts offen";
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
    const result = await post("/api/campaign", { ...campaignFormValues(), action: editing ? "update" : "create", id: editing });
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
$("engine-toggle").onclick = async () => { await post("/api/engine", { action: state.engine?.alive ? "stop" : "start" }); toast(state.engine?.alive ? "Engine wird gestoppt." : "Engine startet."); setTimeout(load, 1800); };
$("backup-now").onclick = async () => { await post("/api/backup"); toast("Sicherung erstellt."); };
document.querySelectorAll("[data-level]").forEach((button) => button.addEventListener("click", async () => { await post("/api/automatik", { level: button.dataset.level }); await load(); toast("Automatik aktualisiert."); }));
$("source-add").onclick = async () => { await post("/api/source", { action: "add", label: $("source-label").value, url: $("source-url").value }); $("source-label").value = ""; $("source-url").value = ""; await load(); toast("Quelle gespeichert. Nachschub wird geholt."); };

// Alle 20s aktualisieren. Ist ein Prüfbereich offen, bleibt NUR dieser stehen – der Rest der
// Seite (Arbeitskorb, Kampagnen, Status) zieht trotzdem nach.
load(); setInterval(() => load(!!(reviewKinds || reviewCampaign)), 20000);
