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
/** Kurzes Datum für Arbeitsbereich und Kontaktspur. Reine Tagesangaben (`due_at` = "2026-09-25")
 * dürfen NICHT durch localDate laufen: das hängt ein "Z" an und ergibt ein ungültiges Datum. */
const kurzDatum = (value) => {
  const roh = String(value || "");
  if (!roh) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(roh)) {
    const [jahr, monat, tag] = roh.split("-");
    return new Date(Number(jahr), Number(monat) - 1, Number(tag)).toLocaleDateString("de-DE", { day: "2-digit", month: "short", year: "numeric" });
  }
  const datum = localDate(roh);
  return Number.isNaN(datum.getTime()) ? roh : datum.toLocaleDateString("de-DE", { day: "2-digit", month: "short", year: "numeric" });
};
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
/** Kampagnen sind stillgelegt (config.campaigns.enabled). Solange der Schalter aus ist, ist der
 * Bereich weder in der Navigation noch über einen alten Link erreichbar. Der Code bleibt. */
const kampagnenAus = () => state && state.kampagnenAktiv === false;
function showView(view) {
  activeView = VIEW_META[view] ? view : "today";
  if (activeView === "campaigns" && kampagnenAus()) activeView = "today";
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
  // „N Entwürfe warten“ steht schon in der Entscheidungsliste – hier nur echte Störungen.
  const blockaden = (state.blockaden || []).filter((b) => !['review', 'campaignReview'].includes(b.aktion?.art));
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
  renderQueue();
  renderQuick();
  renderTopStatus();
  renderTodayKpis();
  renderDecisions();
}

/** Uhrzeit oder Tag des nächsten Versuchs – "um 14:20", "morgen 07:00", "Mo 07:00". */
const wannText = (iso) => {
  if (!iso) return "";
  const d = new Date(iso), jetzt = new Date();
  if (Number.isNaN(d.getTime())) return "";
  const uhr = d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  const tage = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date(jetzt).setHours(0, 0, 0, 0)) / 86400000);
  if (tage <= 0) return d <= jetzt ? "jetzt" : `um ${uhr}`;
  if (tage === 1) return `morgen ${uhr}`;
  return `${d.toLocaleDateString("de-DE", { weekday: "short" })} ${uhr}`;
};
const QUEUE_STATUS = { laeuft: "Läuft", wartet: "Wartet", gestoppt: "Gestoppt", leer: "Leer" };
function renderQueue() {
  const box = $("queue-lanes");
  if (!box) return;
  const kanaele = state.warteschlange || [];
  box.innerHTML = kanaele.map((k) => {
    const limitPct = k.tagesLimit ? Math.min(100, Math.round((k.heute / k.tagesLimit) * 100)) : 0;
    const wann = wannText(k.naechsterVersuch);
    const zahlen = [
      `<div><b>${k.bereit}</b><span>${k.kanal === "anfragen" ? "in der Warteschlange" : "freigegeben, gehen raus"}</span></div>`,
      k.kanal === "nachrichten" ? `<div class="${k.wartetAufDich ? "needs-you" : ""}"><b>${k.wartetAufDich}</b><span>warten auf deine Freigabe</span></div>` : "",
      k.inVorbereitung ? `<div><b>${k.inVorbereitung}</b><span>angenommen, Text entsteht</span></div>` : "",
    ].join("");
    const naechste = (k.naechste || []).length
      ? `<ol class="queue-next">${k.naechste.map((e) => `<li><b>${esc(e.name)}</b><span>${esc(e.art)}</span></li>`).join("")}</ol>${k.bereit > k.naechste.length ? `<small class="queue-more">+ ${k.bereit - k.naechste.length} weitere</small>` : ""}`
      : "";
    return `<article class="queue-lane ${esc(k.status)}">
      <header><span class="lane-label">${esc(k.titel)}</span><span class="queue-pill ${esc(k.status)}"><i></i>${QUEUE_STATUS[k.status] || esc(k.status)}</span></header>
      <p class="queue-why">${esc(k.statusText)}${wann ? ` <strong>Nächster Versuch ${esc(wann)}.</strong>` : ""}</p>
      <div class="queue-limit"><div><span>Heute gesendet</span><b>${k.heute} / ${k.tagesLimit}</b></div><em><i style="width:${limitPct}%"></i></em>${k.wochenLimit ? `<small>Diese Woche ${k.woche} / ${k.wochenLimit}</small>` : ""}</div>
      <div class="queue-counts">${zahlen}</div>
      ${k.reichtTage ? `<small class="queue-reach">Beim heutigen Limit reicht das für etwa ${k.reichtTage} ${k.reichtTage === 1 ? "Tag" : "Tage"}.</small>` : ""}
      ${naechste ? `<div class="queue-order"><span class="lane-label">Als Nächstes</span>${naechste}</div>` : ""}
      ${k.zuletzt ? `<small class="queue-last">Zuletzt: ${esc(k.zuletzt.name)}, ${esc(relativeTime(k.zuletzt.at))}</small>` : ""}
    </article>`;
  }).join("");
}

/**
 * STARTSEITE „HEUTE“ – Designrunde 2 (2026-09-23, Sinan: „zu unübersichtlich“).
 * Vorher sieben Blöcke untereinander, „Engine läuft nicht“ stand an drei Stellen. Jetzt:
 * eine Statuszeile oben rechts, vier Zahlen, die Entscheidungsliste als Hauptsache, und die
 * Bot-Details (Warteschlange, Aktivität) nur noch aufklappbar.
 */
