#!/bin/bash
# Generic Tenant Onboarding Script
# Usage: ./onboard-tenant.sh <tenant-subdomain> <profile.json>
#
# Per North Star Demo Implementation Plan:
# - One generic script, not customer-specific
# - Uses cds subscribe for local multitenancy
# - Profile JSON provides tenant-specific configuration

set -e

TENANT_SUBDOMAIN="$1"
PROFILE_JSON="$2"
MTX_URL="${MTX_URL:-http://localhost:4005}"
APP_URL="${APP_URL:-http://localhost:4004}"

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Validate arguments
if [ -z "$TENANT_SUBDOMAIN" ]; then
    log_error "Usage: $0 <tenant-subdomain> <profile.json>"
    exit 1
fi

if [ ! -f "$PROFILE_JSON" ]; then
    log_error "Profile file not found: $PROFILE_JSON"
    exit 1
fi

log_info "═══════════════════════════════════════════════════════════════════"
log_info "Onboarding tenant: $TENANT_SUBDOMAIN"
log_info "Profile: $PROFILE_JSON"
log_info "═══════════════════════════════════════════════════════════════════"

# Step 1: Subscribe tenant (creates HDI container via MTXS)
log_info "Step 1: Subscribing tenant via MTXS..."
cds subscribe "$TENANT_SUBDOMAIN" --to "$MTX_URL" || {
    log_warn "Tenant may already be subscribed, continuing..."
}

# Wait for provisioning
log_info "Waiting for tenant provisioning to complete..."
sleep 5

# Step 2: Submit tenant profile
log_info "Step 2: Submitting tenant profile..."

# Extract fields from profile JSON
ORG_NAME=$(jq -r '.organizationName' "$PROFILE_JSON")
LOCALE=$(jq -r '.locale // "en"' "$PROFILE_JSON")
SOURCE_MODE=$(jq -r '.sourceMode // "MOCK"' "$PROFILE_JSON")
DEST_NAME=$(jq -r '.destinationName // ""' "$PROFILE_JSON")

PROFILE_PAYLOAD=$(cat <<EOF
{
    "organizationName": "$ORG_NAME",
    "locale": "$LOCALE",
    "sourceMode": "$SOURCE_MODE",
    "destinationName": "$DEST_NAME"
}
EOF
)

# Call submitProfile action (tenant context via subdomain header)
curl -s -X POST "$APP_URL/api/tenant/submitProfile" \
    -H "Content-Type: application/json" \
    -H "x-tenant-subdomain: $TENANT_SUBDOMAIN" \
    -d "$PROFILE_PAYLOAD" | jq .

# Step 3: Verify tenant readiness
log_info "Step 3: Verifying tenant readiness..."
sleep 2

READINESS=$(curl -s "$APP_URL/api/tenant/getTenantReadiness()" \
    -H "x-tenant-subdomain: $TENANT_SUBDOMAIN")

echo "$READINESS" | jq .

IS_READY=$(echo "$READINESS" | jq -r '.isReady')

if [ "$IS_READY" = "true" ]; then
    log_info "═══════════════════════════════════════════════════════════════════"
    log_info "Tenant $TENANT_SUBDOMAIN onboarded successfully!"
    log_info "═══════════════════════════════════════════════════════════════════"
else
    log_warn "Tenant onboarded but discovery may still be in progress."
    log_warn "Check tenant readiness at: $APP_URL/api/tenant/getTenantReadiness()"
fi

exit 0