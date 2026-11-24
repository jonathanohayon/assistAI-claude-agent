import { llm } from '@livekit/agents';
import { z } from 'zod';

import { logToolCall } from '../src/tool-log.js';
import { webPost } from '../src/web-api.js';

export interface ToolFeatures {
  /** Calendar tools : list_available_dates, check_availability, book_appointment,
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
  /** Live caller number getter — populated AFTER ToolContext construction
   *  via SIP attributes. The take_message tool reads it at invoke time so
   *  late-arriving attributes are picked up. Returns '' if unknown. */
  getCallerPhone?: () => string;
  /** Plan features renvoyées par /api/agent/config. Pilotent quels tools
   *  sont enregistrés. Si non fourni : tout activé (legacy). */
  features?: ToolFeatures;
  /** The business's own places (cfg.business.centres from the session
   *  config). Resolves the optional `location_id` the booking tools take.
   *  Absent / empty = the business has no listed place. */
  places?: readonly BookingPlace[];
}

/** One of the business's places, as the session config lists it. */
export interface BookingPlace {
  id: string;
  name: string;
}

/** What the model hears when it names a place the business doesn't have. */
export const UNKNOWN_PLACE =
  'Lieu inconnu : demandez à la personne lequel de nos lieux elle souhaite.';

export type PlaceResolution = { ok: true; location: string | null } | { ok: false; message: string };

/**
 * `location_id` → the `location` sent to the web. Pure.
 *   - a known id (or the exact place name, case-insensitive) → that place's name;
 *   - exactly one place → its name (an omitted or unknown id changes nothing);
 *   - no place → null;
 *   - two or more places: an unknown id → UNKNOWN_PLACE (no request is sent);
 *     an omitted id → null, unless `requireWhenSeveral` (booking: the place
 *     must be chosen) → UNKNOWN_PLACE.
 */
export const resolveLocation = (
  rawPlaces: readonly BookingPlace[] | undefined,
  locationId: string | null | undefined,
  opts: { requireWhenSeveral?: boolean } = {},
): PlaceResolution => {
  // Defensive: a partial payload may hold entries without a usable name.
  const places = (Array.isArray(rawPlaces) ? rawPlaces : []).filter(
    (p): p is BookingPlace => !!p && typeof p.name === 'string' && p.name.trim().length > 0,
  );
  const id = typeof locationId === 'string' ? locationId.trim() : '';
  if (id) {
    const lower = id.toLowerCase();
    const hit =
      places.find((p) => p.id === id) ?? places.find((p) => p.name.trim().toLowerCase() === lower);
    if (hit) return { ok: true, location: hit.name.trim() };
  }
  if (places.length === 0) return { ok: true, location: null };
  if (places.length === 1) return { ok: true, location: places[0]!.name.trim() };
  if (id || opts.requireWhenSeveral) return { ok: false, message: UNKNOWN_PLACE };
  return { ok: true, location: null };
};

const LOCATION_ID_DESCRIPTION =
  "The id of one of the business's places (from list_centres / get_centre_info). Omit it when the business has only one place.";
const DURATION_DESCRIPTION =
  'Duration in minutes: pass the duration of the chosen service, from find_service.';