const ENTSCHEIDUNG_ART = { message: "Antwort", pitchidee: "Antwort · Richtung", first: "Erstnachricht", followup: "Nachfassung", reaktivierung: "Netzwerk", comment: "Kommentar", event: "Einladung" };
const WICHTIG_INTENT = { chance: "Chance", meeting: "Termin", einwand: "Einwand", goal_deviation: "Zielwechsel" };
let entscheidungenAlle = false;
const zeitKurz = (iso) => iso ? new Date(iso).toLocaleString("de-DE", { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "";

function renderTopStatus() {
  const el = $("top-status"); if (!el) return;
  const alive = !!state.engine?.alive, notAus = !!state.governor?.notAus, pause = !!state.governor?.paused;
  const k = state.warteschlange || [];
  const laeuft = k.some((x) => x.status === "laeuft");
  const naechster = k.map((x) => x.naechsterVersuch).filter(Boolean).sort()[0];
  const [ton, text] = notAus ? ["bad", "Not-Aus aktiv"]
    : !alive ? ["bad", "Bot ist aus"]
    : pause ? ["warn", "Sicherheitspause"]
    : laeuft ? ["ok", "Bot sendet"]
    : ["warn", naechster ? `Bot wartet · weiter ${zeitKurz(naechster)}` : "Bot wartet"];
  el.className = `top-status ${ton}`;
  el.innerHTML = `<i></i>${esc(text)}`;
  el.title = k.map((x) => `${x.titel}: ${x.statusText}`).join("\n");
}

function renderTodayKpis() {
  const k = state.warteschlange || [], n = k[0] || {}, a = k[1] || {};
  const zellen = [
    { wert: state.attention?.total || 0, text: "Entscheidungen für dich", akzent: true, ziel: "quick" },
    { wert: `${n.heute ?? 0}/${n.tagesLimit ?? 0}`, text: "Nachrichten heute" },
    { wert: `${a.heute ?? 0}/${a.tagesLimit ?? 0}`, text: "Anfragen heute" },
    { wert: a.bereit ?? 0, text: "Kontakte in der Warteschlange" },
  ];
  $("today-kpis").innerHTML = zellen.map((z) => `<${z.ziel ? "button" : "div"} class="today-kpi ${z.akzent ? "akzent" : ""}" ${z.ziel ? `data-kpi="${z.ziel}"` : ""}><b>${esc(String(z.wert))}</b><span>${esc(z.text)}</span></${z.ziel ? "button" : "div"}>`).join("");
  $("today-kpis").querySelector("[data-kpi=quick]")?.addEventListener("click", () => $("quick-open").click());
}

function oeffneEntwurf(id) {
  const d = (state.drafts || []).find((x) => x.id === id); if (!d) return;
  const gruppe = GROUPS.find((g) => g.kinds.includes(d.kind));
  reviewCampaign = null; reviewKinds = gruppe ? gruppe.kinds : [d.kind];
  reviewIndex = Math.max(0, reviewList().findIndex((x) => x.id === id));
  renderReviewer();
  $("reviewer").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderDecisions() {
  const att = state.attention || {};
  const drafts = (state.drafts || []).filter((d) => d.kind !== "event");
  $("decisions-count").textContent = att.total || "";
  const zeilen = [];
  if (att.systemIssues) zeilen.push({ dringend: true, art: "Technik", name: `${att.systemIssues} technische${att.systemIssues === 1 ? "s Problem" : " Probleme"}`, text: "Sendeweg oder unklare Zustellung prüfen", ziel: () => showView("settings") });
  // Übergaben einzeln – mit Name, Nummer, Chat-Link und Abhaken. Vorher eine Sammelzeile, die
  // nur auf die Kontaktliste sprang und nie verschwand.
  for (const u of state.bookedLeads || []) zeilen.push({ uebergabe: u, dringend: true, art: "Termin", name: u.participant || "Unbekannt", text: u.contact ? `Kontakt: ${u.contact}` : "Gespräch übernehmen", zeit: u.updated_at });
  for (const d of drafts) {
    const wichtig = WICHTIG_INTENT[d.intent];
    const badge = d.phase === "approach" ? `<span class="quick-badge neutral">Richtung wählen</span>`
      : wichtig ? `<span class="quick-badge warn">${esc(wichtig)}</span>`
      : d.pruefung ? (d.pruefung.ok ? `<span class="quick-badge ok">geprüft</span>` : `<span class="quick-badge bad" title="${esc(d.pruefung.gruende.join(", "))}">prüfen</span>`)
      : "";
    const vorschau = d.kind === "message" && d.incoming && !String(d.incoming).startsWith("campaign:") ? `„${d.incoming}“` : d.phase === "approach" ? "Neue Gesprächsrichtung auswählen" : d.draft;
    zeilen.push({ dringend: !!wichtig || d.kind === "message", art: ENTSCHEIDUNG_ART[d.kind] || d.kind, name: d.participant || d.profile?.fullName || "Kontakt", text: vorschau, badge, zeit: d.created_at, id: d.id });
  }
  const sichtbar = entscheidungenAlle ? zeilen : zeilen.slice(0, 12);
  $("decision-list").innerHTML = zeilen.length
    ? sichtbar.map((z, i) => z.uebergabe ? `<div class="decision handover dringend"><i></i><span class="d-art">${esc(z.art)}</span><b class="d-name">${esc(z.name)}</b><span class="d-text">${esc(z.text)}</span><span class="handover-actions"><a class="icon-link wide" href="${esc(z.uebergabe.thread_url)}" target="_blank" rel="noopener">Chat öffnen ↗</a><button data-uebergabe="${i}" data-aktion="erledigt">Erledigt</button><button data-uebergabe="${i}" data-aktion="kein_termin" title="Fehlalarm – war kein echter Termin">Kein Termin</button></span><small class="d-zeit">${z.zeit ? esc(relativeTime(z.zeit)) : ""}</small><span></span></div>` : `<button class="decision ${z.dringend ? "dringend" : ""}" data-decision="${i}"><i></i><span class="d-art">${esc(z.art)}</span><b class="d-name">${esc(z.name)}</b><span class="d-text">${esc(String(z.text || "").replace(/\s+/g, " ").slice(0, 140))}</span>${z.badge || "<span></span>"}<small class="d-zeit">${z.zeit ? esc(relativeTime(z.zeit)) : ""}</small><span class="d-go" aria-hidden="true">›</span></button>`).join("")
      + (zeilen.length > 12 ? `<button class="decision-more" data-more>${entscheidungenAlle ? "Weniger anzeigen" : `Alle ${zeilen.length} anzeigen`}</button>` : "")
    : `<div class="decision-empty"><b>Alles entschieden.</b><span>NextLead arbeitet weiter und meldet sich, sobald du wieder gebraucht wirst.</span></div>`;
  $("decision-list").querySelectorAll("[data-decision]").forEach((b) => b.addEventListener("click", () => {
    const z = sichtbar[Number(b.dataset.decision)];
    if (z.id) oeffneEntwurf(z.id); else z.ziel?.();
  }));
  $("decision-list").querySelectorAll("[data-uebergabe]").forEach((b) => b.addEventListener("click", async () => {
    const z = sichtbar[Number(b.dataset.uebergabe)];
    b.disabled = true;
    try { await post("/api/uebergabe", { thread_url: z.uebergabe.thread_url, action: b.dataset.aktion }); toast(b.dataset.aktion === "erledigt" ? "Übergabe erledigt." : "Als Fehlalarm entfernt."); await load(); }
    catch (error) { toast(error.message); b.disabled = false; }
  }));
  $("decision-list").querySelector("[data-more]")?.addEventListener("click", () => { entscheidungenAlle = !entscheidungenAlle; renderDecisions(); });
  const k = state.warteschlange || [];
  $("bot-summary").textContent = k.map((x) => `${x.titel}: ${({ laeuft: "sendet", wartet: "wartet", gestoppt: "gestoppt", leer: "nichts zu tun" })[x.status] || x.status}`).join(" · ");
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
    reviewer.innerHTML = `<div class="review-head"><div class="review-person"><span class="eyebrow">${label}</span><h3>${esc(draft.participant || "Kontakt")}</h3><p>${esc(reviewHint)}</p></div><span class="review-progress">${reviewIndex + 1} / ${list.length}</span></div><div class="review-context">${profileCard(draft)}<div class="review-compose">${draft.incoming && !String(draft.incoming).startsWith("campaign:") ? `<div class="incoming">${esc(draft.incoming)}</div>` : ""}${contextEvidenceCard(draft)}<textarea data-review-field="text">${esc(draft.draft)}</textarea><div data-review-panel="reject" class="reject-feedback hidden"><span class="eyebrow">Was soll sich ändern?</span><div class="feedback-options"><button data-feedback="different_approach">Komplett anderer Ansatz</button><button data-feedback="artificial">Klingt künstlich</button><button data-feedback="too_personal">Zu persönlich</button><button data-feedback="too_salesy">Zu verkäuferisch</button></div><div class="custom-feedback"><input data-review-field="feedback" placeholder="Oder beschreibe kurz deine gewünschte Richtung…"/><button data-review-action="rewrite">Neu schreiben</button></div></div><div data-review-panel="coach" class="coach-panel hidden"></div><div class="review-actions"><button data-review-action="delete" class="delete-draft">Entwurf löschen</button><button data-review-action="coach" title="Ein Vertriebscoach bewertet den Entwurf und schlägt eine bessere Fassung vor (ein Claude-Aufruf)">✨ KI-Coach</button><button data-review-action="reject">Ablehnen</button><button data-review-action="approve" class="primary">Genehmigen</button></div></div></div>`;
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
    const coach = reviewer.querySelector('[data-review-action="coach"]');
    const coachPanel = reviewer.querySelector('[data-review-panel="coach"]');
    coach.onclick = async () => {
      coach.disabled = true; coach.textContent = "Coach liest …";
      coachPanel.classList.remove("hidden"); coachPanel.innerHTML = `<p class="muted">Der Coach schaut sich den Entwurf an …</p>`;
      try {
        const r = await post("/api/draft/coach", { id: draft.id }, 90000);
        const warn = r.pruefung && !r.pruefung.ok ? `<p class="coach-warn">Achtung, der Vorschlag besteht die Prüfung nicht: ${esc(r.pruefung.gruende.join(", "))}</p>` : "";
        coachPanel.innerHTML = `<div class="coach-row"><b>Stark</b><span>${esc(r.staerke)}</span></div><div class="coach-row"><b>Ändern</b><span>${esc(r.aendern)}</span></div><div class="coach-vorschlag">${esc(r.vorschlag)}</div>${warn}<div class="coach-actions"><button data-coach-take class="primary">Vorschlag übernehmen</button><span class="muted">landet im Textfeld, genehmigen musst du selbst</span></div>`;
        coachPanel.querySelector("[data-coach-take]").onclick = () => { textField.value = r.vorschlag; textField.focus(); toast("Vorschlag übernommen. Prüfen und genehmigen."); };
      } catch (error) { coachPanel.innerHTML = `<p class="coach-warn">${esc(error.message)}</p>`; }
      finally { coach.disabled = false; coach.textContent = "✨ KI-Coach"; }
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
/**
 * ARBEITSBEREICH JE KONTAKT (2026-09-22): Stufe, Aufgaben und Notizen an EINEM Ort, direkt über
 * der Kontaktspur. Bewusst im selben Dialog wie die Spur – wer etwas festhält, hat den Verlauf
 * daneben und muss nicht zwischen Ansichten wechseln.
 */
function zeichneKontaktArbeitsbereich(contact, workspace) {
  const stufen = workspace.stufen || {};
  const manuell = stufen.manuell || [];
  const erreicht = new Map((stufen.erreicht || []).map((row) => [row.stage, row]));
  const aktuell = stufen.aktuell;
  const kette = (stufen.alle || []).filter((stage) => stage !== "lost" && stage !== "not_fit");
  const heute = new Date().toISOString().slice(0, 10);
  const aufgaben = workspace.tasks || [], notizen = workspace.notes || [];
  const offeneAufgaben = aufgaben.filter((task) => task.status === "open");
  const erledigte = aufgaben.filter((task) => task.status !== "open");

  $("contact-desk").innerHTML = `
    <section class="desk-block">
      <div class="desk-head"><b>Stufe</b><span>Beobachtetes vom Bot ist fest. Setzbar ist, was nur du beurteilen kannst.</span></div>
      <ol class="stage-chain">${kette.map((stage) => {
        const treffer = erreicht.get(stage);
        return `<li class="${treffer ? "erreicht" : ""} ${aktuell === stage ? "aktuell" : ""}"><b>${esc(STUFE[stage] || stage)}</b>${treffer ? `<time>${esc(kurzDatum(treffer.seit))}</time>` : ""}</li>`;
      }).join("")}</ol>
      <div class="stage-actions">${manuell.map((stage) => `<button type="button" data-stage="${esc(stage)}" class="${aktuell === stage ? "aktiv" : ""}">${esc(STUFE[stage] || stage)}</button>`).join("")}</div>
      <p class="desk-note" id="stage-note" role="status"></p>
    </section>
    <section class="desk-block">
      <div class="desk-head"><b>Aufgaben</b><span>${offeneAufgaben.length} offen</span></div>
      <form class="desk-form" id="task-form"><input id="task-title" maxlength="220" placeholder="Nächster Schritt, z. B. Montag anrufen" required /><input id="task-due" type="date" /><button type="submit" class="primary">Merken</button></form>
      <ul class="desk-list">${offeneAufgaben.map((task) => `<li class="${task.due_at && task.due_at <= heute ? "faellig" : ""}"><span>${esc(task.title)}${task.due_at ? ` <time>fällig ${esc(kurzDatum(task.due_at))}</time>` : ""}</span><span class="desk-row-actions"><button type="button" data-task-done="${task.id}">Erledigt</button><button type="button" data-task-del="${task.id}" aria-label="Aufgabe löschen">×</button></span></li>`).join("") || `<li class="desk-empty">Nichts offen.</li>`}
      ${erledigte.slice(-3).map((task) => `<li class="erledigt"><span>${esc(task.title)}</span><span class="desk-row-actions"><button type="button" data-task-del="${task.id}" aria-label="Aufgabe löschen">×</button></span></li>`).join("")}</ul>
    </section>
    <section class="desk-block">
      <div class="desk-head"><b>Notizen</b><span>${notizen.length} gespeichert</span></div>
      <form class="desk-form spalte" id="note-form"><textarea id="note-text" rows="2" maxlength="4000" placeholder="Was war wichtig? z. B. Ergebnis des Telefonats" required></textarea><button type="submit" class="primary">Notiz speichern</button></form>
      <ul class="desk-list">${notizen.map((note) => `<li><span>${esc(note.text)}<time>${esc(kurzDatum(note.created_at))}</time></span><span class="desk-row-actions"><button type="button" data-note-del="${note.id}" aria-label="Notiz löschen">×</button></span></li>`).join("") || `<li class="desk-empty">Noch keine Notiz.</li>`}</ul>
    </section>`;

  const neuLaden = async () => { await load(true); await openContactWorkspace(contact); };
  const desk = $("contact-desk");

  desk.querySelectorAll("[data-stage]").forEach((button) => button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      // post() wirft bei einer Ablehnung mit dem Klartext-Grund aus der API.
      await post("/api/stage", { contactId: contact.id, stage: button.dataset.stage });
      toast(`Stufe gesetzt: ${STUFE[button.dataset.stage] || button.dataset.stage}`);
      await neuLaden();
    } catch (error) { $("stage-note").textContent = error.message; button.disabled = false; }
  }));

  $("task-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const title = $("task-title").value.trim(); if (!title) return;
    try { await post("/api/task", { action: "create", contactId: contact.id, title, dueAt: $("task-due").value || undefined }); await neuLaden(); toast("Aufgabe gemerkt."); }
    catch (error) { toast(`Nicht gespeichert: ${error.message}`); }
  });
  desk.querySelectorAll("[data-task-done]").forEach((button) => button.addEventListener("click", async () => {
    button.disabled = true;
    try { await post("/api/task", { action: "complete", id: Number(button.dataset.taskDone) }); await neuLaden(); }
    catch (error) { toast(error.message); button.disabled = false; }
  }));
  desk.querySelectorAll("[data-task-del]").forEach((button) => button.addEventListener("click", async () => {
    button.disabled = true;
    try { await post("/api/task", { action: "delete", id: Number(button.dataset.taskDel) }); await neuLaden(); }
    catch (error) { toast(error.message); button.disabled = false; }
  }));

  $("note-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = $("note-text").value.trim(); if (!text) return;
    try { await post("/api/note", { action: "create", contactId: contact.id, text }); await neuLaden(); toast("Notiz gespeichert."); }
    catch (error) { toast(`Nicht gespeichert: ${error.message}`); }
  });
  desk.querySelectorAll("[data-note-del]").forEach((button) => button.addEventListener("click", async () => {
    button.disabled = true;
    try { await post("/api/note", { action: "delete", id: Number(button.dataset.noteDel) }); await neuLaden(); }
    catch (error) { toast(error.message); button.disabled = false; }
  }));
}

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
    zeichneKontaktArbeitsbereich(contact, workspace);
    const timeline = [...(workspace.timeline || [])].reverse();
    $("contact-timeline").innerHTML = timeline.length ? timeline.map((item) => `<article class="timeline-item ${esc(item.kind)}"><span class="timeline-mark"></span><div class="timeline-body"><div><b>${esc(item.title)}</b><time>${esc(timelineDate(item.ts))}</time></div>${item.text ? `<p>${esc(item.text)}</p>` : ""}<small>${esc(item.source || "NextLead")}</small></div></article>`).join("") : `<div class="timeline-empty"><b>Noch keine Aktivität gespeichert.</b><span>Sobald NextLead eine Aktion oder Nachricht zuordnet, erscheint sie hier.</span></div>`;
  } catch (error) {
    $("contact-desk").innerHTML = "";
    $("contact-timeline").innerHTML = `<div class="timeline-empty"><b>Kontaktspur konnte nicht geladen werden.</b><span>${esc(error.message)}</span></div>`;
  }
}
/** Vertriebsstufen in Klartext. Reihenfolge = Fortschritt; `lost`/`not_fit` sind Endpunkte. */
const STUFE = {
  found: "Gefunden", suitable: "Geeignet", invited: "Eingeladen", accepted: "Angenommen",
  messaged: "Angeschrieben", replied: "Geantwortet", qualified: "Passt", meeting: "Termin",
  won: "Gewonnen", lost: "Verloren", not_fit: "Passt nicht",
};
const STUFE_RANG = { found: 1, suitable: 2, invited: 3, accepted: 4, messaged: 5, replied: 6, qualified: 7, meeting: 8, won: 9, lost: 0, not_fit: 0 };
const STATUS_RANG = { replied: 0, messaged: 1, accepted: 2, invited: 3, new: 4 };
/** Kein Standard-Sortierschlüssel: ohne Klick bleibt die serverseitige Dringlichkeit erhalten
 * (Antworten zuerst). Erst ein Klick auf die Kopfzeile ordnet nach einer Spalte um. */
