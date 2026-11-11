/**
 * UI Wiring Module - Connects UI controls to backend services
 * 
 * Replaces setTimeout mocks with real ApiClient calls while maintaining
 * backward compatibility with demo mode for trade shows and offline presentations.
 * 
 * @module UIWiring
 * @version 1.0.0
 * @requires ApiClient
 */
const UIWiring = {
    /**
     * Feature flag for backend vs demo mode.
     * Set window.SDAINTAI_CONFIG.useBackend = false for pure demo mode.
     * @type {boolean}
     */
    useBackend: (window.SDAINTAI_CONFIG && window.SDAINTAI_CONFIG.useBackend !== undefined) 
        ? window.SDAINTAI_CONFIG.useBackend 
        : true,

    /** @type {number} Polling interval for discovery progress (ms) - per PERF-003 */
    progressPollInterval: 2000,

    /** @type {string|null} Current discovery job ID for cancellation */
    currentDiscoveryJobId: null,

    /** @type {number|null} Progress polling timer ID */
    progressPollTimer: null,

    // ─────────────────────────────────────────────────────────────────────────
    // Utility Functions
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Shows loading state on a button element.
     * @param {string} buttonId - Button element ID
     * @param {string} [message='Loading...'] - Loading message
     */
    showLoadingState(buttonId, message = 'Loading...') {
        const btn = document.getElementById(buttonId);
        if (btn) {
            btn.disabled = true;
            btn._originalContent = btn.innerHTML;
            btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${message}`;
        }
    },

    /**
     * Hides loading state and restores button content.
     * @param {string} buttonId - Button element ID
     * @param {string} [content] - Optional content to set (uses original if not provided)
     */
    hideLoadingState(buttonId, content) {
        const btn = document.getElementById(buttonId);
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = content || btn._originalContent || btn.innerHTML;
        }
    },

    /**
     * Shows a success toast notification.
     * @param {string} message - Toast message
     */
    showSuccessToast(message) {
        if (typeof showToast === 'function') {
            showToast('Success', message, 'success');
        } else {
            console.log('[Success]', message);
        }
    },

    /**
     * Shows an error toast notification.
     * @param {string} message - Error message
     */
    showErrorToast(message) {
        if (typeof showToast === 'function') {
            showToast('Error', message, 'danger');
        } else {
            console.error('[Error]', message);
        }
    },

    /**
     * Logs a brain event (wrapper for the existing logBrainEvent function).
     * @param {string} eventType - Event type
     * @param {string} source - Event source
     * @param {Object} payload - Event payload
     * @param {string} [summary] - Event summary
     */
    logEvent(eventType, source, payload, summary) {
        if (typeof logBrainEvent === 'function') {
            logBrainEvent(eventType, source, payload, summary);
        }
    },

    // ─────────────────────────────────────────────────────────────────────────
    // Connection Testing (US-001)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Tests connectivity to a registered PI/PO system.
     * Wires btn-test-connection and btn-admin-test-pipo to DiscoveryService.testConnection.
     * 
     * @param {string} systemId - UUID of the registered PI system
     * @returns {Promise<Object>} Connection test results
     */
    async testConnection(systemId) {
        if (!this.useBackend || !systemId) {
            return this._mockConnectionTest();
        }

        try {
            this.showLoadingState('btn-test-connection', 'Testing...');
            this.showLoadingState('btn-admin-test-pipo', 'Testing...');
            
            const result = await ApiClient.discovery.testConnection(systemId);
            
            this.logEvent('connection_test', 'discovery', {
                systemId,
                success: result.success,
                dirStatus: result.dirStatus,
                esrStatus: result.esrStatus
            }, `Connection test ${result.success ? 'succeeded' : 'failed'}: ${result.message}`);

            return {
                success: result.success,
                dirStatus: result.dirStatus,
                esrStatus: result.esrStatus,
                sldStatus: result.sldStatus,
                piVersion: result.piVersion,
                swcvCount: result.swcvCount,
                icoCount: result.icoCount,
                channelCount: result.channelCount,
                message: result.message,
                details: result.details
            };
        } catch (error) {
            this.showErrorToast(error.message);
            this.logEvent('error', 'connection_test', { systemId, error: error.message });
            return { success: false, message: error.message };
        } finally {
            this.hideLoadingState('btn-test-connection');
            this.hideLoadingState('btn-admin-test-pipo');
        }
    },

    // ─────────────────────────────────────────────────────────────────────────
    // PI/PO System Registration (US-002)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Registers a new PI/PO system with the backend.
     * Wires btn-save-connection to DiscoveryService.addPISystem.
     * 
     * @param {Object} params - System configuration parameters
     * @returns {Promise<Object>} Registration result
     */
    async registerPISystem(params) {
        if (!this.useBackend) {
            return this._mockRegisterSystem(params);
        }

        try {
            this.showLoadingState('btn-save-connection', 'Registering...');
            const result = await ApiClient.discovery.addPISystem(params);
            
            this.showSuccessToast(`System "${params.systemName}" registered successfully`);
            this.logEvent('system_registered', 'admin', {
                systemName: params.systemName,
                systemId: result.systemId
            }, `PI system "${params.systemName}" registered`);
            
            return result;
        } catch (error) {
            this.showErrorToast(`Registration failed: ${error.message}`);
            throw error;
        } finally {
            this.hideLoadingState('btn-save-connection');
        }
    },

    // ─────────────────────────────────────────────────────────────────────────
    // Asset Discovery (US-003, US-004)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Starts asset discovery for a PI/PO system.
     * Wires btn-import-assets-trigger to DiscoveryService.startDiscovery.
     * 
     * @param {string} systemId - UUID of the PI system
     * @param {string} platform - Platform identifier (pipo, mulesoft, etc.)
     * @param {Object} [options={}] - Discovery options
     * @returns {Promise<Object>} Discovery job details
     */
    async startAssetScan(systemId, platform, options = {}) {
        // Only PI/PO has backend discovery service
        if (!this.useBackend || platform !== 'pipo' || !systemId) {
            return this._mockAssetScan(platform);
        }

        try {
            this.showLoadingState('btn-import-assets-trigger', 'Starting...');
            
            const job = await ApiClient.discovery.startDiscovery(systemId, {
                includeInactive: options.includeInactive ?? false,
                includeHistory: options.includeHistory ?? false,
                artifactTypes: options.artifactTypes
            });

            this.currentDiscoveryJobId = job.jobId;
            this.logEvent('discovery_started', 'discovery', {
                systemId,
                jobId: job.jobId
            }, `Discovery job ${job.jobId} started`);

            // Start progress polling
            this._startProgressPolling(job.jobId, systemId);
            
            return job;
        } catch (error) {
            this.showErrorToast(`Discovery failed: ${error.message}`);
            this.hideLoadingState('btn-import-assets-trigger');
            throw error;
        }
    },

    /**
     * Cancels a running discovery job.
     * @param {string} [jobId] - Job ID (uses current if not provided)
     * @returns {Promise<Object>} Cancellation result
     */
    async cancelDiscovery(jobId) {
        const targetJobId = jobId || this.currentDiscoveryJobId;
        if (!targetJobId) {
            return { success: false, message: 'No discovery job to cancel' };
        }

        try {
            this._stopProgressPolling();
            const result = await ApiClient.discovery.cancelDiscovery(targetJobId);
            this.currentDiscoveryJobId = null;
            this.hideLoadingState('btn-import-assets-trigger', '<i class="fa-solid fa-xmark"></i> Cancelled');
            return result;
        } catch (error) {
            this.showErrorToast(`Cancel failed: ${error.message}`);
            throw error;
        }
    },

    /**
     * Starts polling for discovery progress.
     * @private
     */
    _startProgressPolling(jobId, systemId) {
        this._stopProgressPolling();
        
        const poll = async () => {
            try {
                const progress = await ApiClient.discovery.getDiscoveryProgress(jobId);
                
                // Update UI with progress
                this._updateDiscoveryProgress(progress);
                
                if (progress.status === 'running' || progress.status === 'pending') {
                    this.progressPollTimer = setTimeout(poll, this.progressPollInterval);
                } else if (progress.status === 'completed') {
                    this._handleDiscoveryComplete(progress, systemId);
                } else if (progress.status === 'failed' || progress.status === 'cancelled') {
                    this._handleDiscoveryFailed(progress);
                }
            } catch (error) {
                console.error('[UIWiring] Progress polling error:', error);
                // Continue polling on transient errors
                this.progressPollTimer = setTimeout(poll, this.progressPollInterval);
            }
        };

        poll();
    },

    /**
     * Stops progress polling.
     * @private
     */
    _stopProgressPolling() {
        if (this.progressPollTimer) {
            clearTimeout(this.progressPollTimer);
            this.progressPollTimer = null;
        }
    },

    /**
     * Updates UI with discovery progress.
     * @private
     */
    _updateDiscoveryProgress(progress) {
        const btn = document.getElementById('btn-import-assets-trigger');
        if (btn) {
            btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${progress.phaseName || 'Scanning'}... ${progress.progressPercent || 0}%`;
        }

        // Update Lumi if available
        if (typeof lumiSay === 'function' && progress.currentItem) {
            lumiSay(`Scanning: ${progress.phaseName} (${progress.artifactsFound || 0} found so far)...`);
        }
    },

    /**
     * Handles discovery completion.
     * @private
     */
    async _handleDiscoveryComplete(progress, systemId) {
        this._stopProgressPolling();
        this.currentDiscoveryJobId = null;
        
        const btn = document.getElementById('btn-import-assets-trigger');
        if (btn) {
            btn.innerHTML = '<i class="fa-solid fa-check"></i> Scan complete';
            btn.disabled = false;
        }

        this.showSuccessToast(`Discovery complete: ${progress.artifactsFound} artifacts found`);
        this.logEvent('discovery_completed', 'discovery', {
            jobId: progress.jobId,
            artifactsFound: progress.artifactsFound
        }, `Discovery completed with ${progress.artifactsFound} artifacts`);

        // Load discovered artifacts into UI
        if (systemId) {
            await this._loadDiscoveredArtifacts(systemId);
        }
    },

    /**
     * Handles discovery failure.
     * @private
     */
    _handleDiscoveryFailed(progress) {
        this._stopProgressPolling();
        this.currentDiscoveryJobId = null;
        
        this.hideLoadingState('btn-import-assets-trigger', '<i class="fa-solid fa-xmark"></i> Failed');
        this.showErrorToast(`Discovery failed: ${progress.errors || 'Unknown error'}`);
    },

    /**
     * Loads discovered artifacts from backend into UI state.
     * @private
     */
    async _loadDiscoveredArtifacts(systemId) {
        try {
            const response = await ApiClient.discovery.getArtifacts(systemId, {
                $orderby: 'name'
            });
            
            const artifacts = (response.value || []).map(a => ({
                id: a.ID,
                name: a.name,
                type: a.artifactType,
                tier: a.migrationTier || 'Simple',
                deps: 1,
                status: a.migrationStatus === 'approved' ? 'Ready' : 
                        a.migrationStatus === 'skipped' ? 'Skipped' : 
                        a.assessmentNotes ? 'Review' : 'Ready',
                flowCount: 1,
                live: true,
                tree: [{ kind: a.artifactType, name: a.name, ok: true, children: [] }],
                // Preserve backend fields for later operations
                _backendId: a.ID,
                _migrationStatus: a.migrationStatus,
                _wave: a.migrationWave
            }));

            // Update global state if available
            if (typeof S !== 'undefined') {
                S.assets = artifacts;
                S.assetsLivePi8 = true;
            }

            // Trigger UI refresh if function exists
            if (typeof populateAssetsTable === 'function') {
                populateAssetsTable();
            }

            return artifacts;
        } catch (error) {
            console.error('[UIWiring] Failed to load artifacts:', error);
            throw error;
        }
    },

    // ─────────────────────────────────────────────────────────────────────────
    // Brain Operations (US-005)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Activates the SDAINTAI Brain engine.
     * Wires btn-activate-brain to BrainService.toggleBrain.
     * 
     * @param {string} key - Brain activation key
     * @returns {Promise<Object>} Activation result
     */
    async activateBrain(key) {
        if (!this.useBackend) {
            return this._mockBrainToggle(true);
        }

        try {
            this.showLoadingState('btn-activate-brain', 'Activating...');
            const result = await ApiClient.brain.toggleBrain(key, true);
            
            if (result.success) {
                // Update global state
                if (typeof S !== 'undefined') {
                    S.brainActivated = true;
                    S.brainKey = key;
                }
                this._updateBrainStatusUI(result, true);
                this.showSuccessToast('SDAINTAI Brain activated');
            }
            
            return result;
        } catch (error) {
            this.showErrorToast(`Brain activation failed: ${error.message}`);
            throw error;
        } finally {
            this.hideLoadingState('btn-activate-brain');
        }
    },

    /**
     * Deactivates the SDAINTAI Brain engine.
     * Wires btn-deactivate-brain to BrainService.toggleBrain.
     * 
     * @param {string} key - Brain activation key
     * @returns {Promise<Object>} Deactivation result
     */
    async deactivateBrain(key) {
        if (!this.useBackend) {
            return this._mockBrainToggle(false);
        }

        try {
            const result = await ApiClient.brain.toggleBrain(key, false);
            
            if (result.success) {
                if (typeof S !== 'undefined') {
                    S.brainActivated = false;
                }
                this._updateBrainStatusUI(result, false);
                this.showSuccessToast('Brain deactivated');
            }
            
            return result;
        } catch (error) {
            this.showErrorToast(`Brain deactivation failed: ${error.message}`);
            throw error;
        }
    },

    /**
     * Gets current Brain status.
     * @param {string} key - Brain activation key
     * @returns {Promise<Object>} Brain status
     */
    async getBrainStatus(key) {
        if (!this.useBackend) {
            return this._mockBrainStatus();
        }

        return ApiClient.brain.getBrainStatus(key);
    },

    /**
     * Updates the Brain status UI elements.
     * @private
     */
    _updateBrainStatusUI(result, enabled) {
        const statusEl = document.getElementById('admin-brain-status');
        if (statusEl) {
            if (enabled) {
                statusEl.className = 'conn-status ok';
                statusEl.innerHTML = `<span class="dot"></span> AI Engine active — ${result.eventsCount || 0} events logged`;
            } else {
                statusEl.className = 'conn-status';
                statusEl.innerHTML = '<span class="dot"></span> AI Engine inactive';
            }
        }
    },

    // ─────────────────────────────────────────────────────────────────────────
    // Migration Advisor (US-006)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Runs AI-powered assessment on an artifact.
     * @param {Object} artifactData - Artifact metadata for assessment
     * @returns {Promise<Object>} Assessment result
     */
    async assessArtifact(artifactData) {
        const brainKey = (typeof S !== 'undefined' && S.brainKey) ? S.brainKey : null;
        
        if (!this.useBackend || !brainKey) {
            return this._mockAssessment(artifactData);
        }

        try {
            const result = await ApiClient.brain.migrationAdvisor(brainKey, artifactData);
            
            this.logEvent('artifact_assessed', 'migration_advisor', {
                objectId: artifactData.objectId,
                tier: result.tier,
                score: result.complexityScore
            }, `Assessed ${artifactData.objectId}: ${result.tier} complexity`);
            
            return result;
        } catch (error) {
            console.error('[UIWiring] Assessment failed, using mock:', error);
            return this._mockAssessment(artifactData);
        }
    },

    /**
     * Batch assesses multiple artifacts using backend service.
     * @param {string} systemId - System ID
     * @param {string[]} artifactIds - Array of artifact IDs
     * @returns {Promise<Object>} Batch assessment result
     */
    async batchAssessArtifacts(systemId, artifactIds) {
        if (!this.useBackend) {
            return { assessed: artifactIds.length, failed: 0, message: 'Batch assessed (demo mode)' };
        }

        try {
            const result = await ApiClient.callAction(
                ApiClient.config.basePaths.discovery,
                'batchAssess',
                { artifactIds: JSON.stringify(artifactIds) }
            );
            return result;
        } catch (error) {
            this.showErrorToast(`Batch assessment failed: ${error.message}`);
            throw error;
        }
    },

    // ─────────────────────────────────────────────────────────────────────────
    // Approval Workflow (US-007)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Approves a single artifact for migration.
     * @param {string} artifactId - Artifact UUID
     * @param {number} wave - Target migration wave
     * @param {string} [notes] - Approval notes
     * @returns {Promise<Object>} Approval result
     */
    async approveArtifact(artifactId, wave, notes) {
        if (!this.useBackend) {
            return this._mockApproval(artifactId, wave);
        }

        try {
            const result = await ApiClient.discovery.approveArtifact(artifactId, wave, notes);
            
            if (result.success) {
                this.logEvent('artifact_approved', 'approval_workflow', { artifactId, wave });
            }
            
            return result;
        } catch (error) {
            this.showErrorToast(`Approval failed: ${error.message}`);
            throw error;
        }
    },

    /**
     * Skips an artifact from migration.
     * @param {string} artifactId - Artifact UUID
     * @param {string} reason - Skip reason
     * @returns {Promise<Object>} Skip result
     */
    async skipArtifact(artifactId, reason) {
        if (!this.useBackend) {
            return { success: true, message: 'Artifact skipped (demo mode)' };
        }

        try {
            const result = await ApiClient.discovery.skipArtifact(artifactId, reason);
            
            if (result.success) {
                this.logEvent('artifact_skipped', 'approval_workflow', { artifactId, reason });
            }
            
            return result;
        } catch (error) {
            this.showErrorToast(`Skip failed: ${error.message}`);
            throw error;
        }
    },

    /**
     * Batch approves multiple artifacts.
     * Wires btn-approve-start to DiscoveryService.batchApprove.
     * 
     * @param {string[]} artifactIds - Array of artifact UUIDs
     * @param {number} wave - Target migration wave
     * @param {string} [notes] - Approval notes
     * @returns {Promise<Object>} Batch approval result
     */
    async batchApprove(artifactIds, wave, notes) {
        if (!this.useBackend) {
            return this._mockBatchApproval(artifactIds, wave);
        }

        try {
            this.showLoadingState('btn-approve-start', `Approving ${artifactIds.length}...`);
            const result = await ApiClient.discovery.batchApprove(artifactIds, wave, notes);
            
            this.showSuccessToast(`Approved ${result.approved} artifacts for Wave ${wave}`);
            this.logEvent('batch_approved', 'approval_workflow', {
                count: result.approved,
                wave
            }, `Batch approved ${result.approved} artifacts for wave ${wave}`);
            
            return result;
        } catch (error) {
            this.showErrorToast(`Batch approval failed: ${error.message}`);
            throw error;
        } finally {
            this.hideLoadingState('btn-approve-start');
        }
    },

    // ─────────────────────────────────────────────────────────────────────────
    // Wave Planning (US-008)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Generates a migration wave plan.
     * @param {string} systemId - PI system UUID
     * @returns {Promise<Object>} Wave plan with assignments
     */
    async generateWavePlan(systemId) {
        if (!this.useBackend) {
            return this._mockWavePlan();
        }

        try {
            this.showLoadingState('btn-generate-wave-plan', 'Generating...');
            const result = await ApiClient.discovery.generateWavePlan(systemId);
            
            const waves = JSON.parse(result.waves || '[]');
            this._updateWavePlanUI(waves);
            
            this.showSuccessToast(`Generated ${result.totalWaves} migration waves`);
            this.logEvent('wave_plan_generated', 'planning', {
                systemId,
                totalWaves: result.totalWaves,
                totalHours: result.totalHours
            });
            
            return result;
        } catch (error) {
            this.showErrorToast(`Wave plan generation failed: ${error.message}`);
            throw error;
        } finally {
            this.hideLoadingState('btn-generate-wave-plan');
        }
    },

    /**
     * Updates wave plan UI with generated data.
     * @private
     */
    _updateWavePlanUI(waves) {
        // Update global state if available
        if (typeof S !== 'undefined') {
            S.wavePlan = waves;
        }
        // Trigger UI refresh if function exists
        if (typeof updateWaveTable === 'function') {
            updateWaveTable(waves);
        }
    },

    // ─────────────────────────────────────────────────────────────────────────
    // Export Operations (US-009)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Exports artifact inventory to specified format.
     * Wires btn-export-pdf, btn-export-csv to DiscoveryService.exportInventory.
     * 
     * @param {string} systemId - PI system UUID
     * @param {string} format - Export format (pdf, csv, excel, json)
     * @param {Object} [filters={}] - Applied filters
     * @returns {Promise<Object>} Export result with download URL
     */
    async exportInventory(systemId, format, filters = {}) {
        if (!this.useBackend) {
            return this._mockExport(format);
        }

        try {
            this.showLoadingState(`btn-export-${format}`, `Exporting...`);
            const result = await ApiClient.discovery.exportInventory(systemId, format, filters);
            
            if (result.downloadUrl) {
                window.open(result.downloadUrl, '_blank');
            }
            
            this.showSuccessToast(`Exported ${result.artifactCount} artifacts to ${format.toUpperCase()}`);
            this.logEvent('inventory_exported', 'export', {
                systemId,
                format,
                artifactCount: result.artifactCount
            });
            
            return result;
        } catch (error) {
            this.showErrorToast(`Export failed: ${error.message}`);
            throw error;
        } finally {
            this.hideLoadingState(`btn-export-${format}`);
        }
    },

    // ─────────────────────────────────────────────────────────────────────────
    // Brain Event Capture (US-014)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Captures an event to the Brain for learning.
     * Replaces local array push with BrainService.captureEvent.
     * 
     * @param {string} eventType - Type of event
     * @param {string} source - Event source
     * @param {Object} payload - Event payload
     * @param {string} [summary] - Human-readable summary
     * @returns {Promise<void>}
     */
    async captureBrainEvent(eventType, source, payload, summary) {
        const brainActivated = typeof S !== 'undefined' && S.brainActivated;
        const brainKey = typeof S !== 'undefined' ? S.brainKey : null;
        const sessionId = typeof S !== 'undefined' ? S.brainSessionId : '';

        if (!this.useBackend || !brainActivated || !brainKey) {
            // Fallback to local storage
            this._localCaptureEvent(eventType, source, payload);
            return;
        }

        try {
            await ApiClient.brain.captureEvent(
                brainKey,
                eventType,
                source,
                JSON.stringify(payload || {}),
                (summary || '').slice(0, 500),
                sessionId || ''
            );
        } catch (error) {
            console.warn('[UIWiring] Brain event capture failed:', error.message);
            // Fallback to local storage
            this._localCaptureEvent(eventType, source, payload);
        }
    },

    /**
     * Local fallback for event capture when backend is unavailable.
     * @private
     */
    _localCaptureEvent(eventType, source, payload) {
        if (typeof S !== 'undefined') {
            S.brainChatLog = S.brainChatLog || [];
            S.brainChatLog.push({
                ts: Date.now(),
                eventType,
                source,
                payload
            });
            if (typeof saveBrainMemory === 'function') {
                saveBrainMemory();
            }
        }
    },

    // ─────────────────────────────────────────────────────────────────────────
    // Document Parsing (US-011)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Parses a document using AI document service.
     * @param {File} file - File object to parse
     * @param {string} [sourceContext] - Context about the document
     * @returns {Promise<Object>} Parsed document fields
     */
    async parseDocument(file, sourceContext) {
        const brainKey = typeof S !== 'undefined' ? S.brainKey : null;
        
        if (!this.useBackend || !brainKey) {
            return { success: false, message: 'Document parsing requires backend and active Brain' };
        }

        try {
            // Convert file to base64
            const contentBase64 = await this._fileToBase64(file);
            
            const result = await ApiClient.documents.parseDocument(
                brainKey,
                file.name,
                file.type,
                contentBase64,
                sourceContext
            );
            
            this.logEvent('document_parsed', 'documents', {
                fileName: file.name,
                mimeType: file.type
            });
            
            return result;
        } catch (error) {
            this.showErrorToast(`Document parsing failed: ${error.message}`);
            throw error;
        }
    },

    /**
     * Converts a File to base64 string.
     * @private
     */
    _fileToBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                const base64 = reader.result.split(',')[1];
                resolve(base64);
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    },

    // ─────────────────────────────────────────────────────────────────────────
    // Mock Fallback Methods (Demo Mode)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Mock connection test for demo mode.
     * @private
     */
    _mockConnectionTest() {
        return new Promise(resolve => {
            setTimeout(() => {
                resolve({
                    success: true,
                    dirStatus: 'OK',
                    esrStatus: 'OK',
                    sldStatus: 'OK',
                    piVersion: '7.50',
                    swcvCount: 12,
                    icoCount: 156,
                    channelCount: 89,
                    message: 'Connection successful (demo mode)'
                });
            }, 1200);
        });
    },

    /**
     * Mock system registration for demo mode.
     * @private
     */
    _mockRegisterSystem(params) {
        return new Promise(resolve => {
            setTimeout(() => {
                resolve({
                    systemId: `mock-${Date.now()}`,
                    destinationDir: `PO_${params.systemName}_DIR`,
                    destinationEsr: `PO_${params.systemName}_ESR`,
                    status: 'configured',
                    message: 'System registered (demo mode)'
                });
            }, 800);
        });
    },

    /**
     * Mock asset scan for demo mode.
     * @private
     */
    _mockAssetScan(platform) {
        return new Promise(resolve => {
            setTimeout(() => {
                // Use existing ASSET_SETS if available
                const assets = (typeof ASSET_SETS !== 'undefined' && ASSET_SETS[platform])
                    ? ASSET_SETS[platform]
                    : [];
                
                if (typeof S !== 'undefined') {
                    S.assets = [...assets];
                }
                
                resolve({ success: true, jobId: `mock-job-${Date.now()}`, assets });
            }, 2000);
        });
    },

    /**
     * Mock brain toggle for demo mode.
     * @private
     */
    _mockBrainToggle(enabled) {
        return Promise.resolve({
            success: true,
            message: enabled ? 'Brain activated (demo mode)' : 'Brain deactivated',
            state: enabled
        });
    },

    /**
     * Mock brain status for demo mode.
     * @private
     */
    _mockBrainStatus() {
        const brainLog = typeof S !== 'undefined' ? S.brainChatLog : [];
        return Promise.resolve({
            enabled: typeof S !== 'undefined' ? S.brainActivated : false,
            eventsCount: brainLog?.length || 0,
            insightsCount: 0,
            coherence: 85,
            vectorCount: 0,
            message: 'Status retrieved (demo mode)'
        });
    },

    /**
     * Mock artifact assessment for demo mode.
     * @private
     */
    _mockAssessment(artifactData) {
        const tierRoll = Math.random();
        const tier = tierRoll < 0.5 ? 'simple' : tierRoll < 0.85 ? 'medium' : 'complex';
        const score = tier === 'simple' ? 20 + Math.random() * 20 :
                      tier === 'medium' ? 45 + Math.random() * 25 :
                      75 + Math.random() * 25;
        
        return Promise.resolve({
            objectId: artifactData.objectId,
            objectType: 'SAP_PI_PO_OBJECT',
            tier,
            complexityScore: Math.round(score),
            recommendedTool: tier === 'simple' ? 'BAPI' : tier === 'medium' ? 'iFlow_SemiAuto' : 'iFlow_Custom',
            specificTool: tier === 'simple' ? 'BAPI_SAVE' : 'Custom iFlow',
            estimatedHours: tier === 'simple' ? 2 : tier === 'medium' ? 8 : 24,
            riskLevel: tier === 'complex' ? 'high' : tier === 'medium' ? 'medium' : 'low',
            waveAssignment: tier === 'simple' ? 1 : tier === 'medium' ? 2 : 3,
            rationale: 'Assessment based on complexity factors (demo mode)',
            steps: JSON.stringify(['Assess source', 'Configure adapter', 'Build mapping', 'Test', 'Deploy']),
            prereqs: JSON.stringify(['IS tenant', 'RFC destination']),
            message: 'Assessment complete'
        });
    },

    /**
     * Mock single approval for demo mode.
     * @private
     */
    _mockApproval(artifactId, wave) {
        return Promise.resolve({
            success: true,
            message: `Artifact approved for wave ${wave} (demo mode)`
        });
    },

    /**
     * Mock batch approval for demo mode.
     * @private
     */
    _mockBatchApproval(artifactIds, wave) {
        return Promise.resolve({
            approved: artifactIds.length,
            failed: 0,
            message: 'Batch approval complete (demo mode)'
        });
    },

    /**
     * Mock wave plan for demo mode.
     * @private
     */
    _mockWavePlan() {
        return Promise.resolve({
            waves: JSON.stringify([
                { wave: 1, artifacts: 20, hours: 40, team: ['marco', 'jamal'] },
                { wave: 2, artifacts: 15, hours: 120, team: ['priya', 'anika'] },
                { wave: 3, artifacts: 5, hours: 200, team: ['anika'] }
            ]),
            totalWaves: 3,
            totalHours: 360,
            message: 'Wave plan generated (demo mode)'
        });
    },

    /**
     * Mock export for demo mode.
     * @private
     */
    _mockExport(format) {
        const assetCount = typeof S !== 'undefined' && S.assets ? S.assets.length : 0;
        return Promise.resolve({
            downloadUrl: null,
            artifactCount: assetCount,
            message: `Export to ${format} (demo mode — no file generated)`
        });
    }
};

// Export for ES modules or expose globally
if (typeof module !== 'undefined' && module.exports) {
    module.exports = UIWiring;
} else {
    window.UIWiring = UIWiring;
}
