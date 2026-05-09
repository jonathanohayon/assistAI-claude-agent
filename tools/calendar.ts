import { llm } from '@livekit/agents';
import { z } from 'zod';

const APP_URL = process.env['APP_URL'] ?? 'http://localhost:3002';

const post = async <T>(path: string, body: unknown): Promise<T> => {
  const res = await fetch(`${APP_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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

export const checkAvailability = llm.tool({
  description:
    "Vérifie les créneaux disponibles. Le centre ouvert dépend du jour : LUNDI=Ashdod, MERCREDI=Natanya, autres jours=Jérusalem. Si tu indiques un centre qui ne correspond pas au jour demandé, l'API te dira lequel est ouvert.",
  parameters: z.object({
    date: z.string().describe("Date au format YYYY-MM-DD (ex: 2026-05-12)."),
    center: CENTER_ENUM.nullish().describe(
      "Centre demandé par la cliente. Optionnel — laisse vide pour laisser l'API déterminer le centre du jour.",
    ),
  }),
  execute: async ({ date, center }) => {
    const data = await post<{
      date: string;
      center: string;
      label: string;
      available_slots: string[];
      reason?: string;
    }>('/api/calendar/availability', {
      date,
      center: center ?? undefined,
    });
    if (data.reason) {
      return `${data.reason} Veux-tu un créneau à ${data.label} le ${date} ?`;
    }
    const slots = data.available_slots ?? [];
    if (slots.length === 0) return `Aucun créneau disponible le ${date} à ${data.label}.`;
    return `Le ${date} (centre ${data.label}), créneaux libres : ${slots.join(', ')}`;
  },
});

export const bookAppointment = llm.tool({
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
      expectedLabel?: string;
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
      // The API may have suggested the right centre — surface it so the LLM
      // can apologize and re-propose.
      if (data.expectedLabel) {
        return `${data.error} (Le bon centre pour le ${date} est ${data.expectedLabel}.)`;
      }
      return `Erreur réservation : ${data.error ?? 'inconnue'}`;
    }

    // Auto-save contact to CRM (Sheet). Non-blocking: log but don't fail the booking.
    const notes = `RDV ${date} ${time}${description ? ` — ${description}` : ''}`;
    post('/api/sheets/contact', {
      name,
      phone,
      email: email ?? undefined,
      notes,
    }).catch((e) => console.error('save_contact (auto) failed:', e));

    return data.summary ?? `RDV confirmé le ${date} à ${time} pour ${name}.`;
  },
});

export const saveContact = llm.tool({
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

export const findAppointment = llm.tool({
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

export const cancelAppointment = llm.tool({
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

export const rescheduleAppointment = llm.tool({
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

export const calendarTools = {
  check_availability: checkAvailability,
  book_appointment: bookAppointment,
  save_contact: saveContact,
  find_appointment: findAppointment,
  cancel_appointment: cancelAppointment,
  reschedule_appointment: rescheduleAppointment,
} as const;