let contactSort = { key: null, dir: "asc" };

function contactSortValue(contact, key) {
  if (key === "name") return (contact.full_name || "").toLowerCase();
  if (key === "status") return STATUS_RANG[contact.status] ?? 9;
  if (key === "stufe") return STUFE_RANG[contact.outcome_stage] ?? -1;
  if (key === "score") return contact.ki_score ?? contact.lead_score ?? -1;
  if (key === "quelle") return (contact.quelle || "").toLowerCase();
  if (key === "beruehrung") return contact.letzte_beruehrung || "";
  return "";
}

function renderContacts() {
  const query = $("contact-search").value.toLowerCase().trim(), filter = $("contact-filter").value;
  let rows = state.contacts || [];
  if (query) rows = rows.filter((contact) => `${contact.full_name || ""} ${contact.headline || ""} ${contact.quelle || ""}`.toLowerCase().includes(query));
  if (filter === "attention") rows = rows.filter((contact) => contact.open_draft_id || contact.status === "replied" || contact.automation_status === "paused");
  else if (filter === "paused" || filter === "excluded") rows = rows.filter((contact) => contact.automation_status === filter);
  else if (filter !== "all") rows = rows.filter((contact) => contact.status === filter);
  if (contactSort.key) {
    const richtung = contactSort.dir === "desc" ? -1 : 1;
    rows = rows.slice().sort((a, b) => {
      const links = contactSortValue(a, contactSort.key), rechts = contactSortValue(b, contactSort.key);
      if (links === rechts) return 0;
      return (links > rechts ? 1 : -1) * richtung;
    });
  }
  $("contact-count").textContent = `${rows.length} Kontakte`;
  document.querySelectorAll(".contact-head [data-sort]").forEach((el) => {
    if (el.dataset.sort === contactSort.key) el.dataset.dir = contactSort.dir; else delete el.dataset.dir;
  });
  const quality = state.identityQuality || {};
  $("identity-quality").className = `identity-quality ${quality.ambiguous ? "needs-review" : ""}`;
  $("identity-quality").textContent = quality.ambiguous
    ? `${quality.ambiguous} Zuordnung${quality.ambiguous === 1 ? "" : "en"} prüfen · ${quality.threads_linked || 0} verbunden`
    : quality.orphaned
      ? `${quality.threads_linked || 0} verbunden · ${quality.orphaned} alte Chats getrennt`
      : `${quality.threads_linked || 0} Gespräche sicher verbunden`;
  const heute = new Date().toISOString().slice(0, 10);
  $("contact-rows").innerHTML = rows.slice(0, 300).map((contact) => {
    const protectedState = relationshipLabel(contact);
    const stufe = contact.outcome_stage ? `<span class="contact-stage">${esc(STUFE[contact.outcome_stage] || contact.outcome_stage)}</span>` : `<span class="contact-stage leer">–</span>`;
    const faellig = contact.naechste_faelligkeit && contact.naechste_faelligkeit <= heute;
    const offen = [
      contact.offene_aufgaben ? `<i class="${faellig ? "faellig" : ""}" title="offene Aufgaben">${contact.offene_aufgaben}✓</i>` : "",
      contact.notizen ? `<i title="Notizen">${contact.notizen}✎</i>` : "",
    ].join("");
    // Designrunde 2: sechs Spalten statt neun – Stufe steht unter dem Status, Aufgaben/Notizen
    // als Symbole am Namen, die Quelle im Tooltip.
    return `<div class="contact-row"><div class="contact-person" title="${esc(contact.quelle ? `Quelle: ${contact.quelle}` : "")}"><b>${esc(contact.full_name || "Unbekannt")}${offen ? `<span class="contact-open">${offen}</span>` : ""}</b><span>${esc(contact.headline || "Keine Headline")}</span>${protectedState ? `<i class="relationship-state ${contact.automation_status === "excluded" ? "excluded" : ""}">${esc(protectedState)}</i>` : ""}</div><div class="contact-status"><span class="status-pill ${esc(contact.status)}">${STATUS[contact.status] || esc(contact.status)}</span>${contact.outcome_stage ? stufe : ""}</div><span class="contact-score" title="${esc(contact.ki_grund ? `KI: ${contact.ki_score} · ${({ beratung: "Beratung", partner: "Partner", beide: "Beratung + Partner", keiner: "passt nicht" })[contact.ki_fit] || ""} · ${contact.ki_grund}` : "Regel-Note (noch nicht von der KI bewertet)")}">${contact.ki_score ?? contact.lead_score ?? "–"}${contact.ki_score != null ? `<i class="ki-mark">KI</i>` : ""}</span><span class="contact-meta">${contact.letzte_beruehrung ? esc(relativeTime(contact.letzte_beruehrung)) : "–"}</span><span class="next-step">${esc(nextStep(contact))}</span><span class="contact-actions"><button class="contact-history" data-contact-history="${contact.id}">Verlauf</button><button class="contact-policy icon-only ${protectedState ? "resume" : ""}" data-contact-policy="${contact.id}" title="${protectedState ? "Wieder freigeben" : "Kontakt pausieren"}" aria-label="${protectedState ? "Wieder freigeben" : "Kontakt pausieren"}">${protectedState ? "▶" : "⏸"}</button><a class="icon-link" href="${esc(contact.profile_url)}" target="_blank" rel="noopener" title="LinkedIn-Profil öffnen" aria-label="LinkedIn-Profil öffnen">↗</a></span></div>`;
  }).join("") || `<div class="empty-work">Keine Kontakte in diesem Filter.</div>`;
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

// Sortierung: derselbe Schlüssel schaltet die Richtung um, ein neuer beginnt aufsteigend.
document.querySelectorAll(".contact-head [data-sort]").forEach((kopf) => kopf.addEventListener("click", () => {
  const key = kopf.dataset.sort;
  contactSort = contactSort.key === key ? { key, dir: contactSort.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" };
  renderContacts();
}));

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

/**
 * WAS WIRKT (2026-09-23): eigener Ladepfad mit laufender Nummer wie `ladeWirkung` – keine
 * Lade-Sperre, die späte Antworten verwirft. Einmal beim Öffnen der Auswertung, sonst per Knopf.
 */
const SLOT_TITEL = { first: "Erstnachricht", "followup:wert": "Nachfassung mit Angebot", "followup:abschied": "Schlussstrich", reaktivierung: "Netzwerk-Reaktivierung" };
let variantenAnfrage = 0, variantenGeladen = false;
async function ladeVarianten() {
  const nr = ++variantenAnfrage;
  try {
    const r = await (await fetch("/api/varianten", { cache: "no-store" })).json();
    if (nr !== variantenAnfrage) return;
    variantenGeladen = true;
    $("varianten-body").innerHTML = r.slots.map((s) => `<div class="var-slot"><b>${esc(SLOT_TITEL[s.slot] || s.slot)}</b><table class="var-table"><thead><tr><th>Stil</th><th>gesendet</th><th>ausgewertet</th><th>Antworten</th><th>positiv</th><th>Quote</th><th>Status</th></tr></thead><tbody>${s.arme.map((a) => `<tr><td>${esc(a.titel)}${a.ki ? ` <i class="ki-mark" title="Von der KI erfundener Herausforderer">KI</i>` : ""}</td><td>${a.gesendet}</td><td>${a.reif}</td><td>${a.antworten}</td><td>${a.positiv}</td><td>${a.quote == null ? "–" : `${Math.round(a.quote * 100)} %`}</td><td class="muted">${esc(a.status)}</td></tr>`).join("")}</tbody></table></div>`).join("");
  } catch (error) { if (nr === variantenAnfrage) $("varianten-body").textContent = `Nicht geladen: ${error.message}`; }
}
$("varianten-reload").onclick = ladeVarianten;

/** KI-WOCHENANALYSE (2026-09-23): gespeichertes Ergebnis anzeigen, auf Knopfdruck neu erzeugen. */
let analyseGeladen = false;
function zeigeAnalyse(a) {
  if (!a) { $("ki-analyse-body").innerHTML = `<p class="muted">Noch keine Analyse. Läuft automatisch jeden Montag, oder jetzt per Knopf.</p>`; return; }
  $("ki-analyse-body").innerHTML = `<p class="ki-fazit">${esc(a.kurzfazit)}</p><ol class="ki-empf">${a.empfehlungen.map((r) => `<li><b>${esc(r.titel)}</b><span>${esc(r.warum)}</span><small>→ ${esc(r.wo)}</small></li>`).join("")}</ol><p class="muted">Stand ${new Date(a.at).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</p>`;
}
async function ladeAnalyse() { try { analyseGeladen = true; zeigeAnalyse((await (await fetch("/api/ki-analyse", { cache: "no-store" })).json()).analyse); } catch { analyseGeladen = false; } }
$("ki-analyse-run").onclick = async () => {
  const b = $("ki-analyse-run"); b.disabled = true; b.textContent = "KI analysiert …";
  try { zeigeAnalyse((await post("/api/ki-analyse", {}, 120000)).analyse); }
  catch (error) { toast(`Analyse fehlgeschlagen: ${error.message}`); }
  finally { b.disabled = false; b.textContent = "✨ Jetzt analysieren"; }
};

function renderInsights() {
  if (!variantenGeladen) ladeVarianten();
  if (!analyseGeladen) ladeAnalyse();
  const historical = state.metrics?.historical || {}; const acceptance = pct(historical.accepted || 0, historical.invited || 0); const reply = pct(historical.replied || 0, historical.messaged || 0);
  const kpis = [["Anfragen", historical.invited || 0, "versendet"], ["Annahmequote", acceptance == null ? "–" : `${acceptance}%`, `${historical.accepted || 0} angenommen`], ["Antwortquote", reply == null ? "–" : `${reply}%`, `${historical.replied || 0} aus ${historical.messaged || 0} Nachrichten`], ["Termine", state.terminCount ?? (state.bookedLeads || []).length, "persönlich übergeben"]];
  $("insight-kpis").innerHTML = kpis.map(([label, value, note]) => `<div class="kpi-card"><span>${label}</span><b>${value}</b><small>${note}</small></div>`).join("");
  // Die Wirkungs-Auswertung hat einen eigenen Ladepfad. Sie wird EINMAL geholt und danach nur
  // noch, wenn der Nutzer einen Filter ändert — der 30-Sekunden-Takt des Dashboards soll die
  // Ansicht nicht ständig unter den Händen neu aufbauen.
  fuelleWirkungFilter();
  if (!wirkungDaten) ladeWirkung();
  if (!berichtDaten) ladeBericht();
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

/* ===== TAGES-/WOCHENBERICHT ===== */
let berichtArt = "tag", berichtDatum = null, berichtAnfrage = 0, berichtDaten = null;
const heuteIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const isoPlus = (iso, tage) => { const [y, m, d] = iso.split("-").map(Number); const x = new Date(y, m - 1, d + tage); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };
async function ladeBericht() {
  const meine = ++berichtAnfrage;
  const datum = berichtDatum || heuteIso();
  $("bericht-datum").value = datum;
  try {
    const response = await fetch(`/api/bericht?art=${berichtArt}&datum=${datum}`, { cache: "no-store" });
    const daten = await response.json();
    if (meine !== berichtAnfrage) return; // überholt
    if (!response.ok || daten.error) throw new Error(daten.error || "Bericht nicht ladbar");
    berichtDaten = daten; renderBericht();
  } catch (error) {
    if (meine !== berichtAnfrage) return;
    $("bericht-inhalt").innerHTML = `<div class="empty-work">${esc(error.message)}</div>`;
  }
}
function renderBericht() {
  const b = berichtDaten; if (!b) return;
  $("bericht-titel").textContent = b.art === "tag" ? "Tagesbericht" : "Wochenbericht";
  $("bericht-zeitraum").textContent = `${b.zeitraum.label} · Vergleich: ${b.vergleich.label}`;
  const kachel = (label, key, hinweis) => {
    const jetzt = b.zahlen[key] || 0, vorher = b.vorher[key] || 0, d = jetzt - vorher;
    const cls = d > 0 ? "plus" : d < 0 ? "minus" : "gleich";
    return `<div class="bericht-kachel"><span>${label}</span><b>${jetzt}</b><small class="${cls}">${d > 0 ? "+" : ""}${d} zum Vergleich</small>${hinweis ? `<span>${esc(hinweis)}</span>` : ""}</div>`;
  };
  const kacheln = [
    kachel("Anfragen", "anfragen"), kachel("Neue Kontakte", "neueKontakte"), kachel("Angenommen", "angenommen"),
    kachel("Angeschrieben", "angeschrieben"), kachel("Geantwortet", "geantwortet", b.zahlen.geantwortet ? `davon positiv ${b.zahlen.positiv}` : ""),
    kachel("Qualifiziert", "qualifiziert"), kachel("Termine", "termine"), kachel("Nachrichten gesendet", "nachrichten"),
  ].join("");
  const tage = b.art === "woche" ? `<table class="bericht-tage"><thead><tr><th>Tag</th><th>Anfragen</th><th>Angenommen</th><th>Angeschrieben</th><th>Geantwortet</th></tr></thead><tbody>${b.tage.map((t) => `<tr><td>${t.wochentag} ${t.datum.slice(8)}.${t.datum.slice(5, 7)}.</td><td>${t.anfragen}</td><td>${t.angenommen}</td><td>${t.angeschrieben}</td><td>${t.geantwortet}</td></tr>`).join("")}</tbody></table>` : "";
  const fuss = [
    b.quoten.annahme != null ? `Annahme im Zeitraum <b>${b.quoten.annahme}%</b>` : "",
    b.quoten.antwort != null ? `Antwort <b>${b.quoten.antwort}%</b>` : "",
    b.top.kampagne ? `Beste Kampagne <b>${esc(b.top.kampagne.name)}</b> (${b.top.kampagne.geantwortet} Antworten)` : "",
    b.top.quelle ? `Beste Quelle <b>${esc(b.top.quelle.label)}</b> (${b.top.quelle.angenommen} Annahmen)` : "",
    `Offen: <b>${b.offen.entwuerfe}</b> Entwürfe · <b>${b.offen.hotLeads}</b> Hot Leads`,
  ].filter(Boolean).map((x) => `<span>${x}</span>`).join("");
  $("bericht-inhalt").innerHTML = `<div class="bericht-kacheln">${kacheln}</div>${tage}<div class="bericht-fuss">${fuss}</div>`;
}
document.querySelectorAll("[data-bericht]").forEach((button) => button.addEventListener("click", () => {
  document.querySelectorAll("[data-bericht]").forEach((el) => el.classList.toggle("active", el === button));
  berichtArt = button.dataset.bericht; ladeBericht();
}));
$("bericht-datum")?.addEventListener("change", () => { berichtDatum = $("bericht-datum").value || null; ladeBericht(); });
$("bericht-zurueck")?.addEventListener("click", () => { berichtDatum = isoPlus(berichtDatum || heuteIso(), berichtArt === "woche" ? -7 : -1); ladeBericht(); });
$("bericht-vor")?.addEventListener("click", () => { berichtDatum = isoPlus(berichtDatum || heuteIso(), berichtArt === "woche" ? 7 : 1); ladeBericht(); });
$("bericht-heute")?.addEventListener("click", () => { berichtDatum = null; ladeBericht(); });

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


/**
 * SCHNELLPRÜFUNG (2026-09-23): alle offenen Nachrichten-Entwürfe als kompakte Liste mit Häkchen.
 * Jeder markierte Entwurf läuft serverseitig einzeln durch approveDraft – eine Sperre bei einem
 * blockiert die anderen nicht. Vorausgewählt ist nur, was die Ausgangsprüfung besteht.
 */
const QUICK_LABEL = { first: "Erstnachricht", followup: "Nachfassung", reaktivierung: "Netzwerk", message: "Antwort" };
let quickOffen = false;
function quickList() { return (state.drafts || []).filter((d) => d.phase !== "approach" && d.kind !== "pitchidee" && d.kind !== "event" && d.kind !== "comment"); }
function renderQuick() {
  const box = $("quick-review");
  if (!box) return;
  box.classList.toggle("hidden", !quickOffen);
  if (!quickOffen) return;
  const liste = quickList();
  const vorher = new Set([...box.querySelectorAll("[data-quick]:checked")].map((c) => Number(c.dataset.quick)));
  const ersteAnzeige = !box.dataset.bereit;
  box.innerHTML = `<div class="section-head"><div><span class="eyebrow">Schnellprüfung</span><h3>${liste.length} Entwürfe auf einen Blick</h3></div><div class="head-side"><button data-quick-all>Alle geprüften markieren</button><button data-quick-none>Keine</button><button class="primary" data-quick-approve>Markierte genehmigen</button><button class="icon-btn" data-quick-close aria-label="Schließen">×</button></div></div>
    <p class="muted">Grün = besteht die Prüfung (eine Frage, keine Floskel, richtiger Name …). Gesendet wird wie immer gedrosselt über den Sicherheits-Regler.</p>
    <div class="quick-list">${liste.map((d) => {
      const p = d.pruefung;
      const badge = !p ? `<span class="quick-badge neutral">Antwort, bitte lesen</span>` : p.ok ? `<span class="quick-badge ok">geprüft</span>` : `<span class="quick-badge bad" title="${esc(p.gruende.join(", "))}">${esc(p.gruende[0])}</span>`;
      const an = ersteAnzeige ? !!p?.ok : vorher.has(d.id);
      return `<label class="quick-row"><input type="checkbox" data-quick="${d.id}" ${an ? "checked" : ""}/><div><div class="quick-meta"><b>${esc(d.participant || d.profile?.fullName || "Kontakt")}</b><span>${QUICK_LABEL[d.kind] || esc(d.kind)}${d.sequence_stage ? ` ${d.sequence_stage}` : ""}</span>${badge}</div>${d.incoming && !String(d.incoming).startsWith("campaign:") ? `<div class="quick-in">${esc(d.incoming)}</div>` : ""}<p>${esc(d.draft)}</p></div></label>`;
    }).join("") || `<p class="muted">Nichts offen.</p>`}</div>`;
  box.dataset.bereit = "1";
  box.querySelector("[data-quick-close]").onclick = () => { quickOffen = false; delete box.dataset.bereit; renderQuick(); };
  box.querySelector("[data-quick-all]").onclick = () => box.querySelectorAll("[data-quick]").forEach((c) => { const d = liste.find((x) => x.id === Number(c.dataset.quick)); c.checked = !!d?.pruefung?.ok; });
  box.querySelector("[data-quick-none]").onclick = () => box.querySelectorAll("[data-quick]").forEach((c) => { c.checked = false; });
  box.querySelector("[data-quick-approve]").onclick = async (ev) => {
    const ids = [...box.querySelectorAll("[data-quick]:checked")].map((c) => Number(c.dataset.quick));
    if (!ids.length) return toast("Nichts markiert.");
    ev.target.disabled = true;
    try {
      const r = await post("/api/drafts/bulk", { ids });
      toast(`${r.freigegeben.length} genehmigt${r.blockiert.length ? `, ${r.blockiert.length} gesperrt (${r.blockiert[0].grund})` : ""}.`);
      await load();
    } catch (error) { toast(`Genehmigen fehlgeschlagen: ${error.message}`); }
    finally { ev.target.disabled = false; }
  };
}
$("quick-open").onclick = () => { quickOffen = true; renderQuick(); $("quick-review").scrollIntoView({ behavior: "smooth", block: "start" }); };

/**
 * TASTENKÜRZEL im Einzel-Prüfer: A = genehmigen, R = ablehnen, J/K = nächster/vorheriger.
 * Nicht, während in einem Textfeld getippt wird – sonst genehmigt ein „a“ im Text den Entwurf.
 */
document.addEventListener("keydown", (ev) => {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const tag = (ev.target?.tagName || "").toLowerCase();
  if (tag === "textarea" || tag === "input" || tag === "select" || ev.target?.isContentEditable) return;
  const host = reviewerHost();
  if (!host || host.classList.contains("hidden")) return;
  const key = ev.key.toLowerCase();
  if (key === "a") host.querySelector('[data-review-action="approve"]')?.click();
  else if (key === "r") host.querySelector('[data-review-action="reject"]')?.click();
  else if (key === "j" || key === "k") {
    const n = reviewList().length; if (!n) return;
    reviewIndex = (reviewIndex + (key === "j" ? 1 : n - 1)) % n; renderReviewer();
  } else return;
  ev.preventDefault();
});

/** AUTOMATISCHE FREIGABE – Karte in den Einstellungen. */
function renderAutoFreigabe() {
  const a = state.autoFreigabe; const box = $("auto-card-body");
  if (!a || !box || box.contains(document.activeElement)) return; // nicht beim Tippen überschreiben
  const e = a.einstellung, s = a.schwelle;
  const zeile = (art, titel) => {
    const v = a.vertrauen[art];
    const stand = v.erreicht
      ? `<span class="quick-badge ok">Vertrauen erreicht: ${v.unveraendert} von ${v.entscheidungen} unverändert genehmigt</span>`
      : `<span class="quick-badge neutral">${v.entscheidungen < s.minEntscheidungen ? `noch ${s.minEntscheidungen - v.entscheidungen} eigene Entscheidungen nötig` : `erst ${Math.round(v.quote * 100)} % unverändert genehmigt (nötig ${Math.round(s.minQuote * 100)} %)`}</span>`;
    return `<label class="auto-row"><input type="checkbox" data-auto="${art}" ${e[art] ? "checked" : ""}/><b>${titel}</b>${stand}</label>`;
  };
  box.innerHTML = `${zeile("followup", "Nachfassungen")}${zeile("first", "Erstnachrichten")}
    <div class="auto-num"><label>höchstens <input type="number" min="1" max="30" data-auto-cap value="${e.tagesCap}"/> pro Tag</label><label>frühestens <input type="number" min="15" max="1440" data-auto-karenz value="${e.karenzMin}"/> Minuten nach dem Entwurf</label><span class="muted">Heute automatisch: ${a.heute}</span></div>`;
}
$("auto-save").onclick = async () => {
  const q = (s) => document.querySelector(s);
  try {
    const r = await post("/api/auto-freigabe", { followup: q('[data-auto="followup"]').checked, first: q('[data-auto="first"]').checked, tagesCap: Number(q("[data-auto-cap]").value), karenzMin: Number(q("[data-auto-karenz]").value) });
    state.autoFreigabe = { ...r }; document.activeElement?.blur(); renderAutoFreigabe(); toast("Automatische Freigabe gespeichert.");
  } catch (error) { toast(error.message); }
};

/**
 * KI-ASSISTENT unten rechts (2026-09-23). Der Verlauf lebt nur in diesem Browser-Tab
 * (sessionStorage, in try/catch – privater Modus darf nichts kaputt machen). Jede Frage geht
 * mit den letzten Wortwechseln an /api/assistent; der Server hängt die aktuelle Lage an.
 */
let kiVerlauf = [];
try { kiVerlauf = JSON.parse(sessionStorage.getItem("ki-verlauf") || "[]"); } catch { kiVerlauf = []; }
const kiSpeichern = () => { try { sessionStorage.setItem("ki-verlauf", JSON.stringify(kiVerlauf.slice(-20))); } catch { /* egal */ } };
/** Kleines, sicheres Markdown: erst escapen, dann nur **fett**, Listen und Überschriften-Zeilen. */
function kiMarkdown(text) {
  const zeilen = esc(text).split("\n");
  let html = "", liste = false;
  for (const roh of zeilen) {
    const z = roh.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
    const punkt = z.match(/^\s*(?:[-*•]|\d+\.)\s+(.*)$/);
    if (punkt) { if (!liste) { html += "<ul>"; liste = true; } html += `<li>${punkt[1]}</li>`; continue; }
    if (liste) { html += "</ul>"; liste = false; }
    const kopf = z.match(/^#{1,4}\s+(.*)$/);
    html += kopf ? `<p><b>${kopf[1]}</b></p>` : z.trim() ? `<p>${z}</p>` : "";
  }
  return html + (liste ? "</ul>" : "");
}
function kiZeichnen(wartet = false) {
  $("ki-log").innerHTML = (kiVerlauf.length ? "" : `<p class="ki-hello">Hi! Ich kenne NextLead und sehe die aktuelle Lage deines Bots. Frag mich zum Beispiel, warum gerade nichts rausgeht oder wie du mehr Antworten bekommst.</p>`)
    + kiVerlauf.map((t) => `<div class="ki-msg ${t.rolle}">${t.rolle === "assistent" ? kiMarkdown(t.text) : esc(t.text).replace(/\n/g, "<br>")}</div>`).join("")
    + (wartet ? `<div class="ki-msg assistent ki-typing">denkt nach …</div>` : "");
  $("ki-chips").classList.toggle("hidden", kiVerlauf.length > 0);
  $("ki-log").scrollTop = $("ki-log").scrollHeight;
}
async function kiFragen(frage) {
  frage = String(frage || "").trim(); if (!frage) return;
  const verlauf = kiVerlauf.slice(-8);
  kiVerlauf.push({ rolle: "du", text: frage }); kiZeichnen(true); $("ki-input").value = "";
  try { const r = await post("/api/assistent", { frage, verlauf }, 90000); kiVerlauf.push({ rolle: "assistent", text: r.antwort }); }
  catch (error) { kiVerlauf.push({ rolle: "assistent", text: `Das hat nicht geklappt: ${error.message}` }); }
  kiSpeichern(); kiZeichnen();
}
$("ki-fab").onclick = () => { $("ki-panel").classList.remove("hidden"); $("ki-fab").classList.add("hidden"); kiZeichnen(); $("ki-input").focus(); };
$("ki-close").onclick = () => { $("ki-panel").classList.add("hidden"); $("ki-fab").classList.remove("hidden"); };
$("ki-reset").onclick = () => { kiVerlauf = []; kiSpeichern(); kiZeichnen(); };
$("ki-form").onsubmit = (ev) => { ev.preventDefault(); kiFragen($("ki-input").value); };
$("ki-input").addEventListener("keydown", (ev) => { if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); kiFragen($("ki-input").value); } });
$("ki-chips").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => kiFragen(b.textContent)));

