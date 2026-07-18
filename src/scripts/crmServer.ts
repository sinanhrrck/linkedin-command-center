import { createServer } from "node:http";
import { spawn, execFile } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, openSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getDashboardData } from "../modules/dashboard.js";
import { getDraft, setDraftStatus, sendDraft, approveDraft, rejectDraft } from "../modules/drafts.js";
import { getPost, approvePost, discardPost } from "../modules/content.js";
import { deleteContact } from "../modules/crm.js";
import { db, getState, setState, setMode, setFocus, getFocus, type Mode, type Focus } from "../db/index.js";
import { LIVE_SHOT_PATH } from "../core/session.js";

/**
 * Lokales CRM-Cockpit. Nutzung: npm run crm
 * Startet einen kleinen HTTP-Server (kein Framework), der das Dashboard ausliefert
 * und den Zustand als JSON bereitstellt. Rein lesend – kein Senden, kein Governor-Bypass.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = join(__dirname, "..", "web", "crm.html");
const SETUP_PATH = join(__dirname, "..", "web", "setup.html");
const PROJECT_ROOT = join(__dirname, "..", "..");
const ENV_PATH = join(PROJECT_ROOT, ".env");
const PROFIL_PATH = join(PROJECT_ROOT, "profil.local.json");
const PORT = Number(process.env.CRM_PORT ?? 4321);

/** .env als Key→Value lesen (frisch von Platte, damit Änderungen ohne Neustart sichtbar sind). */
function readEnvFile(): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(ENV_PATH)) return out;
  for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

/** Einzelne Keys in .env setzen – bestehende Zeilen ersetzen, Rest (Kommentare/Struktur) bleibt. */
function updateEnv(updates: Record<string, string>) {
  let lines = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8").split("\n") : [];
  for (const [k, v] of Object.entries(updates)) {
    const line = `${k}=${v}`;
    const idx = lines.findIndex((l) => new RegExp(`^\\s*${k}\\s*=`).test(l));
    if (idx >= 0) lines[idx] = line;
    else lines.push(line);
  }
  writeFileSync(ENV_PATH, lines.join("\n"));
}

/** Ist das Tool eingerichtet? (Gemini-Key + Profil vorhanden). Steuert die Setup-Weiche. */
function setupStatus() {
  const env = readEnvFile();
  const hasGemini = !!(env.GEMINI_API_KEY || process.env.GEMINI_API_KEY);
  const hasProfile = existsSync(PROFIL_PATH);
  const hasPosting = !!(env.LINKEDIN_ACCESS_TOKEN || env.LINKEDIN_CLIENT_ID);
  const linkedInConnected = getState("linkedin_connected") === "1";
  return { configured: hasGemini && hasProfile, hasGemini, hasProfile, hasPosting, linkedInConnected };
}

/**
 * SENDE-WARTESCHLANGE. Klickt Sinan mehrere "Senden"-Knöpfe, kommen mehrere HTTP-Requests
 * gleichzeitig an. Ohne Serialisierung wäre das gefährlich:
 *  1. `session.newPage()` liefert IMMER dieselbe Seite (`ctx.pages()[0]`) – zwei parallele
 *     Versände würden denselben Tab gleichzeitig navigieren und ineinander tippen.
 *     Ergebnis: Nachricht an die falsche Person.
 *  2. Der Governor hält seinen 20-75s-Abstand nur INNERHALB eines Durchlaufs. Parallele
 *     Sends warten jeder für sich und feuern dann fast gleichzeitig – die Taktung, die den
 *     Account schützt, wäre ausgehebelt (derselbe Bug wie bei den überlappenden Cron-Ticks).
 * Deshalb hängt jeder Versand hinten an eine Promise-Kette. Auch nach einem Fehler läuft
 * die Kette weiter, sonst blockiert ein kaputter Entwurf alle folgenden.
 */
let sendeKette: Promise<unknown> = Promise.resolve();
let inWarteschlange = 0;

