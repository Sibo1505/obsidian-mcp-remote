FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
# vault/git.ts shells out to the git CLI at runtime (commit+push after writes, JIT pull before
# reads) — node:20-slim doesn't include it, unlike the build stage's toolchain.
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
RUN useradd --system --create-home appuser
RUN mkdir -p /data && chown appuser:appuser /data
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY public ./public
USER appuser

EXPOSE 3000
CMD ["node", "dist/server.js"]
