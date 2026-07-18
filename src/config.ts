import "dotenv/config";

/**
 * Zentrale Konfiguration. Die Safety-Limits sind bewusst konservativ.
 * Runter ist sicher, hoch ist dein Risiko.
 */
export const config = {
  paths: {
    sessionDir: process.env.SESSION_DIR ?? "./.session",
    dbPath: process.env.DB_PATH ?? "./data.db",
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
    // Für kurze Chat-Antworten reicht Opus locker; wer Budget strecken will, kann hier auf
    // "claude-haiku-4-5" wechseln (5x günstiger, für DM-Antworten völlig ausreichend).
    model: "claude-opus-4-8",
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

  /**
   * SAFETY. Das Herzstück. Alle sendenden Aktionen respektieren diese Werte.
   */
  safety: {
    // Harte Tages-Obergrenzen pro Aktionstyp
    dailyCaps: {
      connect: 20, // Vernetzungsanfragen (Wochenlimit bremst zusätzlich)
      message: 30, // Nachrichten an Erstkontakte
      comment: 15,
      like: 40, // Likes sind harmlos, duerfen autonom + haeufiger; Governor-Delay bremst trotzdem
      profileView: 120,
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

    // Nur in diesen Zeitfenstern arbeiten (lokale Uhrzeit, 24h).
    workingHours: { start: 9, end: 19 },
    workOnWeekends: false,

    // Circuit-Breaker: fällt die Akzeptanzrate der letzten 7 Tage darunter,
    // pausiert der Outreach automatisch.
    minAcceptanceRate: 0.30,
    // Erst ab dieser Zahl versendeter Invites greift die Akzeptanzraten-Prüfung.
    acceptanceRateMinSample: 20,
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
  autopilot: {
    enabled: false,
    maxMessagesPerThread: 6, // danach an den Menschen eskalieren (kein Endlos-Loop)
    intervalMinutes: 20,
  },
} as const;

export type Config = typeof config;