/**
 * DEIN ANGEBOT (2026-09-23): eigener Ladepfad wie `ladeWirkung`, nicht über /api/state – das
 * Formular darf beim Auto-Refresh nicht überschrieben werden, während man tippt. Deshalb wird
 * es nur beim ersten Anzeigen der Einstellungen und nach dem Speichern gefüllt.
 */
let angebot = null;
const OFFER_FELDER = [["titel", "Titel", "z. B. kostenlose Potenzialanalyse"], ["nutzen", "Was die Person davon hat", ""], ["ablauf", "Ablauf / Dauer", ""], ["cta", "Die leichte Frage", "Soll ich dir mal zeigen, wie das abläuft?"], ["naechsterSchritt", "Was nach einem Ja passiert", ""], ["link", "Link (nur für Unterlagen)", "https://…"]];
function offerZeile(m, i) {
  return `<article class="offer-item ${m.aktiv === false ? "off" : ""}" data-offer="${i}">
    <header><label class="offer-toggle"><input type="checkbox" data-f="aktiv" ${m.aktiv === false ? "" : "checked"}/> aktiv</label>
      <select data-f="route"><option value="karriere" ${m.route !== "finanzen" ? "selected" : ""}>bei Karriere-/Orientierungsfragen</option><option value="finanzen" ${m.route === "finanzen" ? "selected" : ""}>bei Geldfragen</option></select>
      <select data-f="art"><option value="gespraech" ${m.art !== "unterlage" ? "selected" : ""}>Gespräch</option><option value="unterlage" ${m.art === "unterlage" ? "selected" : ""}>Unterlage mit Link</option></select>
      <button data-offer-sharpen="${i}" title="Nutzen und Frage nach Hormozis Wertformel schärfen (ein Claude-Aufruf)">✨ Mit KI schärfen</button>
      <button class="danger-ghost" data-offer-remove="${i}">Entfernen</button></header>
    ${m.warum ? `<p class="offer-why">✨ ${esc(m.warum)}</p>` : ""}
    <div class="offer-fields">${OFFER_FELDER.map(([f, label, ph]) => `<label><span>${label}</span><input data-f="${f}" value="${esc(m[f] || "")}" placeholder="${esc(ph)}"/></label>`).join("")}</div>
    <input type="hidden" data-f="key" value="${esc(m.key || "")}"/>
  </article>`;
}
function leseOfferFormular() {
  return [...document.querySelectorAll("[data-offer]")].map((el) => {
    const m = {};
    el.querySelectorAll("[data-f]").forEach((f) => { m[f.dataset.f] = f.type === "checkbox" ? f.checked : f.value; });
    return m;
  });
}
function renderAngebot() {
  if (!angebot) return;
  $("offer-list").innerHTML = angebot.leadMagnete.map(offerZeile).join("") || `<p class="muted">Noch kein strukturiertes Angebot. Übernimm unten einen Vorschlag und pass ihn an.</p>`;
  $("offer-suggestions").innerHTML = angebot.vorschlaege.length
    ? `<span class="lane-label">Vorschläge übernehmen</span>${angebot.vorschlaege.map((v, i) => `<button data-offer-add="${i}">+ ${esc(v.titel)}</button>`).join("")}` : "";
  $("offer-beweise").value = (angebot.beweise || []).join("\n");
  $("offer-link").value = angebot.buchungslink || "";
  document.querySelectorAll("[data-offer-remove]").forEach((b) => b.onclick = () => {
    angebot.leadMagnete = leseOfferFormular(); angebot.leadMagnete.splice(Number(b.dataset.offerRemove), 1); renderAngebot();
  });
  $("offer-ki-list").innerHTML = (angebot.kiVorschlaege || []).length
    ? `<span class="lane-label">KI-Vorschläge (noch nicht gespeichert)</span>${angebot.kiVorschlaege.map((v, i) => `<article class="offer-ki-item"><div><b>${esc(v.titel)}</b> <span class="muted">${v.route === "finanzen" ? "bei Geldfragen" : "bei Karrierefragen"}</span><p>${esc(v.nutzen)}</p><p class="muted">Frage: „${esc(v.cta)}“${v.warum ? ` · ${esc(v.warum)}` : ""}</p></div><button data-offer-ki-add="${i}">Übernehmen</button></article>`).join("")}` : "";
  document.querySelectorAll("[data-offer-ki-add]").forEach((b) => b.onclick = () => {
    angebot.leadMagnete = leseOfferFormular();
    const [v] = angebot.kiVorschlaege.splice(Number(b.dataset.offerKiAdd), 1);
    angebot.leadMagnete.push({ ...v, aktiv: true }); renderAngebot(); $("offer-note").textContent = "Übernommen – zum Aktivieren noch „Angebot speichern“.";
  });
  document.querySelectorAll("[data-offer-sharpen]").forEach((b) => b.onclick = async () => {
    const i = Number(b.dataset.offerSharpen);
    angebot.leadMagnete = leseOfferFormular();
    b.disabled = true; b.textContent = "KI denkt nach…";
    try {
      const r = await post("/api/angebot/ki", { aktion: "schaerfen", magnet: angebot.leadMagnete[i] }, 90000);
      angebot.leadMagnete[i] = r.magnet; renderAngebot(); $("offer-note").textContent = "Geschärft – prüfen und dann „Angebot speichern“.";
    } catch (error) { toast(`KI-Schärfen fehlgeschlagen: ${error.message}`); b.disabled = false; b.textContent = "✨ Mit KI schärfen"; }
  });
  document.querySelectorAll("[data-offer-add]").forEach((b) => b.onclick = () => {
    angebot.leadMagnete = leseOfferFormular();
    const [v] = angebot.vorschlaege.splice(Number(b.dataset.offerAdd), 1);
    angebot.leadMagnete.push({ ...v, aktiv: true }); renderAngebot();
  });
}
async function ladeAngebot() {
  try { const r = await fetch("/api/angebot", { cache: "no-store" }); angebot = await r.json(); renderAngebot(); }
  catch (error) { $("offer-note").textContent = `Angebot nicht geladen: ${error.message}`; }
}
$("offer-ki").onclick = async () => {
  const b = $("offer-ki"); b.disabled = true; b.textContent = "KI denkt nach…";
  try {
    angebot.leadMagnete = leseOfferFormular();
    const r = await post("/api/angebot/ki", { aktion: "vorschlaege" }, 90000);
    angebot.kiVorschlaege = r.vorschlaege; renderAngebot();
  } catch (error) { toast(`KI-Vorschläge fehlgeschlagen: ${error.message}`); }
  finally { b.disabled = false; b.textContent = "✨ KI-Vorschläge holen"; }
};
$("offer-save").onclick = async () => {
  const button = $("offer-save"); button.disabled = true; $("offer-note").textContent = "";
  try {
    const r = await post("/api/angebot", { leadMagnete: leseOfferFormular(), beweise: $("offer-beweise").value, buchungslink: $("offer-link").value.trim() });
    angebot = { ...angebot, leadMagnete: r.leadMagnete, beweise: r.beweise, buchungslink: r.buchungslink };
    renderAngebot(); toast("Angebot gespeichert. Der Bot nutzt es ab der nächsten Nachricht.");
  } catch (error) { $("offer-note").textContent = error.message; }
  finally { button.disabled = false; }
};


