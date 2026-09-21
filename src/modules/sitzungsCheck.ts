import { newPage, guardAgainstCheckpoint } from "../core/session.js";
import { governor } from "../core/safetyGovernor.js";
import { setState } from "../db/index.js";

/**
 * SITZUNGSPRÜFUNG BEIM START (Server-Modus). Auf einem Server kann niemand ein Login-Fenster
 * öffnen; eine ungültige oder abgelaufene Sitzung muss deshalb SAUBER in die Pause führen, nicht
 * in eine Schleife aus Fehlversuchen. Rein lesend: ein Aufruf des Feeds, kein Governor nötig.
 * Ergebnis landet in `linkedin_connected` (Dashboard) und ggf. als Pause-Grund im Governor.
 */
const NICHT_EINGELOGGT = /\/login|\/checkpoint|\/authwall|\/uas\//i;

export async function pruefeSitzungBeimStart(): Promise<boolean> {
  try {
    const page = await newPage();
    await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded", timeout: 45_000 });
    const url = page.url();
    if (NICHT_EINGELOGGT.test(url)) {
      const grund = url.includes("/checkpoint") ? "LinkedIn-Checkpoint" : "Sitzung ungültig/abgelaufen";
      governor.pause(`${grund} – Sitzung am Mac neu exportieren (npm run umzug -- export --nur-sitzung) und auf dem Server importieren`);
      setState("linkedin_connected", "0");
      console.error(`[sitzung] ${grund} (URL: ${url}). Governor pausiert. Siehe MIGRATION.md → „Wenn die Sitzung abgelaufen ist“.`);
      return false;
    }
    if (await guardAgainstCheckpoint(page)) {
      setState("linkedin_connected", "0");
      return false;
    }
    setState("linkedin_connected", "1");
    console.info("[sitzung] Eingeloggt – Sitzung gültig.");
    return true;
  } catch (e) {
    // Netzfehler o.ä.: nicht pausieren (das wäre ein falscher Alarm), aber ehrlich melden.
    console.warn("[sitzung] Prüfung nicht möglich:", (e as Error)?.message?.slice(0, 160));
    return false;
  }
}
