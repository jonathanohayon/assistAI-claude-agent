import { llm } from '@livekit/agents';
import { z } from 'zod';

import { tenantRoutingHeaders } from '../src/call-tools.js';
import { webPost } from '../src/web-api.js';

export interface ToolFeatures {
  /** Calendar tools : check_availability, book_appointment,
   *  find_appointment, cancel_appointment, reschedule_appointment. */
  calendar?: boolean;
  /** CRM tools : save_contact + auto-save dans book_appointment. */
  crm?: boolean;
}

export interface ToolContext {
  /** E.164 number that was dialed — used by the web service to route to the
   *  right tenant's Google Calendar/Sheet for SIP calls. Empty for web
   *  LiveTest sessions ; on retombe sur `tenantUserId` pour le routing.
   *  Snapshot à la construction — préférer `getDialedPhone` (live). */
  dialedPhone: string;
  /** Live getter du numéro composé — les attrs SIP peuvent arriver APRÈS
   *  la construction des tools (et après le timeout de detectOrigin). Lu
   *  au moment de chaque requête (miroir du pattern getCallerPhone) pour
   *  éviter un x-tenant-phone manquant → fallback cross-tenant côté web. */
  getDialedPhone?: () => string;
  /** User UUID du tenant — utilisé pour le routing tenant côté web quand
   *  le numéro composé est vide (cas web LiveTest). Header `x-tenant-user-id`. */
  tenantUserId: string;
  /** Outbound calls only (T4c): the campaign owner's user id. When set,
   *  every request routes by it (`x-tenant-user-id` + `x-call-direction:
   *  outbound`) and the dialed number is ignored. */
  outboundAccountId?: string;
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
    // Tenant routing (src/call-tools.ts): inbound = x-tenant-phone (SIP,
    // read live) else x-tenant-user-id (web LiveTest); outbound = the
    // account id + x-call-direction, never a call number.
    // x-internal-secret + Content-Type sont posés par webPost.
    const headers = tenantRoutingHeaders(ctx);
    // Mesure le round-trip worker→web (réseau Railway + traitement web + appel
    // Google côté serveur). Couplé au log web `google_events_list_latency`,
    // ça donne le découpage complet de la latence calendrier d'un appel.
    const t0 = Date.now();
    const res = await webPost(path, body, { headers, timeoutMs: 10_000 });
    const ms = Date.now() - t0;
    console.log(`[calendar-latency] ${path} → ${res.status} ${ms}ms`);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${path} → HTTP ${res.status} : ${text.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  };

// The place of an appointment is FREE TEXT the agent takes from the
// tenant's own company sheet (locations + "location rules" in its
// instructions). No business rule lives in these descriptions: each tenant's
// days, places and durations come from its data. Sending the `location` key
// (even null) tells the web routes to apply no weekday rule.
const LOCATION_PARAM = z
  .string()
  .nullish()
  .describe(
    "Établissement du rendez-vous, tel qu'il est nommé dans tes consignes (fiche de l'entreprise). Laisse vide si l'entreprise n'a qu'un seul lieu.",
  );
const DURATION_HELP =
  "Durée de la prestation en minutes, telle qu'indiquée dans les prestations de l'entreprise (défaut 30).";

export const makeCalendarTools = (ctx: ToolContext) => {
  const post = makePost(ctx);

  const checkAvailability = llm.tool({
    description:
      "Vérifie les créneaux disponibles pour une date. PASSE la durée de la prestation : un créneau n'est renvoyé que si la prestation ENTIÈRE y tient sans chevauchement. Si l'entreprise a plusieurs établissements, passe celui voulu et respecte AVANT d'appeler les règles par établissement et par jour de tes consignes.",
    parameters: z.object({
      date: z.string().describe("Date au format YYYY-MM-DD (ex: 2026-05-12)."),
      location: LOCATION_PARAM,
      duration: z.number().int().nullish().describe(`${DURATION_HELP} Indispensable pour que les créneaux renvoyés tiennent vraiment.`),
    }),
    execute: async ({ date, location, duration }) => {
      const data = await post<{
        date: string;
        location?: string | null;
        available_slots?: string[];
        reason?: string;
        error?: string;
      }>('/api/calendar/availability', {
        date,
        location: location ?? null,
        duration: duration ?? 30,
      });
      if (data.error) return `Erreur : ${data.error}`;
      if (data.reason) return data.reason;
      const at = data.location ? ` (${data.location})` : '';
      const slots = data.available_slots ?? [];
      if (slots.length === 0) return `Aucun créneau disponible le ${date}${at}.`;
      return `Le ${date}${at}, créneaux libres : ${slots.join(', ')}`;
    },
  });

  const bookAppointment = llm.tool({
    description:
      "Réserve un rendez-vous dans Google Calendar. AVANT d'appeler : prénom, date, heure, prestation, et — si l'entreprise a plusieurs établissements — l'établissement, en respectant les règles par établissement et par jour de tes consignes. Le téléphone est OPTIONNEL — par défaut on prend le numéro de l'appelant (caller ID Twilio). Ne demande JAMAIS le téléphone si tu n'as pas besoin de le récupérer manuellement.",
    parameters: z.object({
      name: z.string().describe("Nom complet du client."),
      phone: z
        .string()
        .nullish()
        .describe(
          "Téléphone OPTIONNEL. Laisse vide / null pour utiliser le caller-ID Twilio (recommandé). Ne fournir QUE si la cliente t'a dicté un AUTRE numéro (par ex. tel de sa mère).",
        ),
      date: z.string().describe("Date au format YYYY-MM-DD."),
      time: z.string().describe("Heure au format HH:MM (24h)."),
      location: LOCATION_PARAM,
      description: z.string().nullish().describe("Objet du rendez-vous : la prestation demandée, telle que nommée dans les prestations de l'entreprise."),
      email: z.string().nullish().describe("Email du client (optionnel)."),
      duration: z
        .number()
        .int()
        .nullish()
        .describe(DURATION_HELP),
    }),
    execute: async ({ name, phone, date, time, location, description, email, duration }) => {
      // Fallback caller-ID si le LLM ne fournit pas phone. Évite que
      // l'agent demande au client un numéro déjà connu via Twilio.
      const resolvedPhone =
        (phone && phone.trim().length > 0 ? phone : null) ??
        ctx.getCallerPhone?.() ??
        '';
      if (!resolvedPhone) {
        return "Erreur : aucun numéro de téléphone fourni et caller-ID indisponible (numéro masqué). Demande à la cliente son numéro pour finaliser la réservation.";
      }
      const data = await post<{
        success?: boolean;
        summary?: string;
        error?: string;
        message?: string;
      }>('/api/calendar/book', {
        name,
        phone: resolvedPhone,
        date,
        time,
        location: location ?? null,
        description: description ?? undefined,
        email: email ?? undefined,
        duration: duration ?? 30,
      });
      if (!data.success) {
        // Overlap with an existing booking — REFUSÉ côté serveur. Le message
        // contient déjà les créneaux libres : propose-les, ne réessaie jamais
        // la même heure.
        if (data.error === 'slot_conflict') {
          return (
            data.message ??
            "Ce créneau chevauche un rendez-vous existant. Propose une autre heure."
          );
        }
        return `Erreur réservation : ${data.error ?? 'inconnue'}`;
      }

      // Auto-save contact au CRM (Sheet) UNIQUEMENT si la feature crm est
      // activée pour ce plan. Non-blocking : log but don't fail the booking.
      if (ctx.features?.crm !== false) {
        const notes = `RDV ${date} ${time}${description ? ` — ${description}` : ''}`;
        post('/api/sheets/contact', {
          name,
          phone: resolvedPhone,
          email: email ?? undefined,
          notes,
        }).catch((e) => console.error('save_contact (auto) failed:', e));
      }

      return data.summary ?? `RDV confirmé le ${date} à ${time} pour ${name}.`;
    },
  });

  const saveContact = llm.tool({
    description:
      "Enregistre un contact dans le CRM (Google Sheet). Le téléphone est OPTIONNEL — par défaut on prend le caller-ID Twilio. Ne demande pas le téléphone à la cliente si on l'a déjà via l'appel.",
    parameters: z.object({
      name: z.string().describe("Nom complet."),
      phone: z
        .string()
        .nullish()
        .describe(
          "Téléphone OPTIONNEL. Laisse vide pour utiliser le caller-ID Twilio. Ne fournir que si la cliente t'a dicté un autre numéro.",
        ),
      email: z.string().nullish().describe("Email (optionnel)."),
      notes: z.string().nullish().describe("Notes libres."),
    }),
    execute: async ({ name, phone, email, notes }) => {
      const resolvedPhone =
        (phone && phone.trim().length > 0 ? phone : null) ??
        ctx.getCallerPhone?.() ??
        '';
      if (!resolvedPhone) {
        return "Erreur : aucun numéro fourni et caller-ID indisponible. Demande à la cliente son numéro.";
      }
      const data = await post<{ success?: boolean; message?: string; error?: string }>(
        '/api/sheets/contact',
        { name, phone: resolvedPhone, email: email ?? undefined, notes: notes ?? undefined },
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
      "Déplace un rendez-vous existant à une nouvelle date/heure. Utilise l'eventId de find_appointment. Si l'entreprise a plusieurs établissements, respecte pour la NOUVELLE date les règles par établissement et par jour de tes consignes.",
    parameters: z.object({
      event_id: z.string().describe("Identifiant Google Calendar de l'événement."),
      new_date: z.string().describe("Nouvelle date (YYYY-MM-DD)."),
      new_time: z.string().describe("Nouvelle heure (HH:MM, 24h)."),
      location: LOCATION_PARAM,
      duration: z.number().int().nullish().describe("Durée en minutes. Si omis, garde la durée actuelle."),
    }),
    execute: async ({ event_id, new_date, new_time, location, duration }) => {
      const data = await post<{
        success?: boolean;
        summary?: string;
        error?: string;
        message?: string;
      }>('/api/calendar/reschedule', {
        eventId: event_id,
        newDate: new_date,
        newTime: new_time,
        location: location ?? null,
        duration: duration ?? undefined,
      });
      // Overlap refusé côté serveur : le message liste les créneaux libres.
      if (data.error === 'slot_conflict') {
        return (
          data.message ??
          'Ce créneau chevauche un rendez-vous existant. Propose une autre heure.'
        );
      }
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

  // take_message retiré du toolset 2026-05-13. Le tool causait un bug
  // SDK ("expected only one message generation") quand le LLM combinait
  // filler audio + tool call → l'agent stallait silencieusement. Les
  // messages sont désormais transmis post-call via le summary
  // for_owner généré par /api/calls/end (déjà envoyé en WhatsApp au
  // proprio, contient toute la conversation structurée). Le persona doit
  // dire "je transmets ton message" puis end_call — aucun tool mid-call.
  // La fonction takeMessage et l'endpoint /api/whatsapp/notify restent
  // dispo dans le code au cas où on les ressuscite.
  void takeMessage; // marqué utilisé pour ESLint, sans l'enregistrer comme tool
  const calendarEnabled = ctx.features?.calendar !== false;
  const crmEnabled = ctx.features?.crm !== false;
  return {
    ...(calendarEnabled
      ? {
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
