/**
 * Tools dynamiques générés depuis la base de connaissances tenant
 * (agent_configs.knowledge). Chaque entrée business devient un tool
 * LLM appelable par son `toolName` (ex: `salon_main()`, `spa_telaviv()`).
 *
 * Le LLM voit ces tools dans son tool registry et peut les appeler
 * quand un client pose une question factuelle ("vous êtes ouverts à
 * quelle heure ?", "quels services chez le spa ?"). La réponse du tool
 * = horaires + détails formatés pour la lecture orale.
 *
 * Avantage par rapport à un simple block prompt : le LLM "voit" l'info
 * comme un appel actif (donc s'en rappelle mieux dans une longue
 * conversation) et l'admin peut référencer le tool nom dans le persona
 * ("Pour les questions sur le salon principal, appelle salon_main").
 */

import { llm } from '@livekit/agents';
import { z } from 'zod';

import type { KnowledgeEntry } from '../src/types.js';

type Tool = llm.Tool;

/**
 * Sanitize le toolName pour qu'il soit un identifiant valide JS/LLM.
 * - lowercase, [a-z0-9_], lead with letter, max 60 chars
 * - vide ou invalide → null (skip cet entry)
 */
function sanitizeToolName(raw: string): string | null {
  if (!raw) return null;
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  if (!cleaned || !/^[a-z]/.test(cleaned)) return null;
  return cleaned;
}

/**
 * Build le record de tools à passer à TenantAgent. Renvoie `{}` si
 * aucune entrée valide — TenantAgent merge avec les autres tools.
 */
export function makeKnowledgeTools(
  entries: KnowledgeEntry[] | undefined,
): Record<string, Tool> {
  if (!Array.isArray(entries) || entries.length === 0) return {};

  const tools: Record<string, Tool> = {};
  const usedNames = new Set<string>();

  for (const entry of entries) {
    const name = sanitizeToolName(entry.toolName);
    if (!name || usedNames.has(name)) continue;
    usedNames.add(name);

    const businessLabel = entry.businessName || name;
    const hasHours = entry.openingHours && entry.openingHours.trim().length > 0;
    const hasDetails = entry.description && entry.description.trim().length > 0;
    if (!hasHours && !hasDetails) continue;

    tools[name] = llm.tool({
      description: `Renvoie les informations factuelles sur ${businessLabel}${
        entry.businessName ? '' : ` (ref: ${name})`
      }. À appeler quand le client pose une question sur les horaires, services, adresse, prix, ou détails de ce business. Réponds ensuite avec les infos retournées, reformulées pour l'oral.`,
      parameters: z.object({
        topic: z
          .enum(['hours', 'details', 'all'])
          .nullish()
          .describe(
            "Quelle partie de l'info récupérer : 'hours' (horaires seuls), 'details' (description seule), 'all' (tout). Défaut: all.",
          ),
      }),
      execute: async ({ topic }) => {
        const want = topic ?? 'all';
        const parts: string[] = [];
        if ((want === 'hours' || want === 'all') && hasHours) {
          parts.push(`Horaires : ${entry.openingHours}`);
        }
        if ((want === 'details' || want === 'all') && hasDetails) {
          parts.push(`Détails : ${entry.description}`);
        }
        if (parts.length === 0) {
          return `Information non disponible pour ${businessLabel}.`;
        }
        return `${businessLabel}\n\n${parts.join('\n\n')}`;
      },
    });
  }

  return tools;
}
