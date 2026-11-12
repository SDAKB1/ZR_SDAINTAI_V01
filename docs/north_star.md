# North Star: PI/PO to Integration Suite Migration Platform

## Key Multi-Tenant Considerations for PI/PO Migration

- **Per-tenant Cloud Connector**: Each customer needs their own Cloud Connector connected to their subaccount
- **Per-tenant Destinations**: Store customer's PI/PO credentials in their own destination configurations
- **Data isolation**: Use HDI containers or schema isolation per tenant
- **Location ID**: Use different `CloudConnectorLocationId` per tenant to route correctly

---

## SaaS Provisioning Service for Your Multi-Tenant App

### Yes, You Need It — And It's Free

| Service | Plan | Cost |
|---------|------|------|
| SaaS Provisioning Service (saas-registry) | application | ✅ Free |

### Required Services for Multi-Tenant SaaS App

Based on the SAP samples and your use case:

| Service | Plan | Free? | Purpose |
|---------|------|-------|---------|
| SaaS Provisioning Service | application | ✅ Free | Register app for tenant subscriptions |
| XSUAA | application or broker | ✅ Free | Tenant-aware authentication |
| Service Manager | container | ✅ Free | Manage tenant-specific service instances |
| Destination Service | lite | ✅ Free | Tenant-specific PI/PO connections |
| Connectivity Service | lite | ✅ Free | Route to on-premise PI/PO |
| HANA Cloud | hana-free | ✅ Free | Tenant data isolation (HDI containers) |
| HTML5 App Repository | app-host, app-runtime | ✅ Free | Host UI |

---

## Architecture for Your Multi-Tenant PI/PO Migration App

```
┌─────────────────────────────────────────────────────────────────────┐
│                     YOUR MULTI-TENANT APP                            │
│                     (Provider Subaccount)                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────────┐    ┌──────────────────┐                       │
│  │ SaaS Registry   │───▶│ Subscription     │                       │
│  │ (saas-registry) │    │ Callbacks        │                       │
│  └─────────────────┘    │ - onSubscription │                       │
│                         │ - getDependencies│                       │
│                         └──────────────────┘                       │
│                                                                     │
│  ┌─────────────────┐    ┌──────────────────┐                       │
│  │ XSUAA           │───▶│ Tenant-aware     │                       │
│  │ (broker plan)   │    │ Auth + Scopes    │                       │
│  └─────────────────┘    └──────────────────┘                       │
│                                                                     │
│  ┌─────────────────┐    ┌──────────────────┐                       │
│  │ Service Manager │───▶│ Per-tenant HDI   │                       │
│  │ (container)     │    │ containers       │                       │
│  └─────────────────┘    └──────────────────┘                       │
│                                                                     │
│  ┌─────────────────┐    ┌──────────────────┐                       │
│  │ Destination     │───▶│ Per-tenant PI/PO │                       │
│  │ Service         │    │ connections      │                       │
│  └─────────────────┘    └──────────────────┘                       │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     SUBSCRIBER TENANTS                               │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐             │
│  │ Tenant A    │    │ Tenant B    │    │ Tenant C    │             │
│  │ (Customer 1)│    │ (Customer 2)│    │ (Customer 3)│             │
│  │             │    │             │    │             │             │
│  │ • PI/PO Sys │    │ • PI/PO Sys │    │ • PI/PO Sys │             │
│  │ • Own data  │    │ • Own data  │    │ • Own data  │             │
│  └──────┬──────┘    └──────┬──────┘    └──────┬──────┘             │
│         │                  │                  │                     │
│         ▼                  ▼                  ▼                     │
│    Cloud Connector    Cloud Connector    Cloud Connector            │
│         │                  │                  │                     │
│         ▼                  ▼                  ▼                     │
│    Their PI/PO        Their PI/PO        Their PI/PO               │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## MTA Configuration for SaaS Registry

```yaml
# mta.yaml
_schema-version: "3.2"
ID: pipo-migration-saas
version: 1.0.0

modules:
  - name: pipo-migration-srv
    type: nodejs
    path: srv
    requires:
      - name: pipo-migration-uaa
      - name: pipo-migration-registry
      - name: pipo-migration-sm
      - name: pipo-migration-destination
      - name: pipo-migration-connectivity
    provides:
      - name: srv-api
        properties:
          srv-url: ${default-url}

  - name: pipo-migration-app
    type: approuter.nodejs
    requires:
      - name: pipo-migration-uaa
      - name: srv-api
        group: destinations
        properties:
          name: srv
          url: ~{srv-url}

resources:
  # SaaS Provisioning Service - FREE
  - name: pipo-migration-registry
    type: org.cloudfoundry.managed-service
    parameters:
      service: saas-registry
      service-plan: application  # FREE plan
      config:
        appName: PIPO Migration Tool
        xsappname: pipo-migration-${org}-${space}
        appUrls:
          getDependencies: ~{srv-api/srv-url}/mt/v1.0/subscriptions/dependencies
          onSubscription: ~{srv-api/srv-url}/mt/v1.0/subscriptions/tenants/{tenantId}
          onSubscriptionAsync: true
          onUnSubscriptionAsync: true
        displayName: PI/PO Migration Tool
        description: Multi-tenant tool for migrating SAP PI/PO to Integration Suite
    requires:
      - name: srv-api

  # XSUAA - FREE
  - name: pipo-migration-uaa
    type: org.cloudfoundry.managed-service
    parameters:
      service: xsuaa
      service-plan: broker  # For multi-tenant
      path: ./xs-security.json

  # Service Manager - FREE
  - name: pipo-migration-sm
    type: org.cloudfoundry.managed-service
    parameters:
      service: service-manager
      service-plan: container

  # Destination - FREE
  - name: pipo-migration-destination
    type: org.cloudfoundry.managed-service
    parameters:
      service: destination
      service-plan: lite

  # Connectivity - FREE
  - name: pipo-migration-connectivity
    type: org.cloudfoundry.managed-service
    parameters:
      service: connectivity
      service-plan: lite
```

---

## xs-security.json for Multi-Tenant

```json
{
  "xsappname": "pipo-migration",
  "tenant-mode": "shared",
  "scopes": [
    {
      "name": "$XSAPPNAME.migration.read",
      "description": "Read PI/PO artifacts"
    },
    {
      "name": "$XSAPPNAME.migration.write",
      "description": "Execute migration"
    },
    {
      "name": "$XSAPPNAME.admin",
      "description": "Admin access"
    }
  ],
  "role-templates": [
    {
      "name": "MigrationViewer",
      "scope-references": ["$XSAPPNAME.migration.read"]
    },
    {
      "name": "MigrationAdmin",
      "scope-references": [
        "$XSAPPNAME.migration.read",
        "$XSAPPNAME.migration.write",
        "$XSAPPNAME.admin"
      ]
    }
  ]
}
```

---

## Optional Services (Based on Requirements)

### Redis

**Not required for core migration functionality.** Consider it only if your app needs:

- Session state sharing across multiple app instances
- Caching frequently-accessed PI/PO metadata
- Rate limiting or job queue management

BTP offers Redis on SAP BTP (hyperscaler option) but it's a **paid service**. For a migration tool, you can likely avoid it by using stateless design patterns.

### Content Agent Service

**Not required for migration itself.** It's specifically for:

- Automated transport of integration content between Integration Suite tenants via CTMS (Cloud Transport Management Service)
- CI/CD pipelines that move iFlows from dev → test → prod tenants

You'd only need it if your SaaS app will automatically deploy migrated iFlows to subscriber tenants. If users manually import the converted content, skip it.

### Process Integration Runtime

**Not required for migration.** This service is for:

- Exposing deployed iFlows as APIs (API access to running integrations)
- ABAP proxy scenarios where SAP systems call Integration Suite via SOAP
- Runtime execution of integrations

Your migration tool reads from PI/PO and converts artifacts—it doesn't need to run integrations.

---

## Multi-Tenant Architecture Components

### 1. Subscription Callback Handler

When a tenant subscribes to your app, BTP calls your callback endpoint. You need to handle:

```javascript
// Example subscription callback (Node.js/CAP style)
app.put('/callback/v1.0/tenants/:tenantId', async (req, res) => {
  const tenantId = req.params.tenantId;
  const subscribedSubdomain = req.body.subscribedSubdomain;

  // Provision tenant-specific resources if needed
  // Return the tenant-specific app URL
  res.status(200).json({
    subscriptionUrl: `https://${subscribedSubdomain}.${appDomain}`
  });
});

