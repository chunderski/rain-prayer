# Sentinel Assess API. Build context: repository root (see docker-compose.yml).
FROM node:22-alpine

WORKDIR /app

# Install only what the API needs: root (tsx), shared, frameworks, and api workspaces.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/frameworks/package.json packages/frameworks/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --include-workspace-root --workspace @sentinel/api --workspace @sentinel/shared --workspace @sentinel/frameworks \
    && npm cache clean --force

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/frameworks packages/frameworks
COPY apps/api apps/api
RUN chown -R node:node /app

# Secure defaults; docker-compose overrides via .env (NODE_ENV=development for local use).
ENV NODE_ENV=production \
    API_HOST=0.0.0.0 \
    API_PORT=3000

USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:3000/health || exit 1

# Apply pending migrations as the owner role, then run the API as sentinel_app.
CMD ["sh", "-c", "node --import tsx apps/api/src/db/migrate.ts && exec node --import tsx apps/api/src/server.ts"]
