# ── Build/Dependencies Stage ──────────────────────────────────────────────────
FROM node:18-alpine AS builder

WORKDIR /app

# Install build dependencies if any native addons are needed
RUN apk add --no-cache python3 make g++

# Copy package configuration
COPY package*.json ./

# Install all dependencies
RUN npm install

# Copy source code
COPY src/ ./src/

# ── Runtime Stage ─────────────────────────────────────────────────────────────
FROM node:18-alpine AS runner

WORKDIR /app

# Ensure security updates and add standard system group/user
RUN apk update && apk upgrade --no-cache && \
    addgroup -S appgroup && adduser -S appuser -G appgroup

# Set production environment
ENV NODE_ENV=production
ENV PORT=3002

# Copy node_modules from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/src ./src

# Set ownership of the application files to the non-root user
RUN chown -R appuser:appgroup /app

# Switch to the non-root user
USER appuser

# Expose service port
EXPOSE 3002

# Healthcheck configuration using Node.js to request the health endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "const port = process.env.PORT || 3002; require('http').get('http://localhost:' + port + '/health', (r) => { if (r.statusCode === 200) process.exit(0); else process.exit(1); }).on('error', () => process.exit(1));"

# Launch the service
CMD ["node", "src/index.js"]
