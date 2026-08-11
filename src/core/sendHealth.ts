import { getState } from "../db/index.js";

export type SendHealthStatus = "ok" | "broken" | "stale" | "unknown";

/** Der Sendeweg muss regelmäßig frisch und vollständig geprüft worden sein. */
export function sendHealthStand(now = new Date(), maxAgeHours = 8): { status: SendHealthStatus; reason: string | null; checkedAt: string | null } {
  const raw = getState("send_health");
  const checkedAt = getState("send_health_ts") || null;
  if (raw === "broken") return { status: "broken", reason: getState("send_health_grund") || "Sendeweg gestört", checkedAt };
  if (raw !== "ok" || !checkedAt) return { status: "unknown", reason: "Sendeweg wurde noch nicht geprüft", checkedAt };
  const checked = new Date(checkedAt).getTime();
  if (!Number.isFinite(checked) || now.getTime() - checked > maxAgeHours * 60 * 60 * 1000)
    return { status: "stale", reason: "Letzte Sendeweg-Prüfung ist älter als 8 Stunden", checkedAt };
  return { status: "ok", reason: null, checkedAt };
}
