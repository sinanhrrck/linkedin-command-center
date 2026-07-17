import { Bot, InlineKeyboard } from "grammy";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { events } from "../core/events.js";
import { governor } from "../core/safetyGovernor.js";
import { countByStatus, hotLeads } from "./crm.js";
import { pendingDrafts, sendDraft, setDraftStatus, type Draft } from "./drafts.js";

/**
 * Telegram-Steuerung: Entwürfe freigeben/senden, offene Nachrichten sehen, Tages-Status.
 * Läuft im Engine-Prozess (index.ts) und teilt sich die Browser-Session.
 * Voraussetzung in .env: TELEGRAM_BOT_TOKEN (+ TELEGRAM_CHAT_ID für Push & Zugriffsschutz).
 */
let bot: Bot | null = null;

function kindLabel(d: Draft): string {
  return d.kind === "first" ? "Erstnachricht (Vernetzung angenommen)" : "Antwort";
}

function draftKeyboard(id: number): InlineKeyboard {
  return new InlineKeyboard().text("✅ Passt, senden", `send:${id}`).text("🗑 Verwerfen", `discard:${id}`);
}

function draftText(d: Draft): string {
  if (d.kind === "first") {
    return (
      `✅ ${d.participant || "Jemand"} hat deine Vernetzungsanfrage angenommen!\n\n` +
      `Diese Nachricht geht an ${d.participant || "ihn/sie"} raus:\n\n${d.draft}\n\n👉 Senden?`
    );
  }
  if (d.kind === "followup") {
    return (
      `📩 Follow-up an ${d.participant || "—"} (noch keine Antwort auf deine Erstnachricht)\n\n` +
      `${d.draft}\n\n👉 Senden?`
    );
  }
  return (
    `✍️ Antwort an ${d.participant || "—"}` +
    (d.incoming ? `\nWorauf: „${d.incoming.slice(0, 160)}"` : "") +
    `\n\n${d.draft}\n\n👉 Senden?`
  );
}

/** Push: neuer Entwurf → sofort in den Chat mit Freigabe-Buttons. */
async function notifyDraft(d: Draft) {
  if (!bot || !config.telegram.chatId || !d) return;
  await bot.api
    .sendMessage(config.telegram.chatId, draftText(d), { reply_markup: draftKeyboard(d.id) })
    .catch(() => {});
}

function statusText(): string {
  const s = governor.snapshot();
  const crm = countByStatus();
  const rate = s.acceptance.armed ? `${Math.round(s.acceptance.rate * 100)}%` : `Standby (n=${s.acceptance.sample})`;
  return (
    `📊 Command Center\n\n` +
    `Anfragen heute: ${s.connect.today}/${s.connect.effectiveCap}  ·  Woche: ${s.connect.week}/${s.connect.weeklyCap}\n` +
    `Akzeptanzrate (7T): ${rate}\n` +
    `🔥 Hot Leads (geantwortet): ${hotLeads().length}\n` +
    `Offene Entwürfe: ${pendingDrafts().length}\n` +
    `CRM: ${Object.entries(crm).map(([k, v]) => `${k} ${v}`).join(" · ") || "leer"}\n` +
    `Bot: ${s.paused ? "⏸ pausiert" : s.withinWorkingHours ? "▶ aktiv" : "🌙 außerhalb Arbeitszeit"}`
  );
}

/** Lesbarer Text je Aktionstyp für die Push-Benachrichtigung. */
const AKTIONS_TEXT: Record<string, string> = {
  connect: "🤝 Vernetzungsanfrage raus",
  message: "✉️ Nachricht gesendet",
  comment: "💬 Kommentar gepostet",
  profileView: "👀 Profil angesehen",
};

/** Klarname zu einer Profil-URL bzw. Thread-URL aus dem CRM (Fallback: leer). */
function nameFuerZiel(target: string): string {
  const row = db
    .prepare("SELECT full_name FROM contacts WHERE profile_url = ? LIMIT 1")
    .get(target) as { full_name: string | null } | undefined;
  return row?.full_name ?? "";
}

