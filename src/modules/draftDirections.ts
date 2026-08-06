export type RejectionReason = "different_approach" | "artificial" | "too_personal" | "too_salesy" | "custom";

export type DraftDirection = {
  key: string;
  title: string;
  description: string;
  instruction: string;
};

const DIRECTIONS: Record<string, DraftDirection[]> = {
  first: [
    { key: "profile_observation", title: "Profilbeobachtung", description: "Mit einem konkreten Detail starten und nur dazu eine ehrliche Frage stellen.", instruction: "Beginne mit einer konkreten Beobachtung aus dem Profil. Erzähle diesmal nichts über Sinans eigenen Werdegang. Stelle eine natürliche Frage genau zu dieser Beobachtung." },
    { key: "shared_origin", title: "Gemeinsamer Start", description: "Kurz über Sinans eigenen Bankstart Gemeinsamkeit herstellen.", instruction: "Nutze Sinans eigenen Start in der Bank als knappe Gemeinsamkeit. Der Profilbezug bleibt kurz. Frage offen nach der heutigen Erfahrung der Person." },
    { key: "future_curiosity", title: "Blick nach vorne", description: "Direkt nach Plänen oder Erwartungen für die Zeit nach Ausbildung beziehungsweise Einstieg fragen.", instruction: "Steige über die Zukunft der Person ein. Frage neugierig nach Plänen oder Erwartungen für die Zeit nach Ausbildung beziehungsweise Berufseinstieg. Keine eigene Geschichte." },
    { key: "daily_reality", title: "Echter Arbeitsalltag", description: "Den praktischen Alltag, Überraschungen oder Lernmomente in den Mittelpunkt stellen.", instruction: "Mache den realen Arbeitsalltag zum Thema. Frage nach einer Überraschung, einem Lernmoment oder dem Unterschied zwischen Erwartung und Praxis. Kein Karriere-Pitch." },
    { key: "direct_short", title: "Sehr kurz und direkt", description: "Ohne Einleitung oder Lebensgeschichte mit einer präzisen Profilfrage eröffnen.", instruction: "Schreibe maximal zwei kurze Sätze. Keine eigene Geschichte, keine Höflichkeitsfloskel. Starte direkt mit einem konkreten Profildetail und einer leicht beantwortbaren Frage." },
  ],
  message: [
    { key: "acknowledge_probe", title: "Aufgreifen und vertiefen", description: "Das Gesagte spiegeln und mit einer einzigen offenen Frage weitergehen.", instruction: "Greife den wichtigsten Gedanken der letzten Nachricht konkret auf. Vertiefe ihn mit genau einer offenen Frage. Noch keinen Lösungsvorschlag machen." },
    { key: "answer_directly", title: "Direkt antworten", description: "Die Aussage oder Frage zuerst klar beantworten, ohne sofort zurückzufragen.", instruction: "Antworte zuerst direkt und hilfreich auf das Gesagte. Stelle nur dann eine kurze Frage, wenn sie für den nächsten Schritt wirklich nötig ist." },
    { key: "share_experience", title: "Eigene Erfahrung", description: "Mit einer kurzen passenden Erfahrung Nähe schaffen, ohne das Gespräch an sich zu reißen.", instruction: "Teile eine knappe, passende Erfahrung von Sinan und gib das Gespräch danach wieder an die Person zurück. Kein Vortrag und kein Pitch." },
    { key: "clarify_choice", title: "Zwei Wege klären", description: "Die Situation als einfache Auswahl greifbar machen.", instruction: "Fasse zwei plausible Wege oder Sichtweisen knapp zusammen und frage, welcher davon näher an der Situation der Person liegt. Nicht suggestiv formulieren." },
    { key: "next_step", title: "Leichter nächster Schritt", description: "Wenn genug Interesse da ist, einen kleinen konkreten nächsten Schritt anbieten.", instruction: "Biete einen kleinen, unverbindlichen nächsten Schritt an, der direkt zum bisherigen Gespräch passt. Kein Druck und keine künstliche Verknappung." },
  ],
  followup: [
    { key: "easy_answer", title: "Leicht zu beantworten", description: "Mit einer sehr einfachen konkreten Frage die Antwortschwelle senken.", instruction: "Schreibe ein kurzes Follow-up mit einer einzigen sehr leicht beantwortbaren Frage. Kein Vorwurf und kein Hinweis darauf, dass die Person nicht geantwortet hat." },
    { key: "new_context", title: "Neuer Gesprächsanlass", description: "Einen neuen, zum Profil passenden Gedanken einbringen statt die alte Frage zu wiederholen.", instruction: "Wiederhole die vorige Frage nicht. Bringe einen neuen, zum Profil passenden Gesprächsanlass ein und bleibe bei maximal zwei Sätzen." },
    { key: "direct_check", title: "Kurzer Check-in", description: "Sachlich und freundlich fragen, ob das Thema grundsätzlich relevant ist.", instruction: "Frage knapp und ohne Druck, ob das Thema grundsätzlich relevant ist. Ein Nein muss leicht möglich sein." },
    { key: "clean_close", title: "Sauber abschließen", description: "Die Tür offenlassen und danach nicht weiter nachfassen.", instruction: "Schließe freundlich und sehr kurz ab. Sage sinngemäß, dass Sinan nicht weiter nachfasst und die Tür offen bleibt. Keine Frage." },
  ],
  reaktivierung: [
    { key: "profile_update", title: "Aktueller Profilanlass", description: "Eine sichtbare aktuelle Rolle oder Entwicklung als ehrlichen Anlass nutzen.", instruction: "Nutze ausschließlich eine konkrete aktuelle Information aus dem Profil als Gesprächsanlass. Keine Floskel über die bestehende Vernetzung." },
    { key: "industry_question", title: "Fachliche Neugier", description: "Mit einer echten Frage zu Branche, Rolle oder Ausbildung einsteigen.", instruction: "Stelle eine ehrliche, fachlich passende Frage zu Rolle, Branche oder Ausbildung. Kein Angebot und keine künstliche Gemeinsamkeit." },
    { key: "direct_reconnect", title: "Offen neu anknüpfen", description: "Kurz und transparent neu anknüpfen, ohne einen Vorwand zu erfinden.", instruction: "Knüpfe offen und knapp neu an. Erfinde keinen Anlass. Stelle eine natürliche Frage, die zum Profil passt." },
  ],
  event: [
    { key: "event_relevance", title: "Konkrete Relevanz", description: "Erklären, warum genau dieses Event zum Profil der Person passen könnte.", instruction: "Beginne mit dem konkreten Grund, warum das Event für diese Person relevant sein könnte. Danach Einladung und Link, ohne Werbesprache." },
    { key: "personal_invite", title: "Persönliche Einladung", description: "Direkt und persönlich einladen, ohne lange Einleitung.", instruction: "Formuliere eine persönliche, knappe Einladung. Kein Marketingtext, keine Übertreibung. Die Person soll frei entscheiden können." },
    { key: "topic_first", title: "Thema zuerst", description: "Mit dem Eventthema und einer passenden Frage Interesse prüfen.", instruction: "Steige über das konkrete Thema des Events ein und prüfe mit einer kurzen Frage, ob es relevant ist. Lade danach unaufdringlich ein." },
  ],
  comment: [
    { key: "add_perspective", title: "Eigene Perspektive", description: "Einen neuen Gedanken ergänzen statt den Beitrag zusammenzufassen.", instruction: "Ergänze eine eigene konkrete Perspektive. Wiederhole oder lobe den Post nicht bloß." },
    { key: "practical_example", title: "Praxisbeispiel", description: "Mit einem kurzen echten Beispiel Mehrwert geben.", instruction: "Ergänze ein kurzes praktisches Beispiel, das den Beitrag sinnvoll erweitert. Keine Eigenwerbung." },
    { key: "honest_question", title: "Ehrliche Rückfrage", description: "Eine konkrete Rückfrage stellen, die echtes Interesse zeigt.", instruction: "Stelle eine präzise Rückfrage zu einem Punkt des Posts. Keine generische Engagement-Frage." },
  ],
};

