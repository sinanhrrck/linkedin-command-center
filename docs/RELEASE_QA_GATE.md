# NextLead Release-QA

Status: **Nicht zur externen Veröffentlichung freigegeben.**

## Aktuelle Fehleraufnahme (11.08.2026)

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

## Verbindliche Freigabekriterien

- [x] TypeScript-Build ohne Fehler
- [x] Komplette automatisierte Testsuite grün (61/61)
- [x] Migration an einer Kopie der echten Daten ohne verlorene Kontakte oder Nachrichten
- [x] Kein Doppelversand bei Neustart oder parallelem Prozess
- [x] Gelöschte und abgelehnte Entwürfe haben eindeutige, unterschiedliche Zustände
- [x] Tageslimits erzeugen keine roten Scheinfehler mehr
- [ ] Frischer Browser-Selbstcheck nach Rücksetzung des heutigen Lesebudgets
- [ ] Kontrollierter End-to-End-Test: Entwurf → Freigabe → bestätigter Versand → Verlauf
- [x] Neustart während laufender Entwurfserstellung auf einer Produktionskopie
- [ ] 24 Stunden interner Betrieb ohne unklassifizierten Fehler
- [ ] Neuinstallation auf einem zweiten Benutzerkonto/Mac ohne lokale Sonderkonfiguration
- [ ] Backup- und Rückrolltest der gebauten App

Erst wenn alle Punkte erfüllt sind, darf die Version extern verteilt werden.
