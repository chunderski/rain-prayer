# Development image for the Sentinel Assess PWA (Vite dev server with hot reload).
# Build from the repository root so the workspace packages resolve:
#   docker build -f apps/web/Dockerfile -t sentinel-web .
#   docker run --rm -p 5173:5173 -e VITE_API_URL=http://localhost:3000 sentinel-web
FROM node:22-alpine
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/frameworks/package.json packages/frameworks/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @sentinel/web --include-workspace-root --ignore-scripts
COPY packages/shared packages/shared
COPY packages/frameworks packages/frameworks
COPY apps/web apps/web
WORKDIR /repo/apps/web
ENV VITE_API_URL=http://localhost:3000
EXPOSE 5173
USER node
CMD ["npx", "vite", "--host", "0.0.0.0", "--port", "5173"]
