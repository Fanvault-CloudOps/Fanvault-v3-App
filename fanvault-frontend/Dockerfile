# ── Build Stage ───────────────────────────────────────────────────────────────
FROM node:18-alpine AS builder

WORKDIR /app

# Copy package configurations
COPY package*.json ./

# Install dependencies (npm install resolves updated semver ranges in package.json)
RUN npm install

# Copy application source code
COPY . .

# Build Vite React production bundle
RUN npm run build

# ── Runtime Stage ─────────────────────────────────────────────────────────────
FROM nginx:1.25-alpine

# Update packages and clean apk cache
RUN apk update && apk upgrade --no-cache && rm -rf /var/cache/apk/*

# Remove default configurations
RUN rm /etc/nginx/conf.d/default.conf

# Copy build output to Nginx HTML root directory
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy main nginx config (overrides base image default to set pid /tmp/nginx.pid)
COPY nginx.conf /etc/nginx/nginx.conf

# Copy configuration template for environment variable interpolation on startup
COPY nginx.conf.template /etc/nginx/templates/default.conf.template

# Pin UID/GID to 101 to match Helm runAsUser: 101; set up writable dirs for non-root nginx
RUN chown -R nginx:nginx /usr/share/nginx/html && \
    mkdir -p /var/cache/nginx/client_temp \
             /var/cache/nginx/proxy_temp \
             /var/cache/nginx/fastcgi_temp \
             /var/cache/nginx/uwsgi_temp \
             /var/cache/nginx/scgi_temp && \
    chown -R nginx:nginx \
             /var/cache/nginx \
             /var/log/nginx \
             /etc/nginx/conf.d \
             /etc/nginx/templates

# Default environment variables for template rendering
ENV USER_SERVICE_HOST=user-service
ENV USER_SERVICE_PORT=3001
ENV COMMERCE_SERVICE_HOST=commerce-service
ENV COMMERCE_SERVICE_PORT=3002

# Run as non-root user
USER nginx

# Expose HTTP port
EXPOSE 8080

# Healthcheck configuration using built-in wget spidering
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost/health || exit 1

# Start Nginx
CMD ["nginx", "-g", "daemon off;"]
