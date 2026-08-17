import { db } from "../db/index.js";
import { config } from "../config.js";
import { canonicalProfileUrl } from "./profileUrl.js";

/**
 * LESE-BUDGET — die Sicherung, die am 2026-08-05 gefehlt hat.
 *
 * Der Safety Governor deckelt ausschließlich SENDENDE Aktionen (connect/message/comment).
 * Das ABRUFEN von Seiten war völlig ungedeckelt: Profile beim Vernetzen und Schreiben,
 * Suchergebnisse beim Lead-Sammeln, Konversationen beim Postfach-Scan. An diesem Tag lud
 * ein einziger Postfach-Lauf 240 Konversationen und öffnete bis zu 100 davon einzeln –
 * ohne dass irgendeine Grenze angeschlagen hätte. LinkedIn hat daraufhin das Konto gesperrt,
 * mit exakt dieser Begründung: "große Menge an LinkedIn Profildaten abgerufen".
 *
 * Die Sendezahlen waren dabei unauffällig. Gedeckelt war also genau das Falsche.
 *
 * Dieses Modul zählt jeden Seitenaufruf gegen LinkedIn und stoppt, wenn das Tagesbudget
 * erschöpft ist. Erfassung passiert AUTOMATISCH in core/session.ts (Navigations-Ereignis),
 * damit sie nicht vergessen werden kann, wenn später neuer Code hinzukommt.
 */

export type LeseArt = "profil" | "seite";

/** Profile wiegen schwerer: Sie sind das, was LinkedIn ausdrücklich zählt und benennt. */
export function leseArt(url: string): LeseArt {
  return /linkedin\.com\/in\//i.test(url) ? "profil" : "seite";
}

const TYP: Record<LeseArt, string> = { profil: "profileView", seite: "pageRead" };

/**
 * ZWEI PROTOKOLLZEILEN SIND NICHT ZWEI ABRUFE (Sinan 2026-08-17).
 *
 * Gezählt wird am Navigations-Ereignis (`framenavigated` in session.ts). LinkedIn leitet
 * `/in/name` aber auf die kanonische Form `/in/name/` um – die Weiterleitung feuert das
 * Ereignis ein zweites Mal. Real gemessen am 17.08.: 60 Protokollzeilen für exakt 30 Profile,
 * jeweils im selben Sekundentakt. Das Budget war also nach 30 statt nach 60 Profilen erschöpft
 * und der Bot stand mittags. Bei Seiten dasselbe (113 Zeilen, 72 Seiten).
 *
 * Bewusst hier korrigiert und NICHT beim Schreiben: `actions` ist das unveränderliche Safety-
 * Protokoll und soll jede Navigation festhalten. Das BUDGET fragt aber, wie viele verschiedene
 * Profile abgerufen wurden – und genau das hat LinkedIn bei der Sperre moniert.
 *
 * Die Caps bleiben unangetastet (60/120). Der Bot bekommt keine höhere Grenze, sondern die
 * Grenze, die immer gemeint war.
 */
function schluessel(target: string, art: LeseArt): string {
  const raw = String(target || "").trim();
  if (!raw) return "";
  if (art === "profil") return canonicalProfileUrl(raw);
  try {
    const url = new URL(raw);
    // Query bleibt erhalten: Suchseite 2 ist eine andere Seite als Suchseite 1.
    return `${url.hostname.toLowerCase()}${url.pathname.replace(/\/+$/, "").toLowerCase()}${url.search}`;
  } catch {
    return raw.split("#")[0].replace(/\/+$/, "").toLowerCase();
  }
}

function heute(type: string, art: LeseArt): number {
  const rows = db
    .prepare("SELECT id,target FROM actions WHERE type=? AND date(created_at,'localtime')=date('now','localtime')")
    .all(type) as Array<{ id: number; target: string | null }>;
  const gesehen = new Set<string>();
  // Ohne Ziel lässt sich nichts zusammenfassen – solche Zeilen zählen einzeln, nie gebündelt.
  for (const row of rows) gesehen.add(schluessel(row.target ?? "", art) || `#${row.id}`);
  return gesehen.size;
}

/** Zählt einen Abruf. Bewusst OHNE Governor-Event: sonst meldet Telegram jeden Seitenaufruf. */
export function zaehleAbruf(url: string): void {
  const art = leseArt(url);
  db.prepare("INSERT INTO actions(type,target) VALUES(?,?)").run(TYP[art], url.slice(0, 300));
}

export type LeseStand = {
  profile: { heute: number; cap: number };
  seiten: { heute: number; cap: number };
  erschoepft: boolean;
  grund: string | null;
};

export function leseStand(): LeseStand {
  const profile = heute(TYP.profil, "profil");
  const seiten = heute(TYP.seite, "seite");
  const capProfil = config.safety.dailyCaps.profileView;
  const capSeite = config.safety.dailyCaps.pageRead;
  const grund = profile >= capProfil
    ? `Tagesbudget für Profilaufrufe erreicht (${profile}/${capProfil})`
    : seiten >= capSeite
      ? `Tagesbudget für Seitenaufrufe erreicht (${seiten}/${capSeite})`
      : null;
  return {
    profile: { heute: profile, cap: capProfil },
    seiten: { heute: seiten, cap: capSeite },
    erschoepft: !!grund,
    grund,
  };
}

/** Fehler beim Überschreiten. Eigene Klasse, damit Aufrufer sie von echten Pannen unterscheiden. */
export class LeseBudgetErschoepft extends Error {
  constructor(grund: string) {
    super(grund);
    this.name = "LeseBudgetErschoepft";
  }
}

/**
 * Wird vor JEDEM Seitenzugriff geprüft (core/session.ts → newPage). Ist das Budget aufgebraucht,
 * bekommt kein Job mehr eine Seite und bricht sauber ab – statt weiterzulesen, bis LinkedIn eingreift.
 */
export function pruefeLeseBudget(): void {
  const stand = leseStand();
  if (stand.erschoepft) throw new LeseBudgetErschoepft(stand.grund!);
}
