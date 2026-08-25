# syntax=docker/dockerfile:1.7
#
# One image, three entrypoints (api / worker / migrate). One SBOM, one scan,
# one digest promoted through environments — divergence between an API image
# and a worker image built from the same commit cannot happen.
ARG NODE_VERSION=22.14.0

# ---- base ------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS base
WORKDIR /app
# dumb-init as PID 1: Node does not reap zombies and handles SIGTERM
# inconsistently as process 1.
RUN apt-get update \
 && apt-get install -y --no-install-recommends dumb-init \
 && rm -rf /var/lib/apt/lists/*

# ---- dependencies ----------------------------------------------------------
# Manifests only, so this layer survives every source-only change.
FROM base AS deps
ENV NODE_ENV=development
COPY package.json package-lock.json* ./
COPY apps/api/package.json            apps/api/
COPY packages/contracts/package.json  packages/contracts/
COPY packages/database/package.json   packages/database/
RUN --mount=type=cache,target=/root/.npm \
    npm ci --workspaces --include-workspace-root --no-audit --no-fund

# ---- build -----------------------------------------------------------------
FROM deps AS build
ENV NODE_ENV=development
COPY tsconfig.base.json turbo.json ./
COPY packages/ packages/
COPY apps/api/ apps/api/
RUN npx turbo run build --filter=@nutricheck/api...
# npm workspaces place a dependency in EITHER the root node_modules or the
# workspace-local one, depending on version conflicts. The runtime stage must
# copy both; this guarantees the local one exists so the COPY never fails on a
# tree where everything happened to hoist.
RUN mkdir -p /app/apps/api/node_modules
# Drop devDependencies (nest CLI, typescript, jest, turbo, drizzle-kit, esbuild)
# before the runtime stage copies the tree. Without this the shipped image
# carries the entire build toolchain.
RUN npm prune --omit=dev --workspaces --include-workspace-root

# ---- runtime ---------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
RUN groupadd -g 1001 nodejs && useradd -u 1001 -g nodejs -m nodejs

COPY --from=build --chown=1001:1001 /app/node_modules            ./node_modules
COPY --from=build --chown=1001:1001 /app/package.json            ./package.json
COPY --from=build --chown=1001:1001 /app/apps/api/dist           ./apps/api/dist
COPY --from=build --chown=1001:1001 /app/apps/api/node_modules   ./apps/api/node_modules
COPY --from=build --chown=1001:1001 /app/packages                ./packages

# M2: the bge-small-en-v1.5 ONNX weights get their own stage here, fetched with
# ADD --checksum=sha256:... so the model is a pinned supply-chain input rather
# than an unsigned runtime download. Until then search is trigram-only.

USER 1001
EXPOSE 3000

# No HEALTHCHECK on purpose: the orchestrator probes /health/* over HTTP, and a
# curl-based healthcheck would force a shell and a curl binary into the image.
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/api/dist/main.js"]
