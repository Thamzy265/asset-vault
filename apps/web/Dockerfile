# syntax=docker/dockerfile:1
# Build context: repository root (see docker-compose.yml).
FROM node:26.13.1-alpine3.24 AS build
WORKDIR /repo
RUN npm install -g pnpm@11.15.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/db/package.json packages/db/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY packages/db packages/db
COPY apps/web apps/web
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @vault/web build

FROM node:26.13.1-alpine3.24
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
# Root-owned and read-only for the runtime user: the app can't change its own code.
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
# The method gate that runs in front of Next (M1.3 T7); plain JavaScript, loaded before server.js.
COPY --from=build /repo/apps/web/http-gate.mjs /repo/apps/web/http-gate-preload.mjs ./apps/web/
USER node
EXPOSE 3000
CMD ["node", "--import", "./apps/web/http-gate-preload.mjs", "apps/web/server.js"]
