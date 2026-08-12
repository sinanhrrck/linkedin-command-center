# NextLead Release-QA

Status: **Nicht zur externen Veröffentlichung freigegeben.**

## Aktueller Build

- Version: `0.8.0-beta.6`
- Stand: 12.08.2026
- Installation: lokal auf dem Betreiber-Mac aktiv
- Datenbestand beim letzten Abgleich: 679 Kontakte, 3 Kampagnen
- Engine/Sendeweg: aktiv und geprueft
- Offene Jobfehler beim letzten Abgleich: 0

## Aktuelle Fehleraufnahme (12.08.2026)

| Bereich | Befund | Behandlung |
|---|---|---|
| Tageslimit | 14 geplante Stopps wurden rot als Fehler gespeichert | `skipped` statt `failed`; Jobs starten bei erreichtem Budget nicht |
| Neustart | Ein sauber unterbrochener Job wurde als Fehler angezeigt | `interrupted` statt `failed` |
| Kampagnenentwürfe | Dashboard-Reconcile markierte laufende KI-Erstellung nach Sekunden als fehlgeschlagen | 15 Minuten Erstellschutz; nur echte Versuche zählen |
| Gelöschte Entwürfe | Nutzerentscheidung wurde als technischer Fehler erneut eingeplant | Kampagnenziel wird `cancelled`, nicht `failed` |
| Versandprüfung | Kampagnennachrichten konnten den Sendeweg-Selbstcheck umgehen | Kampagnen nutzen dieselbe Sperre; Prüfung darf höchstens 8 Stunden alt sein |
| Browserabsturz | Eine abgestürzte Seite konnte wiederverwendet werden | Abgestürzte Seite wird verworfen und neu angelegt |
| App-Paket | Eingebettetes Chromium konnte ohne Ausführungsrecht starten (`EACCES`) | Build setzt das Recht vor der Signatur verbindlich |
| Datenbank | Alter `ON CONFLICT`-Fehler beim Lead-Import | Schema/Upsert durch Integrationstest abgesichert |
| Dashboard | Beziehungsschutz wurde als „nicht zugestellt/Systemfehler“ bezeichnet | Schutzfälle und technische Fehler werden getrennt benannt |
| Dauerhafte Jobfehler | Fehler konnten ohne kontrollierten Endzustand wiederkehren | Backoff, Dead-Letter nach drei Fehlern und manuelle Reparaturaktion |
| Festhaengende Jobs | Ein Browserjob konnte die serielle Warteschlange dauerhaft blockieren | Zentrale Zeitlimits, Browserabbruch und eigener `timed_out`-Status |
| Niedrige Annahmequote | Reduzierung lief automatisch, der Nutzen war nicht sichtbar | Warnkarte mit `3 statt 20`, bewusstem Schutzschalter und Klartextwirkung |
| Entwurfsknoepfe | Arbeitskorb und Kampagne nutzten doppelte IDs; sichtbare Knoepfe wirkten sporadisch tot | Aktionen werden an den jeweils sichtbaren Pruefbereich gebunden |
| „Jetzt pruefen" | Kommentarentwuerfe wurden gezaehlt, aber nicht direkt geoeffnet | Eigene Aufgabe und direkter Einstieg in den passenden Pruefbereich |

## Verbindliche Freigabekriterien

- [x] TypeScript-Build ohne Fehler
- [x] Komplette automatisierte Testsuite grün (69/69)
- [x] Migration an einer Kopie der echten Daten ohne verlorene Kontakte oder Nachrichten
- [x] Kein Doppelversand bei Neustart oder parallelem Prozess
- [x] Gelöschte und abgelehnte Entwürfe haben eindeutige, unterschiedliche Zustände
- [x] Tageslimits erzeugen keine roten Scheinfehler mehr
- [x] Frischer Browser-Selbstcheck nach Update; Sendeweg meldet `ok`
- [ ] Kontrollierter End-to-End-Test: Entwurf → Freigabe → bestätigter Versand → Verlauf
- [x] Neustart während laufender Entwurfserstellung auf einer Produktionskopie
- [ ] 24 Stunden interner Betrieb ohne unklassifizierten Fehler
- [ ] Neuinstallation auf einem zweiten Benutzerkonto/Mac ohne lokale Sonderkonfiguration
- [ ] Backup- und Rückrolltest der gebauten App

## Noch zwingend vor externer Freigabe

1. Einen kontrollierten echten Versand von Entwurf bis bestaetigtem LinkedIn-Verlauf pruefen.
2. Mindestens 24 Stunden internen Betrieb ohne unklassifizierten Fehler dokumentieren.
3. Neuinstallation auf einem zweiten Benutzerkonto oder Mac ohne lokale Sonderkonfiguration testen.
4. Datenbank aus einem Vor-Update-Backup wiederherstellen und die vorherige App-Version wirklich starten.
5. Mail-/Relay-Schluessel vor dem Pilotbetrieb rotieren und ausschliesslich serverseitig halten.
6. Danach einen kleinen, getrennten Pilotnutzer statt sofort einer breiten Veroeffentlichung einsetzen.

Erst wenn alle Punkte erfüllt sind, darf die Version extern verteilt werden.
