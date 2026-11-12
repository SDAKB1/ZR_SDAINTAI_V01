# Demo Tenant Provisioning

This directory contains scripts and profiles for provisioning demo tenants.

## Quick Start

1. Start MTX sidecar: npm run mtx:sidecar
2. Start main app: npm start
3. Subscribe tenants using npm run subscribe:dollarama and subscribe:bombardier
4. Run ./scripts/onboard-tenant.sh t-dollarama profiles/dollarama.json

## Demo Tenants

- Dollarama (t-dollarama): Retail, French locale, EDI patterns
- Bombardier (t-bombardier): Aerospace, English locale, SOAP/REST patterns
