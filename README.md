# Command Center für LinkedIn

Dein persönlicher LinkedIn-Assistent, der **lokal auf deinem Rechner** läuft. Er vernetzt
sich für dich, schreibt Nachrichten in **deiner** Stimme, erkennt heiße Kontakte und legt dir
alles als Entwurf zur Freigabe vor. Du entscheidest, der Bot arbeitet.

Alles läuft **auf deinem Computer, mit deinem Konto**. Es gibt keinen Server, keine Cloud,
niemand außer dir sieht deine Daten.

---

## ⚠️ Bevor du startest — bitte lies das

- Dieses Tool automatisiert dein LinkedIn. Das widerspricht den **Nutzungsbedingungen von
  LinkedIn**. Die Nutzung ist **auf eigene Verantwortung**. Der eingebaute Schutz (Limits,
  Pausen, menschliche Verzögerungen) hält das Risiko klein, aber nicht bei null.
- Du speicherst Kontaktdaten anderer Menschen (**DSGVO**). Dafür bist **du** verantwortlich.
- Sei kein Spammer. Das Tool ist auf **echte, wertige Kontakte** ausgelegt, nicht auf Masse.

---

## 1. Herunterladen

1. Klick oben auf den grünen Button **`< > Code`** → **`Download ZIP`**.
2. Entpacke die ZIP-Datei (Doppelklick). Du hast jetzt einen Ordner `Command Center`.
3. Leg ihn irgendwohin, wo er bleiben darf (z.B. in `Dokumente`).

> Wer sich auskennt, kann stattdessen `git clone` nutzen.

## 2. Starten

**Mac:** Doppelklick auf **`Command Center starten.command`**
**Windows:** Doppelklick auf **`Command Center starten (Windows).bat`**

Beim **allerersten Mal** richtet sich das Tool selbst ein (das dauert ein paar Minuten – bitte
das schwarze Fenster offen lassen). Falls **Node.js** fehlt, öffnet sich automatisch die
Download-Seite: installier es einmalig (die „LTS"-Version), dann starte erneut per Doppelklick.

> **Mac-Hinweis:** Beim ersten Doppelklick sagt macOS evtl. „Entwickler nicht verifiziert".
> Dann: Rechtsklick auf die Datei → **Öffnen** → **Öffnen**. Das musst du nur einmal machen.

Danach öffnet sich dein Browser mit dem **Einrichtungs-Assistenten**.

## 3. Einrichten (der Assistent führt dich durch)

**Schritt 1 – KI-Schlüssel (kostenlos):**
Der Bot schreibt mit Google Gemini. Hol dir einen gratis Schlüssel auf
[aistudio.google.com/apikey](https://aistudio.google.com/apikey) → **„Create API key"** →
kopieren → im Assistenten einfügen.

**Schritt 2 – Wer bist du:**
Dein Vorname, ein paar Sätze über dich und 1–4 echte Nachrichten von dir. Das ist das
Wichtigste: Der Bot ahmt deinen Ton nach, damit die Nachrichten wie von dir klingen.

**Schritt 3 – LinkedIn verbinden:**
Klick „Login-Fenster öffnen", logg dich ganz normal bei LinkedIn ein, dann „Verbindung
prüfen". Fertig.

**Schritt 4:** Speichern – der Bot startet.

## 4. Loslegen

1. **Kontakte sammeln:** Öffne auf LinkedIn eine Personen-Suche (z.B. „Auszubildende
   Bankkaufmann"), kopiere die Adresse aus der Browserzeile. Dann im Ordner einmal (im
   Terminal/in der Eingabeaufforderung):
   ```
   npm run scrape -- "<die kopierte LinkedIn-Such-Adresse>"
   ```
   Oder dauerhaft als automatische Quelle:
   ```
   npm run source -- add "<Such-Adresse>" "Mein Suchname"
   ```
2. **Bot starten:** Im Dashboard oben auf **„Bot starten"**. Ab jetzt vernetzt er sich
   automatisch (gedrosselt & sicher) und legt dir Nachrichten als **Entwurf** vor.
3. **Freigeben:** Unter **„Entwürfe"** liest du jeden Vorschlag, klickst **Genehmigen** (der
   Bot sendet beim nächsten Durchgang) oder **Ablehnen** (er schreibt einen neuen).

Das war's. Schau einmal am Tag rein, gib frei, was gut ist – der Rest läuft von allein.

---

## Was der Bot automatisch macht

- **Vernetzen** mit deinen gesammelten Kontakten – 7 Tage die Woche, aber gedrosselt (max.
  ~20/Tag, ~100/Woche, mit zufälligen Pausen wie ein Mensch).
- **Nachrichten & Antworten** als Entwurf vorbereiten – Versand nur mit deiner Freigabe
  (Nachrichten gehen nur Mo–Fr raus, wirkt menschlicher).
- **Heiße Kontakte erkennen** (wer geantwortet hat) und dir oben anzeigen.
- **Kommentare & Likes** bei passenden Beiträgen (Kommentare mit Freigabe, Likes automatisch).
- **Sich selbst schützen:** Fällt die Annahmequote deiner Anfragen zu tief, pausiert er von
  allein, damit dein Konto nicht auffällt.

## Häufige Fragen

**Muss mein Computer anbleiben?** Ja – solange der Bot arbeiten soll, muss der Rechner laufen
(und wach sein; auf dem Mac hält das Tool ihn automatisch wach).

**Kostet das was?** Nein. Google Gemini ist im Gratis-Rahmen (rund 20 Nachrichten/Tag). Nur
wenn du den optionalen „Voll-Autopilot" mit Claude nutzt, kostet das etwas.

**Sieht jemand meine Daten?** Nein. Alles bleibt auf deinem Rechner. Keine Cloud.

**Der Bot hat lange nichts gemacht?** Er arbeitet bewusst langsam (Sicherheit vor Tempo) und
nur werktags 9–19 Uhr für Nachrichten. Vernetzungen laufen auch am Wochenende.

**„Eigene Beiträge posten" fehlt bei mir?** Das ist optional und braucht eine LinkedIn-
Entwickler-App. Ohne die läuft alles andere ganz normal.

---

## Für Entwickler

Technische Details, Architektur und alle `npm`-Skripte stehen in **[SETUP.md](SETUP.md)** und
**[CLAUDE.md](CLAUDE.md)**. Kurz:

```bash
npm install && npx playwright install chromium
npm run crm      # Dashboard (http://localhost:4321) – enthält den Setup-Assistenten
npm run dev      # Engine-Loop (oder über den Start-Knopf im Dashboard)
```

Kern: TypeScript/Node, Playwright (echte Session), SQLite, node-cron. Jede sendende Aktion
läuft zwingend durch `src/core/safetyGovernor.ts`. Persönliche Daten liegen in `.env`,
`profil.local.json`, `.session/`, `data.db` – alle gitignored, bleiben lokal.
