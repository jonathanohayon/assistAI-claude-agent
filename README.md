# Tamara — Worker voix (LiveKit Agents, TypeScript)

Worker de production du SaaS multi-tenant **Tamara**. Il tient les
conversations vocales temps réel (OpenAI Realtime) pour tous les canaux :

```
Twilio SIP (PSTN) ─┐
WhatsApp Calling  ─┤
LiveTest web      ─┼──► LiveKit Cloud (SFU) ──► CE WORKER ──► API web Next.js (APP_URL)
Campagnes sortantes┘         │                      │
                             │                      ├─ OpenAI Realtime (LLM+STT+TTS)
                             │                      └─ ai-coustics QVF (noise reduction)
```

- **Entrée** : appels PSTN et WhatsApp arrivent par le trunk SIP Twilio →
  LiveKit ; les sessions LiveTest navigateur et les tests d'agent sortant
  arrivent par token web ; les campagnes sortantes sont dispatchées par
  l'app web (room `campaign__<campaignId>__<contactId>__<attempts>`).
- **Cerveau & voix** : `openai.realtime.RealtimeModel` (modèle, voix,
  vitesse, langue STT pilotés par la config tenant). Pas de VAD local
  (Silero retiré — saturait le CPU) : OpenAI `server_vad` gère les tours.
- **Bruit** : ai-coustics **Quail Voice Focus 2.1 L** (`quailVfL`) en
  unique étage de noise reduction, niveau piloté par le slider tenant.
- **App web** : toutes les requêtes worker → web passent par
  `src/web-api.ts` (header `x-internal-secret`). Contrat détaillé dans
  [`docs/web-api-contract.md`](docs/web-api-contract.md).

## Commandes

```bash
npm install
npm run dev        # worker enregistré auprès de LiveKit, hot reload tsx
npm run start      # mode production
npm run typecheck  # tsc --noEmit
```

En dev, les env vars sont lues depuis `.env.local` à la racine du repo
(chargé par dotenv au top de `agent.ts`).

## Variables d'environnement

Liste exhaustive des `process.env` réellement lus par le code :

| Variable | Requis | Rôle |
|----------|--------|------|
| `OPENAI_API_KEY` | oui (sauf si `REALTIME_API_KEY`) | Clé OpenAI Realtime. Validée au `prewarm` (fail-fast avant le 1er appel). |
| `REALTIME_API_KEY` | non | Override de la clé Realtime (prioritaire sur `OPENAI_API_KEY`). |
| `REALTIME_API_BASE` | non | Base URL de l'API Realtime (défaut `https://api.openai.com/v1`). |
| `REALTIME_MODEL` | non | Modèle par défaut si `/api/agent/config` ne répond pas (défaut `gpt-realtime-2`). |
| `REALTIME_VOICE` | non | Voix fallback (défaut `marin`). |
| `REALTIME_TRANSCRIPTION_MODEL` | non | Modèle STT (défaut `gpt-realtime-whisper`). |
| `LIVEKIT_URL` | oui | URL du projet LiveKit Cloud (SFU). Aussi utilisé pour `deleteRoom` au raccroché. |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | oui | Credentials LiveKit (worker + RoomServiceClient). |
| `APP_URL` | oui | Base URL de l'app web Next.js (config, calendrier, recap, logs). |
| `INTERNAL_SECRET` | oui | Secret partagé worker ↔ web (`x-internal-secret`). Sans lui, fallback tenant démo côté web. |
| `SILENCE_HANGUP_MS` | non | Seuil d'inactivité avant raccroché auto (défaut 30 000). |
| `MAX_CALL_DURATION_MS` | non | Durée max absolue d'un appel (défaut 30 min) — coupe les lignes zombies. |
| `INFRA_TWILIO_EDGE` / `INFRA_WORKER_REGION` / `INFRA_WEB_REGION` / `INFRA_LIVEKIT_REGION` / `INFRA_OPENAI_REGION` | non | Étiquettes de topologie loggées dans `call_metrics` + `infra_region_probe` (diagnostic latence). |

