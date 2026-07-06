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

ARG NODE_VERSION=22-alpine

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
RUN npm ci --omit=dev --no-audit

# -----------------------------------------------------------------------
# dev-dependencies — full node_modules (incl. nodemon) for local dev only.
# Kept as a separate stage so it never leaks into the production image.
# -----------------------------------------------------------------------
FROM base AS dev-dependencies
COPY package.json package-lock.json ./
RUN npm ci --no-audit

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
# build — compiles TypeScript (src/**/*.ts) to plain JS (dist/**/*.js).
# Needs the *full* node_modules (dev-dependencies stage) because `tsc`
# itself is a devDependency — this stage's output (dist/) is copied into
# the production image below, but its node_modules never is.
# -----------------------------------------------------------------------
FROM dev-dependencies AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# -----------------------------------------------------------------------
# production — final runtime image. Only prod node_modules + the exact
# runtime files the app needs (no tests, no migrations, no .env, no git,
# no TypeScript source — just the compiled dist/ output).
# Non-root user, read-only-friendly (no filesystem writes at runtime —
# the app has no fs.write*/multer/temp-file usage), tini as PID 1.
#
# Graceful shutdown: the platform (Railway, Docker, k8s, ...) sends
# SIGTERM to PID 1 when stopping/redeploying the container. tini is PID 1
# here specifically so that signal is forwarded correctly to the Node
# process (Node does not handle being PID 1 well on its own — it won't
# reap zombies and can miss signals). src/index.ts's SIGTERM/SIGINT
# handler then drains in-flight requests, closes Socket.io connections,
# and closes Redis/Supabase connections before exiting — see the
# "Graceful shutdown" section of src/index.ts for the exact order.
# STOPSIGNAL is SIGTERM by default for Docker, spelled out here so the
# platform's shutdown grace period (must be >= the app's own
# SHUTDOWN_TIMEOUT_MS, currently 15s) is a deliberate choice, not an
# accident.
# -----------------------------------------------------------------------
FROM base AS production

RUN addgroup -S chalk && adduser -S chalk -G chalk

COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY --from=build /app/dist ./dist
COPY public ./public
# Deliberately NOT copied: src/ (TypeScript source — dist/ is what runs),
# test/, supabase/migrations/, .env*, README.md, .git — none of them are
# needed to run the server (see .dockerignore).

USER chalk

EXPOSE 3000

STOPSIGNAL SIGTERM

# timeout is 8s (not the previous 5s) because /health now round-trips to
# both Redis (PING) and Supabase (a HEAD/count query) instead of just
# answering immediately — give those two network calls room to finish
# under normal conditions without the healthcheck itself flapping.
# A non-200 response (503 while draining, or if either dependency check
# fails) correctly marks the container unhealthy — see src/index.ts.
HEALTHCHECK --interval=30s --timeout=8s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/index.js"]
