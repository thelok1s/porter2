# syntax=docker/dockerfile:1
#
# Porter2 — grammY VK ↔ Telegram bot + Express REST API (serves the TMA).
#
# Runtime: `tsx src/main.ts` (the `npm start` path). tsx resolves the tsconfig
# `paths` aliases (@/*, @local/*) that a plain `tsc` build would leave unresolved.
#
# Deps: the committed package-lock.json is stale (predates the @mtcute/* deps),
# so we install from package.json only and let npm resolve a fresh tree. Native
# modules (sqlite3, better-sqlite3) fetch Node prebuilt binaries — no compilation
# expected; build tools + Python 3.11 (bookworm) are included as a fallback.

# ── deps ───────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS deps
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund

# ── runner: lean image with only what the app needs ─────────────────────────
FROM node:22-bookworm-slim AS runner
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Non-root user — the SQLite files and uploads live in mounted volumes, so make
# sure the host dirs are writable by UID 1001 (see docker-compose.yml).
RUN groupadd --system --gid 1001 porter \
  && useradd --system --uid 1001 --gid porter --create-home porter

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json porter.config.ts ./
COPY src ./src
COPY local ./local

# Persistent state lives here; created so the mount targets always exist.
# NOTE: for BIND mounts these permissions come from the HOST directory, not from
# this chown — a host dir owned by root leaves the container unable to write.
# Create them as UID 1001 on the host: chown -R 1001:1001 db uploads data
RUN mkdir -p db uploads data/images && chown -R porter:porter /app

USER porter

ENV NODE_ENV=production
# Express listen port (porter.config.ts default is 5050). Set PORTER_API_PORT in
# .env to override — must match the port published in docker-compose.yml.
ENV PORTER_API_PORT=5050
# Lets operator scripts tell "inside porter" from "on somebody's laptop". VK
# user tokens are IP-bound, so `npm run vkrenew` must refuse to mint one from
# anywhere but the host porter actually calls VK from (src/scripts/vkrenewnow.ts).
ENV PORTER_IN_CONTAINER=1

EXPOSE 5050
CMD ["node_modules/.bin/tsx", "src/main.ts"]
