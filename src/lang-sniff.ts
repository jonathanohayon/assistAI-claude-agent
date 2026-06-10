/**
 * Détection cheap de la langue dominante d'un texte par comptage de
 * charset (hébreu vs latin). Sert :
 *   - au log `[lang_sniff]` (vérifier après coup que les tours hébreux
 *     sont transcrits en hébreu, pas en charabia français)
 *   - au language-enforcement (`onUserTurnCompleted` injecte une directive
 *     système quand la langue user change de tour en tour)
 *
 * NOTE unification (2026-06) : les deux call sites de agent.ts avaient
 * des variantes légèrement différentes ; on a retenu la plus STRICTE
 * (`hebrewChars > latinChars && hebrewChars > 0`) pour les deux.
 */

/**
 * Renvoie `'he'` si le texte est majoritairement en caractères hébreux,
 * `'lat'` si majoritairement latin, `null` si aucun caractère alphabétique
 * détecté (chiffres seuls, ponctuation, vide).
 */
export function sniffLang(text: string): 'he' | 'lat' | null {
  const hebrewChars = (text.match(/[֐-׿]/g) ?? []).length;
  const latinChars = (text.match(/[A-Za-zÀ-ÿ]/g) ?? []).length;
  if (hebrewChars > latinChars && hebrewChars > 0) return 'he';
  if (latinChars > 0) return 'lat';
  return null;
}
