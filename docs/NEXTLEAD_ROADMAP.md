# NextLead – Fahrplan zur belastbaren Kampagnenplattform

Dieser Fahrplan priorisiert zuerst Beziehungsschutz und Datenqualitaet. Mehr Automatisierung ist
erst sinnvoll, wenn eine bereits bekannte Aussage eines Kontakts jede spaetere Kampagne sicher
stoppen oder verschieben kann.

**Aktueller Stand (12.08.2026):** `0.8.0-beta.6` ist lokal installiert. Phasen 0 bis 4 sind
abgeschlossen. Phase 5 ist begonnen. Der interne Funktionsstand ist noch nicht fuer eine breite
externe Veroeffentlichung freigegeben; dafuer gelten die Kriterien in `RELEASE_QA_GATE.md`.

## Phase 0 – Beziehungsschutz (abgeschlossen)

- [x] Kontaktweite Stati: aktiv, pausiert, nur manuell, ausgeschlossen
- [x] Wiedervorlage mit Datum, lesbarer Bezeichnung und Grund
- [x] Erkennung eindeutiger Aussagen wie „keine Zeit“, „spaeter“, „nach der Pruefung“, „im Winter“
- [x] Dauerhaftes Kontaktverbot bei eindeutiger Ablehnung
- [x] Zentrale Schutzpruefung vor Kampagnenaufnahme, Entwurfserstellung und Versand
- [x] Offene proaktive Entwuerfe und Kampagnenziele bei einem Schutzsignal entfernen
- [x] Direkte, hoefliche Antwort weiterhin erlauben
- [x] Bedienung und Filter im Kontakt-Dashboard
- [x] Historische Gespraeche uebernehmen; Regressionstest fuer Alexander Werbitzki

## Phase 1 – Eine verlaessliche Kontaktidentitaet (abgeschlossen)

- [x] LinkedIn-Profil, Nachrichten-Thread und importierte Quelle auf genau einen Kontakt abbilden
- [x] Dubletten automatisch erkennen und kontrolliert zusammenfuehren
- [x] Vollstaendige Kontakt-Timeline aus Nachrichten, Kampagnen, Notizen und Statuswechseln
- [x] Unklare Zuordnungen blockieren und zur manuellen Klaerung vorlegen
- [x] Datenqualitaetsanzeige mit konkreten Reparaturaktionen

Abnahme: Kein Kontakt kann durch eine abweichende Thread-URL oder einen erneuten Import seine
Historie und seine Sperren verlieren.

## Phase 2 – Kampagnen als echte Workflows

- [x] Visuelle Abfolge aus Zielgruppe, Vernetzen, Warten, Nachricht, Reaktion und Folgeaktion
- [x] Ein Kontakt darf je Workflow immer nur in einem aktiven Schritt stehen
- [x] Eintritts-, Ausschluss- und Abbruchregeln pro Kampagne
- [x] Vorschau der betroffenen Kontakte vor Aktivierung
- [x] Fortschritt: gesamt, wartend, erfolgreich, Fehler, ausgeschlossen und geschuetzt
- [x] Kontrolliertes Pausieren, Fortsetzen und Wiederholen ohne Doppelversand

Abnahme: Kampagnen sind nachvollziehbar, idempotent und nach einem Neustart exakt fortsetzbar.

## Phase 3 – Gespraechskontext und passende Kommunikation

- [x] Letzte relevante Aussage, Zusagen und offene Punkte als strukturierte Gespraechsmemory
- [x] Absicht erkennen: interessiert, spaeter, beschaeftigt, nicht passend, keine weiteren Nachrichten
- [x] Personalisierung verwendet Profil und echten Gespraechsverlauf
- [x] Entwurf zeigt vor Freigabe, auf welche Fakten und Aussagen er sich stuetzt
- [x] Allgemeine Kampagnentexte werden bei widersprechendem Kontext automatisch blockiert
- [x] Manuelle Korrekturen verbessern Regeln, ohne personenbezogene Daten zu vermischen

Abnahme: Ein Fall wie Alexander kann weder dieselbe allgemeine Einladung erhalten noch unbemerkt
in eine neue proaktive Sequenz gelangen.

## Phase 4 – Betriebssicherheit und Transparenz