const makePost =
  (ctx: ToolContext) =>
  async <T>(path: string, body: unknown): Promise<T> => {
    // Routing tenant : prefer x-tenant-phone (SIP) sinon fallback sur
    // x-tenant-user-id (web LiveTest). Au moins un des deux doit être
    // présent pour que le web sache quel Google calendar utiliser.
    // x-internal-secret + Content-Type sont posés par webPost.
    // Numéro composé lu LIVE à chaque requête (attrs SIP tardifs).
    const dialedPhone = ctx.getDialedPhone?.() || ctx.dialedPhone;
    const headers: Record<string, string> = {};
    if (dialedPhone) {
      headers['x-tenant-phone'] = dialedPhone;
    } else if (ctx.tenantUserId) {
      headers['x-tenant-user-id'] = ctx.tenantUserId;
    }
    // Mesure le round-trip worker→web (réseau Railway + traitement web + appel
    // Google côté serveur). Couplé au log web `google_events_list_latency`,
    // ça donne le découpage complet de la latence calendrier d'un appel.
    const t0 = Date.now();
    const res = await webPost(path, body, { headers, timeoutMs: 10_000 });
    const ms = Date.now() - t0;
    console.log(`[calendar-latency] ${path} → ${res.status} ${ms}ms`);
    if (!res.ok) {
      const text = await res.text();
      // A 4xx that carries a reason (`{ error: string, ... }`) is an answer
      // for the model (wrong day for the centre, slot taken, invalid date):
      // hand it back so the tool's own branches run. 401, 5xx, a non-JSON
      // body or a JSON without `error` keep throwing exactly as before.
      // Only an allowlisted refusal keeps its wording (see speakableRefusal);
      // anything else reaches the model as the neutral sentinel, and the log
      // carries the status + a code, never the body (it can name a number).
      const reasoned = parseReasoned4xx(res.status, text);
      if (reasoned) {
        const kept = speakableRefusal(reasoned);
        console.log(`[calendar] refused ${res.status} ${refusalLogCode(reasoned)}`);
        return (kept ?? { error: NEUTRAL_REFUSAL_CODE }) as T;
      }
      throw new Error(`${path} → HTTP ${res.status} : ${text.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  };

/** Parsed body of a 4xx (except 401) whose JSON has a string `error` field,
 *  else null. Never throws. */
export const parseReasoned4xx = (
  status: number,
  text: string,
): ({ error: string } & Record<string, unknown>) | null => {
  if (status < 400 || status >= 500 || status === 401) return null;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const error = (body as Record<string, unknown>)['error'];
  if (typeof error !== 'string') return null;
  return body as { error: string } & Record<string, unknown>;
};

/** What the model hears for any refusal it cannot act on. */
export const NEUTRAL_REFUSAL = 'Impossible pour le moment.';
/** Code makePost puts in place of a refusal that is not allowlisted. */
export const NEUTRAL_REFUSAL_CODE = '__neutral_refusal__';

/** A run of 7+ digits looks like a phone number: never spoken. */
const DIGIT_RUN = /\d{7,}/;

/** The ONLY refusals whose wording may reach the model: the ones the caller
 *  can act on. Matched on the web's `error` field (a code, or the French
 *  text the web routes send for invalid / past dates). Everything else
 *  (tenant unknown, calendar not connected, missing fields, unknown codes)
 *  is neutral by default. The web has no 4xx for "appointment not found"
 *  today (find answers 200 with no events), so nothing is listed for it. */
export const SPEAKABLE_REFUSALS: readonly { name: string; test: (error: string) => boolean }[] = [
  { name: 'wrong_day_for_center', test: (e) => e === 'wrong_day_for_center' },
  { name: 'slot_conflict', test: (e) => e === 'slot_conflict' },
  // lib/iso-date invalidDateError + lib/booking-request: "date invalide : …"
  { name: 'invalid_date', test: (e) => /^date invalide : /i.test(e) },
  // book / reschedule: "Date/heure invalide : …"
  { name: 'invalid_datetime', test: (e) => /^Date\/heure invalide : /.test(e) },
  // book / reschedule: "Le créneau … est déjà passé. …"
  { name: 'past_slot', test: (e) => /^Le créneau .* est déjà passé\./.test(e) },
  // lib/booking-request (book): "Heure invalide : … (format attendu HH:MM, …)"
  { name: 'invalid_time', test: (e) => /^Heure invalide : /.test(e) },
  // lib/booking-request (book): "Durée invalide : … (minutes, entier entre …)"
  { name: 'invalid_duration', test: (e) => /^Durée invalide : /.test(e) },
];

/** The body itself when its refusal is allowlisted and nothing in it holds a
 *  7+ digit run, else null (the caller then speaks the neutral text). */
export const speakableRefusal = <B extends { error: string }>(body: B): B | null => {
  if (!SPEAKABLE_REFUSALS.some((r) => r.test(body.error))) return null;
  if (DIGIT_RUN.test(JSON.stringify(body))) return null;
  return body;
};

/** Log-safe code for a refusal: the allowlist name, a known internal case,
 *  a code-shaped `error`, else "unrecognized". Never the message text. */
export const refusalLogCode = (body: { error: string }): string => {
  const e = body.error;
  const listed = SPEAKABLE_REFUSALS.find((r) => r.test(e));
  if (listed) return listed.name;
  if (/^Tenant inconnu/i.test(e)) return 'tenant_unknown';
  if (/Google Calendar non connecté/i.test(e)) return 'calendar_not_connected';
  if (/Google Sheet non connecté/i.test(e)) return 'sheet_not_connected';
  if (/^[a-z][a-z0-9_]{0,63}$/.test(e) && !/\d{3,}/.test(e)) return e;
  return 'unrecognized';
};

/** Short text for a web refusal a tool has no dedicated branch for: the
 *  neutral text for a non-allowlisted refusal, else the web's `message`
 *  when it is a string, else the error code (≤ 200 chars). */
export const formatRefusal = (data: { error?: unknown; message?: unknown }): string => {
  if (data.error === NEUTRAL_REFUSAL_CODE) return NEUTRAL_REFUSAL;
  const reason =
    typeof data.message === 'string' && data.message.trim()
      ? data.message
      : typeof data.error === 'string'
        ? data.error
        : 'erreur inconnue';
  const text = `Impossible : ${reason.slice(0, 200)}`;
  return DIGIT_RUN.test(text) ? NEUTRAL_REFUSAL : text;
};

type SuggestedDate = { date: string; weekday: string };

const formatSuggested = (suggested?: SuggestedDate[]): string =>
  suggested && suggested.length > 0
    ? suggested.map((d) => `${d.weekday} ${d.date}`).join(', ')
    : '';

/** /api/calendar/list-dates response. `requested_date` / `requested_date_open`
 *  only come from a web that treats `after` as inclusive; an older web omits
 *  them. */
export interface ListDatesResponse {
  /** Legacy web: the weekday centre and its label. */
  center?: string;
  label?: string;
  /** Web that accepts `location`: the place echoed back (null = none). */
  location?: string | null;
  dates: SuggestedDate[];
  error?: string;
  requested_date?: string;
  requested_date_open?: boolean;
}

/** Tool output for list_available_dates. Without `requested_date_open` the
 *  text is exactly the historical one; with it, a plain sentence about the
 *  asked date comes first so the model can't misread the list. */
export const formatListDates = (data: ListDatesResponse): string => {
  if (data.error === NEUTRAL_REFUSAL_CODE) return NEUTRAL_REFUSAL;
  if (data.error) return DIGIT_RUN.test(data.error) ? NEUTRAL_REFUSAL : `Erreur : ${data.error}`;
  const dates = data.dates ?? [];
  const place = data.label || (typeof data.location === 'string' ? data.location : '');
  const at = place ? ` à ${place}` : '';
  const list =
    dates.length === 0
      ? place
        ? `Aucune date trouvée pour ${place}.`
        : 'Aucune date trouvée.'
      : `Prochaines dates ouvertes${at} : ${formatSuggested(dates)}.`;
  if (typeof data.requested_date_open !== 'boolean' || !data.requested_date) return list;
  const verdict = data.requested_date_open
    ? `Le ${data.requested_date} est ouvert${at}.`
    : `Le ${data.requested_date} n'est pas ouvert${at}.`;
  return `${verdict} ${list}`;
};

export const makeCalendarTools = (ctx: ToolContext) => {
  const post = makePost(ctx);

  const places = ctx.places;

  const listAvailableDates = llm.tool({
    description:
      "Renvoie les prochaines dates ouvertes — déterministe, source de vérité. À APPELER avant de proposer une date : ne devine JAMAIS quels jours sont ouverts. Quand la personne demande un jour précis (ex. 'demain'), passe `after` = CETTE date (YYYY-MM-DD) pour la vérifier : la réponse dit alors en clair « Le <date> est ouvert / n'est pas ouvert ». Ne conclus JAMAIS qu'un jour est fermé sans cette phrase « n'est pas ouvert » OU sans avoir appelé check_availability pour ce jour — une date absente de la liste ne veut PAS dire fermé.",
    parameters: z.object({
      location_id: z.string().nullish().describe(LOCATION_ID_DESCRIPTION),
      count: z.number().int().nullish().describe("Combien de prochaines dates retourner (défaut 3, max 10)."),
      after: z.string().nullish().describe("Optionnel : YYYY-MM-DD à partir de laquelle chercher, INCLUSE — passe la date demandée pour la vérifier. Sinon, à partir d'aujourd'hui."),
    }),
    execute: async ({ location_id, count, after }) => {
      logToolCall('list_available_dates', { location_id, count, after });
      const place = resolveLocation(places, location_id);
      if (!place.ok) return place.message;
      // Against a web that predates the `location` shape on list-dates, this
      // answers 400 "center invalide…": not allowlisted, so the model only
      // hears NEUTRAL_REFUSAL (makePost + formatListDates), never the text.
      const data = await post<ListDatesResponse>('/api/calendar/list-dates', {
        location: place.location,
        count: count ?? 3,
        after: after ?? undefined,
      });
      return formatListDates(data);
    },
  });

  const checkAvailability = llm.tool({
    description:
      "Vérifie les créneaux disponibles pour une date précise. PASSE la durée de la prestation choisie (celle de find_service) : un créneau n'est renvoyé que si la prestation ENTIÈRE y tient sans chevauchement. Si l'API renvoie suggested_dates, utilise-les directement. Si tu ne sais pas quelle date proposer, appelle d'abord list_available_dates.",
    parameters: z.object({
      date: z.string().describe("Date au format YYYY-MM-DD (ex: 2026-05-12)."),
      location_id: z.string().nullish().describe(LOCATION_ID_DESCRIPTION),
      duration: z.number().int().nullish().describe(DURATION_DESCRIPTION),
    }),
    execute: async ({ date, location_id, duration }) => {
      logToolCall('check_availability', { date, location_id, duration });
      const place = resolveLocation(places, location_id);
      if (!place.ok) return place.message;
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
        location?: string | null;
      }>('/api/calendar/availability', {
        date,
        // The `location` key (string or null) puts the web on its new path:
        // lib/booking-place.ts isNewShape is `"location" in body`, on the
        // old web too, so no weekday rule applies. `center` is never sent.
        location: place.location,
        duration: duration ?? 30,
      });
      // Wrong day for requested center → server already gave us the next
      // valid dates for that center. Surface them to the LLM verbatim.
      if (data.error === 'wrong_day_for_center') {
        return `${data.message} Propose une de ces dates à la personne.`;
      }
      // Any other refusal (invalid date, calendar not connected, ...).
      if (data.error) return formatRefusal(data);
      // No slots left on this date → server gave us the next valid dates
      // for the SAME center.
      if (data.reason && data.suggested_dates) {
        return `${data.reason}`;
      }
      const label = data.label || (typeof data.location === 'string' ? data.location : '');
      if (data.reason) {
        return label ? `${data.reason} Veux-tu un créneau à ${label} le ${date} ?` : data.reason;
      }
      const slots = data.available_slots ?? [];
      if (slots.length === 0) {
        return label ? `Aucun créneau disponible le ${date} à ${label}.` : `Aucun créneau disponible le ${date}.`;
      }
      // Legacy web (label): its text, unchanged. Location shape: the place.
      return label
        ? `Le ${date} (${data.label ? `centre ${label}` : label}), créneaux libres : ${slots.join(', ')}`
        : `Le ${date}, créneaux libres : ${slots.join(', ')}`;
    },
  });

  const bookAppointment = llm.tool({
    description:
      "Réserve un rendez-vous dans Google Calendar. AVANT d'appeler : prénom, date, heure, prestation, et le lieu si l'entreprise en a plusieurs. Le téléphone est OPTIONNEL — par défaut on prend le numéro de l'appelant (caller ID Twilio). Ne demande JAMAIS le téléphone, sauf s'il faut le récupérer manuellement.",
    parameters: z.object({
      name: z.string().describe("Nom complet du client."),
      phone: z
        .string()
        .nullish()
        .describe(
          "Téléphone OPTIONNEL. Laisse vide / null pour utiliser le caller-ID Twilio (recommandé). Ne fournir QUE si la personne t'a dicté un AUTRE numéro (par ex. tel d'un proche).",
        ),
      date: z.string().describe("Date au format YYYY-MM-DD."),
      time: z.string().describe("Heure au format HH:MM (ex. 14:30)."),
      location_id: z.string().nullish().describe(LOCATION_ID_DESCRIPTION),
      description: z.string().nullish().describe("Objet du rendez-vous : la prestation choisie."),
      email: z.string().nullish().describe("Email du client (optionnel)."),
      duration: z.number().int().nullish().describe(DURATION_DESCRIPTION),
    }),
    execute: async ({ name, phone, date, time, location_id, description, email, duration }) => {
      logToolCall('book_appointment', { name, phone, date, time, location_id, description, email, duration });
      // With several places a booking must name one: ask, send nothing.
      const place = resolveLocation(places, location_id, { requireWhenSeveral: true });
      if (!place.ok) return place.message;
      // Fallback caller-ID si le LLM ne fournit pas phone. Évite que
      // l'agent demande au client un numéro déjà connu via Twilio.
      const resolvedPhone =
        (phone && phone.trim().length > 0 ? phone : null) ??
        ctx.getCallerPhone?.() ??
        '';
      if (!resolvedPhone) {
        return "Erreur : aucun numéro de téléphone fourni et caller-ID indisponible (numéro masqué). Demande à la personne son numéro pour finaliser la réservation.";
      }
      const data = await post<{
        success?: boolean;
        summary?: string;
        error?: string;
        message?: string;
        expectedLabel?: string;
        suggested_dates?: SuggestedDate[];
      }>('/api/calendar/book', {
        name,
        phone: resolvedPhone,
        date,
        time,
        // Always the `location` key, never `center` (see check_availability).
        location: place.location,
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
        // Overlap with an existing booking — REFUSÉ côté serveur. Le message
        // contient déjà les créneaux libres : propose-les, ne réessaie jamais
        // la même heure.
        if (data.error === 'slot_conflict') {
          return (
            data.message ??
            "Ce créneau chevauche un rendez-vous existant. Propose une autre heure."
          );
        }
        return formatRefusal(data);
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
        })
          .then((r) => {
            // Personal data stays out of the log: no body, no message.
            if (r && typeof r === 'object' && 'error' in r) {
              console.error('save_contact (auto) refused by the web');
            }
          })
          .catch((e) => console.error('save_contact (auto) failed:', e));
      }

      return data.summary ?? `RDV confirmé le ${date} à ${time} pour ${name}.`;
    },
  });

  const saveContact = llm.tool({
    description:
      "Enregistre un contact dans le CRM (Google Sheet). Le téléphone est OPTIONNEL — par défaut on prend le caller-ID Twilio. Ne demande pas le téléphone à la personne si on l'a déjà via l'appel.",
    parameters: z.object({
      name: z.string().describe("Nom complet."),
      phone: z
        .string()
        .nullish()
        .describe(
          "Téléphone OPTIONNEL. Laisse vide pour utiliser le caller-ID Twilio. Ne fournir que si la personne t'a dicté un autre numéro.",
        ),
      email: z.string().nullish().describe("Email (optionnel)."),
      notes: z.string().nullish().describe("Notes libres."),
    }),
    execute: async ({ name, phone, email, notes }) => {
      logToolCall('save_contact', { name, phone, email, notes });
      const resolvedPhone =
        (phone && phone.trim().length > 0 ? phone : null) ??
        ctx.getCallerPhone?.() ??
        '';
      if (!resolvedPhone) {
        return "Erreur : aucun numéro fourni et caller-ID indisponible. Demande à la personne son numéro.";
      }
      const data = await post<{ success?: boolean; message?: string; error?: string }>(
        '/api/sheets/contact',
        { name, phone: resolvedPhone, email: email ?? undefined, notes: notes ?? undefined },
      );
      if (data.error) return formatRefusal(data);
      return data.message ?? 'Contact enregistré.';
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
      logToolCall('find_appointment', { phone, date });
      const data = await post<{
        events?: { eventId: string; summary: string; start: string; end: string }[];
        error?: string;
      }>('/api/calendar/find', { phone, date: date ?? undefined });
      if (data.error) return formatRefusal(data);
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
      logToolCall('cancel_appointment', { event_id });
      const data = await post<{ success?: boolean; message?: string; error?: string }>(
        '/api/calendar/cancel',
        { eventId: event_id },
      );
      if (data.error) return formatRefusal(data);
      return data.message ?? 'RDV annulé.';
    },
  });

  const rescheduleAppointment = llm.tool({
    description:
      "Déplace un rendez-vous existant à une nouvelle date/heure. Utilise l'eventId de find_appointment. Ne passe location_id que si la personne change aussi de lieu.",
    parameters: z.object({
      event_id: z.string().describe("Identifiant Google Calendar de l'événement."),
      new_date: z.string().describe("Nouvelle date (YYYY-MM-DD)."),
      new_time: z.string().describe("Nouvelle heure (HH:MM, ex. 14:30)."),
      location_id: z.string().nullish().describe(LOCATION_ID_DESCRIPTION),
      duration: z.number().int().nullish().describe("Durée en minutes. Si omis, garde la durée actuelle."),
    }),
    execute: async ({ event_id, new_date, new_time, location_id, duration }) => {
      logToolCall('reschedule_appointment', { event_id, new_date, new_time, location_id, duration });
      const place = resolveLocation(places, location_id);
      if (!place.ok) return place.message;
      const data = await post<{
        success?: boolean;
        summary?: string;
        error?: string;
        message?: string;
        expectedLabel?: string;
        suggested_dates?: SuggestedDate[];
      }>('/api/calendar/reschedule', {
        eventId: event_id,
        newDate: new_date,
        newTime: new_time,
        // Always the `location` key, never `center`; null keeps the place.
        location: place.location,
        duration: duration ?? undefined,
      });
      // Mauvais centre pour le jour → l'API renvoie les prochaines dates valides.
      if (data.error === 'wrong_day_for_center') {
        const next = formatSuggested(data.suggested_dates);
        return `${data.message ?? data.error}${next ? ` Propose plutôt : ${next}.` : ''}`;
      }
      // Overlap refusé côté serveur : le message liste les créneaux libres.
      if (data.error === 'slot_conflict') {
        return (
          data.message ??
          'Ce créneau chevauche un rendez-vous existant. Propose une autre heure.'
        );
      }
      if (data.error) return formatRefusal(data);
      return data.summary ?? 'RDV déplacé.';
    },
  });

  const takeMessage = llm.tool({
    description:
      "À utiliser quand la personne NE veut PAS prendre de RDV mais veut laisser un message au proprio (ex: 'dis-lui que…', 'peux-tu lui transmettre que…', 'rappelle-moi'). Envoie le message immédiatement par WhatsApp au proprio. Le numéro de la personne est attaché automatiquement (inutile de le passer). Confirme à la personne que le message a été transmis avant de raccrocher.",
    parameters: z.object({
      message: z.string().describe("Message complet à transmettre au proprio, formulé clairement (français/hébreu, peu importe — le proprio comprend les deux)."),
      caller_name: z
        .string()
        .nullish()
        .describe("Prénom de la personne si elle l'a donné. Optionnel."),
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
      return `Message transmis au proprio par WhatsApp.${phone ? ` Numéro de la personne joint : ${phone}.` : ''}`;
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
