# LiveKit Cloud Agent — worker Tamara (Node.js + tsx runtime)
# https://docs.livekit.io/agents/ops/deployment/builds/
# syntax=docker/dockerfile:1

ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-slim AS base

RUN apt-get update -qq \
    && apt-get install --no-install-recommends -y ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ── Build stage ────────────────────────────────────────────────────────
FROM base AS build

WORKDIR /app

# Copie lock files d'abord pour cacher le layer install
COPY package.json package-lock.json ./

# npm ci utilise package-lock.json (équivalent --frozen-lockfile de pnpm)
RUN npm ci --omit=dev=false

# Copie tout le reste (tsx runtime, on ne compile pas — agent.ts est exécuté
# directement par tsx en production, comme sur Railway, pour rester proche
# du dev mode et éviter une étape build/dist).
COPY . .

# Typecheck en build-time pour échouer fast si TS erreurs
RUN npx tsc --noEmit

# Prune dev deps pour image finale plus légère
RUN npm prune --omit=dev

# ── Production stage ───────────────────────────────────────────────────
FROM base

ARG UID=10001
RUN adduser \
    --disabled-password \
    --gecos "" \
    --home "/app" \
    --shell "/sbin/nologin" \
    --uid "${UID}" \
    appuser

WORKDIR /app

COPY --from=build --chown=appuser:appuser /app /app

USER appuser

ENV NODE_ENV=production

# "npm start" résout vers "tsx agent.ts start" via package.json scripts.
# LK Cloud Agent appelle ce CMD au démarrage du container.
CMD [ "npm", "start" ]
