# NextLead vom Mac auf den Heimserver umziehen

Diese Anleitung ist für jemanden geschrieben, der noch nie ein Terminal benutzt hat.
Jeder Befehl steht in einem grauen Kasten. Kopiere ihn genau so, füge ihn im Terminal ein
und drücke Enter. Darunter steht immer ein Satz, was der Befehl macht.

**Voraussetzungen**
- Mac: NextLead-App ist installiert und bei LinkedIn eingeloggt. Das Projekt liegt unter
  `~/Documents/GitHub/linkedin-command-center` und `npm install` wurde dort schon einmal ausgeführt.
- Server: Debian mit Docker und Docker Compose, erreichbar unter `192.168.0.111`, du kannst dich
  per `ssh` anmelden. Der Server braucht Internet (LinkedIn, Gemini, Telegram).

> **WICHTIG, bitte zuerst lesen: Es darf nur EINE Instanz laufen.**
> Nach dem Umzug darf die Mac-App **nicht mehr parallel** laufen. Zwei Geräte am selben
> LinkedIn-Konto sehen für LinkedIn wie ein Konto-Missbrauch aus, und die beiden Datenbanken
> laufen auseinander (der Server weiß dann nichts von Nachrichten, die der Mac gesendet hat,
> und schreibt dieselben Leute doppelt an). Also: Mac-App beenden, umziehen, Mac-App nicht
> mehr öffnen. Wenn du sie zum Einloggen brauchst (Abschnitt „Wenn die Sitzung abgelaufen ist"),
> vorher den Server stoppen.

---

## Teil A: Am Mac

### A1. Mac-App beenden

Schließe NextLead vollständig (im Dock: Rechtsklick → Beenden). Prüfe im Terminal:

```bash
pgrep -fl "NextLead|dist/index.js" || echo "nichts läuft – gut"
```
Zeigt laufende NextLead-Prozesse an. Es muss „nichts läuft – gut" erscheinen. Falls nicht, App noch einmal beenden.

### A2. In den Projektordner wechseln

```bash
cd ~/Documents/GitHub/linkedin-command-center
```
Wechselt ins Projektverzeichnis. Alle folgenden Mac-Befehle laufen von hier aus.

### A3. Neuesten Code holen

```bash
git pull
```
Holt den aktuellen Stand des Projekts (mit dem Server-Modus) von GitHub.

```bash
npm install
```
Installiert fehlende Abhängigkeiten. Dauert beim ersten Mal einige Minuten.

```bash
npx playwright install chromium
```
Lädt den Browser, mit dem das Export-Skript deine Sitzung ausliest (die App bringt ihren eigenen
mit, das Projekt im Terminal braucht einen zweiten, einmalig ~95 MB).

### A4. Umzugspaket erstellen (Datenbank + Sitzung + Keys)

```bash
npm run umzug -- export
```
Öffnet unsichtbar deine gespeicherte LinkedIn-Sitzung, liest die Anmelde-Cookies aus, kopiert die
Datenbank konsistent, nimmt `.env` (API-Keys), `profil.local.json` und Kampagnen-Uploads dazu
und packt alles in eine Datei `nextlead-umzug-JJJJMMTT-HHMM.tar.gz` im Projektordner.

Am Ende steht `✓ Umzugspaket erstellt`. Steht dort `✗ NextLead läuft noch`, zurück zu A1.
Steht dort `Cookie li_at fehlt`, bist du in der App nicht eingeloggt: App öffnen, bei LinkedIn
anmelden, App beenden, A4 wiederholen.

> Das Paket enthält deine API-Keys und deine LinkedIn-Anmeldung. Es liegt nicht in Git
> (steht in `.gitignore`). Lösche es nach dem Umzug (Schritt B9).

### A5. Code auf GitHub pushen (nur wenn du selbst etwas geändert hast)

```bash
git status
```
Zeigt, ob es lokale Änderungen gibt. Steht „nothing to commit", weiter mit A6.

```bash
git add -A && git commit -m "Server-Modus" && git push
```
Speichert deine Änderungen und lädt sie auf GitHub, damit der Server sie holen kann.
Das Umzugspaket wird dabei NICHT hochgeladen, es ist ausgeschlossen.

### A6. Umzugspaket auf den Server kopieren

```bash
scp nextlead-umzug-*.tar.gz sinan@192.168.0.111:~/
```
Kopiert das Paket verschlüsselt in dein Home-Verzeichnis auf dem Server. Ersetze `sinan` durch
deinen Benutzernamen auf dem Server. Du wirst nach dem Server-Passwort gefragt.

---

## Teil B: Auf dem Server

### B1. Am Server anmelden

```bash
ssh sinan@192.168.0.111
```
Öffnet eine Terminal-Sitzung auf dem Server. Alle folgenden Befehle laufen dort.

### B2. Code holen

```bash
git clone https://github.com/sinanhrrck/linkedin-command-center.git
```
Lädt das Projekt von GitHub in den Ordner `linkedin-command-center`. Beim zweiten Mal (Update)
stattdessen im Ordner `git pull` ausführen.

```bash
cd linkedin-command-center
```
Wechselt in den Projektordner.

### B3. Node einmalig für den Import installieren

Der Import läuft einmal außerhalb von Docker, damit er das Paket direkt in den Datenordner
schreiben kann. Prüfe, ob Node vorhanden ist:

```bash
node -v
```
Zeigt die Node-Version. Steht dort `v20`, `v22` oder `v24`, weiter mit B4. Fehlt Node:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt-get install -y nodejs
```
Installiert Node 24 (dieselbe Version wie im Docker-Image).

```bash
npm install && npx playwright install --with-deps chromium
```
Installiert die Abhängigkeiten und einen Chromium für den einmaligen Import-Check.

### B4. Umzugspaket einspielen

```bash
mkdir -p data
```
Legt den Datenordner an. Hier liegt ab jetzt alles: Datenbank, Sitzung, Keys, Backups.

```bash
npm run umzug -- import ~/nextlead-umzug-*.tar.gz
```
Entpackt das Paket in `./data`: Datenbank, Profil, Uploads, `.env` (Mac-Pfade werden dabei
entfernt) und spielt die LinkedIn-Cookies in einen frischen Browser-Profilordner
`./data/.session` ein. Danach ruft er EINMAL den LinkedIn-Feed auf und meldet
`✓ Sitzung gültig – eingeloggt`.

Meldet er `⚠ LinkedIn zeigt: …/checkpoint/…`: LinkedIn will das neue Gerät bestätigen.
Siehe Abschnitt „Wenn LinkedIn einen Checkpoint zeigt" unten.

### B5. Dashboard-Passwort (DASHBOARD_TOKEN) setzen

Das Dashboard ist im ganzen Heimnetz erreichbar. Deshalb verweigert der Server-Modus den Start,
solange kein Passwort gesetzt ist.

```bash
openssl rand -hex 24
```
Erzeugt einen zufälligen 48-Zeichen-Wert, z. B. `3f9a…`. Das ist dein Passwort. Kopiere ihn.

```bash
nano data/.env
```
Öffnet die Konfigurationsdatei im Editor. Gehe mit den Pfeiltasten ans Ende und füge eine neue
Zeile hinzu (statt `<wert>` deinen kopierten Wert einsetzen, ohne Leerzeichen, ohne Anführungszeichen):

```
DASHBOARD_TOKEN=<wert>
```

Speichern: `Strg+O`, Enter. Beenden: `Strg+X`.

```bash
grep -c "^DASHBOARD_TOKEN=" data/.env
```
Prüft, ob die Zeile drin ist. Muss `1` ausgeben.

### B6. Container bauen und starten

```bash
docker compose build
```
Baut das Docker-Image: lädt das offizielle Playwright-Image (mit Chromium und Node), installiert
die Abhängigkeiten und kopiert den Code hinein. Dauert beim ersten Mal 5–10 Minuten.
Datenbank, Sitzung und `.env` landen dabei NICHT im Image, nur im Ordner `./data`.

```bash
docker compose up -d
```
Startet NextLead im Hintergrund. `restart: unless-stopped` sorgt dafür, dass es nach einem
Server-Neustart von selbst wieder hochkommt.

### B7. Log prüfen

```bash
docker compose logs -f --tail=100
```
Zeigt die laufende Ausgabe (mit `Strg+C` beenden, der Container läuft weiter). Diese Zeilen musst du sehen:

- `CRM-Cockpit läuft` → Dashboard steht.
- `[server] Zeit: lokal … · TZ=Europe/Berlin` → Zeitzone stimmt. Steht dort eine Warnung
  `Prozesszeit ≠ Europe/Berlin`, ist etwas mit `TZ` in `docker-compose.yml` falsch.
- `[server] ERSTSTART: Not-Aus ist AKTIV` → Sicherheitsbremse, nichts wird gesendet (siehe B8).
- `[sitzung] Eingeloggt – Sitzung gültig.` → LinkedIn erkennt die Anmeldung.

Erscheint stattdessen `START VERWEIGERT: DASHBOARD_TOKEN fehlt`, zurück zu B5, dann
`docker compose up -d` erneut. Erscheint `[sitzung] Sitzung ungültig` oder `Checkpoint`,
siehe die Abschnitte am Ende.

Das ausführliche Engine-Protokoll liegt in `data/engine.log`:

```bash
tail -f data/engine.log
```
Zeigt live, was die Engine tut.

### B8. Oberfläche öffnen und freigeben

Öffne im Browser (am Mac oder Handy im selben Netz):

**http://192.168.0.111:4321**

Der Browser fragt nach Benutzername und Passwort. Benutzername: beliebig (z. B. `sinan`).
Passwort: dein `DASHBOARD_TOKEN`.

Beim ersten Start ist bewusst alles gebremst, weil LinkedIn ein neues Gerät sieht:
- **Not-Aus ist aktiv**: die Engine läuft, liest Postfach und Annahmen, sendet aber NICHTS.
- **Warm-up steht auf Tag 1**: die Tageslimits beginnen wieder bei 50 % und steigen über 7 Tage.

Wenn im Log `Sitzung gültig` steht und das Dashboard normale Daten zeigt: unter
**Einstellungen → Not-Aus** die Sperre lösen. Ab da sendet der Bot wieder, gedrosselt.

### B9. Aufräumen

```bash
rm ~/nextlead-umzug-*.tar.gz
```
Löscht das Umzugspaket auf dem Server (es enthält Keys und Anmeldung, das Original steckt jetzt in `./data`).

Am Mac ebenso:

```bash
rm ~/Documents/GitHub/linkedin-command-center/nextlead-umzug-*.tar.gz
```
Löscht das Paket am Mac.

---

## Alltag

| Was | Befehl (im Ordner `linkedin-command-center` auf dem Server) |
|---|---|
| Status | `docker compose ps` |
| Log ansehen | `docker compose logs -f --tail=100` |
| Engine-Protokoll | `tail -f data/engine.log` |
| Stoppen | `docker compose down` |
| Starten | `docker compose up -d` |
| Code-Update einspielen | `git pull && docker compose build && docker compose up -d` |
| Datenbank-Sicherung von Hand | Dashboard → Einstellungen → Backup. Backups liegen in `data/backups/`. |

Wichtig zu wissen:
- Die Engine startet im Server-Modus automatisch mit dem Container und wird alle 2 Minuten
  neu gestartet, falls sie hängt. Der Stop-Knopf im Dashboard schaltet das ab, der Start-Knopf wieder an.
- Ein Telegram-Bot arbeitet auf dem Server genauso wie am Mac (die Werte stehen in `data/.env`).
- Sichere den Ordner `data/` regelmäßig weg (z. B. `tar -czf ~/nextlead-backup-$(date +%F).tar.gz data`).
  Darin ist alles, was du zum Wiederherstellen brauchst.

---

## Wenn die Sitzung abgelaufen ist

LinkedIn-Anmeldungen halten typischerweise Wochen bis Monate. Läuft sie ab, steht im Log
`[sitzung] Sitzung ungültig/abgelaufen` und der Governor pausiert (Dashboard zeigt den Grund).
Auf dem Server gibt es keinen Bildschirm zum Einloggen, deshalb geht der Weg über den Mac:

**1. Server stoppen** (keine zwei Geräte gleichzeitig):
```bash
docker compose down
```

**2. Am Mac einloggen.** NextLead-App öffnen, bei LinkedIn anmelden (Setup-Assistent bzw.
Einstellungen → LinkedIn verbinden), warten bis der Feed sichtbar ist, App beenden.
Die App darf nur zum Einloggen laufen. Starte dort NICHT die Engine.

**3. Nur die Sitzung exportieren** (klein, ohne Datenbank, damit die Server-Daten nicht
überschrieben werden):
```bash
cd ~/Documents/GitHub/linkedin-command-center && npm run umzug -- export --nur-sitzung
```
Erzeugt `nextlead-sitzung-JJJJMMTT-HHMM.json` (wenige KB).

**4. Auf den Server kopieren:**
```bash
scp nextlead-sitzung-*.json sinan@192.168.0.111:~/
```

**5. Auf dem Server einspielen:**
```bash
cd ~/linkedin-command-center && npm run umzug -- import ~/nextlead-sitzung-*.json
```
Ersetzt nur die Cookies im Profilordner `data/.session`, Datenbank und `.env` bleiben unangetastet,
und prüft sofort, ob die Anmeldung gilt.

**6. Server wieder starten und Pause aufheben:**
```bash
docker compose up -d
```
Dann im Dashboard die Pause des Governors bzw. den Not-Aus aufheben.

**7. Dateien löschen** (Mac und Server): `rm nextlead-sitzung-*.json`.

Das Verfahren ist beliebig oft wiederholbar.

## Wenn LinkedIn einen Checkpoint zeigt

Ein Checkpoint („Bestätige deine Identität", Code per E-Mail) heißt: LinkedIn will das neue
Gerät (den Server) bestätigt haben. Der Bot pausiert dann automatisch und wartet.
Ohne Bildschirm am Server lässt sich der Code dort nicht eingeben. Lösung: dasselbe Verfahren
wie bei „Sitzung abgelaufen" (am Mac einloggen, Sitzung exportieren, importieren). Meist
akzeptiert LinkedIn den Server nach ein bis zwei Bestätigungen dauerhaft. Bleibt es hartnäckig,
liegt es an der Server-IP; dann hilft nur, den Warm-up geduldig auszusitzen und nichts zu forcieren.

## Warnung „data.db wurde nach dem Export noch verändert"

Steht diese Zeile beim ersten Start im Log, lief die Mac-App nach dem Export weiter und hat die
Datenbank noch beschrieben. Der Server hat dann einen veralteten Stand. Sicherster Weg:
`docker compose down`, am Mac Schritt A1 und A4 wiederholen, auf dem Server `rm -rf data/data.db`
und B4 mit `--ueberschreiben` wiederholen (`npm run umzug -- import <paket> --ueberschreiben`).
