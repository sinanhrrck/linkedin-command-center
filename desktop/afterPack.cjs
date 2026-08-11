// electron-builder-Hook: signiert die fertige .app AD-HOC (Signatur "-").
// Ohne jede Signatur lehnt macOS (Apple Silicon) die App als "beschädigt" ab und ein Laie
// kommt nicht rein. Mit Ad-hoc-Signatur greift stattdessen der normale Gatekeeper-Dialog
// ("nicht verifizierter Entwickler") → Rechtsklick → Öffnen genügt, kein Terminal/xattr.
// Kostet nichts (kein Apple-Account); entfernt nur die "beschädigt"-Blockade.
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { chmodSync, existsSync } = require("node:fs");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return; // nur macOS
  const appName = context.packager.appInfo.productFilename; // "NextLead"
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  console.log(`[afterPack] Ad-hoc-Signatur für ${appPath}`);
  try {
    // Beim Entpacken aus ASAR/DMG kann das Ausführungsbit des eingebetteten Chromium-Binaries
    // verloren gehen. Dann startet die App normal, aber jede LinkedIn-Funktion endet mit EACCES.
    // Vor dem Signieren das konkrete Playwright-Binary defensiv ausführbar machen.
    const browserRoot = path.join(appPath, "Contents", "Resources", "app.asar.unpacked", "node_modules", "playwright-core", ".local-browsers");
    try {
      const result = execFileSync("find", [browserRoot, "-type", "f", "(", "-name", "chrome", "-o", "-name", "chrome-headless-shell", "-o", "-name", "ffmpeg", ")", "-print"], { encoding: "utf8" });
      for (const binary of result.split("\n").filter(Boolean)) if (existsSync(binary)) chmodSync(binary, 0o755);
    } catch (e) {
      throw new Error(`Eingebetteten Browser nicht ausführbar gemacht: ${e.message}`);
    }
    // Finder/Downloads können com.apple.provenance und Resource-Fork-Metadaten auf Assets
    // hinterlassen. codesign lehnt das gesamte Bundle dann als "detritus not allowed" ab.
    // Vor dem Signieren nur diese erweiterten Dateiattribute aus dem frisch gebauten Bundle
    // entfernen; App-Inhalte und Nutzerdaten bleiben unangetastet.
    const bereinigen = () => {
      execFileSync("xattr", ["-cr", appPath], { stdio: "inherit" });
      for (const attr of ["com.apple.FinderInfo", "com.apple.ResourceFork"]) {
        try {
          execFileSync("find", [appPath, "-exec", "xattr", "-d", attr, "{}", ";"], { stdio: "ignore" });
        } catch { /* die meisten Dateien tragen das Attribut nicht */ }
      }
    };
    bereinigen();
    // macOS 27 lässt com.apple.provenance stehen und `xattr -cr` überspringt dadurch teils
    // nachfolgende FinderInfo-Attribute. Genau diese lehnt codesign als "detritus" ab.
    // Die beiden Signatur-störenden Attribute daher zusätzlich gezielt je Bundle-Eintrag
    // entfernen; fehlende Attribute sind normal und werden ignoriert.
    const signieren = () => execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
    try {
      signieren();
    } catch {
      // Auf APFS können von Electron gerade entpackte Metadaten erst beim ersten Signatur-Lauf
      // vollständig sichtbar werden. Ein zweiter Cleanup+Signatur-Lauf ist deterministisch und
      // verhindert, dass ein ansonsten fertiges Paket an Finder-Metadaten scheitert.
      bereinigen();
      signieren();
    }
    console.log("[afterPack] Ad-hoc-Signatur gesetzt ✅");
  } catch (e) {
    console.error("[afterPack] Signatur fehlgeschlagen:", e.message);
    throw e; // Build abbrechen, damit wir es merken – lieber Fehler als "beschädigte" App
  }
};