export function startTelegram() {
  if (!config.telegram.botToken) {
    console.info("[telegram] kein TELEGRAM_BOT_TOKEN – Telegram-Steuerung aus.");
    return;
  }
  bot = new Bot(config.telegram.botToken);

  // Zugriffsschutz: nur der konfigurierte Chat darf steuern.
  const allowed = (chatId?: number) =>
    !config.telegram.chatId || String(chatId) === config.telegram.chatId;

  bot.command("start", (ctx) =>
    ctx.reply(
      `👋 LinkedIn Command Center verbunden.\nDeine Chat-ID: ${ctx.chat.id}\n\n` +
        `/status – Tages-Status & Zahlen\n/entwuerfe – offene Nachrichten freigeben\n/leads – Hot Leads (haben geantwortet)\n/pause – Outreach anhalten\n/resume – fortsetzen`,
    ),
  );

  bot.command("status", (ctx) => {
    if (!allowed(ctx.chat.id)) return;
    ctx.reply(statusText());
  });

  bot.command(["entwuerfe", "offen", "drafts"], async (ctx) => {
    if (!allowed(ctx.chat.id)) return;
    const ds = pendingDrafts();
    if (!ds.length) return ctx.reply("Keine offenen Entwürfe. 🎉");
    await ctx.reply(`${ds.length} offene(r) Entwurf/Entwürfe:`);
    for (const d of ds) {
      await ctx.reply(draftText(d), { reply_markup: draftKeyboard(d.id) });
    }
  });

  bot.command(["leads", "hotleads"], (ctx) => {
    if (!allowed(ctx.chat.id)) return;
    const leads = hotLeads();
    if (!leads.length) return ctx.reply("Noch keine Hot Leads (niemand hat geantwortet).");
    const list = leads
      .map((c) => `🔥 ${c.full_name}${c.headline ? ` – ${c.headline}` : ""}\n${c.profile_url}`)
      .join("\n\n");
    ctx.reply(`Hot Leads (haben geantwortet):\n\n${list}`);
  });

  bot.command("pause", (ctx) => {
    if (!allowed(ctx.chat.id)) return;
    governor.pause("manuell via Telegram");
    ctx.reply("⏸ Outreach pausiert.");
  });
  bot.command("resume", (ctx) => {
    if (!allowed(ctx.chat.id)) return;
    governor.resume();
    ctx.reply("▶ Outreach fortgesetzt.");
  });

  bot.callbackQuery(/^send:(\d+)$/, async (ctx) => {
    if (!allowed(ctx.chat?.id)) return ctx.answerCallbackQuery("Nicht erlaubt.");
    const id = Number(ctx.match[1]);
    await ctx.answerCallbackQuery("Wird gesendet…");
    const res = await sendDraft(id).catch((e) => ({ ok: false, reason: String(e) }));
    await ctx.editMessageText(
      res.ok ? "✅ Gesendet." : `⏭ Nicht gesendet: ${res.reason ?? "unbekannt"}`,
    ).catch(() => {});
  });

  bot.callbackQuery(/^discard:(\d+)$/, async (ctx) => {
    if (!allowed(ctx.chat?.id)) return ctx.answerCallbackQuery("Nicht erlaubt.");
    setDraftStatus(Number(ctx.match[1]), "discarded");
    await ctx.answerCallbackQuery("Verworfen.");
    await ctx.editMessageText("🗑 Verworfen.").catch(() => {});
  });

  // Neue Entwürfe automatisch pushen.
  events.on("draft:new", (d: Draft) => notifyDraft(d));

  /**
   * JEDE erfolgreiche Sendeaktion melden (aus governor.record – dem einzigen Choke-Point,
   * durch den alle Sends laufen). So bekommt Sinan mit, was der Bot tut, ohne ins Dashboard
   * zu schauen. Zum Kontakt wird der Klarname aus dem CRM nachgeschlagen, die nackte
   * Profil-URL sagt nichts.
   */
  events.on("action:done", (a: { type: string; target: string | null }) => {
    if (!bot || !config.telegram.chatId) return;
    const wer = a.target ? nameFuerZiel(a.target) : "";
    const heute = governor.snapshot();
    const zeile = AKTIONS_TEXT[a.type] ?? `▫️ ${a.type}`;
    bot.api
      .sendMessage(
        config.telegram.chatId,
        `${zeile}${wer ? ` an *${wer}*` : ""}\n` +
          `_heute: ${heute.connect.today}/${heute.connect.effectiveCap} Anfragen · Woche ${heute.connect.week}/${heute.connect.weeklyCap}_`,
        { parse_mode: "Markdown", link_preview_options: { is_disabled: true } },
      )
      .catch(() => {});
  });

  /**
   * KI-Umschaltung melden. Sinans ausdrücklicher Wunsch: er will WISSEN, wann sein bezahltes
   * Guthaben angefasst wird, bevor es passiert. Das Event wird in core/textLlm.ts synchron
   * gefeuert, BEVOR Claude angefragt wird. Höchstens 1 Meldung pro Stunde (kein Spam).
   */
  events.on("llm:fallback", (d: { grund: string; modell: string }) => {
    if (!bot || !config.telegram.chatId) return;
    bot.api
      .sendMessage(
        config.telegram.chatId,
        `💸 *Wechsle auf Claude (kostenpflichtig)*\n\n` +
          `Gemini ist ausgefallen: \`${d.grund}\`\n` +
          `Ab jetzt schreibt \`${d.modell}\` die Nachrichten. Das kostet echtes Geld ` +
          `(grob 1 bis 2 Cent pro Nachricht).\n\n` +
          `Sobald Gemini wieder läuft, wechsle ich automatisch zurück und melde mich.\n` +
          `Kein Geld ausgeben? Dann \`/pause\` senden oder \`LLM_FALLBACK=false\` in die .env.`,
        { parse_mode: "Markdown" },
      )
      .catch(() => {});
  });

  // Entwarnung: Gemini ist zurück, es fließt wieder kein Geld.
  events.on("llm:zurueck", (d: { minuten: number }) => {
    if (!bot || !config.telegram.chatId) return;
    bot.api
      .sendMessage(
        config.telegram.chatId,
        `✅ Gemini läuft wieder (war ${d.minuten} Min. weg). Zurück auf gratis, dein Guthaben wird nicht mehr angefasst.`,
      )
      .catch(() => {});
  });

  /**
   * ESKALATION mit Kontext. Sinans Wunsch: bei heiklen Fällen nicht nur "hier ist ein
   * Entwurf", sondern das ganze Bild – worum ging es, was schlägt die KI vor, wie gehen wir
   * damit um. Die Daten kommen aus EINEM converseStep-Aufruf (kostet nichts extra).
   * Ausgelöst bei "objection" (höfliche Absage/Einwand) und "meeting" (Termin-Signal).
   */
  events.on(
    "lead:eskalation",
    (e: {
      draft: Draft;
      participant: string;
      intent: string;
      zusammenfassung: string;
      strategie: string;
      threadUrl: string;
      contact: string | null;
    }) => {
      if (!bot || !config.telegram.chatId || !e.draft) return;
      const kopf =
        e.intent === "objection"
          ? `🟠 *${e.participant} winkt ab*`
          : `🎯 *${e.participant} will reden!*`;
      const text =
        `${kopf}\n\n` +
        `*Worum ging es*\n${e.zusammenfassung || "—"}\n\n` +
        `*Wie wir damit umgehen*\n${e.strategie || "—"}\n\n` +
        (e.contact ? `📞 *Kontakt:* ${e.contact}\n\n` : "") +
        `*Vorschlag der KI*\n_${e.draft.draft}_\n\n` +
        `💬 [Chat öffnen](${e.threadUrl})\n\n` +
        (e.intent === "objection"
          ? `Ein Nein verdient einen würdigen Abschluss. Senden, anpassen oder einfach ruhen lassen?`
          : `Du entscheidest.`);
      bot.api
        .sendMessage(config.telegram.chatId, text, {
          parse_mode: "Markdown",
          reply_markup: draftKeyboard(e.draft.id),
          link_preview_options: { is_disabled: true },
        })
        .catch(() => {});
    },
  );

  // Autopilot-Handoff: KI hat einen Termin klargemacht → Kontakt sofort pushen.
  events.on("lead:booked", (l: { participant: string; contact: string | null; threadUrl: string }) => {
    if (!bot || !config.telegram.chatId) return;
    bot.api
      .sendMessage(
        config.telegram.chatId,
        `🎯 TERMIN! ${l.participant} ist bereit für ein Gespräch.\n` +
          `${l.contact ? `📞 Kontakt: ${l.contact}\n` : "📞 Noch keine Nummer genannt – im Chat nachfragen.\n"}` +
          `💬 Chat: ${l.threadUrl}\n\nAb hier übernimmst du. 🤝`,
      )
      .catch(() => {});
  });

  bot.catch((err) => console.error("[telegram] Fehler:", err.message));
  bot.start().catch((e) => console.error("[telegram] Start-Fehler:", e));
  console.info("[telegram] Bot läuft. /status /entwuerfe");
}
