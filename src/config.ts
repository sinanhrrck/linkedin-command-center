import dotenv from "dotenv";
import { mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * SERVER-MODUS (2026-09-21): `NEXTLEAD_SERVER=1` = Betrieb ohne App-Hülle auf einem Heimserver
 * (Docker, kein Bildschirm). Alles, was hier abweicht, ist bewusst an dieses Flag gebunden, damit
 * die Mac-App und der Entwickler-Modus byte-identisch weiterlaufen.
 */
const SERVER_MODUS = process.env.NEXTLEAD_SERVER === "1";

/**
 * EIN DATENORDNER. Im Server-Modus liegen ALLE Laufzeitdaten unter `DATA_DIR` (Standard ./data):
 * Datenbank + Backups, Browser-Sitzung, .env, profil.local.json, Uploads, Live-Bild, engine.log.
 * Ohne DATA_DIR bleibt jeder Pfad exakt wie bisher (relativ zum Arbeitsverzeichnis) – die Mac-App
 * setzt DB_PATH/SESSION_DIR selbst und arbeitet in ihrem userData-Ordner. Die spezifischen
 * Variablen (DB_PATH, SESSION_DIR, …) gewinnen immer gegen DATA_DIR.
 */
const DATA_DIR = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : SERVER_MODUS ? resolve("./data") : null;
// Ordner sofort anlegen: db/index.ts öffnet die Datenbank beim Import, ein fehlender Ordner
// würde sonst mit „unable to open database file“ abbrechen, bevor irgendeine Prüfung läuft.
if (DATA_DIR) mkdirSync(DATA_DIR, { recursive: true });
const imDatenordner = (name: string, sonst: string) => (DATA_DIR ? join(DATA_DIR, name) : sonst);

// .env laden – aus dem Datenordner, wenn es einen gibt, sonst wie bisher aus dem Arbeitsverzeichnis.
// Muss VOR dem Lesen aller anderen process.env-Werte passieren.
const ENV_PATH = process.env.ENV_PATH ?? imDatenordner(".env", ".env");
dotenv.config({ path: ENV_PATH });

/**
 * Zentrale Konfiguration. Die Safety-Limits sind bewusst konservativ.
 * Runter ist sicher, hoch ist dein Risiko.
 */
export const config = {
  paths: {
    dataDir: DATA_DIR,
    envPath: ENV_PATH,
    sessionDir: process.env.SESSION_DIR ?? imDatenordner(".session", "./.session"),
    dbPath: process.env.DB_PATH ?? imDatenordner("data.db", "./data.db"),
    // Kampagnen-Material (Flyer, Agenda, Bilder). Bleibt lokal wie die Session, nie im Repo.
    uploadDir: process.env.UPLOAD_DIR ?? imDatenordner(".uploads", "./.uploads"),
    // Persönliches Nutzerprofil für alle KI-Texte (gitignored).
    profilPath: process.env.PROFIL_PATH ?? imDatenordner("profil.local.json", "profil.local.json"),
    // Live-Ansicht (Screenshot des versteckten Browsers) und Engine-Protokoll.
    liveDir: process.env.LIVE_DIR ?? imDatenordner(".live", ".live"),
    engineLog: process.env.ENGINE_LOG ?? imDatenordner("engine.log", "engine.log"),
    // Änderungszeit der DB-Datei BEVOR irgendein Modul sie öffnet (config.ts lädt als erstes).
    // Nötig für die Umzugs-Warnung in core/serverMode.ts: nach dem Öffnen trägt die Datei die
    // Startzeit des Servers selbst – so entstand am 2026-09-22 ein Fehlalarm beim Erststart.
    dbMtimeBeimStart: (() => {
      try { return statSync(process.env.DB_PATH ?? imDatenordner("data.db", "./data.db")).mtimeMs; } catch { return 0; }
    })(),
  },

  /**
   * DASHBOARD-SERVER. Standard bleibt 127.0.0.1:4321 (nur dieser Rechner). Im Server-Modus
   * 0.0.0.0 (ganzes Heimnetz) – dann ist ein DASHBOARD_TOKEN PFLICHT (Basic-Auth), sonst
   * verweigert der Server den Start. Ist ein Token gesetzt, wird es in jedem Modus verlangt.
   */
  server: {
    serverModus: SERVER_MODUS,
    host: process.env.HOST ?? (SERVER_MODUS ? "0.0.0.0" : "127.0.0.1"),
    port: Number(process.env.PORT ?? process.env.CRM_PORT ?? 4321),
    token: process.env.DASHBOARD_TOKEN ?? "",
  },

  gemini: {
    apiKey: process.env.GEMINI_API_KEY ?? "",
    // Free Tier dieses Keys: NUR "gemini-flash-latest" hat ein Gratis-Kontingent (~20/Tag).
    // Alle gepinnten 2.x-Modelle liefern "limit: 0" (kein Free Tier). Deshalb hier bleiben
    // und KI-Aufrufe sparsam einsetzen (siehe connectNotes).
    model: "gemini-flash-latest",
    // KI-Notizen an Vernetzungsanfragen? Default AUS: LinkedIn lässt Notizen meist nicht zu
    // (Premium/limitiert) UND sie würden das knappe 20/Tag-Kontingent aufbrauchen.
    // Das Budget bleibt für Erstnachrichten (bei Annahme) und DM-Antworten reserviert.
    connectNotes: false,
  },

  /**
   * BEZAHLTER KI-Anbieter (Anthropic/Claude). Bewusst getrennt vom Gemini-Free-Tier:
   * Gemini treibt alle Tests + Entwürfe (gratis), Claude treibt NUR den Voll-Autopilot
   * (converseStep) – die einzige hochvolumige, autonome Textquelle. So bleibt das knappe
   * Guthaben geschont: solange du im Manuell/Halb-Modus arbeitest, wird Claude nie aufgerufen.
   */
  llm: {
    anthropicKey: process.env.ANTHROPIC_API_KEY ?? "",
    // Modell für den Sales-Agent. Default HAIKU: ~5x günstiger als Opus, für kurze DM-Chats
    // völlig ausreichend – nach dem Kosten-Vorfall die vernünftige Standardwahl. Wer mehr
    // Qualität will, überschreibt per .env: LLM_MODEL=claude-sonnet-4-6 (Mittelweg) oder
    // LLM_MODEL=claude-opus-4-8 (stärkstes, teuerstes). Preise (In/Out pro Mio Token):
    // Haiku 4.5 $1/$5 · Sonnet 4.6 $3/$15 · Opus 4.8 $5/$25.
    model: process.env.LLM_MODEL ?? "claude-haiku-4-5",
    // Welcher Anbieter treibt den Autopilot? "claude" = bezahlt (Produktion, Standard),
    // "gemini" = gratis erzwingen (spart Geld, aber 20/Tag-Limit reicht nur für Testläufe).
    autopilotProvider: (process.env.LLM_AUTOPILOT_PROVIDER ?? "claude") as "claude" | "gemini",
    // Notnagel: faellt Gemini aus (503/Tageslimit), uebernimmt Claude – ABER nur mit
    // vorheriger Telegram-Meldung (core/textLlm.ts). Auf false = Bot steht lieber still,
    // als Geld auszugeben. Grund: Gemini war am 2026-07-16 stundenlang mit 503 down.
    fallbackToClaude: process.env.LLM_FALLBACK !== "false",
  },

  /**
   * BROWSER-SICHTBARKEIT. Der Bot steuert Chrome über das Debug-Protokoll (CDP), NICHT über
   * deine echte Maus/Tastatur. Er braucht also kein sichtbares Fenster und blockiert dich nicht
   * (anders als eine Chrome-Extension wie LinkedIn Helper, die in DEINEM Fenster sitzt).
   *
   * Bewusst NICHT headless: der headless-User-Agent enthält "HeadlessChrome" → LinkedIn erkennt
   * das sofort. Stattdessen echtes Fenster (sauberer UA "Chrome/149.0.0.0"), auf macOS via
   * System Events versteckt. Fingerprint bleibt echt, Fenster ist weg.
   */
  browser: {
    /**
     * "embedded" (Standard) = headless, KEIN Fenster existiert → nichts kann aufpoppen.
     *   Die Seite ist nur im Dashboard als Live-Ansicht sichtbar. Fingerprint wird gehärtet
     *   (siehe core/session.ts STEALTH), weil headless sonst am UA erkennbar wäre.
     * "visible"  = echtes Fenster (nötig für `npm run login`, oder zum Zuschauen).
     */
    mode: (process.env.BROWSER_MODE ?? "embedded") as "embedded" | "visible",
    // Echter Chrome-UA. headless würde sonst "HeadlessChrome/149..." senden → LinkedIn erkennt das.
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    locale: "de-DE",
    timezone: "Europe/Berlin",
  },

  linkedin: {
    accessToken: process.env.LINKEDIN_ACCESS_TOKEN ?? "",
    refreshToken: process.env.LINKEDIN_REFRESH_TOKEN ?? "",
    clientId: process.env.LINKEDIN_CLIENT_ID ?? "",
    clientSecret: process.env.LINKEDIN_CLIENT_SECRET ?? "",
    personUrn: process.env.LINKEDIN_PERSON_URN ?? "",
    apiVersion: "202506", // LinkedIn-Version-Header, YYYYMM
  },

  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
    chatId: process.env.TELEGRAM_CHAT_ID ?? "",
  },

  learning: {
    // Standard bleibt strikt lokal. Ein gemeinsamer Lernserver muss bewusst konfiguriert UND
    // aktiviert werden; selbst dann gehen nur Aggregate ohne Texte, Namen, URLs oder Zeitpunkte.
    syncEnabled: process.env.LEARNING_SYNC_ENABLED === "true",
    syncUrl: process.env.LEARNING_SYNC_URL ?? "",
  },

  /**
   * Optionaler, installationsübergreifender Meldeweg. Ohne ausdrücklich eingerichteten
   * NextLead-Relay bleiben Meldungen ausschließlich lokal in der Warteschlange. Die Domain
   * einer Empfängeradresse darf niemals stillschweigend als technischer Endpunkt dienen.
   */
  reporting: {
    endpoint: process.env.NEXTLEAD_REPORT_ENDPOINT ?? "https://nextlead-report-relay.siharrack.chatgpt.site/api/nextlead-report",
  },

  /**
   * SAFETY. Das Herzstück. Alle sendenden Aktionen respektieren diese Werte.
   */
  safety: {
    // Harte Tages-Obergrenzen pro Aktionstyp
    dailyCaps: {
      connect: 20, // Vernetzungsanfragen (Wochenlimit bremst zusätzlich)
      message: 30, // KALTE Erstnachrichten (+ Follow-ups) an neue Kontakte – das ist der riskante Teil, den LinkedIn beobachtet
      /**
       * KAMPAGNEN-EINLADUNGEN (Sinans Vorgabe 2026-08-05): eigener Topf, damit ein laufendes
       * Event NICHT das Akquise-Kontingent auffrisst und umgekehrt. Empfänger sind bereits
       * bestätigte Verbindungen, keine Fremden – das Risikoprofil ist niedriger als bei `message`.
       * ACHTUNG: LinkedIn sieht trotzdem die SUMME aller Nachrichten. Dieser Topf erhöht das
       * Tagesvolumen real auf bis zu 50 unaufgeforderte Nachrichten. Wer hier hochdreht,
       * kauft sich Reichweite mit Sperr-Risiko.
       */
      campaign: 20,
      reply: 120, // ANTWORTEN in bestehenden Gesprächen (jemand hat DIR geschrieben) – quasi risikofrei, eigener Topf, damit heiße Leads nie durch kalte Outreach blockiert werden
      comment: 15,
      like: 40, // Likes sind harmlos, duerfen autonom + haeufiger; Governor-Delay bremst trotzdem
      /**
       * LESE-BUDGET (2026-08-05, nach der Kontosperre). LinkedIn hat NICHT das Senden moniert,
       * sondern: "Ihr Konto hat eine große Menge an LinkedIn Profildaten abgerufen". Genau das
       * war bis dahin ungedeckelt – ein einziger Postfach-Lauf öffnete bis zu 100 Chats.
       * Diese beiden Werte sind die Sicherung dagegen (siehe core/leseBudget.ts).
       * Bewusst knapp: Ein Mensch ruft an einem Arbeitstag keine 60 fremden Profile auf.
       * NICHT hochdrehen – das ist die Grenze, an der das Konto zuletzt gesperrt wurde.
       */
      profileView: 60, // fremde Profile pro Tag (/in/…)
      pageRead: 120, // sonstige LinkedIn-Seiten: Postfach, Threads, Suche, Feed
    },
    // Wochenlimit für Vernetzungen – LinkedIns praktische Sperr-Schwelle liegt bei ~100/Woche.
    // DARÜBER droht Konto-Restriktion. Das ist die echte Decke, nicht der Tages-Cap.
    weeklyConnectCap: 100,

    // Warm-up: startet höher (50%) und ist nach 7 Tagen auf 100%. Schneller als vorher,
    // aber immer noch eine Rampe (neue Automatisierung nicht sofort auf Vollgas).
    warmupDays: 7,
    warmupStartFactor: 0.5, // Tag 1 = 50% der Caps

    // Zufällige Pause zwischen zwei Aktionen (ms). Nie fixe Abstände.
    // Kompromiss aus Tempo und Ban-Sicherheit. Höher = sicherer, niedriger = schneller/riskanter.
    delayBetweenActionsMs: { min: 20_000, max: 75_000 },

    // Nur in diesen Zeitfenstern arbeiten (lokale Uhrzeit, 24h). Ab 7 Uhr (Sinans Vorgabe
    // 2026-09-22, vorher 9) bis 22 Uhr, damit Anfragen + Nachrichten morgens früh und abends
    // rausgehen. Die Cron-Zeiten in index.ts, die morgens starten, hängen an START_STUNDE.
    // Alle übrigen Schutz-Mechanismen (Caps, Pausen, Circuit-Breaker) bleiben unverändert scharf.
    workingHours: { start: 7, end: 22 },
    // Am SONNTAG NUR diese Aktionstypen (Sinans Vorgabe 2026-07-25: Nachrichten Mo–Sa, Sonntag
    // Ruhetag). Vernetzen/Liken/Profilbesuche laufen 7 Tage; Direktnachrichten & Kommentare gehen
    // Mo–Sa, am Sonntag nicht. (Der Name „weekendActions" bleibt aus Kompatibilität; gemeint ist
    // jetzt „Sonntags-Aktionen".) Die Wochentags-Logik sitzt in safetyGovernor.withinWorkingHours.
    weekendActions: ["connect", "like", "profileView"],
    workOnWeekends: true, // Wochenende NICHT komplett sperren – die Feinsteuerung macht weekendActions

    // Circuit-Breaker: fällt die Akzeptanzrate des rollierenden Fensters darunter,
    // wird der Outreach zunächst halbiert und bei sehr schwacher Quote auf Recovery gedrosselt.
    minAcceptanceRate: 0.30,
    /**
     * Ab HIER greift der sehr kleine Recovery-Modus. Zwischen diesem Wert und
     * `minAcceptanceRate` läuft das halbe Tageskontingent. Ein vollständiger Stopp könnte sich
     * ohne neue, bessere Kontakte nicht selbst auflösen; Recovery bleibt deshalb bewusst klein.
     */
    hardStopAcceptance: 0.20,
    /**
     * RECOVERY statt Sackgasse: Auch unterhalb der Gefahrenschwelle darf NextLead wenige,
     * weiterhin vom Lead-Score priorisierte Vernetzungen senden. So kann sich eine durch alte,
     * schlechte Quellen gedrückte Quote mit besseren Kontakten wieder erholen, ohne den
     * Kontoschutz komplett auszuschalten.
     */
    recoveryConnectCap: 3,
    // Erst ab dieser Zahl versendeter Invites greift die Akzeptanzraten-Prüfung.
    acceptanceRateMinSample: 20,
    // Rollierendes Bewertungsfenster. 7 Tage waren bei 20 Anfragen/Tag zu nervös: wenige
    // schlechte Suchtage kippten sofort den ganzen Bot, obwohl die Gesamtquote gesund war.
    // 14 Tage reagieren weiterhin auf echte Verschlechterungen, glätten aber Tagesausreißer.
    acceptanceWindowDays: 14,
    // Reifezeit: so viele Tage bekommt eine Einladung, BEVOR sie in die Akzeptanzrate zählt.
    // Ohne das würden die Anfragen von heute die Quote künstlich nach unten ziehen (niemand
    // nimmt in Minuten an) und der Circuit-Breaker pausiert grundlos. Menschen brauchen 1-3 Tage.
    acceptanceMaturityDays: 2,

    // Ausstehende Invites, ab denen gewarnt/pausiert wird (non-reziprokes Signal).
    maxPendingInvites: 500,
  },

  /**
   * AUTOPILOT (voll-autonome Gespräche). NUR einschalten mit bezahltem KI-Key
   * (Gemini-Free-Tier 20/Tag reicht NICHT) UND Immer-an-Maschine. Sendet KI-Antworten
   * ohne Freigabe – governor-gedrosselt. Erkennt Termin-Zusagen → Handoff via Telegram.
   * Eskaliert Einwände/Unsicheres an den Menschen statt selbst Mist zu bauen.
   */
  /**
   * KAMPAGNEN (Event-Einladungen + Auftrags-Zielgruppen) sind STILLGELEGT (2026-09-22, Sinans
   * Entscheidung). Der komplette Code, die Tabellen und `crm_stage_events.campaign_id` bleiben
   * unangetastet – die Zuordnung ist beim Schreiben eingefroren und darf nie rückwirkend
   * verschwinden. `enabled: false` schaltet nur ZWEI Dinge ab: den campaignTick im Loop und den
   * Kampagnen-Bereich im Cockpit. Angeschrieben wird ausschliesslich über die normale,
   * individuelle Strecke (first/followup/message/reaktivierung). Auf true zurückstellen
   * reaktiviert alles ohne weitere Änderung.
   */
  campaigns: {
    enabled: false,
  },

  autopilot: {
    enabled: false,
    maxMessagesPerThread: 6, // danach an den Menschen eskalieren (kein Endlos-Loop)
    intervalMinutes: 20,
  },

  /**
   * NEUER SALES-AGENT (src/agent) – die intelligente Pipeline (State Machine, Profil, Scores,
   * Risk/Validator/Humanizer) statt des einfachen converseStep. Default AUS: solange `enabled`
   * false ist, ändert sich am laufenden Bot NICHTS.
   * shadowMode: der Agent DENKT mit und legt seine Antwort nur als ENTWURF ab (sendet NICHT) –
   * so sieht man, was er tun WÜRDE, bevor er Verantwortung übernimmt. Erst nach Beobachtung auf
   * false stellen (dann sendet er governor-gedrosselt + validiert).
   */
  agent: {
    enabled: false,
    shadowMode: true,
    intervalMinutes: 8,
  },
} as const;

export type Config = typeof config;
