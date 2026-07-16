import { db } from "../db/index.js";
import { newPage, closeSession } from "../core/session.js";
import { humanDelay } from "../core/humanize.js";

const c = db.prepare("SELECT profile_url, full_name FROM contacts WHERE status='new' LIMIT 1").get() as { profile_url: string; full_name: string };
console.info("Profil:", c.full_name, c.profile_url);

const page = await newPage();
await page.goto(c.profile_url, { waitUntil: "domcontentloaded" });
await humanDelay(3000, 4000);

// Sichtbare Buttons im oberen Aktionsbereich
const buttons = await page.evaluate(() => {
  const btns = Array.from(document.querySelectorAll("button, a"))
    .filter((el) => (el as HTMLElement).offsetParent !== null)
    .map((el) => ({
      tag: el.tagName.toLowerCase(),
      text: (el as HTMLElement).innerText?.trim().slice(0, 30) || "",
      aria: el.getAttribute("aria-label")?.slice(0, 50) || "",
    }))
    .filter((b) => /vernetzen|connect|mehr|more|folgen|follow|nachricht|message|ausstehend|pending/i.test(b.text + " " + b.aria));
  return btns.slice(0, 15);
});
console.info("\n=== Relevante Buttons ===");
buttons.forEach((b) => console.info(`  <${b.tag}> text="${b.text}" aria="${b.aria}"`));

// Test: greift der aktuelle Selektor?
const cur = await page.locator('button:has-text("Vernetzen"), button:has-text("Connect")').count();
console.info(`\nAktueller Selektor 'button:has-text(Vernetzen/Connect)' → ${cur} Treffer`);

await closeSession();
process.exit(0);
