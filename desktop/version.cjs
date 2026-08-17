/**
 * VERSIONSVERGLEICH FÜR DEN UPDATE-CHECK.
 *
 * Bewusst eine eigene Datei: `main.cjs` lädt Electron beim Import und ist damit nicht testbar.
 * Diese Funktion hat wochenlang still falsch gearbeitet (siehe unten) – sie braucht Tests.
 *
 * FEHLER, GEFUNDEN AM 2026-08-17: Der alte Vergleich war ein reiner Zahlen-Split über ".".
 * Bei "0.8.0-beta.7" ergibt das ["0","8","0-beta","7"], und `Number("0-beta")` ist NaN. Ein
 * Vergleich gegen NaN ist immer falsch, also meldete die App nie ein Update. Zusammen mit dem
 * zweiten Fehler (`/releases/latest` blendet Vorabversionen aus und lieferte v0.3.0) hat die
 * In-App-Aktualisierung für JEDE Beta-Version nie funktioniert – der Nutzer sah dauerhaft eine
 * veraltete App und vermutete den Fehler im Anwendungscode.
 */

/** "v0.8.0-beta.7" → { kern: [0,8,0], vor: ["beta","7"] } */
function teile(version) {
  const roh = String(version || "").trim().replace(/^v/i, "");
  const [kern, ...rest] = roh.split("-");
  return {
    kern: kern.split(".").map((n) => Number(n) || 0),
    vor: rest.join("-") ? rest.join("-").split(".") : [],
  };
}

/**
 * Ist `a` neuer als `b`? Folgt der Semver-Rangfolge: erst die Zahlen, dann gilt eine
 * Vorabversion als ÄLTER als die fertige Fassung (0.8.0-beta.8 < 0.8.0).
 */
function istNeuer(a, b) {
  const A = teile(a);
  const B = teile(b);
  for (let i = 0; i < Math.max(A.kern.length, B.kern.length); i++) {
    const d = (A.kern[i] || 0) - (B.kern[i] || 0);
    if (d !== 0) return d > 0;
  }
  if (!A.vor.length && !B.vor.length) return false;
  if (!A.vor.length) return true;  // fertige Fassung schlägt Vorabversion
  if (!B.vor.length) return false;
  for (let i = 0; i < Math.max(A.vor.length, B.vor.length); i++) {
    const x = A.vor[i];
    const y = B.vor[i];
    if (x === undefined) return false; // "beta" < "beta.1": weniger Teile = älter
    if (y === undefined) return true;
    const nx = Number(x);
    const ny = Number(y);
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
      if (nx !== ny) return nx > ny;
      continue;
    }
    if (x !== y) return x > y;
  }
  return false;
}

/**
 * Wählt aus der Release-Liste die Fassung, gegen die verglichen wird.
 *
 * NICHT `/releases/latest` verwenden: GitHub blendet dort Vorabversionen grundsätzlich aus.
 * Alle Beta-Releases dieses Projekts sind `prerelease: true`, deshalb lieferte der Endpunkt
 * das uralte v0.3.0. Entwürfe bleiben aussen vor – die haben noch keine fertigen Dateien.
 */
function neuestesRelease(releases) {
  if (!Array.isArray(releases)) return null;
  const brauchbar = releases.filter((r) => r && !r.draft && r.tag_name);
  if (!brauchbar.length) return null;
  return brauchbar.reduce((best, r) => (istNeuer(r.tag_name, best.tag_name) ? r : best), brauchbar[0]);
}

module.exports = { istNeuer, neuestesRelease, teile };
