import { llm } from '@livekit/agents';
import { z } from 'zod';

export interface ToolFeatures {
  /** Calendar tools : list_available_dates, check_availability, book_appointment,
   *  find_appointment, cancel_appointment, reschedule_appointment. */
  calendar?: boolean;
  /** CRM tools : save_contact + auto-save dans book_appointment. */
  crm?: boolean;
}

export interface ToolContext {
  appUrl: string;
  /** E.164 number that was dialed — used by the web service to route to the
   *  right tenant's Google Calendar/Sheet. */
  dialedPhone: string;
  /** INTERNAL_SECRET shared between agent and web — authorizes per-tenant
   *  routing on /api/calendar/* and /api/sheets/contact. */
  internalSecret: string;
  /** Live caller number getter — populated AFTER ToolContext construction
   *  via SIP attributes. The take_message tool reads it at invoke time so
   *  late-arriving attributes are picked up. Returns '' if unknown. */
  getCallerPhone?: () => string;
  /** Plan features renvoyées par /api/agent/config. Pilotent quels tools
   *  sont enregistrés. Si non fourni : tout activé (legacy). */
  features?: ToolFeatures;
}

const makePost =
  (ctx: ToolContext) =>
  async <T>(path: string, body: unknown): Promise<T> => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    // Send tenant-routing headers when both the secret and the dialed number
    // are available. If either is missing, the web service falls back to its
    // session-based or demo path and may refuse — which is what we want
    // rather than silently writing into the admin's calendar.
    if (ctx.internalSecret && ctx.dialedPhone) {
      headers['x-internal-secret'] = ctx.internalSecret;
      headers['x-tenant-phone'] = ctx.dialedPhone;
    }
    const res = await fetch(`${ctx.appUrl}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${path} → HTTP ${res.status} : ${text.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  };

// Centers a tenant operates (current = Prestige). Each day of the week is
// bound to ONE centre on the server side — this enum is exposed to the LLM
// so it commits to a centre when querying or booking.
const CENTER_ENUM = z.enum(['jerusalem', 'ashdod', 'natanya']);

type SuggestedDate = { date: string; weekday: string };

const formatSuggested = (suggested?: SuggestedDate[]): string =>
  suggested && suggested.length > 0
    ? suggested.map((d) => `${d.weekday} ${d.date}`).join(', ')
    : '';

export const makeCalendarTools = (ctx: ToolContext) => {
  const post = makePost(ctx);

  const listAvailableDates = llm.tool({
    description:
      "Renvoie les prochaines dates valides pour un centre donné — déterministe, source de vérité. À APPELER systématiquement avant de proposer une date à la cliente : NE devine JAMAIS quel jour de la semaine correspond à quel centre, demande ce tool. Utile aussi quand la cliente dit 'je veux Jérusalem la semaine prochaine' → tu obtiens directement les dates ouvertes.",
    parameters: z.object({
      center: CENTER_ENUM.describe("Centre voulu par la cliente (jerusalem, ashdod, natanya)."),
      count: z.number().int().nullish().describe("Combien de prochaines dates retourner (défaut 3, max 10)."),
      after: z.string().nullish().describe("Optionnel : YYYY-MM-DD à partir de laquelle chercher (exclusif). Sinon, à partir d'aujourd'hui."),
    }),
    execute: async ({ center, count, after }) => {
      const data = await post<{
        center: string;
        label: string;
        dates: SuggestedDate[];
        error?: string;
      }>('/api/calendar/list-dates', {
        center,
        count: count ?? 3,
        after: after ?? undefined,
      });
      if (data.error) return `Erreur : ${data.error}`;
      const dates = data.dates ?? [];
      if (dates.length === 0) return `Aucune date trouvée pour ${data.label}.`;
      return `Prochaines dates ouvertes à ${data.label} : ${formatSuggested(dates)}.`;
    },
  });

  const checkAvailability = llm.tool({
    description:
      "Vérifie les créneaux disponibles pour une date + centre précis. Si la date ne matche pas le centre, l'API renvoie suggested_dates avec les prochaines dates valides — utilise-les directement. Si tu ne sais pas quelle date proposer, appelle d'abord list_available_dates(center).",
    parameters: z.object({
      date: z.string().describe("Date au format YYYY-MM-DD (ex: 2026-05-12)."),
      center: CENTER_ENUM.nullish().describe(
        "Centre demandé par la cliente. Optionnel — laisse vide pour laisser l'API déterminer le centre du jour.",
      ),
    }),
    execute: async ({ date, center }) => {
      const data = await post<{
        date: string;
        center?: string;
        label?: string;
        available_slots?: string[];
        reason?: string;
        error?: string;
        message?: string;
        suggested_dates?: SuggestedDate[];
        open_label_that_day?: string;
        requested_center?: string;
      }>('/api/calendar/availability', {
        date,
        center: center ?? undefined,
      });
      // Wrong day for requested center → server already gave us the next
      // valid dates for that center. Surface them to the LLM verbatim.
      if (data.error === 'wrong_day_for_center') {
        return `${data.message} Propose une de ces dates à la cliente.`;
      }
      // No slots left on this date → server gave us the next valid dates
      // for the SAME center.
      if (data.reason && data.suggested_dates) {
        return `${data.reason}`;
      }
      if (data.reason) {
        return `${data.reason} Veux-tu un créneau à ${data.label} le ${date} ?`;
      }
      const slots = data.available_slots ?? [];
      if (slots.length === 0) return `Aucun créneau disponible le ${date} à ${data.label}.`;
      return `Le ${date} (centre ${data.label}), créneaux libres : ${slots.join(', ')}`;
    },
  });

  const bookAppointment = llm.tool({
    description:
      "Réserve un rendez-vous dans Google Calendar. AVANT d'appeler : prénom, téléphone, date, heure, prestation, et déduis le centre depuis la date (LUNDI=Ashdod, MERCREDI=Natanya, autres jours=Jérusalem). L'API rejettera la réservation si le centre ne correspond pas au jour.",
    parameters: z.object({
      name: z.string().describe("Nom complet du client."),
      phone: z.string().describe("Numéro de téléphone."),
      date: z.string().describe("Date au format YYYY-MM-DD."),
      time: z.string().describe("Heure au format HH:MM (24h)."),
      center: CENTER_ENUM.describe(
        "Centre obligatoire — déduis-le du jour de la semaine : LUNDI=ashdod, MERCREDI=natanya, autres=jerusalem.",
      ),
      description: z.string().nullish().describe("Objet du rendez-vous (ex: 'soin du visage', 'épilation')."),
      email: z.string().nullish().describe("Email du client (optionnel)."),
      duration: z
        .number()
        .int()
        .nullish()
        .describe("Durée en minutes (60 pour soins de la peau, 30 pour épilation, défaut 30)."),
    }),
    execute: async ({ name, phone, date, time, center, description, email, duration }) => {
      const data = await post<{
        success?: boolean;
        summary?: string;
        error?: string;
        message?: string;
        expectedLabel?: string;
        suggested_dates?: SuggestedDate[];
      }>('/api/calendar/book', {
        name,
        phone,
        date,
        time,
        center,
        description: description ?? undefined,
        email: email ?? undefined,
        duration: duration ?? 30,
      });
      if (!data.success) {
        // Wrong center for the day → server gave us next valid dates for
        // the requested center. Hand them back so the LLM can re-propose.
        if (data.error === 'wrong_day_for_center') {
          const next = formatSuggested(data.suggested_dates);
          return `${data.message ?? data.error}${next ? ` Propose plutôt : ${next}.` : ''}`;
        }
        if (data.expectedLabel) {
          return `${data.error} (Le bon centre pour le ${date} est ${data.expectedLabel}.)`;
        }
        return `Erreur réservation : ${data.error ?? 'inconnue'}`;
      }

      // Auto-save contact au CRM (Sheet) UNIQUEMENT si la feature crm est
      // activée pour ce plan. Non-blocking : log but don't fail the booking.
      if (ctx.features?.crm !== false) {
        const notes = `RDV ${date} ${time}${description ? ` — ${description}` : ''}`;
        post('/api/sheets/contact', {
          name,
          phone,
          email: email ?? undefined,
          notes,
        }).catch((e) => console.error('save_contact (auto) failed:', e));
      }

      return data.summary ?? `RDV confirmé le ${date} à ${time} pour ${name}.`;
    },
  });

  const saveContact = llm.tool({
    description:
      "Enregistre un contact dans le CRM (Google Sheet). À utiliser pour conserver les coordonnées d'un appelant.",
    parameters: z.object({
      name: z.string().describe("Nom complet."),
      phone: z.string().describe("Numéro de téléphone."),
      email: z.string().nullish().describe("Email (optionnel)."),
      notes: z.string().nullish().describe("Notes libres."),
    }),
    execute: async ({ name, phone, email, notes }) => {
      const data = await post<{ success?: boolean; message?: string; error?: string }>(
        '/api/sheets/contact',
        { name, phone, email: email ?? undefined, notes: notes ?? undefined },
      );
      return data.message ?? data.error ?? 'Contact enregistré.';
    },
  });

  const findAppointment = llm.tool({
    description:
      "Cherche les rendez-vous d'un client par téléphone. Renvoie une liste avec eventId pour annuler ou déplacer ensuite.",
    parameters: z.object({
      phone: z.string().describe("Numéro de téléphone du client."),
      date: z.string().nullish().describe("Optionnel : limite la recherche à cette date (YYYY-MM-DD). Sinon cherche les 30 prochains jours."),
    }),
    execute: async ({ phone, date }) => {
      const data = await post<{
        events?: { eventId: string; summary: string; start: string; end: string }[];
        error?: string;
      }>('/api/calendar/find', { phone, date: date ?? undefined });
      if (data.error) return `Erreur recherche : ${data.error}`;
      const events = data.events ?? [];
      if (events.length === 0) return `Aucun rendez-vous trouvé pour ${phone}.`;
      return events
        .map(
          (e, i) =>
            `${i + 1}. ${e.summary ?? 'RDV'} — ${e.start} (eventId: ${e.eventId})`,
        )
        .join('\n');
    },
  });

  const cancelAppointment = llm.tool({
    description:
      "Annule un rendez-vous en utilisant son eventId (obtenu via find_appointment).",
    parameters: z.object({
      event_id: z.string().describe("Identifiant Google Calendar de l'événement à supprimer."),
    }),
    execute: async ({ event_id }) => {
      const data = await post<{ success?: boolean; message?: string; error?: string }>(
        '/api/calendar/cancel',
        { eventId: event_id },
      );
      return data.message ?? data.error ?? 'RDV annulé.';
    },
  });

  const rescheduleAppointment = llm.tool({
    description:
      "Déplace un rendez-vous existant à une nouvelle date/heure. Utilise l'eventId de find_appointment.",
    parameters: z.object({
      event_id: z.string().describe("Identifiant Google Calendar de l'événement."),
      new_date: z.string().describe("Nouvelle date (YYYY-MM-DD)."),
      new_time: z.string().describe("Nouvelle heure (HH:MM, 24h)."),
      duration: z.number().int().nullish().describe("Durée en minutes. Si omis, garde la durée actuelle."),
    }),
    execute: async ({ event_id, new_date, new_time, duration }) => {
      const data = await post<{ success?: boolean; summary?: string; error?: string }>(
        '/api/calendar/reschedule',
        {
          eventId: event_id,
          newDate: new_date,
          newTime: new_time,
          duration: duration ?? undefined,
        },
      );
      return data.summary ?? data.error ?? 'RDV déplacé.';
    },
  });

  const takeMessage = llm.tool({
    description:
      "À utiliser quand la cliente NE veut PAS prendre de RDV mais veut laisser un message au proprio (ex: 'dis-lui que…', 'peux-tu lui transmettre que…', 'rappelle-moi'). Envoie le message immédiatement par WhatsApp au proprio. Le numéro de la cliente est attaché automatiquement (pas besoin de le passer). Confirme à la cliente que le message a été transmis avant de raccrocher.",
    parameters: z.object({
      message: z.string().describe("Message complet à transmettre au proprio, formulé clairement (français/hébreu, peu importe — le proprio comprend les deux)."),
      caller_name: z
        .string()
        .nullish()
        .describe("Prénom de la cliente si elle l'a donné. Optionnel."),
    }),
    execute: async ({ message, caller_name }) => {
      const phone = ctx.getCallerPhone?.() ?? '';
      const data = await post<{ ok?: boolean; sid?: string; error?: string }>(
        '/api/whatsapp/notify',
        {
          message,
          callerName: caller_name ?? undefined,
          callerPhone: phone || undefined,
        },
      );
      if (!data.ok) return `Erreur WhatsApp : ${data.error ?? 'inconnue'}`;
      return `Message transmis au proprio par WhatsApp.${phone ? ` Numéro de la cliente joint : ${phone}.` : ''}`;
    },
  });

  // take_message reste TOUJOURS dispo — c'est le fallback "laisser un
  // message" qui ne dépend ni de calendar ni de CRM. Sans lui, un tenant
  // sans calendrier serait muet face à toute demande non-RDV.
  const calendarEnabled = ctx.features?.calendar !== false;
  const crmEnabled = ctx.features?.crm !== false;
  return {
    take_message: takeMessage,
    ...(calendarEnabled
      ? {
          list_available_dates: listAvailableDates,
          check_availability: checkAvailability,
          book_appointment: bookAppointment,
          find_appointment: findAppointment,
          cancel_appointment: cancelAppointment,
          reschedule_appointment: rescheduleAppointment,
        }
      : {}),
    ...(crmEnabled ? { save_contact: saveContact } : {}),
  };
};
