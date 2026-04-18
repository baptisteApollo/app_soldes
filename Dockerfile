# syntax=docker/dockerfile:1.7
# =============================================================================
# Multi-stage image for app_soldes:
#   Stage 1 builds the Expo web bundle (static files)
#   Stage 2 produces the runtime — Node + Express API that also serves the bundle
# =============================================================================

# ---- Stage 1: web bundle ----------------------------------------------------
FROM node:20-bookworm AS web
WORKDIR /build

# Install only what's needed to resolve the JS deps
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Copy the Expo app sources
COPY app        ./app
COPY src        ./src
COPY assets     ./assets
COPY scripts    ./scripts
COPY app.json tsconfig.json ./

# Produce /build/dist
RUN npx expo export -p web

# ---- Stage 2: runtime -------------------------------------------------------
FROM node:20-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    DB_PATH=/data/dlc-manager.db \
    UPLOADS_DIR=/data/uploads

# sqlite3 is a native module: build tools are needed during `npm ci`,
# then we drop them to keep the image small.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
 && apt-get purge -y --auto-remove python3 make g++ \
 && rm -rf /root/.npm

COPY server/ ./
COPY --from=web /build/dist ./public

RUN mkdir -p /data && chown -R node:node /app /data
USER node
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "index.js"]
