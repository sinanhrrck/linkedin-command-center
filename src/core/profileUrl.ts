/**
 * Eine LinkedIn-Profil-URL hat im gesamten System genau eine Schreibweise.
 * Query-Parameter, Hash, Gross-/Kleinschreibung und ein abschliessender Slash duerfen niemals
 * einen zweiten Kontakt erzeugen. Andere URLs (Messaging-Threads, Posts, Events) bleiben bis auf
 * Tracking-Parameter unangetastet.
 */
export function canonicalProfileUrl(value: string): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (!/(^|\.)linkedin\.com$/i.test(url.hostname) || !/^\/in\//i.test(url.pathname)) return raw;
    const path = url.pathname.replace(/\/+$/, "").toLowerCase();
    return `https://www.linkedin.com${path}`;
  } catch {
    return raw.split("?")[0].split("#")[0].replace(/\/+$/, "").toLowerCase();
  }
}

export function isLinkedInProfileUrl(value: string): boolean {
  return /^https?:\/\/(?:[^/]+\.)?linkedin\.com\/in\//i.test(String(value || "").trim());
}
