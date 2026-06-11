/**
 * Helpers d'extraction de texte depuis les structures ChatMessage du SDK
 * LiveKit Agents (mode Realtime).
 */

/**
 * Extrait le texte brut d'une entrée `content[]` de ChatMessage. Les
 * modèles Realtime émettent des objets comme `{ type: 'audio',
 * transcript: '...' }` ou `{ type: 'text', text: '...' }` plutôt que des
 * strings — on sonde les champs usuels (`transcript`, `text`, `content`),
 * récursivement sur les arrays, avant d'abandonner.
 *
 * Fonction pure, ne throw jamais. Renvoie `''` si rien d'extractible.
 */
export const extractText = (content: unknown): string => {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(extractText).filter(Boolean).join(' ').trim();
  }
  if (typeof content === 'object') {
    const obj = content as Record<string, unknown>;
    for (const key of ['transcript', 'text', 'content']) {
      const v = obj[key];
      if (typeof v === 'string' && v.trim()) return v;
      if (Array.isArray(v)) {
        const joined = extractText(v);
        if (joined) return joined;
      }
    }
  }
  return '';
};
