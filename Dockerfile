FROM node:26-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:26-slim
WORKDIR /app
ENV NODE_ENV=production
RUN useradd --system --create-home appuser
RUN mkdir -p /data && chown appuser:appuser /data
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY public ./public
USER appuser

EXPOSE 3000
CMD ["node", "dist/server.js"]
