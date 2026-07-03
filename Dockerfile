# syntax=docker/dockerfile:1

# =============================================================================
# Chalk backend — multi-stage Dockerfile
#
# Targets:
#   development  -> used by docker-compose.yml (hot-reload, full devDeps)
#   production   -> used by docker-compose.prod.yml / CD pipeline (lean, non-root)
#
# Layer order is deliberate: dependency manifests are copied and installed
# *before* application source, so `docker build` only re-runs `npm ci`
# (the slow step) when package.json/package-lock.json actually change —
# editing src/ or public/ never invalidates the deps layer.
# =============================================================================

ARG NODE_VERSION=20-alpine

# -----------------------------------------------------------------------
# base — shared foundation for every other stage. Alpine keeps the image
# small; tini is added here once so every downstream stage gets proper
# PID 1 signal handling (Node does not reap zombies or forward SIGTERM
# correctly on its own when run directly as PID 1 in a container).
# -----------------------------------------------------------------------
FROM node:${NODE_VERSION} AS base
RUN apk add --no-cache tini
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

# -----------------------------------------------------------------------
# dependencies — production-only node_modules, cached as its own layer.
# Only package.json + package-lock.json are copied here, nothing else,
# so touching application code never busts this (expensive) layer.
# -----------------------------------------------------------------------
FROM base AS dependencies
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,id=npm-cache \
    npm ci --omit=dev --no-audit

# -----------------------------------------------------------------------
# dev-dependencies — full node_modules (incl. nodemon) for local dev only.
# Kept as a separate stage so it never leaks into the production image.
# -----------------------------------------------------------------------
FROM base AS dev-dependencies
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,id=npm-cache \
    npm ci --no-audit

# -----------------------------------------------------------------------
# development — target used by docker-compose.yml. Source code is NOT
# copied here on purpose: it's bind-mounted at runtime by compose for
# hot-reload, so this stage only needs to be correct once, at build time.
# Runs as root: the bind mount is owned by the host user, and matching
# container-user UID to host-user UID across platforms is more friction
# than it's worth for a local-only dev container. Production never does
# this — see the `production` stage below.
# -----------------------------------------------------------------------
FROM dev-dependencies AS development
ENV NODE_ENV=development
COPY . .
EXPOSE 3000
ENTRYPOINT ["tini", "--"]
CMD ["npm", "run", "dev"]

# -----------------------------------------------------------------------
# production — final runtime image. Only prod node_modules + the exact
# runtime files the app needs (no tests, no migrations, no .env, no git).
# Non-root user, read-only-friendly (no filesystem writes at runtime —
# the app has no fs.write*/multer/temp-file usage), tini as PID 1.
# -----------------------------------------------------------------------
FROM base AS production

RUN addgroup -S chalk && adduser -S chalk -G chalk

COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
# Deliberately NOT copied: test/, supabase/migrations/, .env*, README.md,
# .git — none of them are needed to run the server (see .dockerignore).

USER chalk

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

ENTRYPOINT ["tini", "--"]
CMD ["node", "src/index.js"]
