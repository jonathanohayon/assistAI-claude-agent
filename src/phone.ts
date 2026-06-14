/**
 * Helpers de formatage des numéros de téléphone.
 */

/**
 * Convertit un numéro E.164 israélien en format local.
 * `+972585001007` → `0585001007`. Tout autre format est renvoyé tel quel.
 *
 * Les clientes dictent en format local, on stocke en format local, l'agent
 * lit en format local — cette conversion est appliquée partout où un numéro
 * Twilio (E.164) entre dans le flux conversationnel ou les tools.
 */
export function toIsraeliLocal(phone: string): string {
  return phone.startsWith('+972') ? '0' + phone.slice(4) : phone;
}