## Origines d'une session (`src/origin.ts`)

Le worker reçoit tous les jobs du même projet LiveKit et distingue
l'origine depuis les attributes/metadata du participant remote :

| `origin.kind` | Détection | Cas |
|---------------|-----------|-----|
| `sip` | attribute `sip.trunkPhoneNumber` (préfixe `whatsapp:` → `channel: 'whatsapp'`, sinon `pstn`) | Appel entrant PSTN ou WhatsApp via Twilio |
| `web` | metadata `{ source: 'web', userId }` | LiveTest navigateur depuis /dashboard |
| `outbound_test` | metadata `{ source: 'outbound_test', agentId, userId }` | Test live d'un agent sortant depuis /dashboard |
| `campaign` | metadata job/participant `{ source: 'campaign', … }` OU nom de room `campaign__…` | Appel sortant de campagne |
| `unknown` | timeout de détection (1,5 s) | Fallback tenant par défaut |

## Cycle de vie d'un appel (`agent.ts entry()`)

1. **`ctx.connect()`** — join de la room, instrumentation des phases.
2. **`detectOrigin`** — résolution SIP / web / campagne (poll 1,5 s max).
3. **`fetchConfig(origin)`** — GET config tenant (persona, modèle, voix,
   features, templates). Failure-open → `defaultConfig()`.
4. **Opener pré-généré** — fetch parallèle de l'audio d'accueil
   (`/api/agent/greeting-audio`, SIP only) ; joué via `session.say` sinon
   accueil généré par le modèle.
5. **`session.start()`** — ouvre la WS OpenAI Realtime. En cas d'échec :
   `closeSession('start_failed')` (sinon la ligne SIP resterait ouverte).
6. **Pendant l'appel** — capture transcript (dédupliquée), publication
   data-channel pour les sessions web, enforcement de langue
   (`sniffLang`), métriques latence/coût, tools (calendrier/CRM, business,
   knowledge, `end_call`).
7. **Watchdogs** — silence (`SILENCE_HANGUP_MS`, grace 10 s au début,
   suspendu quand l'agent parle) + cap durée (`MAX_CALL_DURATION_MS`).
   `end_call` attend la fin du goodbye (hard-cap 8 s, trailing 600 ms).
8. **Post-call (`finally`)** — `call_metrics` + `call_ended` (remoteLog),
   puis `triggerRecap()` : `/api/calls/end` (inbound) ou
   `/api/agent/campaign-result` (campagne), avec retry/backoff et dump
   console en dernier recours.

## Déploiement

Production sur **Railway** (région europe-west4), service worker séparé de
l'app web. Process : `npm run start` (tsx, pas de build). Les env vars
ci-dessus sont configurées dans le service Railway ; le SFU LiveKit est le
projet `tamarProjectv1` (Frankfurt), OpenAI Realtime servi depuis les US.

## TODO risqués (volontairement non faits)

- **M3 — fail-closed sur campaign-config** : aujourd'hui un échec de
  `/api/agent/campaign-config` retombe sur `defaultConfig()` (persona
  réceptionniste sur un appel SORTANT) ; passer fail-closed exige de
  coordonner le retry côté web pour ne pas perdre le contact de campagne.
- **M5 — `runWithSession` au lieu de `enterWith`** : `enterWith` fuit le
  contexte AsyncLocalStorage hors du scope de la session ; le remplacer
  impose de wrapper tout le corps d'`entry()` dans un closure — refactor
  trop invasif pour un fix périphérique.
- **M6 — dédup transcript user** : `UserInputTranscribed` et
  `ConversationItemAdded` peuvent doubler un tour user si le texte diffère
  légèrement ; une dédup plus agressive risque de perdre des tours
  légitimes (répétitions réelles du client).
- **Extraction `MetricsCollector`** : les compteurs de métriques vivent en
  closures dans `entry()` ; les extraire demande un objet de contexte
  partagé (cf. `src/README.md`) — chantier dédié, pas un cleanup.
