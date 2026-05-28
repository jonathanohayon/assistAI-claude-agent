/**
 * Tools structurés depuis `agent_configs.business` (jsonb tenant).
 * Remplace `tools/knowledge.ts` (one-tool-per-business legacy).
 *
 * Expose 5 tools fixes au LLM :
 *   - list_centres()                              → liste centres + addresses
 *   - get_centre_info(centreId)                   → adresse + résumé hebdo
 *   - get_opening_hours(centreId, day?|isoDate?)  → horaires d'un jour
 *   - list_services(centreId?)                    → services dispo
 *   - find_service(query, centreId?)              → recherche textuelle
 *
 * Les tools sont enregistrés SEULEMENT si la config business contient
 * au moins une donnée — sinon makeBusinessTools renvoie {} et le LLM
 * ne voit aucun tool business (évite hallucinations).
 */

import { llm } from '@livekit/agents';
import { z } from 'zod';

type Tool = llm.Tool;

type WeekDay = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
type DayHours = { open: boolean; openTime: string; closeTime: string };

interface BusinessCentre {
  id: string;
  name: string;
  address: string;
  hours: Record<WeekDay, DayHours>;
}

interface BusinessService {
  id: string;
  name: string;
  durationMinutes: number;
  priceILS: number;
  centreIds: string[] | 'all';
  description: string;
}

export interface BusinessConfig {
  identity: { name: string; tagline: string; email: string };
  centres: BusinessCentre[];
  services: BusinessService[];
}

const DAY_LABELS_FR: Record<WeekDay, string> = {
  sun: 'dimanche',
  mon: 'lundi',
  tue: 'mardi',
  wed: 'mercredi',
  thu: 'jeudi',
  fri: 'vendredi',
  sat: 'samedi',
};

const ORDERED_DAYS: WeekDay[] = [
  'sun',
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
];

// "YYYY-MM-DD" → WeekDay code. Asia/Jerusalem n'a pas d'impact ici car
// on parse le ISO comme un jour calendaire pur (la date string suffit).
const isoDateToWeekDay = (iso: string): WeekDay | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  // getUTCDay : 0=Sunday, 1=Monday, …
  return ORDERED_DAYS[d.getUTCDay()] ?? null;
};

const formatCentreHoursSummary = (c: BusinessCentre): string => {
  const lines: string[] = [];
  for (const d of ORDERED_DAYS) {
    const dh = c.hours?.[d];
    if (!dh || !dh.open) lines.push(`${DAY_LABELS_FR[d]} : fermé`);
    else lines.push(`${DAY_LABELS_FR[d]} : ${dh.openTime}–${dh.closeTime}`);
  }
  return lines.join(' · ');
};

const findCentre = (
  business: BusinessConfig,
  centreId: string,
): BusinessCentre | null => {
  const exact = business.centres.find((c) => c.id === centreId);
  if (exact) return exact;
  // Fallback : match insensible par nom (le LLM peut passer "Jerusalem"
  // au lieu de l'id `ctr_xyz`). Best-effort.
  const lower = centreId.toLowerCase().trim();
  return (
    business.centres.find((c) => c.name.toLowerCase() === lower) ??
    business.centres.find((c) => c.name.toLowerCase().includes(lower)) ??
    null
  );
};

const servicesForCentre = (
  business: BusinessConfig,
  centreId?: string | null,
): BusinessService[] => {
  if (!centreId) return business.services;
  const c = findCentre(business, centreId);
  const resolvedId = c?.id ?? centreId;
  return business.services.filter(
    (s) =>
      s.centreIds === 'all' ||
      (Array.isArray(s.centreIds) && s.centreIds.includes(resolvedId)),
  );
};

const formatService = (s: BusinessService, business: BusinessConfig): string => {
  const where =
    s.centreIds === 'all'
      ? 'tous les centres'
      : s.centreIds
          .map((id) => business.centres.find((c) => c.id === id)?.name ?? id)
          .join(', ') || '(aucun centre)';
  return `${s.name} — ${s.durationMinutes} min, ${s.priceILS} ₪ (dispo à ${where})${s.description ? ` — ${s.description}` : ''}`;
};

