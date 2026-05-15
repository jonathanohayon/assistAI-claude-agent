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
| **`constants.ts`** | Magic numbers du runtime : timings (`SILENCE_HANGUP_MS`, etc.), timeouts fetch, valeurs par défaut. Override via env vars commentés. |
| **`env.ts`** | `requireEnv()` / `envOr()` — accès défensif aux variables d'environnement. |
| **`types.ts`** | `AgentFeatures`, `FetchedConfig`, `TranscriptEntry`, `SessionOrigin`, `ProcessUserData`. Toutes les interfaces partagées. |
| **`origin.ts`** | `detectOrigin()` + helpers `sipFromOf()`, `sipToOf()`, `webUserIdOf()`. Distingue SIP Twilio vs Web LiveTest depuis les attributes/metadata du participant. |
| **`config-fetcher.ts`** | `fetchConfig(origin)` — GET `/api/agent/config` avec routing per-origin. `defaultConfig()` + `DEFAULT_FEATURES` en fallback failure-open. |
| **`remote-log.ts`** | `remoteLog()` — POST `/api/events` best-effort. Mirror stdout pour Railway logs. |
| **`post-call.ts`** | `postCallEnd()` — POST `/api/calls/end` avec le transcript final. Web service prend le relais (summary, WhatsApp recap, DB persist). |

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