/** NACHFASS-PLAN (2026-09-23): eigener Ladepfad, damit der Auto-Refresh das Formular nicht überschreibt. */
let fuPlan = null;
const FU_ZWECK = { wert: "Wert geben + Angebot", beweis: "Echte Geschichte + Angebot", anknuepfen: "Locker anknüpfen", abschied: "Ehrlicher Schlussstrich" };
const FU_PRESETS = { 2: [{ nachTagen: 4, zweck: "wert" }, { nachTagen: 7, zweck: "abschied" }], 3: [{ nachTagen: 3, zweck: "wert" }, { nachTagen: 5, zweck: "beweis" }, { nachTagen: 7, zweck: "abschied" }] };
function renderFuPlan() {
  if (!fuPlan) return;
  $("fu-steps").innerHTML = fuPlan.map((s, i) => {
    const letzte = i === fuPlan.length - 1;
    return `<div class="fu-step"><b>${i + 1}. Nachfassung</b><label>nach <input type="number" min="2" max="30" data-fu-days="${i}" value="${s.nachTagen}"/> Tagen</label>${letzte
      ? `<span class="fu-fixed">${FU_ZWECK.abschied}</span>`
      : `<select data-fu-zweck="${i}">${["wert", "beweis", "anknuepfen"].map((z) => `<option value="${z}" ${s.zweck === z ? "selected" : ""}>${FU_ZWECK[z]}</option>`).join("")}</select>`}</div>`;
  }).join("");
}
const leseFuPlan = () => fuPlan.map((s, i) => ({ nachTagen: Number(document.querySelector(`[data-fu-days="${i}"]`)?.value || s.nachTagen), zweck: document.querySelector(`[data-fu-zweck="${i}"]`)?.value || "abschied" }));
async function ladeFuPlan() { try { fuPlan = (await (await fetch("/api/followup-plan", { cache: "no-store" })).json()).plan; renderFuPlan(); } catch (error) { $("fu-note").textContent = `Plan nicht geladen: ${error.message}`; } }
document.querySelectorAll("[data-fu-preset]").forEach((b) => b.addEventListener("click", () => { fuPlan = FU_PRESETS[b.dataset.fuPreset].map((s) => ({ ...s })); renderFuPlan(); $("fu-note").textContent = "Noch nicht gespeichert."; }));
$("fu-save").onclick = async () => {
  $("fu-note").textContent = "";
  try { fuPlan = (await post("/api/followup-plan", { plan: leseFuPlan() })).plan; renderFuPlan(); toast("Nachfass-Plan gespeichert."); }
  catch (error) { $("fu-note").textContent = error.message; }
};

