# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Build stage: install, build the workspace, and produce a self-contained
# production deployment of the API server via pnpm deploy.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build
RUN corepack enable

WORKDIR /app

# Package manifests first for dependency-layer caching.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/engine/package.json packages/engine/
COPY packages/core/package.json packages/core/
COPY packages/testkit/package.json packages/testkit/
COPY packages/engine-playwright/package.json packages/engine-playwright/
COPY packages/policy/package.json packages/policy/
COPY packages/api/package.json packages/api/
COPY packages/sdk-typescript/package.json packages/sdk-typescript/
COPY packages/cli/package.json packages/cli/
COPY packages/mcp-server/package.json packages/mcp-server/
COPY packages/benchmarks/package.json packages/benchmarks/

RUN pnpm install --frozen-lockfile

# Build the workspace: cross-package resolution needs dist/ present.
COPY tsconfig.json biome.json ./
COPY packages packages
RUN pnpm -r build

# Self-contained production deployment: the API package with its workspace
# dependencies inlined (real files, no workspace symlinks).
RUN pnpm --filter @agentbrowser/api deploy --prod /deploy \
  && find /deploy -name "*.test.ts" -delete \
  && find /deploy -name "*.tsbuildinfo" -delete \
  && find /deploy -type d -name src -prune -exec rm -rf {} +

# ---------------------------------------------------------------------------
# Runtime stage: the Playwright base ships Chromium and its system libraries
# and nothing else. Runs as the base image's non-root user (pwuser, uid 1000).
# The service is stateless by design (ephemeral sessions, in-memory stores),
# so the container is safe under --read-only with a tmpfs on /tmp.
# ---------------------------------------------------------------------------
FROM mcr.microsoft.com/playwright:v1.62.1-noble

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

COPY --from=build --chown=pwuser:pwuser /deploy ./

USER pwuser

EXPOSE 3000

# Liveness probe against the HTTP surface.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/bin.js"]
