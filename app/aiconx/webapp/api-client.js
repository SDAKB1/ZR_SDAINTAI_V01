/**
 * API Client Module - Centralized backend communication for SDAINT-AI Migration Cockpit
 * 
 * Replaces scattered setTimeout mocks with real OData V4 service calls.
 * Provides consistent error handling, CSRF token management, and retry logic.
 * 
 * @module ApiClient
 * @version 1.0.0
 */
const ApiClient = {
    // ─────────────────────────────────────────────────────────────────────────
    // Configuration
    // ─────────────────────────────────────────────────────────────────────────
    config: {
        basePaths: {
            discovery: '/odata/v4/discovery',
            brain: '/odata/v4/brain',
            aiconx: '/odata/v4/aiconx',
            documents: '/odata/v4/documents',
            rapDev: '/odata/v4/rap-dev'
        },
        timeout: 30000,
        retryAttempts: 3,
        retryDelay: 1000
    },

    /** @type {Object.<string, string>} CSRF tokens cached per service path */
    csrfTokens: {},

    // ─────────────────────────────────────────────────────────────────────────
    // CSRF Token Management
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Fetches and caches a CSRF token for the given service path.
     * @param {string} servicePath - The OData service base path
     * @returns {Promise<string|null>} The CSRF token or null if unavailable
     */
    async fetchCsrfToken(servicePath) {
        if (this.csrfTokens[servicePath]) {
            return this.csrfTokens[servicePath];
        }
        try {
            const res = await fetch(`${servicePath}/$metadata`, {
                method: 'HEAD',
                headers: { 'x-csrf-token': 'fetch' },
                credentials: 'same-origin'
            });
            const token = res.headers.get('x-csrf-token');
            if (token) {
                this.csrfTokens[servicePath] = token;
            }
            return token;
        } catch (error) {
            console.warn('[ApiClient] CSRF token fetch failed:', error.message);
            return null;
        }
    },

    /**
     * Invalidates the cached CSRF token for a service path.
     * @param {string} servicePath - The OData service base path
     */
    invalidateCsrfToken(servicePath) {
        delete this.csrfTokens[servicePath];
    },

    // ─────────────────────────────────────────────────────────────────────────
    // Core HTTP Methods
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Calls an OData action (POST) with automatic CSRF handling and retry on 403.
     * @param {string} servicePath - The OData service base path
     * @param {string} actionName - The action name to call
     * @param {Object} [params={}] - The action parameters
     * @returns {Promise<Object>} The parsed JSON response
     * @throws {Error} If the action fails after retries
     */
    async callAction(servicePath, actionName, params = {}) {
        const url = `${servicePath}/${actionName}`;
        
        const makeRequest = async (retryCount = 0) => {
            const token = await this.fetchCsrfToken(servicePath);
            const headers = {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            };
            if (token) {
                headers['x-csrf-token'] = token;
            }

            const res = await fetch(url, {
                method: 'POST',
                headers,
                credentials: 'same-origin',
                body: JSON.stringify(params)
            });

            // Handle CSRF token expiration
            if (res.status === 403 && retryCount === 0) {
                console.log('[ApiClient] CSRF token expired, refreshing...');
                this.invalidateCsrfToken(servicePath);
                return makeRequest(1);
            }

            if (!res.ok) {
                const error = await res.json().catch(() => ({ error: { message: res.statusText } }));
                throw new Error(error.error?.message || `Action failed: ${res.status}`);
            }

            return res.json();
        };

        return makeRequest();
    },

    /**
     * Calls an OData function (GET) with query parameters.
     * @param {string} servicePath - The OData service base path
     * @param {string} functionName - The function name to call
     * @param {Object} [params={}] - The function parameters
     * @returns {Promise<Object>} The parsed JSON response
     * @throws {Error} If the function call fails
     */
    async callFunction(servicePath, functionName, params = {}) {
        const queryString = Object.entries(params)
            .filter(([, v]) => v !== undefined && v !== null)
            .map(([k, v]) => `${k}=${encodeURIComponent(typeof v === 'object' ? JSON.stringify(v) : v)}`)
            .join('&');
        const url = `${servicePath}/${functionName}${queryString ? '?' + queryString : ''}`;
        
        const res = await fetch(url, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
            credentials: 'same-origin'
        });

        if (!res.ok) {
            const error = await res.json().catch(() => ({ error: { message: res.statusText } }));
            throw new Error(error.error?.message || `Function call failed: ${res.status}`);
        }

        return res.json();
    },

    /**
     * Fetches entities from an OData entity set.
     * @param {string} servicePath - The OData service base path
     * @param {string} entitySet - The entity set name
     * @param {Object} [options={}] - Query options ($filter, $select, $orderby, $top, $skip)
     * @returns {Promise<Object>} The parsed JSON response with value array
     */
    async fetchEntities(servicePath, entitySet, options = {}) {
        const queryParts = [];
        if (options.$filter) queryParts.push(`$filter=${encodeURIComponent(options.$filter)}`);
        if (options.$select) queryParts.push(`$select=${encodeURIComponent(options.$select)}`);
        if (options.$orderby) queryParts.push(`$orderby=${encodeURIComponent(options.$orderby)}`);
        if (options.$top) queryParts.push(`$top=${options.$top}`);
        if (options.$skip) queryParts.push(`$skip=${options.$skip}`);
        if (options.$expand) queryParts.push(`$expand=${encodeURIComponent(options.$expand)}`);

        const url = `${servicePath}/${entitySet}${queryParts.length ? '?' + queryParts.join('&') : ''}`;
        
        const res = await fetch(url, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
            credentials: 'same-origin'
        });

        if (!res.ok) {
            throw new Error(`Failed to fetch ${entitySet}: ${res.status}`);
        }

        return res.json();
    },

    // ─────────────────────────────────────────────────────────────────────────
    // Discovery Service API (US-001, US-002, US-003, US-007, US-008, US-009)
    // ─────────────────────────────────────────────────────────────────────────
    discovery: {
        /**
         * Tests connectivity to a registered PI/PO system.
         * @param {string} systemId - UUID of the registered PI system
         * @returns {Promise<Object>} Connection test results with status per component
         */
        async testConnection(systemId) {
            return ApiClient.callAction(
                ApiClient.config.basePaths.discovery,
                'testConnection',
                { systemId }
            );
        },

        /**
         * Registers a new PI/PO system for discovery.
         * @param {Object} params - System configuration
         * @param {string} params.systemName - Unique system name
         * @param {string} params.description - System description
         * @param {string} params.virtualHost - Cloud Connector virtual host
         * @param {number} [params.virtualPort=443] - Virtual port
         * @param {string} [params.protocol='http'] - Protocol (http/https)
         * @param {string} params.locationId - Cloud Connector location ID
         * @param {string} params.techUser - Technical user for PI/PO
         * @param {string} params.techPassword - Technical user password
         * @param {string} [params.piVersion='7.50'] - PI/PO version
         * @returns {Promise<Object>} Created system details with destination names
         */
        async addPISystem(params) {
            return ApiClient.callAction(
                ApiClient.config.basePaths.discovery,
                'addPISystem',
                params
            );
        },

        /**
         * Starts an artifact discovery job for a PI/PO system.
         * @param {string} systemId - UUID of the PI system
         * @param {Object} [options={}] - Discovery options
         * @param {boolean} [options.includeInactive=false] - Include inactive ICOs
         * @param {boolean} [options.includeHistory=false] - Include versioned objects
         * @param {string[]} [options.artifactTypes] - Types to discover (null = all)
         * @returns {Promise<Object>} Created job details with jobId
         */
        async startDiscovery(systemId, options = {}) {
            return ApiClient.callAction(
                ApiClient.config.basePaths.discovery,
                'startDiscovery',
                {
                    systemId,
                    includeInactive: options.includeInactive ?? false,
                    includeHistory: options.includeHistory ?? false,
                    artifactTypes: options.artifactTypes ? JSON.stringify(options.artifactTypes) : null
                }
            );
        },

        /**
         * Gets current progress of a discovery job.
         * @param {string} jobId - UUID of the discovery job
         * @returns {Promise<Object>} Progress details including phase and percentage
         */
        async getDiscoveryProgress(jobId) {
            return ApiClient.callFunction(
                ApiClient.config.basePaths.discovery,
                'getDiscoveryProgress',
                { jobId }
            );
        },

        /**
         * Cancels a running discovery job.
         * @param {string} jobId - UUID of the discovery job
         * @returns {Promise<Object>} Cancellation result
         */
        async cancelDiscovery(jobId) {
            return ApiClient.callAction(
                ApiClient.config.basePaths.discovery,
                'cancelDiscovery',
                { jobId }
            );
        },

        /**
         * Approves a single artifact for migration.
         * @param {string} artifactId - UUID of the artifact
         * @param {number} wave - Target migration wave (1-10)
         * @param {string} [notes] - Approval notes
         * @returns {Promise<Object>} Approval result
         */
        async approveArtifact(artifactId, wave, notes) {
            return ApiClient.callAction(
                ApiClient.config.basePaths.discovery,
                'approveArtifact',
                { artifactId, wave, notes }
            );
        },

        /**
         * Skips an artifact from migration.
         * @param {string} artifactId - UUID of the artifact
         * @param {string} reason - Skip reason
         * @returns {Promise<Object>} Skip result
         */
        async skipArtifact(artifactId, reason) {
            return ApiClient.callAction(
                ApiClient.config.basePaths.discovery,
                'skipArtifact',
                { artifactId, reason }
            );
        },

        /**
         * Batch approves multiple artifacts.
         * @param {string[]} artifactIds - Array of artifact UUIDs
         * @param {number} wave - Target migration wave
         * @param {string} [notes] - Approval notes
         * @returns {Promise<Object>} Batch approval result with counts
         */
        async batchApprove(artifactIds, wave, notes) {
            return ApiClient.callAction(
                ApiClient.config.basePaths.discovery,
                'batchApprove',
                {
                    artifactIds: JSON.stringify(artifactIds),
                    wave,
                    notes
                }
            );
        },

        /**
         * Runs AI assessment on an artifact.
         * @param {string} artifactId - UUID of the artifact
         * @returns {Promise<Object>} Assessment result with tier and recommendations
         */
        async assessArtifact(artifactId) {
            return ApiClient.callAction(
                ApiClient.config.basePaths.discovery,
                'assessArtifact',
                { artifactId }
            );
        },

        /**
         * Generates a migration wave plan for a system.
         * @param {string} systemId - UUID of the PI system
         * @returns {Promise<Object>} Wave plan with assignments
         */
        async generateWavePlan(systemId) {
            return ApiClient.callAction(
                ApiClient.config.basePaths.discovery,
                'generateWavePlan',
                { systemId }
            );
        },

        /**
         * Exports artifact inventory to specified format.
         * @param {string} systemId - UUID of the PI system
         * @param {string} format - Export format (excel, csv, json, pdf)
         * @param {Object} [filters={}] - Filter options
         * @returns {Promise<Object>} Export result with download URL
         */
        async exportInventory(systemId, format, filters = {}) {
            return ApiClient.callAction(
                ApiClient.config.basePaths.discovery,
                'exportInventory',
                {
                    systemId,
                    format,
                    filters: JSON.stringify(filters)
                }
            );
        },

        /**
         * Gets discovery summary statistics for a system.
         * @param {string} systemId - UUID of the PI system
         * @returns {Promise<Object>} Summary with counts by type, tier, status
         */
        async getDiscoverySummary(systemId) {
            return ApiClient.callFunction(
                ApiClient.config.basePaths.discovery,
                'getDiscoverySummary',
                { systemId }
            );
        },

        /**
         * Fetches all registered PI systems for the current tenant.
         * @returns {Promise<Object>} List of PI systems
         */
        async getPISystems() {
            return ApiClient.fetchEntities(
                ApiClient.config.basePaths.discovery,
                'PISystems',
                { $orderby: 'systemName' }
            );
        },

        /**
         * Fetches artifacts for a system with optional filtering.
         * @param {string} systemId - UUID of the PI system
         * @param {Object} [options={}] - Query options
         * @returns {Promise<Object>} List of artifacts
         */
        async getArtifacts(systemId, options = {}) {
            const filter = options.$filter 
                ? `system_ID eq ${systemId} and ${options.$filter}`
                : `system_ID eq ${systemId}`;
            return ApiClient.fetchEntities(
                ApiClient.config.basePaths.discovery,
                'Artifacts',
                { ...options, $filter: filter }
            );
        }
    },

    // ─────────────────────────────────────────────────────────────────────────
    // Brain Service API (US-005, US-006, US-014)
    // ─────────────────────────────────────────────────────────────────────────
    brain: {
        /**
         * Toggles the Brain engine on or off.
         * @param {string} key - Brain activation key
         * @param {boolean} enabled - Enable or disable
         * @returns {Promise<Object>} Toggle result with new state
         */
        async toggleBrain(key, enabled) {
            return ApiClient.callAction(
                ApiClient.config.basePaths.brain,
                'toggleBrain',
                { key, enabled }
            );
        },

        /**
         * Gets current Brain status and statistics.
         * @param {string} key - Brain activation key
         * @returns {Promise<Object>} Status with event/insight counts
         */
        async getBrainStatus(key) {
            return ApiClient.callAction(
                ApiClient.config.basePaths.brain,
                'getBrainStatus',
                { key }
            );
        },

        /**
         * Captures an event for Brain learning.
         * @param {string} key - Brain activation key
         * @param {string} eventType - Type of event
         * @param {string} source - Event source
         * @param {string} payload - JSON payload
         * @param {string} summary - Human-readable summary
         * @param {string} sessionId - Session identifier
         * @returns {Promise<Object>} Capture result with event ID
         */
        async captureEvent(key, eventType, source, payload, summary, sessionId) {
            return ApiClient.callAction(
                ApiClient.config.basePaths.brain,
                'captureEvent',
                { key, eventType, source, payload, summary, sessionId }
            );
        },

        /**
         * Runs AI-powered migration advisor on artifact data.
         * @param {string} key - Brain activation key
         * @param {Object} artifactData - Artifact metadata for assessment
         * @returns {Promise<Object>} Assessment with tier, tool, effort
         */
        async migrationAdvisor(key, artifactData) {
            return ApiClient.callAction(
                ApiClient.config.basePaths.brain,
                'migrationAdvisor',
                { key, ...artifactData }
            );
        },

        /**
         * Exports the full Brain state as an archive.
         * @param {string} key - Brain activation key
         * @returns {Promise<Object>} Archive data (base64 encoded)
         */
        async exportBrain(key) {
            return ApiClient.callAction(
                ApiClient.config.basePaths.brain,
                'exportBrain',
                { key }
            );
        },

        /**
         * Imports a Brain archive (merge).
         * @param {string} key - Brain activation key
         * @param {string} data - Base64 encoded archive data
         * @returns {Promise<Object>} Import result
         */
        async importBrain(key, data) {
            return ApiClient.callAction(
                ApiClient.config.basePaths.brain,
                'importBrain',
                { key, data }
            );
        },

        /**
         * Tests PI/PO destination connectivity through Brain service.
         * @param {string} key - Brain activation key
         * @returns {Promise<Object>} Connectivity test results
         */
        async testPipoDestinations(key) {
            return ApiClient.callAction(
                ApiClient.config.basePaths.brain,
                'testPipoDestinations',
                { key }
            );
        },

        /**
         * Seeds migration knowledge into the vector store.
         * @param {string} key - Brain activation key
         * @returns {Promise<Object>} Seeding result
         */
        async seedMigrationKnowledge(key) {
            return ApiClient.callAction(
                ApiClient.config.basePaths.brain,
                'seedMigrationKnowledge',
                { key }
            );
        }
    },

    // ─────────────────────────────────────────────────────────────────────────
    // Document Service API (US-011)
    // ─────────────────────────────────────────────────────────────────────────
    documents: {
        /**
         * Parses a document using AI and stores results.
         * @param {string} key - Brain activation key
         * @param {string} fileName - Original file name
         * @param {string} mimeType - MIME type of the document
         * @param {string} contentBase64 - Base64 encoded content
         * @param {string} [sourceContext] - Context about the document source
         * @returns {Promise<Object>} Parsed document fields
         */
        async parseDocument(key, fileName, mimeType, contentBase64, sourceContext) {
            return ApiClient.callAction(
                ApiClient.config.basePaths.documents,
                'parseDocument',
                { key, fileName, mimeType, contentBase64, sourceContext }
            );
        }
    },

    // ─────────────────────────────────────────────────────────────────────────
    // RAP Dev Orchestrator API (US-012)
    // ─────────────────────────────────────────────────────────────────────────
    rapDev: {
        /**
         * Generates behavior implementation for a RAP object.
         * @param {string} key - Brain activation key
         * @param {string} objectId - RAP object identifier
         * @param {string} spec - Specification for generation
         * @param {string} requestedBy - User requesting generation
         * @returns {Promise<Object>} Generation result
         */
        async generateBehaviorImpl(key, objectId, spec, requestedBy) {
            return ApiClient.callAction(
                ApiClient.config.basePaths.rapDev,
                'generateBehaviorImpl',
                { key, objectId, spec, requestedBy }
            );
        },

        /**
         * Reviews consistency of a RAP object.
         * @param {string} key - Brain activation key
         * @param {string} objectId - RAP object identifier
         * @param {string} requestedBy - User requesting review
         * @returns {Promise<Object>} Consistency review result
         */
        async reviewConsistency(key, objectId, requestedBy) {
            return ApiClient.callAction(
                ApiClient.config.basePaths.rapDev,
                'reviewConsistency',
                { key, objectId, requestedBy }
            );
        },

        /**
         * Runs ATC check on a RAP object.
         * @param {string} key - Brain activation key
         * @param {string} objectId - RAP object identifier
         * @param {string} requestedBy - User requesting check
         * @returns {Promise<Object>} ATC check result
         */
        async runAtcCheck(key, objectId, requestedBy) {
            return ApiClient.callAction(
                ApiClient.config.basePaths.rapDev,
                'runAtcCheck',
                { key, objectId, requestedBy }
            );
        },

        /**
         * Gets status of a RAP development run.
         * @param {string} key - Brain activation key
         * @param {string} runId - Run identifier
         * @returns {Promise<Object>} Run status
         */
        async getRunStatus(key, runId) {
            return ApiClient.callAction(
                ApiClient.config.basePaths.rapDev,
                'getRunStatus',
                { key, runId }
            );
        }
    }
};

// Export for ES modules or expose globally
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ApiClient;
} else {
    window.ApiClient = ApiClient;
}
