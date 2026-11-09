/**
 * Loyalty v1: the caller's visit history with this tenant, sent by the web
 * in /api/agent/config (`clientProfile`), turned into ONE line appended to
 * the per-call context. Unknown caller / no history / malformed → no line,
 * so the call behaves exactly as before.
 */

export interface ClientProfile {
  visits: number;
  lastVisitAt: string | null;
  nextVisitAt: string | null;
  regular: boolean;
  name: string;
}

/** Validate the untrusted JSON from the web; anything odd → null. */
export function parseClientProfile(raw: unknown): ClientProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const visits = r['visits'];
  if (typeof visits !== 'number' || !Number.isFinite(visits) || visits < 0) return null;
  const iso = (v: unknown) =>
    typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null;
  return {
    visits: Math.floor(visits),
    lastVisitAt: iso(r['lastVisitAt']),
    nextVisitAt: iso(r['nextVisitAt']),
    regular: r['regular'] === true,
    name: typeof r['name'] === 'string' ? r['name'].slice(0, 60) : '',
  };
}

function dayLabel(iso: string): string {
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Asia/Jerusalem',
    day: 'numeric',
    month: 'long',
  }).format(new Date(iso));
}

/**
 * The single context line ('' = nothing to say). Gender-neutral on purpose:
 * clinics and barbers have male clients too, so the line never presumes a
 * gender and tells the model to adapt only when it is certain.
 */
export function clientProfileLine(p: ClientProfile | null): string {
  if (!p) return '';
  const name = p.name ? ` (prénom sur ses rendez-vous : ${p.name}, à confirmer avant de l'utiliser)` : '';
  const next = p.nextVisitAt ? ` Un rendez-vous est déjà prévu le ${dayLabel(p.nextVisitAt)}.` : '';
  const gender =
    " Adapte le genre grammatical uniquement si le prénom ou la voix le rend certain.";
  if (p.visits === 0) {
    return next ? `**PERSONNE DÉJÀ CONNUE**${name} :${next}${gender}` : '';
  }
  const last = p.lastVisitAt ? `, dernière visite le ${dayLabel(p.lastVisitAt)}` : '';
  const tone = p.regular
    ? "Cette personne vient régulièrement : accueille-la chaleureusement comme quelqu'un que tu connais bien"
    : "Cette personne a déjà eu rendez-vous ici : tu peux l'accueillir comme quelqu'un de connu";
  return `**PERSONNE DÉJÀ CLIENTE${p.regular ? ' (RÉGULIÈRE)' : ''}**${name} : ${p.visits} visite${p.visits > 1 ? 's' : ''}${last}.${next} ${tone}, sans réciter ces chiffres.${gender}`;
}
