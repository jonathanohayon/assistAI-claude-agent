import { z } from 'zod';

/**
 * Model-visible definitions (description + parameters) of the two call-control
 * tools agent.ts registers inside its entry closure (end_call, transfer_call).
 * They live here so tests can check every tool definition the worker
 * registers; agent.ts spreads each one into its tool, next to `execute`.
 */

export const TRANSFER_CALL_SPEC = {
  description:
    "Transfers the caller to a person at the business (the owner or the team). Use it ONLY when the caller explicitly asks to speak to a person, or when you really can't help. Call this tool FIRST, without saying anything before it; its result tells you what to say next. Never call end_call after a transfer.",
  parameters: z.object({
    reason: z
      .string()
      .nullish()
      .describe("Short reason: 'caller_asked_for_person', 'cannot_help', 'complaint', 'urgent'."),
  }),
};

export const END_CALL_SPEC = {
  description:
    "Termine l'appel et raccroche. À appeler UNIQUEMENT dans le MÊME tour de parole où tu viens de dire au revoir À VOIX HAUTE, EN UNE SEULE PHRASE COURTE et DANS LA LANGUE DU CLIENT — et seulement quand la conversation est réellement finie : RDV pris/annulé/déplacé, info donnée et plus rien à demander, le client dit au revoir ou demande à raccrocher, ou silence persistant après une relance. Ne PAS appeler en plein milieu d'un échange ni pendant une simple pause ; si le client reparle pendant que tu conclus, n'appelle PAS end_call et reprends la conversation. Garde le au revoir COURT : un au revoir long ou bavard augmente le risque que ce raccroché soit perdu et que la ligne reste ouverte. APRÈS end_call, NE GÉNÈRE PLUS AUCUNE PAROLE — la ligne se ferme, tout son émis sera coupé.",
  parameters: z.object({
    reason: z
      .string()
      .nullish()
      .describe(
        "Raison courte du raccroché : 'appointment_booked', 'appointment_cancelled', 'appointment_rescheduled', 'information_given', 'client_requested_hangup', 'no_response', 'voicemail'.",
      ),
  }),
};
