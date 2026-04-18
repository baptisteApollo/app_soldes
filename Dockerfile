# syntax=docker/dockerfile:1.7

# ---------- Stage 1: build native deps ----------
FROM node:20-alpine AS builder

# Tools required to compile better-sqlite3 native binding
RUN apk add --no-cache python3 make g++ libc6-compat

WORKDIR /app/server

COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---------- Stage 2: runtime ----------
FROM node:20-alpine AS runtime

# libstdc++ needed at runtime for the compiled .node binding; tini for signals
RUN apk add --no-cache libstdc++ tini wget \
    && addgroup -S app && adduser -S app -G app

WORKDIR /app/server

COPY --from=builder --chown=app:app /app/server/node_modules ./node_modules

COPY --chown=app:app server/package.json ./package.json
COPY --chown=app:app server/index.js ./index.js
COPY --chown=app:app server/sync.js ./sync.js
COPY --chown=app:app server/conflictResolver.js ./conflictResolver.js
COPY --chown=app:app server/deviceRegistry.js ./deviceRegistry.js
COPY --chown=app:app server/public ./public

# Pre-create mountpoints so fresh named volumes are writable by non-root user
RUN mkdir -p /data /app/server/uploads \
    && chown -R app:app /data /app/server/uploads

ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/dlc-manager.db \
    UPLOADS_DIR=/app/server/uploads

USER app
EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "index.js"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1