app.delete('/callback/v1.0/tenants/:tenantId', async (req, res) => {
  const tenantId = req.params.tenantId;
  // Cleanup tenant resources
  res.status(200).send();
});
```

### 2. Tenant-Aware Destination Lookup

Each subscriber tenant might have their own PI/PO system. You'll need tenant-specific destinations:

```javascript
const { getDestination } = require('@sap-cloud-sdk/connectivity');

async function getPIPODestination(tenantId) {
  // Option A: Tenant-specific destination naming convention
  const destName = `PO_${tenantId}_ESR`;

  // Option B: Shared destination with tenant header
  const destination = await getDestination({
    destinationName: destName,
    jwt: req.headers.authorization // Tenant context from JWT
  });

  return destination;
}
```

### 3. MTA Configuration for Multi-Tenancy

```yaml
_schema-version: "3.1"
ID: pipo-migration-saas
version: 1.0.0

modules:
  - name: pipo-migration-srv
    type: nodejs
    path: srv
    parameters:
      buildpack: nodejs_buildpack
      memory: 256M
    requires:
      - name: pipo-migration-uaa
      - name: pipo-migration-registry
      - name: pipo-migration-dest
      - name: pipo-migration-conn
    provides:
      - name: srv-api
        properties:
          srv-url: ${default-url}

  - name: pipo-migration-approuter
    type: approuter.nodejs
    path: approuter
    parameters:
      memory: 128M
    requires:
      - name: pipo-migration-uaa
      - name: srv-api
        group: destinations
        properties:
          name: srv
          url: ~{srv-url}
          forwardAuthToken: true

resources:
  - name: pipo-migration-uaa
    type: org.cloudfoundry.managed-service
    parameters:
      service: xsuaa
      service-plan: broker
      path: ./xs-security.json

  - name: pipo-migration-registry
    type: org.cloudfoundry.managed-service
    parameters:
      service: saas-registry
      service-plan: application
      config:
        xsappname: pipo-migration
        appName: pipo-migration
        displayName: PI/PO Migration Tool
        description: Migrate SAP PI/PO artifacts to Integration Suite
        category: Integration
        appUrls:
          onSubscription: https://${org}-${space}-pipo-migration-srv.${default-domain}/callback/v1.0/tenants/{tenantId}
          getDependencies: https://${org}-${space}-pipo-migration-srv.${default-domain}/callback/v1.0/dependencies

  - name: pipo-migration-dest
    type: org.cloudfoundry.managed-service
    parameters:
      service: destination
      service-plan: lite

  - name: pipo-migration-conn
    type: org.cloudfoundry.managed-service
    parameters:
      service: connectivity
      service-plan: lite
```

### 4. xs-security.json for Broker Plan

```json
{
  "xsappname": "pipo-migration",
  "tenant-mode": "shared",
  "scopes": [
    {
      "name": "$XSAPPNAME.migration.read",
      "description": "Read PI/PO artifacts"
    },
    {
      "name": "$XSAPPNAME.migration.write",
      "description": "Create Integration Suite artifacts"
    },
    {
      "name": "$XSAPPNAME.admin",
      "description": "Admin operations"
    }
  ],
  "role-templates": [
    {
      "name": "MigrationUser",
      "description": "Perform migrations",
      "scope-references": [
        "$XSAPPNAME.migration.read",
        "$XSAPPNAME.migration.write"
      ]
    },
    {
      "name": "Admin",
      "description": "Administrator",
      "scope-references": [
        "$XSAPPNAME.admin"
      ]
    }
  ]
}
```

---

## Key Decision Points

### Destination Strategy
Will each tenant bring their own PI/PO system, or will you offer a shared analysis service?

- **Own PI/PO** → Tenant-specific destinations (managed via Destination Service API)
- **Shared** → Your existing PO_PJ2_ESR destination

### Output Delivery
How will migrated artifacts reach subscriber tenants?

- **Download as zip** (simplest)
- **Direct deploy** to their Integration Suite (requires their IS credentials/destination)
- **Content Agent integration** (requires Content Agent Service, adds complexity)

### Persistence
Do you need to store migration history/state?

- **Yes** → Add SAP HANA Cloud (paid) or PostgreSQL on BTP
- **No** → Keep it stateless, generate artifacts on-demand

---

## HANA Cloud for State, Cache, and Vectors

### What You Get with HANA Cloud

| Capability | Use Case |
|------------|----------|
| Relational tables | LangGraph state checkpoints, tenant data, migration history |
| JSON document store | PI/PO discovery cache (ICOs, channels, mappings) |
| Vector engine | Semantic search over PI/PO artifacts, AI-powered mapping suggestions |
| In-memory processing | Fast cache reads without separate Redis |

### Cost Consideration

HANA Cloud is **not free** — the cheapest option is:

- **SAP HANA Cloud, Free Tier**: 30GB storage, stops after 30 days of inactivity, limited to non-production
- **Production**: Starts ~$500+/month for smallest configuration

Since you mentioned "free option" but also "production" — those are mutually exclusive with HANA Cloud. Your options:

| Environment | Approach |
|-------------|----------|
| Dev/Test | HANA Cloud Free Tier (auto-stops, 30GB limit) |
| Production | Paid HANA Cloud OR PostgreSQL (~$50/mo) with in-app caching |

---

### 1. Schema Design: State + Cache + Vectors in HANA

```sql
-- Tenant management
CREATE TABLE tenants (
    tenant_id NVARCHAR(64) PRIMARY KEY,
    subdomain NVARCHAR(128) NOT NULL,
    pipo_destination NVARCHAR(128),
    is_destination NVARCHAR(128),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    config JSON
);

-- LangGraph state checkpoints
CREATE TABLE langgraph_checkpoints (
    thread_id NVARCHAR(128) NOT NULL,
    checkpoint_ns NVARCHAR(128) NOT NULL,
    checkpoint_id NVARCHAR(128) NOT NULL,
    parent_checkpoint_id NVARCHAR(128),
    tenant_id NVARCHAR(64) NOT NULL,
    checkpoint BLOB,  -- Serialized state
    metadata JSON,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
);

CREATE INDEX idx_checkpoint_tenant ON langgraph_checkpoints(tenant_id);
CREATE INDEX idx_checkpoint_parent ON langgraph_checkpoints(parent_checkpoint_id);

-- PI/PO Discovery Cache (JSON document store pattern)
CREATE TABLE pipo_cache (
    tenant_id NVARCHAR(64) NOT NULL,
    resource_type NVARCHAR(64) NOT NULL,  -- 'ico', 'channel', 'mapping', 'sender_agreement', etc.
    resource_id NVARCHAR(256) NOT NULL,
    data JSON NOT NULL,  -- Full PI/PO API response
    etag NVARCHAR(128),  -- For change detection
    version INTEGER DEFAULT 1,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (tenant_id, resource_type, resource_id)
);

-- Partial index for fast expiry checks
CREATE INDEX idx_cache_expiry ON pipo_cache(expires_at);
CREATE INDEX idx_cache_lookup ON pipo_cache(tenant_id, resource_type);

-- Vector embeddings for semantic search
CREATE TABLE pipo_embeddings (
    tenant_id NVARCHAR(64) NOT NULL,
    resource_type NVARCHAR(64) NOT NULL,
    resource_id NVARCHAR(256) NOT NULL,
    chunk_index INTEGER DEFAULT 0,
    content_text NCLOB,  -- Original text for display
    embedding REAL_VECTOR(1536),  -- OpenAI ada-002 or similar
    metadata JSON,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (tenant_id, resource_type, resource_id, chunk_index)
);