export function makeBusinessTools(
  business?: BusinessConfig,
): Record<string, Tool> {
  if (!business) return {};
  const hasCentres = business.centres.length > 0;
  const hasServices = business.services.length > 0;
  if (!hasCentres && !hasServices) return {};

  const tools: Record<string, Tool> = {};

  if (hasCentres) {
    tools['list_centres'] = llm.tool({
      description:
        "Liste tous les centres du business du tenant avec leurs ids, noms et addresses. Appelle ce tool pour aiguiller le client vers le bon centre ou avant d'appeler get_centre_info / get_opening_hours.",
      parameters: z.object({}),
      execute: async () => {
        if (business.centres.length === 0) {
          return 'Aucun centre défini pour ce tenant.';
        }
        const lines = business.centres.map(
          (c, i) =>
            `${i + 1}. ${c.name} (id: \`${c.id}\`)${c.address ? ` — ${c.address}` : ''}`,
        );
        return `Centres disponibles :\n${lines.join('\n')}`;
      },
    });

    tools['get_centre_info'] = llm.tool({
      description:
        "Renvoie l'adresse complète + résumé des horaires hebdo d'un centre. Le centreId est l'id retourné par list_centres ; tu peux aussi passer le nom du centre, le tool fera le match insensible à la casse.",
      parameters: z.object({
        centreId: z
          .string()
          .describe("L'id du centre (ex: ctr_abc) OU le nom (ex: 'Jerusalem')."),
      }),
      execute: async ({ centreId }) => {
        const c = findCentre(business, centreId);
        if (!c) return `Centre introuvable : "${centreId}". Appelle list_centres pour voir les centres disponibles.`;
        const addrLine = c.address ? `Adresse : ${c.address}.` : '';
        const hours = formatCentreHoursSummary(c);
        return [`Centre ${c.name} (id: ${c.id}).`, addrLine, `Horaires : ${hours}`]
          .filter(Boolean)
          .join('\n');
      },
    });

    tools['get_opening_hours'] = llm.tool({
      description:
        "Renvoie les horaires d'un centre pour UN JOUR donné. Tu peux passer soit un day code (mon/tue/wed/thu/fri/sat/sun), soit un isoDate au format YYYY-MM-DD (le tool calcule le jour de la semaine). Si rien n'est fourni → renvoie tous les jours.",
      parameters: z.object({
        centreId: z.string().describe("Id du centre (ou nom)."),
        day: z
          .enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])
          .nullish()
          .describe("Code jour de la semaine (3 lettres)."),
        isoDate: z
          .string()
          .nullish()
          .describe(
            "Date YYYY-MM-DD (ex: 2026-06-03). Si fourni, le tool en déduit le jour de la semaine.",
          ),
      }),
      execute: async ({ centreId, day, isoDate }) => {
        const c = findCentre(business, centreId);
        if (!c) return `Centre introuvable : "${centreId}".`;
        let resolvedDay: WeekDay | null = (day as WeekDay) ?? null;
        if (!resolvedDay && isoDate) resolvedDay = isoDateToWeekDay(isoDate);
        if (!resolvedDay) {
          // Pas de jour → renvoie tout le hebdo
          return `Horaires de ${c.name} :\n${formatCentreHoursSummary(c)}`;
        }
        const dh = c.hours?.[resolvedDay];
        if (!dh || !dh.open) {
          return `${c.name} est FERMÉ le ${DAY_LABELS_FR[resolvedDay]}${isoDate ? ` (date demandée : ${isoDate})` : ''}.`;
        }
        return `${c.name} est OUVERT le ${DAY_LABELS_FR[resolvedDay]}${isoDate ? ` (${isoDate})` : ''} de ${dh.openTime} à ${dh.closeTime}.`;
      },
    });
  }

  if (hasServices) {
    tools['list_services'] = llm.tool({
      description:
        "Liste les soins / prestations dispo (nom, durée, prix). Tu peux filtrer par centre via centreId, sinon tout le catalogue est renvoyé. Utilise ce tool quand le client demande 'qu'est-ce que vous proposez', 'quels services', etc.",
      parameters: z.object({
        centreId: z
          .string()
          .nullish()
          .describe("Optionnel — filtre les services dispo à ce centre."),
      }),
      execute: async ({ centreId }) => {
        const matched = servicesForCentre(business, centreId);
        if (matched.length === 0) {
          return centreId
            ? `Aucun soin disponible pour ce centre.`
            : `Aucun soin défini.`;
        }
        const lines = matched.map(
          (s, i) => `${i + 1}. ${formatService(s, business)}`,
        );
        return `Soins disponibles${centreId ? ` (centre ${centreId})` : ''} :\n${lines.join('\n')}`;
      },
    });

    tools['find_service'] = llm.tool({
      description:
        "Recherche textuelle floue dans les noms et descriptions de soins. Use case : le client dit 'je veux un massage' ou 'lifting', tu cherches le soin correspondant pour confirmer prix/durée avant de proposer.",
      parameters: z.object({
        query: z.string().describe("Texte de recherche (insensible à la casse, partial match)."),
        centreId: z
          .string()
          .nullish()
          .describe("Optionnel — restreint la recherche à ce centre."),
      }),
      execute: async ({ query, centreId }) => {
        const pool = servicesForCentre(business, centreId);
        const q = query.toLowerCase().trim();
        if (!q) return 'Query vide — précise un mot-clé.';
        const matches = pool.filter(
          (s) =>
            s.name.toLowerCase().includes(q) ||
            s.description.toLowerCase().includes(q),
        );
        if (matches.length === 0) {
          return `Aucun soin ne matche "${query}"${centreId ? ` au centre ${centreId}` : ''}. Appelle list_services pour voir tout le catalogue.`;
        }
        const lines = matches.map((s) => formatService(s, business));
        return `${matches.length} soin(s) trouvé(s) pour "${query}" :\n${lines.join('\n')}`;
      },
    });
  }

  return tools;
}
