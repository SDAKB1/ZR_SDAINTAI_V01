# =============================================================================
# SDAINTAI Multi-Tenant SaaS - CAP Server Dockerfile
# =============================================================================
FROM node:20-alpine

WORKDIR /app

# Install build dependencies for native modules (hdb, better-sqlite3)
RUN apk add --no-cache python3 make g++ wget

# Copy package files first (better Docker layer caching)
COPY package.json package-lock.json* ./

# Install all dependencies
RUN npm install --legacy-peer-deps

# Copy CDS configuration
COPY .cdsrc.json* ./

# Copy database models
COPY db/ ./db/

# Copy services
COPY srv/ ./srv/

# Copy UI applications
COPY app/ ./app/

# Build CDS for production
RUN npx cds build --production

# Expose CAP server port
EXPOSE 4004

# Environment defaults
ENV NODE_ENV=production
ENV PORT=4004

# Health check endpoint
HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=90s \
  CMD wget -q --spider http://localhost:4004/health || exit 1

# Start CAP server
CMD ["npx", "cds-serve"]
