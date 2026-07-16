import { getContext, newPage, closeSession } from "../core/session.js";

/**
 * Einmalig ausführen: npm run login
 * Öffnet den persistenten Browser. Logg dich manuell bei LinkedIn ein
 * (inkl. 2FA). Danach bleibt die Session in ./.session erhalten.
 */
async function main() {
  // Sichtbar: hier musst DU tippen (Login + 2FA). Im Betrieb läuft der Browser versteckt.
  await getContext({ visible: true });
  const page = await newPage();
  await page.goto("https://www.linkedin.com/login");
  console.info("→ Bitte im geöffneten Browser einloggen. Fenster offen lassen, bis du fertig bist.");
  console.info("→ Danach dieses Terminal mit STRG+C beenden. Die Session ist dann gespeichert.");
  // Prozess offen halten
  await new Promise(() => {});
}

main().catch(async (e) => {
  console.error(e);
  await closeSession();
  process.exit(1);
});
