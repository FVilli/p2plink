# syntax=docker/dockerfile:1.7
# Build context is the repository root:
#   docker build -f demo/backend/Dockerfile -t p2plink-demo .
FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json .npmrc ./
COPY packages ./packages
COPY scripts ./scripts
COPY demo ./demo
RUN pnpm install --frozen-lockfile
RUN pnpm -r --filter "./packages/**" build
RUN cd demo \
  && pnpm install --frozen-lockfile \
  && pnpm --filter @p2plink/demo-mesh build \
  && pnpm --filter @p2plink/demo-backend build
# Keep only runtime dependencies in the final image.
RUN pnpm prune --prod && cd demo && pnpm prune --prod

FROM node:24-alpine AS runtime
RUN apk add --no-cache wget
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app /app
# The demo runtime only needs the backend, mesh package and library packages.
RUN rm -rf /app/examples /app/demo/web /app/demo/angular-web /app/demo/react-web /app/docs /app/tests /app/scripts /app/.git
USER node
EXPOSE 3100
HEALTHCHECK --interval=15s --timeout=5s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3100/health >/dev/null || exit 1
CMD ["node", "demo/backend/dist/main.js"]
