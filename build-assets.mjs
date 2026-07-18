// Kopiert Nicht-TS-Dateien nach dist/, damit die kompilierte App ohne src/ läuft.
import { cpSync, mkdirSync } from "node:fs";
mkdirSync("dist/db", { recursive: true });
cpSync("src/db/schema.sql", "dist/db/schema.sql");
cpSync("src/web", "dist/web", { recursive: true });
console.log("[build] Assets (schema.sql, web/) nach dist/ kopiert.");
