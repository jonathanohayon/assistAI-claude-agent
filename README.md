# Prestige Agent (TypeScript)

Worker LiveKit/WebRTC pour le salon **Prestige**. Reçoit les appels via Twilio SIP Trunk → LiveKit → ce worker. Cerveau & voix : **Grok Realtime (xAI)** servi via le plugin OpenAI Realtime de LiveKit (même format de protocole, base URL surchargée).

## Installation

```bash
npm install
cp .env.example .env
# remplir LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, GROK_API_KEY
```

## Lancement

Mode développement (worker enregistré auprès du serveur LiveKit) :

```bash
npx tsx agent.ts dev
```

Production :

```bash
npx tsx agent.ts start
```

## Architecture

- **VAD** : Silero (pré-chargé via `prewarm`) pour le barge-in et la détection client.
- **LLM + STT + TTS** : un seul `openai.realtime.RealtimeModel` pointé sur `wss://api.x.ai/v1/realtime` — Grok parle l'API Realtime d'OpenAI mot pour mot.
- **Tools** : `tools/calendar.ts` expose `check_availability(day)` (stub 50 ms).
- **Audio** : LiveKit gère les buffers, aucun transcodage manuel.
