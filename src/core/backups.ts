import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { config } from "../config.js";
import { db, getState, setState } from "../db/index.js";

const KEEP = 21;
const backupDir = () => join(dirname(resolve(config.paths.dbPath)), "backups");
const dayKey = () => new Date().toISOString().slice(0, 10);
const isBackupName = (name: string) => /^nextlead-\d{8}-\d{6}-\d{3}\.sqlite$/.test(name);

export type BackupStatus = {
  directory: string;
  count: number;
  latestAt: string | null;
  latestSize: number | null;
  lastError: string | null;
};

/** Erzeugt einen konsistenten SQLite-Snapshot. Die Backup-API berücksichtigt WAL korrekt. */
export async function createDatabaseBackup(reason: "daily" | "manual" = "manual") {
  const dir = backupDir();
  mkdirSync(dir, { recursive: true });
  const now = new Date();
  const compact = now.toISOString().replace(/[-:TZ.]/g, "").slice(0, 17);
  const stamp = `${compact.slice(0, 8)}-${compact.slice(8, 14)}-${compact.slice(14)}`;
  const destination = join(dir, `nextlead-${stamp}.sqlite`);
  try {
    await db.backup(destination);
    const size = statSync(destination).size;
    if (size < 1024) throw new Error("Backup ist unerwartet klein.");
    setState("last_backup_at", now.toISOString());
    setState("last_backup_path", destination);
    setState("last_backup_error", "");
    setState("backup_day", dayKey());
    pruneBackups(dir);
    console.info(`[backup] ${reason}: ${destination}`);
    return { ok: true, path: destination, size };
  } catch (error) {
    const message = (error as Error)?.message?.slice(0, 180) || "Unbekannter Backup-Fehler";
    setState("last_backup_error", message);
    console.error(`[backup] ${reason} fehlgeschlagen: ${message}`);
    return { ok: false, error: message };
  }
}

/** Maximal ein automatisches Backup pro UTC-Tag; manuelle Sicherungen bleiben jederzeit möglich. */
export async function ensureDailyBackup() {
  if (getState("backup_day") === dayKey()) return { ok: true, skipped: true };
  return createDatabaseBackup("daily");
}

export function getBackupStatus(): BackupStatus {
  const dir = backupDir();
  let files: Array<{ name: string; mtimeMs: number; size: number }> = [];
  try {
    if (existsSync(dir)) files = readdirSync(dir)
      .filter(isBackupName)
      .map((name) => ({ name, mtimeMs: statSync(join(dir, name)).mtimeMs, size: statSync(join(dir, name)).size }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    // Diagnose bleibt verfügbar, auch wenn ein externer Prozess gerade am Ordner arbeitet.
  }
  const latest = files[0];
  return {
    directory: dir,
    count: files.length,
    latestAt: getState("last_backup_at") || (latest ? new Date(latest.mtimeMs).toISOString() : null),
    latestSize: latest?.size ?? null,
    lastError: getState("last_backup_error") || null,
  };
}

/** Nur eindeutig selbst erzeugte, alte Backup-Dateien entfernen – nie fremde Dateien im Ordner. */
function pruneBackups(dir: string) {
  const old = readdirSync(dir)
    .filter(isBackupName)
    .map((name) => ({ name, mtimeMs: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(KEEP);
  for (const file of old) unlinkSync(join(dir, file.name));
}
