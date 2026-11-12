# =============================================================================
# SDAINTAI Multi-Tenant SaaS - MTX Sidecar Dockerfile
# Handles tenant provisioning, HDI container creation, and schema deployment
# =============================================================================
FROM node:20-alpine

WORKDIR /app

# Install build dependencies
RUN apk add --no-cache python3 make g++ wget

# Copy package files from sidecar directory
COPY package.json package-lock.json* ./

# Install production dependencies only
RUN npm ci --only=production || npm install --only=production

# Copy sidecar service code
COPY srv/ ./srv/

# Expose sidecar port
EXPOSE 4005

# Environment defaults
ENV NODE_ENV=production
ENV PORT=4005

# Health check - MTX sidecar provisioning endpoint
HEALTHCHECK --interval=30s --timeout=10s --start-period=45s --retries=3 \
  CMD wget -q --spider http://localhost:4005/-/cds/saas-provisioning/health || exit 1

# Start MTX sidecar
CMD ["npm", "start"]
