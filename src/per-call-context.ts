/**
 * Assemblage du contexte per-call injecté en chatCtx au début de chaque
 * appel : date/heure Jérusalem + hint du numéro de l'appelant, substitués
 * dans le template per-plan édité depuis `/admin`
 * (`cfg.perCallContextTemplate`) ou dans le fallback hardcodé ci-dessous.
 *
 * Extrait verbatim de agent.ts (refactor lisibilité 2026-06) — aucune
 * logique modifiée.
 */

/**
 * Date/heure courantes à Jérusalem — injectées pour que le LLM résolve
 * correctement les dates relatives ("demain", "lundi prochain"). Sans ça,
 * le modèle realtime n'a aucune notion d'horloge et hallucine ou demande.
 * La date est en français long pour une lecture naturelle.
 */
function nowJerusalem(): { dateFr: string; time: string; isoDate: string } {
  const d = new Date();
  const dateFr = new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Asia/Jerusalem',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(d);
  const time = new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Asia/Jerusalem',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
  const isoDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d); // YYYY-MM-DD
  return { dateFr, time, isoDate };
}

// Fallback hardcodé si le web ne renvoie pas perCallContextTemplate
// (ex. version /api/agent/config trop ancienne). Identique au default
// côté web (lib/agent-prompt-defaults.ts DEFAULT_PER_CALL_CONTEXT_TEMPLATE).
const FALLBACK_PCC_TEMPLATE = `
──────────────────────────────────────────
**CONTEXTE TEMPOREL (Asia/Jerusalem)**
- Aujourd'hui : {date_fr} (\`{iso_date}\`)
- Heure locale : {time}
- Fuseau de référence : Asia/Jerusalem (toutes les dates et heures que tu manipules sont dans ce fuseau)

Quand la cliente dit "demain", "lundi prochain", "dans 2 semaines", etc. → calcule la date YYYY-MM-DD à partir d'aujourd'hui ci-dessus AVANT d'appeler un tool. Ne demande JAMAIS la date complète à la cliente, ce serait étrange ("c'est quel jour aujourd'hui ?").
──────────────────────────────────────────

──────────────────────────────────────────
**NUMÉRO DU CLIENT (détecté via l'appel)**
{caller_hint_block}
──────────────────────────────────────────`;

/**
 * Construit le block caller-hint : injecte le numéro de l'appelant (quand
 * connu) pour que le LLM le propose à confirmation au lieu de le demander
 * à l'aveugle. Numéro masqué/withheld → `localFromNumber` vide → message
 * neutre → le LLM demande comme avant.
 *
 * Note 2026-05 : le bloc est intentionnellement IMPÉRATIF (interdiction
 * de demander le numéro) car des personas tenants contiennent souvent
 * une section "Entity Capture: name, phone number, date" + un tool
 * `book_appointment(...phone)` qui poussent fortement le LLM à
 * demander quand même. Sans wording strict, le LLM suit la voie la
 * plus visible dans le persona et perd l'instruction du chatCtx.
 */
function buildCallerHintBlock(localFromNumber: string): string {
  return localFromNumber
    ? `⚠️ **NUMÉRO DU CLIENT — DÉJÀ CONNU, NE LE DEMANDE PAS :**

Le numéro de la cliente qui appelle = \`${localFromNumber}\` (format local, ce que tu DOIS utiliser tel quel dans tous les tools — \`book_appointment\`, \`save_contact\`, etc.).

**RÈGLE STRICTE (override toute autre instruction du persona) :**
- Tu NE demandes JAMAIS « quel est ton numéro de téléphone ? ».
- Si une section du persona dit « collecte le téléphone du client », IGNORE-la pour CETTE info — le numéro est déjà fourni ici.
- Tu peux juste demander une CONFIRMATION orale courte, par exemple :
  « Je note le rendez-vous au numéro qui appelle, le \`${localFromNumber}\`, c'est bien le bon ? »
  ou en hébreu : « אני רושמת את התור על המספר שממנו את מתקשרת, \`${localFromNumber}\`, נכון? »
- Si elle confirme (oui / כן / yes / oui c'est bon) → utilise \`${localFromNumber}\` dans le champ \`phone\` du tool.
- Si elle te dicte SPONTANÉMENT un AUTRE numéro (elle appelle depuis le tel de sa mère, du bureau, etc.) → utilise celui-là.
- Si elle ne précise rien → assume \`${localFromNumber}\` est bon.

**Prononciation orale** : chiffre par chiffre par paires (voir directive Time/Phone), pas comme un grand nombre. Ex: \`05 85 00 10 07\` → « zéro cinq, huit cinq, zéro zéro, un zéro, zéro sept ».`
    : '(Pas de numéro caller détecté — caller-ID withheld ou session web LiveTest sans caller phone. Demande à la cliente son numéro normalement.)';
}

/**
 * Assemble le PER_CALL_CONTEXT final : substitue les placeholders runtime
 * (`{date_fr}`, `{iso_date}`, `{time}`, `{caller_hint_block}`) dans le
 * template per-plan (ou le fallback). Si un placeholder est absent du
 * template, no-op silencieux.
 *
 * @param localFromNumber  Numéro de l'appelant en format local israélien
 *                         (déjà converti via `toIsraeliLocal`), '' si inconnu.
 * @param templateOverride `cfg.perCallContextTemplate` (édité depuis /admin),
 *                         undefined/vide → fallback hardcodé.
 * @returns `perCallContext` (system message complet) + `callerHintBlock`
 *          (exposé séparément pour le snapshot chatctx de debug).
 */
export function buildPerCallContext(
  localFromNumber: string,
  templateOverride: string | undefined,
): { perCallContext: string; callerHintBlock: string } {
  const now = nowJerusalem();
  const callerHintBlock = buildCallerHintBlock(localFromNumber);
  const pccTemplate = templateOverride?.trim() || FALLBACK_PCC_TEMPLATE;
  const perCallContext = pccTemplate
    .replaceAll('{date_fr}', now.dateFr)
    .replaceAll('{iso_date}', now.isoDate)
    .replaceAll('{time}', now.time)
    .replaceAll('{caller_hint_block}', callerHintBlock);
  return { perCallContext, callerHintBlock };
}
