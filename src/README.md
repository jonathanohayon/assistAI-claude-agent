# `src/` — Modules du worker

Cartographie de l'architecture du worker LiveKit Agents. Le point d'entrée
reste `agent.ts` à la racine, qui orchestre tout le reste.

## Pourquoi cette structure

`agent.ts` faisait 1287 lignes — trop pour rester lisible. Les helpers
standalone (parsing, fetch, log, types) ont été sortis en modules
thématiques. Le corps de `entry()` reste dans `agent.ts` car ses closures
internes (transcript, métriques, watchdog) partagent du state local qu'on
ne peut pas extraire proprement sans gros refactor.

## Modules

| Fichier | Contenu |
|---------|---------|
| **`constants.ts`** | Magic numbers du runtime : timings (`SILENCE_HANGUP_MS`, `MAX_CALL_DURATION_MS`, etc.), timeouts fetch, valeurs par défaut. Override via env vars commentés. |
| **`env.ts`** | `requireEnv()` / `envOr()` — accès défensif aux variables d'environnement. |
| **`types.ts`** | `AgentFeatures`, `FetchedConfig`, `TranscriptEntry`, `SessionOrigin`, `ProcessUserData`. Toutes les interfaces partagées. |
| **`origin.ts`** | `detectOrigin()` + helpers `sipFromOf()`, `sipToOf()`, `webUserIdOf()`, `outboundTestOf()`. Distingue SIP Twilio (PSTN/WhatsApp), Web LiveTest, test live d'agent sortant (`outbound_test`) et campagne sortante (`campaign`, via metadata job/participant ou nom de room `campaign__…`). |
| **`config-fetcher.ts`** | `fetchConfig(origin)` — GET `/api/agent/config` (ou `campaign-config` / `outbound-test-config` selon l'origine). `defaultConfig()` + `DEFAULT_FEATURES` en fallback failure-open. |
| **`web-api.ts`** | `webGet()` / `webPost()` — client HTTP centralisé worker → app web : `APP_URL`, header `x-internal-secret`, timeout. Renvoie la `Response` brute, chaque call site garde son handling. |
| **`remote-log.ts`** | `remoteLog()` — POST `/api/events` best-effort. Mirror stdout pour Railway logs. `enterSession()`/`runWithSession()` propagent `origin` via AsyncLocalStorage. |
| **`post-call.ts`** | `postCallEnd()` (inbound → `/api/calls/end`) et `postCampaignResult()` (campagne → `/api/agent/campaign-result`). Retry/backoff 3 tentatives, dump console du payload en dernier recours. |
| **`greeting-player.ts`** | `fetchOpenerPcm()` (GET `/api/agent/greeting-audio`, timeout 600 ms, null si indispo) + `pcmToFrameStream()` — accueil pré-généré joué via `session.say`. |
| **`pricing.ts`** | `computeRealtimeCostUsd()` — coût USD d'un appel depuis le breakdown tokens (audio/texte/cached) au tarif du modèle. |
| **`region-probe.ts`** | `probeRegionsAtStartup()` — RTT réels vers Twilio/LiveKit/OpenAI/Web au boot, loggé `infra_region_probe`. N'utilise PAS `web-api.ts` (sonde réseau bas niveau). |
| **`phone.ts`** | `toIsraeliLocal()` — `+972…` → `0…`. Appliqué partout où un numéro E.164 entre dans le flux conversationnel ou les tools. |
| **`lang-sniff.ts`** | `sniffLang()` — détection cheap hébreu/latin par charset (variante stricte unifiée). Sert au log `[lang_sniff]` et au language-enforcement. |
| **`transcript.ts`** | `extractText()` — extraction du texte brut depuis les `content[]` des ChatMessages Realtime. |
| **`per-call-context.ts`** | `buildPerCallContext()` — assemble le system message per-call (date/heure Jérusalem + caller-hint) depuis le template per-plan ou le fallback hardcodé. |

## `tools/` (racine du repo)

| Fichier | Contenu |
|---------|---------|
| **`tools/calendar.ts`** | Tools tenant : calendrier (`list_available_dates`, `check_availability`, `book_appointment`, `find_appointment`, `cancel_appointment`, `reschedule_appointment`) + CRM (`save_contact`, auto-save dans book). POST `/api/calendar/*` et `/api/sheets/contact` via `webPost` avec routing tenant `x-tenant-phone` / `x-tenant-user-id`. Gating par `features` du plan. |
| **`tools/business.ts`** | 5 tools structurés depuis `agent_configs.business` : `list_centres`, `get_centre_info`, `get_opening_hours`, `list_services`, `find_service`. |
| **`tools/knowledge.ts`** | Tools legacy `knowledge` (un par entrée) — fallback pour les tenants pas encore migrés vers `business`. À droper en release N+1. |

## Convention d'imports

Le projet est en **ESM** (`"type": "module"` dans `package.json`). Les
imports TypeScript utilisent l'extension **`.js`** même pour les fichiers
`.ts` — c'est la convention `moduleResolution: node16+` :

```ts
import { fetchConfig } from './src/config-fetcher.js'; // ← .js !
```

TS compile en `.js` ; au runtime le `.js` matche le fichier généré.

## Convention de structure par fichier

Chaque module suit le même pattern :

```ts
/**
 * Doc header — explique en 2-3 lignes ce que fait ce module.
 */

// 1. Imports (3rd party, puis locaux)
import { X } from 'package';
import { Y } from './other-module.js';

// 2. Constants (si pertinentes au module)
const TIMEOUT_MS = 5000;

// 3. Types/interfaces (si pertinents au module)
interface FooOptions { ... }

// 4. Fonctions / classes — chacune avec doc JSDoc qui décrit input/output
/**
 * Description de la fonction.
 * @param x Paramètre x
 * @returns Ce que ça renvoie
 */
export function foo(x: number): boolean { ... }
```

## Ce qui n'a PAS été extrait (et pourquoi)

Le corps de `entry()` dans `agent.ts` contient encore :
- La classe `LoggingRealtimeModel` (closure sur les métriques locales)
- La classe `TenantAgent extends voice.Agent`
- La logique de capture transcript + dedupe
- Le watchdog silence
- Le scheduling end_call avec hard-cap + trailing delay
- L'extraction des call_metrics finaux

Ces blocs partagent énormément de state local (transcript[], counters de
métriques, refs aux promises, etc.). Les extraire propres demanderait
soit de passer ~15 args à chaque helper, soit de créer un objet
`CallContext` qui transporte tout. Pour V1 on garde dans `agent.ts` —
les ajouts récents ont juste mieux commenté les sections.

Prochain refactor possible : créer une classe `CallSession` qui possède
toutes les refs et expose des méthodes publiques (`onUserSpeech()`,
`triggerRecap()`, etc.). Pour plus tard.
