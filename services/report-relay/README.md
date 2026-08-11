# NextLead Report Relay

Dieser kleine öffentliche Dienst nimmt bewusst abgesendete NextLead-Fehlerberichte und Feedback
entgegen und sendet sie ausschließlich an `sinan.harrack@koenigswege.com`. Der Resend-Schlüssel
bleibt auf dem Server und wird niemals mit der Desktop-App ausgeliefert.

Benötigte Umgebungsvariablen:

```text
RESEND_API_KEY=...
REPORT_TO=sinan.harrack@koenigswege.com
REPORT_FROM=NextLead Meldungen <meldungen@koenigswege.com>
PORT=8787
```

Der öffentliche Dienst läuft unter der eigenständigen NextLead-Adresse
`https://nextlead-report-relay.siharrack.chatgpt.site/api/nextlead-report`. Die App wird ausschließlich
über `NEXTLEAD_REPORT_ENDPOINT` auf genau diese Adresse gesetzt. Aus der Domain der Empfängeradresse
wird niemals ein technischer Endpunkt abgeleitet.
