// electron-builder-Hook: signiert die fertige .app AD-HOC (Signatur "-").
// Ohne jede Signatur lehnt macOS (Apple Silicon) die App als "beschädigt" ab und ein Laie
// kommt nicht rein. Mit Ad-hoc-Signatur greift stattdessen der normale Gatekeeper-Dialog
// ("nicht verifizierter Entwickler") → Rechtsklick → Öffnen genügt, kein Terminal/xattr.
// Kostet nichts (kein Apple-Account); entfernt nur die "beschädigt"-Blockade.
const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return; // nur macOS
  const appName = context.packager.appInfo.productFilename; // "NextLead"
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  console.log(`[afterPack] Ad-hoc-Signatur für ${appPath}`);
  try {
    // Finder/Downloads können com.apple.provenance und Resource-Fork-Metadaten auf Assets
    // hinterlassen. codesign lehnt das gesamte Bundle dann als "detritus not allowed" ab.
    // Vor dem Signieren nur diese erweiterten Dateiattribute aus dem frisch gebauten Bundle
    // entfernen; App-Inhalte und Nutzerdaten bleiben unangetastet.
    execFileSync("xattr", ["-cr", appPath], { stdio: "inherit" });
    const signieren = () => execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
    try {
      signieren();
    } catch {
      // Auf APFS können von Electron gerade entpackte Metadaten erst beim ersten Signatur-Lauf
      // vollständig sichtbar werden. Ein zweiter Cleanup+Signatur-Lauf ist deterministisch und
      // verhindert, dass ein ansonsten fertiges Paket an Finder-Metadaten scheitert.
      execFileSync("xattr", ["-cr", appPath], { stdio: "inherit" });
      signieren();
    }
    console.log("[afterPack] Ad-hoc-Signatur gesetzt ✅");
  } catch (e) {
    console.error("[afterPack] Signatur fehlgeschlagen:", e.message);
    throw e; // Build abbrechen, damit wir es merken – lieber Fehler als "beschädigte" App
  }
};
