import { getContext, newPage, closeSession } from "../core/session.js";

/**
 * Prüft versteckt, ob die gespeicherte LinkedIn-Session eingeloggt ist.
 * Exit 0 = eingeloggt, Exit 1 = nicht (Login/Checkpoint/Authwall oder Fehler).
 * Wird vom Setup-Assistenten aufgerufen (crmServer → /api/setup/verify-login), nachdem das
 * sichtbare Login-Fenster geschlossen wurde (der persistente Kontext erlaubt nur EINEN Browser).
 */
async function main() {
  await getContext(); // versteckt (embedded)
  const page = await newPage();
  await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded", timeout: 30_000 });
  const url = page.url();
  const eingeloggt = !/\/login|\/checkpoint|\/authwall|\/uas\//i.test(url);
  console.info(eingeloggt ? "eingeloggt" : `nicht eingeloggt (URL: ${url})`);
  await closeSession();
  process.exit(eingeloggt ? 0 : 1);
}

main().catch(async (e) => {
  console.error("Login-Prüfung fehlgeschlagen:", (e as Error)?.message?.slice(0, 120));
  await closeSession().catch(() => {});
  process.exit(1);
});
