import { llm } from '@livekit/agents';
import { z } from 'zod';

import { webPost } from '../src/web-api.js';

/**
 * Tool `record_order` — enregistre une commande/réservation dictée par le
 * client au téléphone dans le Google Sheet "Commandes" du tenant (via
 * /api/orders/record côté web). Enregistré UNIQUEMENT quand `ordersEnabled`
 * est vrai dans /api/agent/config (toggle "Commandes" de la tuile CRM).
 *
 * Routing tenant identique aux tools calendrier : x-tenant-phone (SIP) sinon
 * x-tenant-user-id (web LiveTest). x-internal-secret + Content-Type posés par
 * webPost.
 */
export interface OrdersToolContext {
  dialedPhone: string;
  getDialedPhone?: () => string;
  tenantUserId: string;
  getCallerPhone?: () => string;
}

export const makeOrdersTools = (ctx: OrdersToolContext) => {
  const recordOrder = llm.tool({
    description:
      "Enregistre une commande ou une réservation que le client passe au téléphone (produit/service, quantité, détails). À appeler dès que le client confirme ce qu'il veut commander/réserver. Le numéro de l'appelant est rempli automatiquement ; le nom et les autres champs sont optionnels — n'invente rien, ne renseigne que ce que le client a réellement dit. Suis ta persona pour savoir quelles infos demander (ex. le nom).",
    parameters: z.object({
      item: z.string().describe('Produit ou service commandé/réservé.'),
      quantity: z
        .number()
        .int()
        .nullish()
        .describe('Quantité (optionnel).'),
      description: z
        .string()
        .nullish()
        .describe('Détails ou précisions utiles (optionnel).'),
      name: z.string().nullish().describe('Nom du client (optionnel).'),
      center: z
        .string()
        .nullish()
        .describe('Centre / point de retrait si pertinent (optionnel).'),
    }),
    execute: async ({ item, quantity, description, name, center }) => {
      const dialedPhone = ctx.getDialedPhone?.() || ctx.dialedPhone;
      const headers: Record<string, string> = {};
      if (dialedPhone) {
        headers['x-tenant-phone'] = dialedPhone;
      } else if (ctx.tenantUserId) {
        headers['x-tenant-user-id'] = ctx.tenantUserId;
      }
      const phone = ctx.getCallerPhone?.() || '';
      const res = await webPost(
        '/api/orders/record',
        {
          item,
          quantity: quantity ?? undefined,
          description: description ?? undefined,
          name: name ?? undefined,
          phone,
          center: center ?? undefined,
        },
        { headers, timeoutMs: 10_000 },
      );
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        console.log(`[orders] record_order → HTTP ${res.status} ${txt.slice(0, 160)}`);
        return "Je n'ai pas réussi à enregistrer la commande, je réessaie plus tard.";
      }
      return 'Commande enregistrée.';
    },
  });

  return { record_order: recordOrder };
};
