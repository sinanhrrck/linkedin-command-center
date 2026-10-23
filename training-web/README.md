# NextLead Training-Website

Öffentliche Seite auf Vercel: https://nextlead-training.vercel.app

| Link | Für wen | Was passiert |
|---|---|---|
| `/` | Externe | Anonyme Studie im Fragebogen-Stil: Einwilligung, Altersgruppe + Tätigkeit, Rollenkarte, Chat (der Bot schreibt an), Fragebogen. Nur die Rolle „Lead“. |
| `/team` | Kollegen | Chat-Training mit beiden Rollen („Ich bin der Bot“ / „Ich bin der Lead“), Vorname, Ausrichtung Standard/AEC. |

Jedes abgeschlossene Training schickt **eine E-Mail an dich** (Resend) mit Ergebnis, Chat, Vorschlägen und einer
Importdatei im Anhang. Im Cockpit: Training → „Trainings-Dateien importieren“ (mehrere auf einmal). Gespeichert
wird auf der Website nichts.

## Einrichten (einmalig)

1. **Anthropic-Schlüssel:** In der Anthropic-Konsole einen **eigenen** API-Schlüssel nur für diese Seite anlegen und
   dort ein **monatliches Ausgabenlimit** setzen. Die Seite ist öffentlich, jede Nachricht kostet etwas Guthaben.
2. **Resend:** Auf resend.com ein kostenloses Konto mit der E-Mail-Adresse anlegen, an die die Trainings gehen
   sollen, und einen API-Schlüssel erzeugen. Ohne eigene Domain darf Resend nur an genau diese Adresse senden.
3. **Vercel** → Projekt `nextlead-training` → Settings → Environment Variables (Production):

   | Name | Wert |
   |---|---|
   | `ANTHROPIC_API_KEY` | Schlüssel aus Schritt 1 |
   | `RESEND_API_KEY` | Schlüssel aus Schritt 2 |
   | `MAIL_TO` | deine Resend-Konto-Adresse |
   | `VERANTWORTLICH_NAME` | wer die Studie verantwortet (steht im Einwilligungstext) |
   | `VERANTWORTLICH_KONTAKT` | Kontakt-E-Mail für Fragen |
   | `BOT_MODEL` (optional) | überschreibt das Modell aus der Momentaufnahme (dort steht `LLM_MODEL` des echten Bots) |
   | `KI_MODEL` (optional) | Modell für KI-Lead und Auswertung, Standard `claude-opus-5-5` |

4. **Neu deployen** (Vercel → Deployments → … → Redeploy). Solange etwas fehlt, zeigt die Seite
   „noch nicht fertig eingerichtet“ und niemand kann starten.
5. **Einwilligungstext prüfen** (`public/index.html`, Abschnitt `s-info`) – Datenschutz verantwortest du.

## Der Bot auf der Seite ist der echte Bot (1:1)

Die Seite enthält keine eigene Prompt-Fassung. `npm run trainingsseite` (im Repo-Hauptordner) baut:

- `api/_kern.mjs` – gebündelter Original-Code aus `src/trainingsweb/kern.ts`: die Agent-Pipeline
  (`handleIncomingMessage`: Analyse → Phase → Antwort → Humanizer → Validator → Übergabe/Schweigen) und die
  Erstnachricht (`erstnachrichtPrompt` + Ausbildungs- und Ausgangsprüfung).
- `api/_bot.json` – Momentaufnahme der Live-Daten: Profil-Kontext je Ausrichtung inkl. freigegebener
  Trainings-Regeln, Angebot, Vertriebswissen, Zielgruppen-Anleitung, Stil-Varianten, Lernregeln, Modell.

Claude wird wie in `core/claude.ts` aufgerufen (gleiches Modell, 1024 Tokens, Vertriebswissen als gecachter
System-Block). Ein Test (`src/core/trainingsweb.test.ts`) prüft, dass Website-Kern und Live-Bot identische
Prompts schicken. Einzige Abweichung: die Stil-Variante der Erstnachricht wird zufällig statt nach Erfolgszahlen
gewählt.

**Nur ein Snapshot vom Heimserver ist wirklich 1:1** (dort liegen Zielgruppen, Regeln und das Vertriebswissen).
Nach jedem Server-Update, das Profil, Angebot, Zielgruppen oder Regeln ändert:

1. Auf dem Server (Ordner `/root/linkedin-command-center`):
   `docker compose exec nextlead npm run trainingsseite -- --nur-snapshot /data/trainings-snapshot.json`
   (liest nur; die Lernhistorie wird dabei idempotent nachgetragen wie bei jedem Engine-Start)
2. Datei auf den Mac holen nach `training-web/api/_bot.json`:
   `scp root@192.168.0.111:/root/linkedin-command-center/data/trainings-snapshot.json training-web/api/_bot.json`
3. Kern bauen und deployen: im Repo-Hauptordner `npx esbuild src/trainingsweb/kern.ts --bundle --platform=node --format=esm --target=node20 --outfile=training-web/api/_kern.mjs`,
   dann in `training-web/` `npx vercel deploy --prod`.

`.vercelignore` sorgt dafür, dass `api/_bot.json` und `api/_kern.mjs` mit hochgeladen werden, obwohl git sie
ignoriert; von außen sind beide nicht abrufbar (404).

## Schutz gegen Missbrauch

Kein Login – deshalb: Prompts entstehen nur auf dem Server, Antworten sind auf festes JSON beschränkt, höchstens
40 Nachrichten à 1500 Zeichen je Gespräch. Die eigentliche Kostenbremse ist das Ausgabenlimit des eigenen
Anthropic-Schlüssels (Schritt 1). Resend kostenlos: 100 Mails pro Tag.