-- HANA Vector index for similarity search
CREATE VECTOR INDEX idx_pipo_vectors
ON pipo_embeddings(embedding)
USING HNSW;  -- Hierarchical Navigable Small World graph

-- Migration history
CREATE TABLE migrations (
    migration_id NVARCHAR(64) PRIMARY KEY,
    tenant_id NVARCHAR(64) NOT NULL,
    source_ico_id NVARCHAR(256),
    target_iflow_id NVARCHAR(256),
    status NVARCHAR(32),  -- 'pending', 'converting', 'converted', 'deployed', 'failed'
    conversion_result JSON,
    deployment_result JSON,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP
);
```

---

### 2. HANA-Based Cache Layer (Python)

```python
from hdbcli import dbapi
from datetime import datetime, timedelta
import json
from typing import Any, Optional

class HANACache:
    """PI/PO discovery cache using HANA Cloud JSON storage"""

    def __init__(self, connection_params: dict, tenant_id: str):
        self.conn_params = connection_params
        self.tenant_id = tenant_id
        self.default_ttl = timedelta(hours=24)

    def _get_connection(self):
        return dbapi.connect(**self.conn_params)

    async def get(self, resource_type: str, resource_id: str = "__all__") -> Optional[dict]:
        """Get cached data, returns None if expired or missing"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT data FROM pipo_cache
                WHERE tenant_id = ?
                  AND resource_type = ?
                  AND resource_id = ?
                  AND expires_at > CURRENT_TIMESTAMP
            """, (self.tenant_id, resource_type, resource_id))

            row = cursor.fetchone()
            return json.loads(row[0]) if row else None

    async def set(
        self,
        resource_type: str,
        data: Any,
        resource_id: str = "__all__",
        ttl: timedelta = None
    ):
        """Cache data with TTL"""
        expires_at = datetime.utcnow() + (ttl or self.default_ttl)

        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                UPSERT pipo_cache (tenant_id, resource_type, resource_id, data, expires_at, updated_at)
                VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                WITH PRIMARY KEY
            """, (self.tenant_id, resource_type, resource_id, json.dumps(data), expires_at))
            conn.commit()

    async def get_icos(self) -> Optional[list]:
        """Get cached ICO list"""
        return await self.get("ico_list")

    async def set_icos(self, icos: list, ttl: timedelta = None):
        """Cache ICO list"""
        await self.set("ico_list", icos, ttl=ttl or timedelta(hours=24))

    async def get_ico_detail(self, ico_id: str) -> Optional[dict]:
        """Get cached ICO details"""
        return await self.get("ico_detail", ico_id)

    async def set_ico_detail(self, ico_id: str, detail: dict):
        """Cache ICO details"""
        await self.set("ico_detail", detail, resource_id=ico_id, ttl=timedelta(hours=12))

    async def invalidate(self, resource_type: str = None, resource_id: str = None):
        """Invalidate cache entries"""
        with self._get_connection() as conn:
            cursor = conn.cursor()

            if resource_type and resource_id:
                cursor.execute("""
                    DELETE FROM pipo_cache
                    WHERE tenant_id = ? AND resource_type = ? AND resource_id = ?
                """, (self.tenant_id, resource_type, resource_id))
            elif resource_type:
                cursor.execute("""
                    DELETE FROM pipo_cache
                    WHERE tenant_id = ? AND resource_type = ?
                """, (self.tenant_id, resource_type))
            else:
                cursor.execute("""
                    DELETE FROM pipo_cache WHERE tenant_id = ?
                """, (self.tenant_id,))

            conn.commit()

    async def cleanup_expired(self):
        """Remove expired entries (run periodically)"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                DELETE FROM pipo_cache WHERE expires_at < CURRENT_TIMESTAMP
            """)
            conn.commit()
```

---

### 3. LangGraph Checkpointer for HANA

```python
from langgraph.checkpoint.base import BaseCheckpointSaver, Checkpoint, CheckpointMetadata
from typing import Optional, Iterator, Tuple
import pickle

class HANACheckpointer(BaseCheckpointSaver):
    """LangGraph checkpoint saver using HANA Cloud"""

    def __init__(self, connection_params: dict, tenant_id: str):
        super().__init__()
        self.conn_params = connection_params
        self.tenant_id = tenant_id

    def _get_connection(self):
        from hdbcli import dbapi
        return dbapi.connect(**self.conn_params)

    def put(
        self,
        config: dict,
        checkpoint: Checkpoint,
        metadata: CheckpointMetadata,
    ) -> dict:
        """Save checkpoint to HANA"""
        thread_id = config["configurable"]["thread_id"]
        checkpoint_ns = config["configurable"].get("checkpoint_ns", "")
        checkpoint_id = checkpoint["id"]
        parent_id = config["configurable"].get("checkpoint_id")

        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                UPSERT langgraph_checkpoints
                (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, tenant_id, checkpoint, metadata)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                WITH PRIMARY KEY
            """, (
                thread_id,
                checkpoint_ns,
                checkpoint_id,
                parent_id,
                self.tenant_id,
                pickle.dumps(checkpoint),
                json.dumps(metadata) if metadata else None
            ))
            conn.commit()

        return {
            "configurable": {
                "thread_id": thread_id,
                "checkpoint_ns": checkpoint_ns,
                "checkpoint_id": checkpoint_id,
            }
        }

    def get_tuple(self, config: dict) -> Optional[Tuple[Checkpoint, dict]]:
        """Load checkpoint from HANA"""
        thread_id = config["configurable"]["thread_id"]
        checkpoint_ns = config["configurable"].get("checkpoint_ns", "")
        checkpoint_id = config["configurable"].get("checkpoint_id")

        with self._get_connection() as conn:
            cursor = conn.cursor()

            if checkpoint_id:
                cursor.execute("""
                    SELECT checkpoint, metadata, parent_checkpoint_id
                    FROM langgraph_checkpoints
                    WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ? AND tenant_id = ?
                """, (thread_id, checkpoint_ns, checkpoint_id, self.tenant_id))
            else:
                # Get latest checkpoint
                cursor.execute("""
                    SELECT checkpoint, metadata, checkpoint_id, parent_checkpoint_id
                    FROM langgraph_checkpoints
                    WHERE thread_id = ? AND checkpoint_ns = ? AND tenant_id = ?
                    ORDER BY created_at DESC
                    LIMIT 1
                """, (thread_id, checkpoint_ns, self.tenant_id))

            row = cursor.fetchone()
            if not row:
                return None

            checkpoint = pickle.loads(row[0])
            metadata = json.loads(row[1]) if row[1] else {}

            return checkpoint, {
                "configurable": {
                    "thread_id": thread_id,
                    "checkpoint_ns": checkpoint_ns,
                    "checkpoint_id": row[2] if len(row) > 3 else checkpoint_id,
                }
            }

    def list(self, config: dict) -> Iterator[Tuple[Checkpoint, dict]]:
        """List all checkpoints for a thread"""
        thread_id = config["configurable"]["thread_id"]
        checkpoint_ns = config["configurable"].get("checkpoint_ns", "")

        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT checkpoint, metadata, checkpoint_id
                FROM langgraph_checkpoints
                WHERE thread_id = ? AND checkpoint_ns = ? AND tenant_id = ?
                ORDER BY created_at DESC
            """, (thread_id, checkpoint_ns, self.tenant_id))

            for row in cursor.fetchall():
                checkpoint = pickle.loads(row[0])
                yield checkpoint, {
                    "configurable": {
                        "thread_id": thread_id,
                        "checkpoint_ns": checkpoint_ns,
                        "checkpoint_id": row[2],
                    }
                }
```

---

### 4. Vector Search for Smart Migration Suggestions

```python
class HANAVectorSearch:
    """Semantic search over PI/PO artifacts using HANA Vector Engine"""

    def __init__(self, connection_params: dict, tenant_id: str, embedding_client):
        self.conn_params = connection_params
        self.tenant_id = tenant_id
        self.embedding_client = embedding_client  # OpenAI, Bedrock, etc.

    async def index_ico(self, ico_id: str, ico_data: dict):
        """Index ICO content for semantic search"""
        # Create searchable text from ICO structure
        text_content = self._ico_to_text(ico_data)

        # Generate embedding
        embedding = await self.embedding_client.embed(text_content)

        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                UPSERT pipo_embeddings
                (tenant_id, resource_type, resource_id, chunk_index, content_text, embedding, metadata)
                VALUES (?, 'ico', ?, 0, ?, TO_REAL_VECTOR(?), ?)
                WITH PRIMARY KEY
            """, (
                self.tenant_id,
                ico_id,
                text_content,
                str(embedding),  # HANA expects string format for vector
                json.dumps({"ico_name": ico_data.get("name")})
            ))
            conn.commit()

    async def search_similar(self, query: str, top_k: int = 5) -> list[dict]:
        """Find similar PI/PO artifacts by semantic search"""
        query_embedding = await self.embedding_client.embed(query)

        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT resource_type, resource_id, content_text, metadata,
                       COSINE_SIMILARITY(embedding, TO_REAL_VECTOR(?)) AS similarity
                FROM pipo_embeddings
                WHERE tenant_id = ?
                ORDER BY similarity DESC
                LIMIT ?
            """, (str(query_embedding), self.tenant_id, top_k))

            results = []
            for row in cursor.fetchall():
                results.append({
                    "resource_type": row[0],
                    "resource_id": row[1],
                    "content": row[2],
                    "metadata": json.loads(row[3]) if row[3] else {},
                    "similarity": row[4]
                })
            return results

    def _ico_to_text(self, ico_data: dict) -> str:
        """Convert ICO structure to searchable text"""
        parts = [
            f"ICO: {ico_data.get('name', '')}",
            f"Description: {ico_data.get('description', '')}",
            f"Sender: {ico_data.get('senderComponent', '')} / {ico_data.get('senderInterface', '')}",
            f"Receiver: {ico_data.get('receiverComponent', '')} / {ico_data.get('receiverInterface', '')}",
        ]
        if ico_data.get('mappingProgram'):
            parts.append(f"Mapping: {ico_data['mappingProgram']}")
        return "\n".join(parts)
```

---

### 5. Updated Service Requirements

| Service | Plan | Purpose | Cost |
|---------|------|---------|------|
| SAP HANA Cloud | hana (free tier for dev) | State, cache, vectors | Free (dev) / $500+ (prod) |
| saas-registry | application | Multi-tenant subscriptions | Free |
| xsuaa | broker | Tenant-aware auth | Free |
| destination | lite | PI/PO + IS connectivity | Free |
| connectivity | lite | Cloud Connector tunnel | Free |

### MTA Resource for HANA Cloud

```yaml
resources:
  - name: pipo-migration-hdi
    type: com.sap.xs.hdi-container
    parameters:
      service: hana
      service-plan: hdi-shared  # Uses existing HANA Cloud instance
    properties:
      hdi-service-name: ${service-name}
```

---

## Summary

With HANA Cloud you consolidate everything into one service:

- **LangGraph state** → `langgraph_checkpoints` table
- **Discovery cache** → `pipo_cache` table with JSON + TTL
- **Vector search** → `pipo_embeddings` with HANA Vector Engine
- **No Redis needed** — HANA's in-memory processing handles fast cache reads

The trade-off is cost: HANA Cloud Free Tier works for dev but production requires paid tier. If budget is tight, PostgreSQL (~$50/mo) + application-level caching is the practical alternative.

---

## Complete PI/PO Artifact Catalog for Migration

Based on SAP documentation and the SAP PI MCP server implementation, here's the comprehensive breakdown:

### 1. Enterprise Services Repository (ESR) Artifacts

The ESR contains all design-time objects. These are accessed via:
- SOAP services: `/rep/support/SimpleQuery`, `/rep/read/ext`
- ESR API endpoint: `/dir/services/` + specific service WSDLs

| Artifact Type | ESR Object Code | API/Endpoint | Migration Relevance |
|--------------|-----------------|--------------|---------------------|
| Data Types | XI_DTYPE | SimpleQuery + read/ext | Core - schema definitions |
| Message Types | XI_MTYPE | SimpleQuery + read/ext | Core - message structure |
| Service Interfaces | XI_SVCIF | ServiceInterfaceInService | Core - interface definition |
| Message Mappings | XI_TRAFO | SimpleQuery + read/ext (no SOAP service) | Core - transformation logic |
| Operation Mappings | XI_OPMAP | OperationMappingInService | Core - links interfaces to mappings |
| XSLT Mappings | XI_XSLT | SimpleQuery + read/ext | Core - XSLT transformations |
| Java Mappings | XI_JAVAMAP | SimpleQuery + read/ext | Core - Java transformation code |
| Function Libraries | XI_FUNCLIB | SimpleQuery + read/ext | Supporting - UDFs |
| Imported Archives | XI_IMP_ARC | SimpleQuery + read/ext | Supporting - Java libs |
| External Definitions | XI_EXT_DEF | SimpleQuery + read/ext | Supporting - XSDs, WSDLs |
| Context Objects | XI_CONTEXT | SimpleQuery + read/ext | Supporting - routing context |
| IDoc Definitions | XI_IDOC | SimpleQuery + read/ext | Supporting - IDoc metadata |
| RFC Definitions | XI_RFC | SimpleQuery + read/ext | Supporting - RFC metadata |
| Integration Processes (ccBPM) | XI_IP | SimpleQuery + read/ext | Complex - BPM workflows |
| Fault Message Types | XI_FAULT | SimpleQuery + read/ext | Error handling |

#### ESR API Endpoints

```javascript
const ESR_ENDPOINTS = {
    // SOAP Services (WSDL-based)
    "ServiceInterfaceInService": "/rep/services/ServiceInterfaceInService?wsdl",
    "OperationMappingInService": "/rep/services/OperationMappingInService?wsdl",
    "DataTypeInService": "/rep/services/DataTypeInService?wsdl",
    "MessageTypeInService": "/rep/services/MessageTypeInService?wsdl",

    // Generic Query/Read (for all object types)
    "SimpleQuery": "/rep/support/SimpleQuery",
    "ReadObject": "/rep/read/ext",  // method=PLAIN&TYPE=<object_code>&...

    // Software Component Versions
    "SoftwareComponentVersionQuery": "/rep/services/SoftwareComponentVersionInService?wsdl",
};
```

### 2. Integration Directory (ID) Artifacts

The ID contains configuration-time objects that define how messages flow at runtime.

| Artifact Type | API Service | Purpose | Migration Relevance |
|--------------|-------------|---------|---------------------|
| Integrated Configurations (ICO) | IntegratedConfigurationInService | Main routing config | Core - primary migration unit |
| Communication Channels | CommunicationChannelInService | Adapter configuration | Core - endpoint settings |
| Sender Agreements | SenderAgreementInService | Inbound agreement | Core - security/protocol |
| Receiver Agreements | ReceiverAgreementInService | Outbound agreement | Core - security/protocol |
| Receiver Determinations | ReceiverDeterminationInService | Routing rules | Core - routing logic |
| Interface Determinations | InterfaceDeterminationInService | Interface routing | Core - interface selection |
| Configuration Scenarios | ConfigurationScenarioInService | Scenario grouping | Organizational |
| Value Mappings | ValueMappingInService | Code translation | Core - lookup tables |
| Alert Rules | AlertRuleInService | Monitoring rules | Supporting - alerting |
| Parties | PartyInService | Business partner | Organizational |
| Communication Components | CommunicationComponentInService | System endpoints | Core - system reference |

#### Integration Directory API Endpoints

```javascript
const ID_ENDPOINTS = {
    // Core Configuration
    "IntegratedConfigurationInService": "/dir/services/IntegratedConfigurationInService?wsdl",
    "IntegratedConfiguration750InService": "/dir/services/IntegratedConfiguration750InService?wsdl",  // 7.50+

    // Channels & Agreements
    "CommunicationChannelInService": "/dir/services/CommunicationChannelInService?wsdl",
    "SenderAgreementInService": "/dir/services/SenderAgreementInService?wsdl",
    "ReceiverAgreementInService": "/dir/services/ReceiverAgreementInService?wsdl",

    // Routing
    "ReceiverDeterminationInService": "/dir/services/ReceiverDeterminationInService?wsdl",
    "InterfaceDeterminationInService": "/dir/services/InterfaceDeterminationInService?wsdl",

    // Supporting
    "ValueMappingInService": "/dir/services/ValueMappingInService?wsdl",
    "ConfigurationScenarioInService": "/dir/services/ConfigurationScenarioInService?wsdl",
    "AlertRuleInService": "/AlertRuleInService?wsdl",

    // Organizational
    "PartyInService": "/dir/services/PartyInService?wsdl",
    "CommunicationComponentInService": "/dir/services/CommunicationComponentInService?wsdl",
};
```

### 3. System Landscape Directory (SLD) Artifacts

The SLD contains landscape metadata — technical and business systems info.

| Artifact Type | API/Interface | Purpose | Migration Relevance |
|--------------|---------------|---------|---------------------|
| Technical Systems | SLD HTTP API / CIM | Physical system entries | Metadata - system inventory |
| Business Systems | SLD HTTP API / CIM | Logical system names | Core - endpoint mapping |
| Products | SLD HTTP API | Installed products | Metadata - versions |
| Software Components | SLD HTTP API | SWCV definitions | Core - version tracking |
| Software Component Versions | SLD HTTP API | Version registry | Core - artifact versioning |
| System Landscapes | SLD HTTP API | Landscape groupings | Metadata - organization |
| Name Reservations | SLD HTTP API | Namespace registry | Metadata |

#### SLD API Endpoints

```javascript
const SLD_ENDPOINTS = {
    // CIM-based HTTP API
    "TechnicalSystems": "/sld/cimom/jndi?method=read&class=SAP_BCTechnicalSystem",
    "BusinessSystems": "/sld/cimom/jndi?method=read&class=SAP_BCBusinessSystem",
    "SoftwareComponentVersions": "/sld/cimom/jndi?method=read&class=SAP_SoftwareComponentVersion",
    "Products": "/sld/cimom/jndi?method=read&class=SAP_Product",

    // REST-ish endpoints (newer)
    "TechnicalSystemsREST": "/sld/api/TechnicalSystems",
    "BusinessSystemsREST": "/sld/api/BusinessSystems",

    // For querying registered systems
    "SystemQuery": "/sld/cimom/query",
};
```

### 4. Configuration & Runtime Artifacts

Additional runtime/config artifacts not in ESR/ID/SLD:

| Artifact Type | Source | Purpose | Migration Relevance |
|--------------|--------|---------|---------------------|
| Adapter Metadata | Adapter Framework | Adapter configurations | Supporting - adapter params |
| Module Configurations | Adapter Framework | Module chain settings | Core - processing steps |
| Cache Configurations | Runtime Cache | Cache settings | Operational |
| Message Logs | PIMON / Message Monitor | Historical messages | Analysis - testing |
| Alert Configurations | Alert Framework | Alert subscriptions | Supporting |
| User Mappings | Identity Management | Certificate/user maps | Security |
| Secure Storage | Credential Store | Passwords, keys | Security - credentials |

#### Runtime & Monitoring Endpoints

```javascript
const RUNTIME_ENDPOINTS = {
    // Adapter Framework
    "ChannelAdminServlet": "/AdapterFramework/ChannelAdminServlet",
    "AdapterMessageMonitoring": "/mdt/MessageList",

    // Message Monitoring (PIMON)
    "MessageSearch": "/mdt/MessageSearchServlet",
    "MessageDetails": "/mdt/MessageDetails",

    // BPM/Process Monitoring
    "BPMFacadeBean": "/BPMFacadeBeanImplService",

    // Runtime Cache
    "RuntimeCacheMonitor": "/rwb/CacheMonitor",
};
```

### 5. Complete JavaScript Data Model for Caching

```javascript
/**
 * PI/PO Artifact Types and Cache Models
 * For use in SDAINT-AI Discovery Service
 */

const ArtifactSource = {
    ESR: "esr",
    ID: "integration_directory",
    SLD: "system_landscape",
    CONFIG: "configuration",
    RUNTIME: "runtime"
};

const ArtifactType = {
    // ESR Types
    DATA_TYPE: "XI_DTYPE",
    MESSAGE_TYPE: "XI_MTYPE",
    SERVICE_INTERFACE: "XI_SVCIF",
    MESSAGE_MAPPING: "XI_TRAFO",
    OPERATION_MAPPING: "XI_OPMAP",
    XSLT_MAPPING: "XI_XSLT",
    JAVA_MAPPING: "XI_JAVAMAP",
    FUNCTION_LIBRARY: "XI_FUNCLIB",
    IMPORTED_ARCHIVE: "XI_IMP_ARC",
    EXTERNAL_DEFINITION: "XI_EXT_DEF",
    CONTEXT_OBJECT: "XI_CONTEXT",
    IDOC_DEFINITION: "XI_IDOC",
    RFC_DEFINITION: "XI_RFC",
    INTEGRATION_PROCESS: "XI_IP",

    // ID Types
    ICO: "ICO",
    COMMUNICATION_CHANNEL: "CHANNEL",
    SENDER_AGREEMENT: "SENDER_AGR",
    RECEIVER_AGREEMENT: "RECEIVER_AGR",
    RECEIVER_DETERMINATION: "RECEIVER_DET",
    INTERFACE_DETERMINATION: "INTERFACE_DET",
    VALUE_MAPPING: "VALUE_MAP",
    CONFIGURATION_SCENARIO: "CONFIG_SCENARIO",
    PARTY: "PARTY",
    COMMUNICATION_COMPONENT: "COMM_COMP",

    // SLD Types
    BUSINESS_SYSTEM: "BUSINESS_SYS",
    TECHNICAL_SYSTEM: "TECHNICAL_SYS",
    SOFTWARE_COMPONENT_VERSION: "SWCV",
    PRODUCT: "PRODUCT"
};

/**
 * Base artifact model for caching
 */
class PIPOArtifact {
    constructor(data = {}) {
        this.artifact_id = data.artifact_id || '';
        this.artifact_type = data.artifact_type || '';
        this.source = data.source || '';
        this.name = data.name || '';
        this.namespace = data.namespace || '';
        this.software_component_version = data.software_component_version || null;
        this.description = data.description || null;
        this.raw_data = data.raw_data || {};
        this.dependencies = data.dependencies || [];
        this.dependents = data.dependents || [];
        this.last_modified = data.last_modified || null;
        this.responsible_user = data.responsible_user || null;

        // Cache metadata
        this.cached_at = data.cached_at || new Date();
        this.cache_version = data.cache_version || 1;
        this.etag = data.etag || null;
    }
}

/**
 * Integrated Configuration Object
 */
class ICOArtifact extends PIPOArtifact {
    constructor(data = {}) {
        super(data);
        this.sender_party = data.sender_party || null;
        this.sender_component = data.sender_component || '';
        this.sender_interface = data.sender_interface || '';
        this.sender_namespace = data.sender_namespace || '';
        this.receivers = data.receivers || [];
        this.operation_mappings = data.operation_mappings || [];
        this.channels = data.channels || [];
        this.routing_conditions = data.routing_conditions || [];
        this.is_active = data.is_active !== false;
    }
}

/**
 * Communication Channel
 */
class ChannelArtifact extends PIPOArtifact {
    constructor(data = {}) {
        super(data);
        this.party = data.party || null;
        this.component = data.component || '';
        this.adapter_type = data.adapter_type || '';
        this.direction = data.direction || '';  // SENDER or RECEIVER
        this.protocol = data.protocol || '';
        this.transport_protocol = data.transport_protocol || '';
        this.message_protocol = data.message_protocol || '';
        this.adapter_specific_params = data.adapter_specific_params || {};
        this.module_chain = data.module_chain || [];
    }
}

/**
 * Message/Operation Mapping
 */
class MappingArtifact extends PIPOArtifact {
    constructor(data = {}) {
        super(data);
        this.mapping_type = data.mapping_type || '';  // message, operation, xslt, java
        this.source_interface = data.source_interface || null;
        this.target_interface = data.target_interface || null;
        this.source_message = data.source_message || null;
        this.target_message = data.target_message || null;
        this.uses_function_library = data.uses_function_library || [];
        this.uses_imported_archive = data.uses_imported_archive || [];
        this.uses_value_mapping = data.uses_value_mapping || false;
        this.generated_java_source = data.generated_java_source || null;
        this.mapping_definition = data.mapping_definition || null;
    }
}

/**
 * SLD Business System
 */
class BusinessSystemArtifact extends PIPOArtifact {
    constructor(data = {}) {
        super(data);
        this.technical_system = data.technical_system || '';
        this.system_role = data.system_role || '';  // Development, Test, Production
        this.client = data.client || null;
        this.url = data.url || null;
        this.integration_server_of = data.integration_server_of || null;
    }
}

/**
 * Value Mapping
 */
class ValueMappingArtifact extends PIPOArtifact {
    constructor(data = {}) {
        super(data);
        this.group_name = data.group_name || '';
        this.representations = data.representations || [];
        this.master_language = data.master_language || 'EN';
    }
}

module.exports = {
    ArtifactSource,
    ArtifactType,
    PIPOArtifact,
    ICOArtifact,
    ChannelArtifact,
    MappingArtifact,
    BusinessSystemArtifact,
    ValueMappingArtifact
};
```

### 6. HANA Cache Schema for All Artifacts

```sql
-- Main artifact cache table (polymorphic)
CREATE TABLE pipo_artifacts (
    tenant_id NVARCHAR(64) NOT NULL,
    artifact_id NVARCHAR(512) NOT NULL,
    artifact_type NVARCHAR(32) NOT NULL,  -- From ArtifactType enum
    source NVARCHAR(32) NOT NULL,  -- ESR, ID, SLD, CONFIG, RUNTIME

    -- Identity
    name NVARCHAR(512) NOT NULL,
    namespace NVARCHAR(512),
    swcv NVARCHAR(256),  -- Software Component Version

    -- Metadata
    description NCLOB,
    responsible_user NVARCHAR(128),
    last_modified TIMESTAMP,

    -- Full data (JSON)
    raw_data JSON NOT NULL,

    -- Dependencies (JSON arrays of artifact_ids)
    dependencies JSON,
    dependents JSON,

    -- Cache control
    cached_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    cache_version INTEGER DEFAULT 1,
    etag NVARCHAR(128),
    expires_at TIMESTAMP NOT NULL,

    PRIMARY KEY (tenant_id, artifact_id)
);

-- Indexes for common queries
CREATE INDEX idx_artifact_type ON pipo_artifacts(tenant_id, artifact_type);
CREATE INDEX idx_artifact_source ON pipo_artifacts(tenant_id, source);
CREATE INDEX idx_artifact_namespace ON pipo_artifacts(tenant_id, namespace);
CREATE INDEX idx_artifact_name ON pipo_artifacts(tenant_id, name);
CREATE INDEX idx_artifact_expiry ON pipo_artifacts(expires_at);

-- ICO-specific view for quick lookups
CREATE VIEW v_icos AS
SELECT
    tenant_id,
    artifact_id,
    name,
    namespace,
    JSON_VALUE(raw_data, '$.sender_component') as sender_component,
    JSON_VALUE(raw_data, '$.sender_interface') as sender_interface,
    JSON_VALUE(raw_data, '$.is_active') as is_active,
    cached_at
FROM pipo_artifacts
WHERE artifact_type = 'ICO';

-- Channel view
CREATE VIEW v_channels AS
SELECT
    tenant_id,
    artifact_id,
    name,
    JSON_VALUE(raw_data, '$.component') as component,
    JSON_VALUE(raw_data, '$.adapter_type') as adapter_type,
    JSON_VALUE(raw_data, '$.direction') as direction,
    JSON_VALUE(raw_data, '$.protocol') as protocol,
    cached_at
FROM pipo_artifacts
WHERE artifact_type = 'CHANNEL';

-- Business systems view
CREATE VIEW v_business_systems AS
SELECT
    tenant_id,
    artifact_id,
    name,
    JSON_VALUE(raw_data, '$.technical_system') as technical_system,
    JSON_VALUE(raw_data, '$.system_role') as system_role,
    JSON_VALUE(raw_data, '$.url') as url,
    cached_at
FROM pipo_artifacts
WHERE artifact_type = 'BUSINESS_SYS';

-- Dependency graph for impact analysis
CREATE TABLE pipo_dependency_graph (
    tenant_id NVARCHAR(64) NOT NULL,
    source_artifact_id NVARCHAR(512) NOT NULL,
    target_artifact_id NVARCHAR(512) NOT NULL,
    dependency_type NVARCHAR(64),  -- uses_mapping, uses_channel, references, etc.
    PRIMARY KEY (tenant_id, source_artifact_id, target_artifact_id)
);

CREATE INDEX idx_dep_source ON pipo_dependency_graph(tenant_id, source_artifact_id);
CREATE INDEX idx_dep_target ON pipo_dependency_graph(tenant_id, target_artifact_id);
```

### 7. Cache TTL Summary

| Area | Artifacts | TTL (hours) | Priority |
|------|-----------|-------------|----------|
| ESR | Message Mappings, Operation Mappings, Service Interfaces, Data/Message Types, Java/XSLT Mappings, Function Libraries, Imported Archives | 24 | High |
| Integration Directory | ICOs, Channels, Value Mappings, Sender/Receiver Agreements, Configuration Scenarios | 12 | High |
| SLD | Business Systems, Technical Systems, Software Component Versions | 48 | Medium |
| Runtime | Channel status, Message logs (recent) | 1 | Low (operational) |

The discovery service covers all artifact types from ESR, Integration Directory, and SLD. The dependency graph enables impact analysis ("what's affected if I change this mapping?").

---


---

## Artifact Migration Analysis: What to Import vs. Skip

Based on research from the repo and SAP documentation:

### Summary Table

| Artifact | Import? | Reason | Migration Approach |
|----------|---------|--------|-------------------|
| **Alert Rules** | ❌ NO | Monitoring config, not integration logic. IS has its own alerting. | Recreate in IS Alert Notification Service |
| **Parties** | ⚠️ CONDITIONAL | Only for B2B/EDI with Trading Partner Management. Not needed for A2A. | Map to IS Trading Partner profiles |
| **Module Configurations** | ✅ YES | Critical processing logic (encoding, formatting, custom modules) | Extract for analysis; rebuild as Groovy/adapter configs |
| **Credential Mappings** | 📋 INVENTORY | Cannot migrate credentials. But references useful for planning. | Inventory for manual recreation in IS Security Material |

### 1. Alert Rules — NOT NEEDED

Alert rules are operational monitoring configurations, not integration artifacts. SAP Integration Suite has its own alerting via Alert Notification Service and Integration Advisor.

**Recommendation:** Skip import. Document requirements and recreate in IS.

### 2. Parties — CONDITIONAL (B2B Only)

**When Needed:**
- ✅ YES: B2B/EDI scenarios (AS2, SFTP with trading partners, EDI X12/EDIFACT)
- ❌ NO: Just organizational groupings for internal A2A integration

**What to Extract:**
```javascript
{
  partyId: string,
  partyName: string,
  partyAgency: string,      // "DUNS", "GLN"
  identifiers: [],          // Identifier schemes
  communicationChannels: [],
  contacts: [],
  certificates: []          // References, not actual certs
}
```

**Migration Path:** Party → IS Trading Partner Profile

### 3. Module Configurations — CRITICAL

Module configurations define adapter-level processing logic:
- Encoding (PayloadSwapBean, XMLAnonymizer)
- Compression
- Custom enterprise beans

**Common PI/PO Modules → IS Equivalent:**

| PI/PO Module | Integration Suite Equivalent |
|--------------|------------------------------|
| PayloadSwapBean | Content Modifier / Groovy Script |
| XMLAnonymizer | XSLT / Groovy Script |
| MessageTransformBean | Content Modifier |
| TextCodec | Encoder step |
| Custom Java Modules | Groovy Script wrapper |

### 4. Credential Mappings — INVENTORY ONLY

**Why NOT import actual credentials:**
- Security-sensitive data
- Cannot be exported from PI/PO secure storage
- Should never be migrated as-is (rotation policies, different key stores)

**What TO Extract (Inventory):**
```javascript
{
  credentialAlias: string,     // Name/alias in secure storage
  credentialType: string,      // "Password", "Certificate", "KeyPair", "OAuth"
  usedByChannels: [],          // Which channels reference it
  usedByAgreements: [],        // Which agreements reference it
  authType: string             // "Basic", "Certificate", "OAuth2"
}
```

**Use for:**
- Planning: Know which credentials need recreation in IS Security Material
- Checklist: Ensure all security material configured before go-live
- Mapping: Document IS security artifact ↔ PI/PO credential correspondence

### Discovery Priority Order

| Priority | Artifact Type | Action | Reason |
|----------|--------------|--------|--------|
| 1 | ICOs | ✅ Full import | Primary migration unit |
| 2 | Message Mappings | ✅ Full import | Core transformation logic |
| 3 | Channels + Module Configs | ✅ Full import | Endpoint + processing logic |
| 4 | Value Mappings | ✅ Full import | Code translation tables |
| 5 | Service Interfaces | ✅ Full import | Interface definitions |
| 6 | Business Systems (SLD) | ✅ Full import | System landscape mapping |
| 7 | Credential References | 📋 Inventory | Security planning |
| 8 | Parties | ⚠️ Conditional | Only for B2B scenarios |
| 9 | Alert Rules | ❌ Skip | Recreate in IS |

---


## Gap Analysis: Implementation Status

Based on review of the codebase against this north star document, here are identified gaps:

### 🔴 CRITICAL GAPS (Must Add)

#### 1. Module Configurations — NEEDS SCHEMA
**Current state:** `pipoClientImproved.js` has extraction methods, but CDS schema incomplete.

**Gap:** Need full CDS entity for module configurations:
```cds
entity ModuleConfiguration : cuid {
  tenant       : Association to Tenant;
  channelId    : String(512);
  moduleKey    : String(128);
  moduleName   : String(256);  // e.g., "AF_Modules/PayloadSwapBean"
  moduleType   : String(64);   // "Local Enterprise Bean", "Module"
  parameters   : LargeString;  // JSON
  processingSequence : Integer;
  cachedAt     : Timestamp;
}
```

#### 2. Credential Inventory — NEEDS SCHEMA
**Current state:** Extraction method exists in `pipoClientImproved.js`.

**Gap:** Need CDS entity:
```cds
entity CredentialInventory : cuid {
  tenant           : Association to Tenant;
  credentialAlias  : String(256);
  credentialType   : String(64);   // Password, Certificate, KeyPair, OAuth
  authType         : String(64);   // Basic, Certificate, OAuth2
  referencedBy     : LargeString;  // JSON array of channel/agreement IDs
  migrationStatus  : String(32) default 'pending';  // pending, created, verified
  isEquivalent     : String(256);  // Corresponding IS Security Material
  notes            : LargeString;
}
```

#### 3. Dependency Graph — MISSING
**Current state:** No implementation.

**Gap:** Need for impact analysis:
```cds
entity DependencyGraph : cuid {
  tenant            : Association to Tenant;
  sourceArtifactId  : String(512);
  targetArtifactId  : String(512);
  dependencyType    : String(64);  // uses_mapping, uses_channel, references_interface
}
```

### 🟠 IMPORTANT GAPS (Should Add)

#### 4. Party Artifact — NEEDS ENHANCEMENT
**Current state:** Basic entity exists, extraction methods exist.

**Gap:** Missing B2B-specific fields:
- `partyAgency` (DUNS, GLN)
- `identifiers` (array of scheme/value)
- `certificates` (alias references)

#### 5. Migration Assessment Model — MISSING
**Gap:** No scoring/readiness tracking:
```cds
entity MigrationAssessment : cuid {
  tenant              : Association to Tenant;
  artifactId          : String(512);
  artifactType        : String(32);
  migrationScore      : Integer;           // 0-100
  isAutoMigratable    : Boolean;
  unsupportedFeatures : LargeString;       // JSON array
  manualEffortHours   : Decimal(10,2);
  riskLevel           : String(16);        // low, medium, high
  recommendations     : LargeString;       // JSON
  assessedAt          : Timestamp;
}
```

#### 6. Integration Suite Target Model — MISSING
**Gap:** No tracking of converted artifacts:
```cds
entity IFlowArtifact : cuid {
  tenant              : Association to Tenant;
  iflowId             : String(256);
  packageId           : String(256);
  name                : String(256);
  version             : String(32) default '1.0.0';
  status              : String(32);        // draft, deployed, active
  sourceIcoId         : String(512);       // Link to PI/PO ICO
  conversionNotes     : LargeString;       // JSON
  manualChanges       : LargeString;       // JSON
  deploymentResult    : LargeString;       // JSON
}
```

### 🟡 MINOR GAPS (Nice to Have)

#### 7. Cache TTL Strategy — UNDOCUMENTED
Different artifact types should have different TTLs:
```javascript
const CACHE_TTL = {
  DATA_TYPE: 48 * 60 * 60,           // 48 hours (static)
  MESSAGE_TYPE: 48 * 60 * 60,
  ICO: 24 * 60 * 60,                 // 24 hours (moderate)
  COMMUNICATION_CHANNEL: 12 * 60 * 60,  // 12 hours (volatile)
  DISCOVERY_SUMMARY: 6 * 60 * 60,    // 6 hours
};
```

#### 8. Error Handling Model — MISSING
No retry/recovery strategy documented.

### 📋 Implementation Checklist

| Gap | Priority | Status | File to Update |
|-----|----------|--------|----------------|
| Module Config Schema | 🔴 Critical | ⬜ TODO | `db/tenant-schema.cds` |
| Credential Inventory Schema | 🔴 Critical | ⬜ TODO | `db/tenant-schema.cds` |
| Dependency Graph | 🔴 Critical | ⬜ TODO | `db/tenant-schema.cds`, `srv/discovery-service.js` |
| Party B2B Fields | 🟠 Important | ⬜ TODO | `db/tenant-schema.cds` |
| Migration Assessment | 🟠 Important | ⬜ TODO | `db/tenant-schema.cds`, new service |
| IFlow Target Model | 🟠 Important | ⬜ TODO | `db/tenant-schema.cds`, new service |
| Cache TTL Strategy | 🟡 Minor | ⬜ TODO | `srv/utils/hanaCache.js` |
| Error Handling | 🟡 Minor | ⬜ TODO | New utility |

---


## Enterprise Messaging vs. In-App Job Queue

### The Pain Point This Solves

PI/PO migration analysis is **slow** — a single ICO assessment takes 2-5 minutes (discovery calls, mapping analysis, dependency resolution). Without async processing:

```
User clicks "Analyze" → Browser waits 5 min → HTTP timeout (504) → User retries → Frustration
```

**The core problem:** Long-running operations don't fit the HTTP request/response model.

### Benefits of Having Async Job Queue

| Benefit | What It Means |
|---------|---------------|
| **No timeouts** | Jobs run to completion regardless of HTTP limits (CF default: 60s) |
| **User sees progress** | UI can poll status, show "Step 3/7: Analyzing mappings..." |
| **Restartability** | If app restarts mid-job, job resumes from HANA state |
| **Auditability** | Every job logged with tenant, duration, success/failure |
| **Throttling** | Process one job at a time, prevent resource exhaustion |
| **Cancellation** | User can abort a stuck job without killing the app |

### Risks of NOT Having It

| Risk | Impact | Likelihood |
|------|--------|------------|
| **HTTP timeouts** | Users get 504 errors on large PI/PO systems | 🔴 High — any system with 50+ ICOs |
| **Lost work** | App restart = in-flight analysis lost, no recovery | 🟠 Medium — happens on deploys |
| **No visibility** | "Is it still running or frozen?" — users don't know | 🔴 High — UX nightmare |
| **Resource contention** | 3 users start analysis simultaneously = OOM crash | 🟠 Medium — depends on tenant count |
| **No retry** | Transient PI/PO API failure = user must restart from scratch | 🟠 Medium |

### When You Can Skip It

- **Prototype/demo phase** — just accept the wait
- **Single-user tool** — no contention, user can wait
- **Jobs under 30 seconds** — HTTP response is fine

### Bottom Line

If your migration analysis takes **>60 seconds** (it will), you need async processing. The question is: pay for Enterprise Messaging or build a simple DB-backed queue?

For <10 concurrent tenants, the DB queue costs nothing and works fine. Enterprise Messaging becomes worth it when you need exactly-once delivery, multiple worker instances, or high throughput.

---

### Why Enterprise Messaging Exists

- Decouple long jobs from HTTP requests
- Handle spikes (queue jobs, process later)
- Reliable delivery if worker crashes

### Why You Likely Don't Need It

With few simultaneous tenants, just run migrations synchronously or with simple in-app background jobs:

```javascript
// Option 1: Synchronous (simplest)
srv.on('runMigration', async (req) => {
    const result = await analyzePIPO(req.data);  // Takes 2-5 min
    return result;  // Client waits
});

// Option 2: Simple async with status polling
srv.on('startMigration', async (req) => {
    const jobId = uuid();

    // Store job, return immediately
    await INSERT.into(Jobs).entries({ id: jobId, status: 'running', tenant: req.tenant });

    // Run in background (no message queue needed)
    setImmediate(async () => {
        try {
            const result = await analyzePIPO(req.data);
            await UPDATE(Jobs).set({ status: 'done', result }).where({ id: jobId });
        } catch (e) {
            await UPDATE(Jobs).set({ status: 'failed', error: e.message }).where({ id: jobId });
        }
    });

    return { jobId };
});

// Client polls this
srv.on('getJobStatus', async (req) => {
    return SELECT.one.from(Jobs).where({ id: req.data.jobId });
});
```

### Comparison

| Approach | Complexity | Cost | Good for |
|----------|------------|------|----------|
| Synchronous | Trivial | $0 | Quick jobs (<30s) |
| setImmediate + polling | Simple | $0 | Few concurrent users |
| Enterprise Messaging | Complex | $10-50/mo | High volume, reliability guarantees |

**Recommendation:** Start with Option 2 (simple async + polling). You can always add Enterprise Messaging later if you scale up. The code change is isolated to how you queue/dequeue — the actual migration logic stays the same.

Delete Enterprise Messaging, save the money, and revisit when you have 10+ tenants running migrations simultaneously.

---

## Pattern: In-App Job Queue with Database State

### How It Works

```
┌─────────────────────────────────────────────────────────────┐
│  AICONX-srv                                                 │
│                                                             │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │  API Layer   │───▶│  Job Table   │◀───│  Worker Loop │  │
│  │  (accepts    │    │  (HANA)      │    │  (polls &    │  │
│  │   requests)  │    │              │    │   executes)  │  │
│  └──────────────┘    └──────────────┘    └──────────────┘  │
│         │                   │                    │          │
│         ▼                   ▼                    ▼          │
│    Returns jobId      Persists state      Runs migration   │
└─────────────────────────────────────────────────────────────┘
```

### The Code

**Schema Definition:**

```sql
-- db/schema.cds
entity MigrationJobs {
    key id        : UUID;
    tenant        : String;
    status        : String enum { queued; running; done; failed };
    jobType       : String;  // 'assessment', 'migration', 'deployment'
    input         : LargeString;  // JSON params
    result        : LargeString;  // JSON output
    error         : LargeString;
    createdAt     : Timestamp;
    startedAt     : Timestamp;
    completedAt   : Timestamp;
}
```

**Job Queue Implementation:**

```javascript
// srv/job-queue.js
const cds = require('@sap/cds');

class JobQueue {
    constructor() {
        this.processing = false;
        this.pollInterval = 5000; // 5 seconds
    }

    // Called at app startup
    start() {
        setInterval(() => this.processNext(), this.pollInterval);
    }

    // API calls this to queue work
    async enqueue(tenant, jobType, input) {
        const { MigrationJobs } = cds.entities;
        const job = {
            id: cds.utils.uuid(),
            tenant,
            jobType,
            status: 'queued',
            input: JSON.stringify(input),
            createdAt: new Date()
        };
        await INSERT.into(MigrationJobs).entries(job);
        return job.id;
    }

    // Worker loop picks up next job
    async processNext() {
        if (this.processing) return;

        const { MigrationJobs } = cds.entities;
        const job = await SELECT.one.from(MigrationJobs)
            .where({ status: 'queued' })
            .orderBy('createdAt asc');

        if (!job) return;

        this.processing = true;
        try {
            await UPDATE(MigrationJobs)
                .set({ status: 'running', startedAt: new Date() })
                .where({ id: job.id });

            const result = await this.execute(job);

            await UPDATE(MigrationJobs)
                .set({ status: 'done', result: JSON.stringify(result), completedAt: new Date() })
                .where({ id: job.id });
        } catch (e) {
            await UPDATE(MigrationJobs)
                .set({ status: 'failed', error: e.message, completedAt: new Date() })
                .where({ id: job.id });
        }
        this.processing = false;
    }

    async execute(job) {
        const input = JSON.parse(job.input);
        switch (job.jobType) {
            case 'assessment': return await runAssessment(input);
            case 'migration':  return await runMigration(input);
            case 'deployment': return await runDeployment(input);
        }
    }
}

module.exports = new JobQueue();
```

**Service Integration:**

```javascript
// srv/migration-service.js
const cds = require('@sap/cds');
const jobQueue = require('./job-queue');

module.exports = cds.service.impl(async function() {

    // Start worker on app boot
    jobQueue.start();

    // Queue a migration (returns immediately)
    this.on('startMigration', async (req) => {
        const jobId = await jobQueue.enqueue(
            req.tenant,
            'migration',
            req.data
        );
        return { jobId, status: 'queued' };
    });

    // Check status (client polls this)
    this.on('getJobStatus', async (req) => {
        const { MigrationJobs } = cds.entities;
        return SELECT.one.from(MigrationJobs).where({ id: req.data.jobId });
    });

    // Cancel a job
    this.on('cancelJob', async (req) => {
        const { MigrationJobs } = cds.entities;
        await UPDATE(MigrationJobs)
            .set({ status: 'failed', error: 'Cancelled by user' })
            .where({ id: req.data.jobId, status: 'queued' });
        return { success: true };
    });
});
```

### Benefits

| Benefit | Why It Matters |
|---------|----------------|
| Non-blocking API | User doesn't wait 5 minutes for HTTP response to complete |
| Survives restarts | Job state is in HANA, not memory — app restart resumes processing |
| Visibility | Query the Jobs table to see all running/queued/failed jobs |
| Tenant isolation | Each job tagged with tenant ID, easy to filter/prioritize |
| Retry capability | Failed jobs can be re-queued with one UPDATE |
| Rate limiting | Process one at a time, or add concurrency controls |
| No extra cost | Uses your existing HANA, no Enterprise Messaging fees |

### When to Upgrade to Enterprise Messaging

| Scenario | Stick with DB Queue | Move to Event Mesh |
|----------|---------------------|-------------------|
| 1-10 concurrent jobs | ✅ | Overkill |
| Migrations take <10 min | ✅ | Overkill |
| Need guaranteed exactly-once | Maybe | ✅ Built-in |
| Multiple worker instances | Gets complex | ✅ Built-in |
| 50+ tenants, high volume | Struggles | ✅ |

### The Upgrade Path is Clean

Replace `jobQueue.enqueue()` with `emit('migration.start', data)` and subscribe the worker to Event Mesh instead of polling HANA. The migration logic itself doesn't change.

---
