# ── Build/Dependencies Stage ──────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Install build dependencies if any native addons are needed
RUN apk add --no-cache python3 make g++

# Copy package configuration
COPY package*.json ./

# Install production dependencies only (excludes devDeps with vulnerable transitive chains)
RUN npm install --omit=dev

# Copy source code
COPY src/ ./src/

# ── Runtime Stage ─────────────────────────────────────────────────────────────
FROM node:22-alpine AS runner

WORKDIR /app

# Apply Alpine security patches and upgrade npm to get fixed bundled deps
# (fixes libcrypto3/libssl3/musl/zlib via apk; fixes npm-bundled tar/glob/minimatch via npm upgrade)
# Patch undici in npm's bundled modules (CVE-2026-12151) via temp-dir swap
RUN apk update && apk upgrade --no-cache && \
    npm install -g npm@latest && \
    mkdir -p /tmp/undici-fix && cd /tmp/undici-fix && \
    npm install undici@"^6.27.0" --no-save 2>/dev/null && \
    rm -rf /usr/local/lib/node_modules/npm/node_modules/undici && \
    cp -r /tmp/undici-fix/node_modules/undici /usr/local/lib/node_modules/npm/node_modules/ && \
    rm -rf /tmp/undici-fix && cd / && \
    addgroup -S appgroup && adduser -S appuser -G appgroup

# Set production environment
ENV NODE_ENV=production
ENV PORT=3001

# Copy node_modules from builder (production dependencies only)
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/src ./src

# Set ownership of the application files to the non-root user
RUN chown -R appuser:appgroup /app

# Switch to the non-root user
USER appuser

# Expose service port
EXPOSE 3001

# Healthcheck configuration using Node.js to request the health endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "const port = process.env.PORT || 3001; require('http').get('http://localhost:' + port + '/health', (r) => { if (r.statusCode === 200) process.exit(0); else process.exit(1); }).on('error', () => process.exit(1));"

# Launch the service
CMD ["node", "src/index.js"]
