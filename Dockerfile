# =============================================================================
# Multi-stage Dockerfile for Backstage (monorepo root)
# =============================================================================
#
# USAGE:
#   # 1. Build frontend + backend bundles on the host:
#   yarn install --immutable
#   yarn tsc
#   yarn build:backend
#
#   # 2. Build the Docker image:
#   docker build . --tag backstage:latest
#
# NOTE: The host Node version must match the FROM version below.
# =============================================================================

# ─── Stage 1: Builder ────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Install build dependencies (needed for native modules like better-sqlite3)
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && \
    apt-get install -y --no-install-recommends \
        python3 \
        make \
        g++ \
        libsqlite3-dev && \
    rm -rf /var/lib/apt/lists/*

# Copy Yarn workspace files
COPY .yarn ./.yarn
COPY .yarnrc.yml yarn.lock package.json backstage.json ./

# Copy all package.json files for workspace resolution
COPY packages/backend/package.json ./packages/backend/
COPY packages/app/package.json     ./packages/app/

# Install ALL dependencies (including devDependencies for build)
RUN --mount=type=cache,target=/root/.cache/yarn,sharing=locked \
    yarn install --immutable

# Copy source files
COPY packages ./packages
COPY plugins   ./plugins
COPY examples  ./examples
COPY app-config*.yaml ./

# Compile TypeScript and build the backend bundle
RUN yarn tsc && yarn build:backend

# ─── Stage 2: Runtime ────────────────────────────────────────────────────────
FROM node:22-bookworm-slim

# Install runtime-only native deps
# Remove libsqlite3-dev if you switch fully to PostgreSQL and remove better-sqlite3
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && \
    apt-get install -y --no-install-recommends libsqlite3-dev && \
    rm -rf /var/lib/apt/lists/*

# Run as non-root
USER node
WORKDIR /app

# Copy Yarn workspace metadata
COPY --chown=node:node .yarn       ./.yarn
COPY --chown=node:node .yarnrc.yml ./
COPY --chown=node:node backstage.json ./

ENV NODE_ENV=production

# Copy the skeleton (package.json files) + yarn.lock so we can
# install production-only dependencies cleanly
COPY --chown=node:node yarn.lock package.json \
     packages/backend/dist/skeleton.tar.gz ./
RUN tar xzf skeleton.tar.gz && rm skeleton.tar.gz

RUN --mount=type=cache,target=/home/node/.cache/yarn,sharing=locked,uid=1000,gid=1000 \
    yarn workspaces focus --all --production && rm -rf "$(yarn cache clean)"

# Copy example catalog data
COPY --chown=node:node examples ./examples

# Copy the backend bundle and all app-config files
COPY --chown=node:node packages/backend/dist/bundle.tar.gz app-config*.yaml ./
RUN tar xzf bundle.tar.gz && rm bundle.tar.gz

EXPOSE 7007

CMD ["node", "packages/backend", "--config", "app-config.yaml", "--config", "app-config.production.yaml"]
