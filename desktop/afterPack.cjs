// electron-builder-Hook: signiert die fertige .app AD-HOC (Signatur "-").
// Ohne jede Signatur lehnt macOS (Apple Silicon) die App als "beschädigt" ab und ein Laie
// kommt nicht rein. Mit Ad-hoc-Signatur greift stattdessen der normale Gatekeeper-Dialog
// ("nicht verifizierter Entwickler") → Rechtsklick → Öffnen genügt, kein Terminal/xattr.
// Kostet nichts (kein Apple-Account); entfernt nur die "beschädigt"-Blockade.
const { execSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return; // nur macOS
  const appName = context.packager.appInfo.productFilename; // "NextLead"
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  console.log(`[afterPack] Ad-hoc-Signatur für ${appPath}`);
  try {
    execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: "inherit" });
    console.log("[afterPack] Ad-hoc-Signatur gesetzt ✅");
  } catch (e) {
    console.error("[afterPack] Signatur fehlgeschlagen:", e.message);
    throw e; // Build abbrechen, damit wir es merken – lieber Fehler als "beschädigte" App
  }
};
