FROM node:22-bookworm-slim AS build
WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json .npmrc ./
COPY packages ./packages
COPY apps/p2plink-registry/package.json apps/p2plink-registry/package.json
COPY apps/p2plink-registry/admin/package.json apps/p2plink-registry/admin/package.json
RUN pnpm install --frozen-lockfile
COPY apps/p2plink-registry ./apps/p2plink-registry
RUN pnpm --filter @p2plink/core build
RUN pnpm --filter @p2plink/crypto build
RUN pnpm --filter p2plink-registry build
RUN pnpm --filter p2plink-admin build

FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production PORT=3200
WORKDIR /app
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/packages ./packages
COPY --from=build /workspace/apps/p2plink-registry/node_modules ./apps/p2plink-registry/node_modules
COPY --from=build /workspace/apps/p2plink-registry/dist ./apps/p2plink-registry/dist
COPY --from=build /workspace/apps/p2plink-registry/admin/dist/browser ./apps/p2plink-registry/dist/admin
COPY --from=build /workspace/apps/p2plink-registry/prisma ./apps/p2plink-registry/prisma
COPY --from=build /workspace/apps/p2plink-registry/package.json ./apps/p2plink-registry/package.json
WORKDIR /app/apps/p2plink-registry
EXPOSE 3200
CMD ["node", "dist/main.js"]