- [x] Einheitliche Job-Queue fuer Lesen, Vernetzen, Entwuerfe und Versand
- [x] Wiederholungsregeln, Zeitlimits und Dead-Letter-Queue fuer dauerhafte Fehler
  - Backoff und Dead-Letter nach drei Fehlern sowie zentrale, sicher abbrechbare Job-Zeitlimits sind umgesetzt.
- [x] Erklaerbare Statusgruende und konkrete Reparaturaktion bei jedem Stillstand
- [x] Audit-Log: warum wurde ein Kontakt aufgenommen, blockiert, verschoben oder angeschrieben
- [x] Kontingente, Ruhezeiten, Recovery-Modus und LinkedIn-Sicherheitsgrenzen zentral verwalten
- [x] Fehlerbericht und Feedback fuer jede Installation, Zustellung nur an den Betreiber

Abnahme: Jeder Stillstand ist erklaerbar und jeder Versand kann auf eine konkrete Entscheidung
zurueckgefuehrt werden.

## Phase 5 – Wirkung messen und verbessern

- [ ] Funnel je Kampagne und Segment von Quelle bis Termin/Ergebnis
  - Gesamtfunnel und Ziel-Oekonomie fuer B1/P1/AEC sind vorhanden.
  - Offen: belastbare Zuordnung je Kampagne, Lead-Quelle, Segment und Zeitraum bis zum Ergebnis.
- [ ] Antwortqualitaet und echte Geschaeftsergebnisse statt nur Aktivitaet messen
  - Status fuer qualifiziert, Termin, gewonnen und verloren sind technisch vorbereitet.
  - Offen: konsistente Einordnung aller Antworten und eine belastbare Ergebnisansicht.
- [ ] Versionierte Vorlagen und kontrollierte A/B-Tests
  - Experiment-Grundstruktur ist vorhanden.
  - Offen: unveraenderliche Vorlagenversionen, faire Zuteilung, Mindeststichprobe und Rollback.
- [ ] Warnung bei sinkender Annahme-, Antwort- oder Qualifizierungsrate
  - [x] Annahmequote mit Warnschwelle, sichtbarer Wirkung und Schalter fuer weniger Anfragen.
  - [ ] Antwortquote, positive Antwortquote und Qualifizierungsquote mit Mindeststichprobe.
- [ ] Empfehlungen bleiben Vorschlaege und veraendern keine laufende Kampagne ungeprueft
  - Offen: Vorschau, bewusste Uebernahme, Ignorieren und Rueckgaengigmachen jeder Empfehlung.

Abnahme: Verbesserungen werden anhand belastbarer Ergebnisse entschieden und sind rueckrollbar.

## Phase 6 – Mehrnutzerfaehigkeit und Produktreife

- [ ] Nutzer, Rollen, getrennte Datenraeume und installationsuebergreifende Konfiguration
  - Jede Installation arbeitet bereits mit ihrem lokalen Datenbestand.
  - Offen: Anmeldung, Rollen und nachweisbar getrennte Datenraeume fuer mehrere Nutzer.
- [ ] Geheimnisse ausschliesslich serverseitig und sicher rotierbar speichern
  - Feedback wird ueber einen zentralen Relay-Dienst nur an den Betreiber zugestellt.
  - Offen: Rotation des verwendeten Mail-Schluessels und zentrale Verwaltung aller Produktgeheimnisse.
- [ ] Zentraler Release-Kanal mit Migration, Backup und Rueckrollmoeglichkeit
  - Versionierte DMGs, Backup vor Installation und lokale Rueckfall-App sind vorhanden.
  - Offen: signierter/notarisierter Updatekanal und automatisches, geprueftes Rollback fuer andere Nutzer.
- [ ] Monitoring, Datenschutz, Aufbewahrungsregeln und Export/Loeschung
  - Bereinigte Fehlerberichte, Feedback und optionale Ausschnitt-Screenshots sind vorhanden.
  - Offen: zentrale Fehleruebersicht, Aufbewahrungsfristen, vollstaendiger Export und Kontoloeschung.
- [ ] End-to-End-Tests fuer Installation, Update, Kampagne, Antwort, Sperre und Wiederherstellung
  - 69 automatisierte Kern-, Integritaets- und Regressionstests sind gruen.
  - Offen: echte Mehrinstallations- und Oberflaechenablaeufe einschliesslich Update und Wiederherstellung.

Abnahme: Neue Nutzer erhalten dasselbe Verhalten und dieselben Schutzregeln ohne lokale
Sonderkonfiguration fuer den Betreiber.