export function directionOptions(kind: string, rejectedKeys: string[] = [], count = 3): DraftDirection[] {
  const base = DIRECTIONS[kind] ?? DIRECTIONS.message;
  const rejected = new Set(rejectedKeys.filter(Boolean));
  const fresh = base.filter((item) => !rejected.has(item.key));
  return [...fresh, ...base.filter((item) => rejected.has(item.key))].slice(0, count);
}

export function feedbackInstruction(reason: RejectionReason, custom?: string): string {
  if (reason === "artificial") return "Der vorige Text klang künstlich. Schreibe deutlich natürlicher und gesprochener, ohne erkennbare Vorlage oder Dreierformel.";
  if (reason === "too_personal") return "Der vorige Text war zu persönlich. Bleibe professioneller, triff keine Annahmen über Gefühle oder Lebenslage und beziehe dich nur auf sichtbare Fakten.";
  if (reason === "too_salesy") return "Der vorige Text wirkte verkäuferisch. Entferne Angebot, Nutzenbehauptung und Druck vollständig. Führe nur ein echtes, neutrales Gespräch weiter.";
  if (reason === "custom") return `Setze dieses konkrete Nutzerfeedback verbindlich um: ${String(custom || "").trim()}`;
  return "Verwende eine vollständig andere Gesprächsrichtung, nicht nur andere Wörter.";
}

export function reasonLabel(reason: RejectionReason): string {
  return ({ different_approach: "Anderer Gesprächsansatz", artificial: "Klingt künstlich", too_personal: "Zu persönlich", too_salesy: "Zu verkäuferisch", custom: "Eigene Anweisung" })[reason];
}