function nacheinander<T>(fn: () => Promise<T>): Promise<T> {
  inWarteschlange++;
  const naechster = sendeKette.then(fn, fn);
  sendeKette = naechster.then(
    () => inWarteschlange--,
    () => inWarteschlange--,
  );
  return naechster;
}

/** Läuft der Engine-Loop? (Heartbeat < 150s alt) */
function engineAlive(): boolean {
  const hb = getState("engine_heartbeat");
  return hb ? Date.now() - new Date(hb).getTime() < 150_000 : false;
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  // ===== SETUP-ASSISTENT (Onboarding ohne Terminal, für Laien) =====
  // Status: ist alles eingerichtet? Steuert die Weiche "/" → Dashboard oder Setup.
  if (url.pathname === "/api/setup/status") {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(setupStatus()));
    return;
  }

  // Keys + Profil speichern. Keys → .env (strukturschonend), Profil → profil.local.json.
  if (url.pathname === "/api/setup/save" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { keys, profil } = JSON.parse(body || "{}") as { keys?: Record<string, string>; profil?: unknown };
        if (keys && typeof keys === "object") {
          const erlaubt = ["GEMINI_API_KEY", "ANTHROPIC_API_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "LINKEDIN_ACCESS_TOKEN", "LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET", "LINKEDIN_PERSON_URN"];
          const upd: Record<string, string> = {};
          for (const [k, v] of Object.entries(keys)) if (erlaubt.includes(k) && typeof v === "string" && v.trim()) upd[k] = v.trim();
          if (Object.keys(upd).length) updateEnv(upd);
        }
        if (profil && typeof profil === "object") {
          writeFileSync(PROFIL_PATH, JSON.stringify(profil, null, 2));
        }
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, ...setupStatus() }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, error: String(e) }));
      }
    });
    return;
  }

  // Aktuelles Profil laden (fürs Vorbefüllen des Formulars, falls schon eins existiert).
  if (url.pathname === "/api/setup/profil") {
    try {
      const roh = existsSync(PROFIL_PATH) ? readFileSync(PROFIL_PATH, "utf8") : "{}";
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }).end(roh);
    } catch {
      res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
    }
    return;
  }

  // LinkedIn verbinden: öffnet ein SICHTBARES Browserfenster zum Einloggen (wie `npm run login`).
  if (url.pathname === "/api/setup/login" && req.method === "POST") {
    try {
      const logFd = openSync(join(PROJECT_ROOT, "engine.log"), "a");
      const child = spawn("npx", ["tsx", "src/scripts/login.ts"], {
        cwd: PROJECT_ROOT, detached: true, stdio: ["ignore", logFd, logFd],
        env: { ...process.env, BROWSER_MODE: "visible" },
      });
      child.unref();
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, error: String(e) }));
    }
    return;
  }

  // Login prüfen: schließt das Login-Fenster, öffnet versteckt den Feed und prüft, ob eingeloggt.
  if (url.pathname === "/api/setup/verify-login" && req.method === "POST") {
    execFile("pkill", ["-f", "tsx src/scripts/login.ts"], () => {
      try { rmSync(join(PROJECT_ROOT, ".session", "SingletonLock"), { force: true }); } catch { /* egal */ }
      setTimeout(() => {
        const child = spawn("npx", ["tsx", "src/scripts/checkLogin.ts"], { cwd: PROJECT_ROOT, env: process.env });
        let ausgabe = "";
        child.stdout?.on("data", (d) => (ausgabe += d));
        child.stderr?.on("data", (d) => (ausgabe += d));
        child.on("exit", (code) => {
          const ok = code === 0;
          setState("linkedin_connected", ok ? "1" : "0");
          res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok, hinweis: ok ? "" : ausgabe.slice(-200) }));
        });
      }, 2000);
    });
    return;
  }

  // Entwurf editieren, verwerfen ODER senden. Der Versand lief früher bewusst nur per CLI
  // (`npm run send -- <id>`), weil dem Sendeweg nicht zu trauen war. Seit er verifiziert ist
  // (outreach.tippenUndSenden: Feld leer + Text im Verlauf) geht er auch hier – wie in Telegram.
  // sendDraft läuft über den Governor, es gibt also keinen Bypass.
  if (url.pathname === "/api/draft" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { id, action, text } = JSON.parse(body || "{}");
        const d = getDraft(Number(id));
        if (!d) {
          res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "not found" }));
          return;
        }
        if (action === "save" && typeof text === "string") {
          db.prepare("UPDATE drafts SET draft=? WHERE id=?").run(text.trim(), Number(id));
        } else if (action === "discard") {
          setDraftStatus(Number(id), "discarded");
        } else if (action === "approve") {
          // Genehmigen: der Bot sendet beim nächsten Lauf (governor-gedrosselt). Kein Direktversand.
          approveDraft(Number(id), typeof text === "string" ? text : undefined);
        } else if (action === "reject") {
          // Ablehnen: verwerfen + sofort einen neuen Entwurf erzeugen (async, KI-Aufruf).
          rejectDraft(Number(id))
            .then((r) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(r)))
            .catch((e) => res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, reason: String(e?.message ?? e).slice(0, 160) })));
          return; // Antwort kommt asynchron
        } else if (action === "send") {
          // Vorher speichern, falls im Feld editiert wurde – sonst geht der alte Text raus.
          if (typeof text === "string" && text.trim()) {
            db.prepare("UPDATE drafts SET draft=? WHERE id=?").run(text.trim(), Number(id));
          }
          // Reiht sich ein: mehrere Klicks sind erlaubt, laufen aber garantiert nacheinander.
          nacheinander(() => sendDraft(Number(id)))
            .then((r) => {
              res
                .writeHead(r.ok ? 200 : 409, { "Content-Type": "application/json" })
                .end(JSON.stringify(r));
            })
            .catch((e) => {
              // Ehrlich bleiben: Fehler durchreichen statt Erfolg vorgaukeln.
              res
                .writeHead(500, { "Content-Type": "application/json" })
                .end(JSON.stringify({ ok: false, reason: String(e?.message ?? e).slice(0, 160) }));
            });
          return; // Antwort kommt asynchron
        } else {
          res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "bad action" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: String(e) }));
      }
    });
    return;
  }

  // Eigene Post-Entwuerfe freigeben/verwerfen. Freigabe setzt 'approved' + faellig ab jetzt;
  // der Cron in index.ts veroeffentlicht ihn ueber die OFFIZIELLE API (kein Governor noetig,
  // kein Selektor-Risiko). Editierter Text wird vorher gespeichert.
  if (url.pathname === "/api/post" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { id, action, text } = JSON.parse(body || "{}");
        const p = getPost(Number(id));
        if (!p) {
          res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "not found" }));
          return;
        }
        if (typeof text === "string" && text.trim() && p.status === "draft") {
          db.prepare("UPDATE posts SET body=? WHERE id=? AND status='draft'").run(text.trim(), Number(id));
        }
        if (action === "approve") {
          const ok = approvePost(Number(id));
          res.writeHead(ok ? 200 : 409, { "Content-Type": "application/json" }).end(JSON.stringify({ ok }));
        } else if (action === "discard") {
          const ok = discardPost(Number(id));
          res.writeHead(ok ? 200 : 409, { "Content-Type": "application/json" }).end(JSON.stringify({ ok }));
        } else if (action === "save") {
          res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "bad action" }));
        }
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: String(e) }));
      }
    });
    return;
  }

  // Automatik-Modus umschalten (manual | semi | full).
  if (url.pathname === "/api/mode" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { mode } = JSON.parse(body || "{}");
        if (!["manual", "semi", "full"].includes(mode)) {
          res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "bad mode" }));
          return;
        }
        setMode(mode as Mode);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, mode }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: String(e) }));
      }
    });
    return;
  }

  // FOKUS umschalten: auf welche Zielgruppe geht der Bot? Steuert, aus welchen Quellen er
  // sich Nachschub holt (leadFeed). Sinan stellt nur das ein, der Rest laeuft von allein.
  if (url.pathname === "/api/focus" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { focus } = JSON.parse(body || "{}");
        if (!["azubi", "student", "beides"].includes(focus)) {
          res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "bad focus" }));
          return;
        }
        setFocus(focus as Focus);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, focus }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: String(e) }));
      }
    });
    return;
  }

  // Engine (Loop) starten/stoppen – ersetzt "npm run dev" im Terminal.
  if (url.pathname === "/api/engine" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { action } = JSON.parse(body || "{}");
        if (action === "start") {
          if (engineAlive()) {
            res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, already: true }));
            return;
          }
          // Loop-Ausgabe in engine.log schreiben (statt still) – fürs Debuggen.
          const logFd = openSync(join(PROJECT_ROOT, "engine.log"), "a");
          // Auf macOS via `caffeinate -i` starten: hält den Mac wach, solange der Loop läuft
          // (verhindert Idle-Sleep → Bot stirbt nicht). Beim Stoppen schläft der Mac wieder normal.
          const isMac = process.platform === "darwin";
          const cmd = isMac ? "caffeinate" : "npx";
          const args = isMac ? ["-i", "npx", "tsx", "src/index.ts"] : ["tsx", "src/index.ts"];
          const child = spawn(cmd, args, {
            cwd: PROJECT_ROOT,
            detached: true,
            stdio: ["ignore", logFd, logFd],
            env: process.env,
          });
          child.unref();
          res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, pid: child.pid }));
        } else if (action === "stop") {
          // Robust: Loop-Prozess per Muster killen (egal wie gestartet), Lock aufräumen.
          execFile("pkill", ["-f", "tsx src/index.ts"], () => {
            try {
              rmSync(join(PROJECT_ROOT, ".session", "SingletonLock"), { force: true });
            } catch {
              /* egal */
            }
          });
          setState("engine_heartbeat", ""); // sofort als offline markieren
          res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "bad action" }));
        }
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: String(e) }));
      }
    });
    return;
  }

  // Kontakt aus dem CRM entfernen.
  if (url.pathname === "/api/contact" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { id, action } = JSON.parse(body || "{}");
        if (action !== "delete") {
          res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "bad action" }));
          return;
        }
        const ok = deleteContact(Number(id));
        res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" }).end(JSON.stringify({ ok }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: String(e) }));
      }
    });
    return;
  }

  // Live-Ansicht: letzter Schnappschuss des versteckten Browsers (von der Engine geschrieben).
  // Getrennte Prozesse → Umweg über Datei. 404, solange die Engine noch keinen geschrieben hat.
  if (url.pathname === "/api/live.jpg") {
    try {
      const img = readFileSync(LIVE_SHOT_PATH);
      res
        .writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "no-store" })
        .end(img);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("noch kein Bild");
    }
    return;
  }

  if (url.pathname === "/api/state") {
    try {
      const data = JSON.stringify(getDashboardData());
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }).end(data);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" }).end(
        JSON.stringify({ error: String(e) }),
      );
    }
    return;
  }

  // Setup-Seite (der Assistent selbst).
  if (url.pathname === "/setup") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(readFileSync(SETUP_PATH, "utf-8"));
    return;
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    // Weiche: noch nicht eingerichtet → Setup-Assistent, sonst das Dashboard.
    if (!setupStatus().configured) {
      res.writeHead(302, { Location: "/setup" }).end();
      return;
    }
    // In dev bei jedem Request frisch lesen, damit Design-Änderungen sofort greifen.
    const html = readFileSync(HTML_PATH, "utf-8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(html);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" }).end("Nicht gefunden");
});

server.listen(PORT, () => {
  console.info(`\n  CRM-Cockpit läuft →  http://localhost:${PORT}\n`);
  console.info("  Beenden mit STRG+C.\n");
});
