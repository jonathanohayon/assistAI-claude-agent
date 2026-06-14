# Contrat worker → app web (APP_URL)

Tous les appels HTTP du worker vers l'app web Next.js passent par
`src/web-api.ts` (`webGet`/`webPost`), qui pose systématiquement le header
**`x-internal-secret: $INTERNAL_SECRET`** et le timeout. Ce document liste
les endpoints consommés, leurs headers et le comportement du worker en cas
d'échec.

Vocabulaire :

- **failure-open** : l'échec ne bloque pas l'appel — le worker continue
  avec un fallback (config par défaut, accueil modèle…).
- **best-effort** : l'échec est avalé (log local au plus), aucune
  conséquence sur l'appel.
- **retry** : 3 tentatives (immédiat, +1 s, +4 s), 5xx et erreurs réseau
  retentés, 4xx non. En dernier recours le payload complet est dumpé en
  `console.error` pour recovery manuelle depuis les logs Railway.

## Config & accueil (chemin pré-greeting)

| Endpoint | Méthode | Headers | Échec côté worker |
|----------|---------|---------|-------------------|
| `/api/agent/config?phone=…` (SIP) / `?userId=…` (web) / sans query (unknown) | GET | `x-internal-secret` | **Failure-open** — timeout 5 s (`CONFIG_FETCH_TIMEOUT_MS`) ; toute erreur (réseau, HTTP, parse) → `defaultConfig()` (persona legacy compilée), l'appel continue. |
| `/api/agent/campaign-config?campaignId=…&contactId=…` | GET | `x-internal-secret` | **Failure-open** (même chemin que config). ⚠️ Risqué : un échec sert la persona réceptionniste sur un appel SORTANT — fail-closed à coordonner avec le retry web (TODO M3, cf. README racine). |
| `/api/agent/outbound-test-config?agentId=…` | GET | `x-internal-secret` | **Failure-open** → `defaultConfig()`. |
| `/api/agent/greeting-audio?phone=…` | GET | `x-internal-secret` | **Best-effort** — timeout 600 ms ; non-200 / body vide / erreur → `null` → l'accueil est généré par le modèle. Réponse attendue : body PCM16 mono + headers `x-sample-rate`, `x-opener-text` (base64). |

## Pendant l'appel (tools LLM)

Routing tenant des tools : `x-tenant-phone` (numéro composé, lu LIVE à
chaque requête) prioritaire, sinon `x-tenant-user-id` (sessions web
LiveTest). Sans l'un des deux, le web retombe sur le compte démo/admin.

| Endpoint | Méthode | Headers | Échec côté worker |
|----------|---------|---------|-------------------|
| `/api/calendar/list-dates`, `/api/calendar/availability`, `/api/calendar/book`, `/api/calendar/find`, `/api/calendar/cancel`, `/api/calendar/reschedule` | POST | `x-internal-secret` + `x-tenant-phone` \| `x-tenant-user-id` | Timeout 10 s. HTTP non-ok → `throw` (message = status + 200 premiers chars du body) → le SDK renvoie l'erreur au LLM comme résultat de tool, qui s'excuse/repropose. Latence loggée `[calendar-latency]` (couplée au log web `google_events_list_latency`). |
| `/api/sheets/contact` | POST | idem calendrier | Idem. Cas particulier : l'auto-save après `book_appointment` est **non-bloquant** (`.catch` → `console.error`), la résa n'échoue jamais à cause du CRM. |
| `/api/whatsapp/notify` | POST | idem calendrier | Tool `take_message` RETIRÉ du toolset (2026-05-13, bug SDK mid-call) — le code reste mais l'endpoint n'est plus appelé en prod. |

## Post-call & télémétrie

| Endpoint | Méthode | Headers | Échec côté worker |
|----------|---------|---------|-------------------|
| `/api/calls/end` | POST | `x-internal-secret` | **Retry** (3×, timeout 30 s `POST_CALL_TIMEOUT_MS`) puis dump payload — un échec ici = perte du transcript (il n'existe nulle part ailleurs). Skip si transcript vide. Le web prend le relais : summary LLM, WhatsApp client/owner, persistance DB. |
| `/api/agent/campaign-result` | POST | `x-internal-secret` | **Retry** (3×) puis dump payload. Porte `campaignId`, `contactId`, `outcome` (`connected`/`no_answer`), transcript, durée. Le web fait l'analyse IA + transition du contact. |
| `/api/events` | POST | `x-internal-secret` | **Best-effort** — timeout 5 s (`REMOTE_LOG_TIMEOUT_MS`), ne throw jamais, mirror stdout systématique. `origin` auto-injecté via AsyncLocalStorage pour la résolution `user_id` côté web. Fire-and-forget sur le chemin d'appel (jamais awaité avant le greeting ni dans `closeSession`). |
