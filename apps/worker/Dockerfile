# syntax=docker/dockerfile:1
# Build context: repository root (see docker-compose.yml).
# Runs TypeScript directly with Node's built-in type stripping (no build step).
FROM node:26.13.1-alpine3.24 AS deps
WORKDIR /app
RUN npm install -g pnpm@11.15.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/worker/package.json apps/worker/
COPY packages/db/package.json packages/db/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter @vault/worker...

FROM node:26.13.1-alpine3.24
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app ./
COPY packages/db/src packages/db/src
COPY apps/worker/src apps/worker/src
USER node
CMD ["node", "apps/worker/src/main.ts"]
