// Rein, ohne Profil/DB: wird auch in die Trainings-Website gebündelt (src/trainingsweb/kern.ts).
/**
 * Nachbearbeitung: Anführungszeichen weg, Gedankenstrich-Satztrenner → Komma, Emojis raus.
 * Die Emoji-Entfernung ist bewusst maschinell und nicht nur eine Prompt-Regel: die Few-Shot-
 * Beispiele stammen aus Sinans echten Nachrichten, in denen Emojis vorkamen. Selbst wenn ein
 * Modell sich davon anstecken lässt, kommt hier garantiert keins durch.
 */
export function saubern(text: string): string {
  return text
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\s[–—-]\s/g, ", ") // " – "/" — "/" - " als Satztrenner → Komma
    .replace(
      /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}]/gu,
      "",
    )
    .replace(/:\)|:-\)|;\)|:D/g, "") // Text-Smileys
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.!?])/g, "$1")
    .trim();
}