function renderSettings() {
  if (!angebot) ladeAngebot();
  if (!fuPlan) ladeFuPlan();
  renderAutoFreigabe();
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
  // Kampagnen stillgelegt: Navigationspunkt weg und, falls der Bereich gerade offen war,
  // zurück auf "Heute". renderCampaigns() läuft dann gar nicht erst.
  const kampagnen = !kampagnenAus();
  document.querySelectorAll('[data-view="campaigns"]').forEach((el) => el.classList.toggle("hidden", !kampagnen));
  if (!kampagnen && activeView === "campaigns") showView("today");
  renderStatus(); renderToday(); if (kampagnen) renderCampaigns(); renderContacts(); renderInsights(); renderSettings();
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

/**
 * AUSWERTUNG IN REITERN (Designrunde 2, 2026-09-23): statt acht Blöcken untereinander vier Reiter.
 * Der zuletzt gewählte Reiter bleibt in diesem Browser gemerkt (localStorage, in try/catch).
 */
function zeigeInsightTab(tab) {
  const erlaubt = ["ueberblick", "wirkt", "rechner", "berichte"];
  if (!erlaubt.includes(tab)) tab = "ueberblick";
  document.querySelectorAll("#view-insights [data-tab]").forEach((el) => el.classList.toggle("tab-aus", el.dataset.tab !== tab));
  document.querySelectorAll("[data-insight-tab]").forEach((b) => { b.classList.toggle("active", b.dataset.insightTab === tab); b.setAttribute("aria-selected", String(b.dataset.insightTab === tab)); });
  try { localStorage.setItem("insight-tab", tab); } catch { /* egal */ }
}
document.querySelectorAll("[data-insight-tab]").forEach((b) => b.addEventListener("click", () => zeigeInsightTab(b.dataset.insightTab)));
let gemerkterTab = "ueberblick";
try { gemerkterTab = localStorage.getItem("insight-tab") || "ueberblick"; } catch { /* egal */ }
zeigeInsightTab(gemerkterTab);
