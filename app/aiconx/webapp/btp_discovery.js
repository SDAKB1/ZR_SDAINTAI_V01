/**
 * PI/PO Discovery Module
 * 
 * Wires the backend discovery service to the UI:
 * - System configuration and connection testing
 * - Discovery wizard with real-time SSE progress
 * - Artifact browser with filtering and pagination
 * - Approval workflow with batch operations
 */

// ═══════════════════════════════════════════════════════════════════════════════
// DISCOVERY STATE
// ═══════════════════════════════════════════════════════════════════════════════
const DiscoveryState = {
  systems: [],
  currentSystem: null,
  currentJob: null,
  artifacts: [],
  pagination: { page: 1, pageSize: 50, total: 0 },
  filters: { type: '', status: '', tier: '', search: '' },
  sseConnection: null,
};

// ═══════════════════════════════════════════════════════════════════════════════
// API HELPERS
// ═══════════════════════════════════════════════════════════════════════════════
const DISCOVERY_API = '/odata/v4/discovery';

async function discoveryFetch(endpoint, options = {}) {
  const url = `${DISCOVERY_API}${endpoint}`;
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  
  try {
    const response = await fetch(url, { ...options, headers });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: { message: response.statusText } }));
      throw new Error(error.error?.message || `HTTP ${response.status}`);
    }
    return response.json();
  } catch (error) {
    console.error(`[Discovery API] ${endpoint}:`, error);
    throw error;
  }
}

async function discoveryAction(action, data) {
  return discoveryFetch(`/${action}`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SSE REAL-TIME PROGRESS
// ═══════════════════════════════════════════════════════════════════════════════
function connectDiscoverySSE(jobId, callbacks = {}) {
  // Close existing connection
  if (DiscoveryState.sseConnection) {
    DiscoveryState.sseConnection.close();
  }
  
  const url = jobId ? `/sse/discovery/${jobId}` : '/sse/discovery';
  const eventSource = new EventSource(url);
  DiscoveryState.sseConnection = eventSource;
  
  eventSource.addEventListener('connected', (e) => {
    console.log('[SSE] Connected:', JSON.parse(e.data));
    if (callbacks.onConnected) callbacks.onConnected(JSON.parse(e.data));
  });
  
  eventSource.addEventListener('progress', (e) => {
    const progress = JSON.parse(e.data);
    console.log('[SSE] Progress:', progress);
    updateDiscoveryProgress(progress);
    if (callbacks.onProgress) callbacks.onProgress(progress);
  });
  
  eventSource.addEventListener('completed', (e) => {
    const result = JSON.parse(e.data);
    console.log('[SSE] Completed:', result);
    updateDiscoveryComplete(result);
    if (callbacks.onCompleted) callbacks.onCompleted(result);
    eventSource.close();
  });
  
  eventSource.addEventListener('error', (e) => {
    const errorData = e.data ? JSON.parse(e.data) : { message: 'Connection error' };
    console.error('[SSE] Error:', errorData);
    if (callbacks.onError) callbacks.onError(errorData);
  });
  
  eventSource.addEventListener('ping', () => {
    console.log('[SSE] Ping received');
  });
  
  eventSource.onerror = () => {
    console.warn('[SSE] Connection error, will retry...');
  };
  
  return eventSource;
}

function disconnectDiscoverySSE() {
  if (DiscoveryState.sseConnection) {
    DiscoveryState.sseConnection.close();
    DiscoveryState.sseConnection = null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SYSTEM MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════
async function loadPISystems() {
  try {
    const result = await discoveryFetch('/PISystems');
    DiscoveryState.systems = result.value || [];
    renderSystemList();
    return DiscoveryState.systems;
  } catch (error) {
    showToast('Error', `Failed to load PI/PO systems: ${error.message}`, 'danger');
    return [];
  }
}

async function addPISystem() {
  const systemData = {
    systemName: $('admin-pipo-system-name').value.trim(),
    description: `PI/PO ${$('admin-pipo-version').value} system`,
    virtualHost: extractHost($('admin-pipo-address').value),
    virtualPort: extractPort($('admin-pipo-address').value),
    protocol: $('admin-pipo-address').value.startsWith('https') ? 'https' : 'http',
    locationId: $('admin-pipo-location').value.trim(),
    techUser: $('admin-pipo-userid').value.trim(),
    techPassword: $('admin-pipo-password').value,
    piVersion: $('admin-pipo-version').value.trim(),
  };
  
  if (!systemData.systemName || !systemData.virtualHost || !systemData.techUser || !systemData.techPassword) {
    showToast('Validation Error', 'Please fill in all required PI/PO connection fields', 'danger');
    return null;
  }
  
  try {
    showDiscoveryLoading('Adding PI/PO system...');
    const result = await discoveryAction('addPISystem', systemData);
    hideDiscoveryLoading();
    
    showToast('System Added', result.message, 'success');
    await loadPISystems();
    return result;
  } catch (error) {
    hideDiscoveryLoading();
    showToast('Error', `Failed to add system: ${error.message}`, 'danger');
    return null;
  }
}

async function testSystemConnection(systemId) {
  const statusEl = $('admin-pipo-test-status');
  statusEl.style.display = 'flex';
  statusEl.className = 'conn-status';
  statusEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Testing PI/PO connection via Cloud Connector...';
  $('btn-admin-test-pipo').disabled = true;
  
  try {
    // If no systemId, use form values to test connection
    if (!systemId) {
      // First add the system, then test
      const addResult = await addPISystem();
      if (!addResult) {
        $('btn-admin-test-pipo').disabled = false;
        statusEl.className = 'conn-status fail';
        statusEl.innerHTML = '<span class="dot"></span> Please complete all fields first';
        return;
      }
      systemId = addResult.systemId;
    }
    
    const result = await discoveryAction('testConnection', { systemId });
    $('btn-admin-test-pipo').disabled = false;
    
    if (result.success) {
      statusEl.className = 'conn-status ok';
      statusEl.innerHTML = `<span class="dot"></span> Connected! PI/PO ${result.piVersion || ''} - ${result.icoCount || 0} ICOs, ${result.channelCount || 0} Channels`;
      
      // Show detailed results
      if (result.details) {
        console.log('[Connection Test] Details:', JSON.parse(result.details));
      }
    } else {
      statusEl.className = 'conn-status fail';
      statusEl.innerHTML = `<span class="dot"></span> Connection failed: ${result.message}`;
    }
    
    return result;
  } catch (error) {
    $('btn-admin-test-pipo').disabled = false;
    statusEl.className = 'conn-status fail';
    statusEl.innerHTML = `<span class="dot"></span> Error: ${error.message}`;
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DISCOVERY WIZARD
// ═══════════════════════════════════════════════════════════════════════════════
function openDiscoveryWizard(systemId) {
  DiscoveryState.currentSystem = DiscoveryState.systems.find(s => s.ID === systemId);
  
  if (!DiscoveryState.currentSystem) {
    showToast('Error', 'Please select a PI/PO system first', 'danger');
    return;
  }
  
  const system = DiscoveryState.currentSystem;
  const bodyHtml = `
    <div class="discovery-wizard">
      <div class="wizard-header">
        <i class="fa-solid fa-magnifying-glass-chart"></i>
        <div>
          <h3>Discover ${system.systemName} Artifacts</h3>
          <p class="text-muted">Scan the PI/PO system to find all integration artifacts</p>
        </div>
      </div>
      
      <div class="wizard-options">
        <label class="wizard-option">
          <input type="checkbox" id="disco-include-inactive"> 
          <span>Include inactive ICOs and channels</span>
        </label>
        <label class="wizard-option">
          <input type="checkbox" id="disco-include-history"> 
          <span>Include version history</span>
        </label>
      </div>
      
      <div class="wizard-types">
        <p class="text-muted">Artifact types to discover:</p>
        <div class="type-grid">
          <label><input type="checkbox" checked data-type="IntegratedConfiguration"> ICOs</label>
          <label><input type="checkbox" checked data-type="CommunicationChannel"> Channels</label>
          <label><input type="checkbox" checked data-type="MessageMapping"> Message Mappings</label>
          <label><input type="checkbox" checked data-type="ValueMappingGroup"> Value Mappings</label>
          <label><input type="checkbox" checked data-type="SenderAgreement"> Sender Agreements</label>
          <label><input type="checkbox" checked data-type="ReceiverAgreement"> Receiver Agreements</label>
        </div>
      </div>
      
      <div id="discovery-progress-container" style="display:none;">
        <div class="progress-header">
          <span id="discovery-phase-name">Initializing...</span>
          <span id="discovery-phase-count">Phase 0/6</span>
        </div>
        <div class="progress-bar-container">
          <div class="progress-bar" id="discovery-progress-bar" style="width:0%"></div>
        </div>
        <div class="progress-stats">
          <span><i class="fa-solid fa-cube"></i> <span id="discovery-artifact-count">0</span> artifacts found</span>
          <span id="discovery-current-item"></span>
        </div>
      </div>
    </div>
  `;
  
  openModal('Start Discovery', bodyHtml, [
    { label: 'Cancel', cls: 'btn-btp-cancel', onClick: closeModal },
    { label: 'Start Discovery', cls: 'btn-btp-gold', onClick: () => startDiscovery(systemId) },
  ]);
}

async function startDiscovery(systemId) {
  const selectedTypes = [];
  document.querySelectorAll('.wizard-types input[data-type]:checked').forEach(cb => {
    selectedTypes.push(cb.dataset.type);
  });
  
  const options = {
    systemId,
    includeInactive: $('#disco-include-inactive')?.checked || false,
    includeHistory: $('#disco-include-history')?.checked || false,
    artifactTypes: selectedTypes.length > 0 ? JSON.stringify(selectedTypes) : null,
  };
  
  try {
    // Show progress container
    const progressContainer = document.getElementById('discovery-progress-container');
    if (progressContainer) progressContainer.style.display = 'block';
    
    // Disable start button
    const startBtn = document.querySelector('.lumi-modal-foot .btn-btp-gold');
    if (startBtn) {
      startBtn.disabled = true;
      startBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Running...';
    }
    
    // Start the discovery job
    const result = await discoveryAction('startDiscovery', options);
    DiscoveryState.currentJob = result.jobId;
    
    // Connect SSE for real-time updates
    connectDiscoverySSE(result.jobId, {
      onProgress: (progress) => updateDiscoveryProgress(progress),
      onCompleted: (result) => {
        updateDiscoveryComplete(result);
        showToast('Discovery Complete', `Found ${result.artifactsFound} artifacts`, 'success');
        setTimeout(() => {
          closeModal();
          showArtifactBrowser(systemId);
        }, 1500);
      },
      onError: (error) => {
        showToast('Discovery Error', error.message, 'danger');
      },
    });
    
  } catch (error) {
    showToast('Error', `Failed to start discovery: ${error.message}`, 'danger');
  }
}

function updateDiscoveryProgress(progress) {
  const progressBar = document.getElementById('discovery-progress-bar');
  const phaseName = document.getElementById('discovery-phase-name');
  const phaseCount = document.getElementById('discovery-phase-count');
  const artifactCount = document.getElementById('discovery-artifact-count');
  const currentItem = document.getElementById('discovery-current-item');
  
  if (progressBar) progressBar.style.width = `${progress.progressPercent}%`;
  if (phaseName) phaseName.textContent = progress.phaseName || 'Processing...';
  if (phaseCount) phaseCount.textContent = `Phase ${progress.phase}/6`;
  if (artifactCount) artifactCount.textContent = progress.artifactsFound || 0;
  if (currentItem && progress.currentItem) currentItem.textContent = progress.currentItem;
}

function updateDiscoveryComplete(result) {
  const progressBar = document.getElementById('discovery-progress-bar');
  const phaseName = document.getElementById('discovery-phase-name');
  const phaseCount = document.getElementById('discovery-phase-count');
  
  if (progressBar) {
    progressBar.style.width = '100%';
    progressBar.classList.add('complete');
  }
  if (phaseName) phaseName.textContent = 'Discovery Complete!';
  if (phaseCount) phaseCount.textContent = `${result.artifactsFound} artifacts discovered`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ARTIFACT BROWSER
// ═══════════════════════════════════════════════════════════════════════════════
async function showArtifactBrowser(systemId) {
  DiscoveryState.currentSystem = DiscoveryState.systems.find(s => s.ID === systemId) || DiscoveryState.currentSystem;
  
  // Navigate to discovery screen
  showScreen('screen-discovery');
  
  // Load artifacts
  await loadArtifacts(systemId);
}

async function loadArtifacts(systemId, page = 1) {
  const { filters, pagination } = DiscoveryState;
  const skip = (page - 1) * pagination.pageSize;
  
  let filterStr = systemId ? `system_ID eq ${systemId}` : '';
  if (filters.type) filterStr += ` and artifactType eq '${filters.type}'`;
  if (filters.status) filterStr += ` and migrationStatus eq '${filters.status}'`;
  if (filters.tier) filterStr += ` and migrationTier eq '${filters.tier}'`;
  if (filters.search) filterStr += ` and contains(name, '${filters.search}')`;
  
  try {
    showDiscoveryLoading('Loading artifacts...');
    
    const result = await discoveryFetch(`/Artifacts?$filter=${encodeURIComponent(filterStr)}&$top=${pagination.pageSize}&$skip=${skip}&$count=true&$orderby=createdAt desc`);
    
    DiscoveryState.artifacts = result.value || [];
    DiscoveryState.pagination.total = result['@odata.count'] || 0;
    DiscoveryState.pagination.page = page;
    
    renderArtifactTable();
    renderPagination();
    hideDiscoveryLoading();
    
  } catch (error) {
    hideDiscoveryLoading();
    showToast('Error', `Failed to load artifacts: ${error.message}`, 'danger');
  }
}

function renderArtifactTable() {
  const container = document.getElementById('artifact-table-body');
  if (!container) return;
  
  if (DiscoveryState.artifacts.length === 0) {
    container.innerHTML = `
      <tr class="empty-row">
        <td colspan="7">
          <div class="empty-state">
            <i class="fa-solid fa-box-open"></i>
            <p>No artifacts found</p>
            <button class="btn-btp btn-btp-action" onclick="openDiscoveryWizard('${DiscoveryState.currentSystem?.ID}')">
              <i class="fa-solid fa-magnifying-glass"></i> Run Discovery
            </button>
          </div>
        </td>
      </tr>
    `;
    return;
  }
  
  container.innerHTML = DiscoveryState.artifacts.map(artifact => `
    <tr data-id="${artifact.ID}" class="artifact-row ${artifact.migrationStatus}">
      <td>
        <input type="checkbox" class="artifact-select" data-id="${artifact.ID}">
      </td>
      <td>
        <div class="artifact-name">
          <i class="fa-solid ${getArtifactIcon(artifact.artifactType)}"></i>
          <span>${artifact.name || artifact.objectId}</span>
        </div>
        <div class="artifact-meta">${artifact.namespace || ''}</div>
      </td>
      <td><span class="type-badge">${formatArtifactType(artifact.artifactType)}</span></td>
      <td><span class="adapter-badge ${artifact.adapterType?.toLowerCase()}">${artifact.adapterType || '-'}</span></td>
      <td>
        <span class="tier-badge ${artifact.migrationTier || 'unknown'}">
          ${artifact.migrationTier || 'Not assessed'}
        </span>
      </td>
      <td>
        <span class="status-badge ${artifact.migrationStatus}">
          ${formatStatus(artifact.migrationStatus)}
        </span>
      </td>
      <td class="actions">
        <button class="btn-icon" onclick="viewArtifactDetails('${artifact.ID}')" title="View Details">
          <i class="fa-solid fa-eye"></i>
        </button>
        <button class="btn-icon" onclick="assessArtifact('${artifact.ID}')" title="AI Assessment">
          <i class="fa-solid fa-robot"></i>
        </button>
        <button class="btn-icon" onclick="approveArtifact('${artifact.ID}')" title="Approve">
          <i class="fa-solid fa-check"></i>
        </button>
      </td>
    </tr>
  `).join('');
}

function renderPagination() {
  const container = document.getElementById('artifact-pagination');
  if (!container) return;
  
  const { page, pageSize, total } = DiscoveryState.pagination;
  const totalPages = Math.ceil(total / pageSize);
  
  container.innerHTML = `
    <span class="pagination-info">Showing ${(page - 1) * pageSize + 1}-${Math.min(page * pageSize, total)} of ${total}</span>
    <div class="pagination-buttons">
      <button class="btn-page" ${page <= 1 ? 'disabled' : ''} onclick="loadArtifacts('${DiscoveryState.currentSystem?.ID}', ${page - 1})">
        <i class="fa-solid fa-chevron-left"></i>
      </button>
      <span class="page-num">${page} / ${totalPages}</span>
      <button class="btn-page" ${page >= totalPages ? 'disabled' : ''} onclick="loadArtifacts('${DiscoveryState.currentSystem?.ID}', ${page + 1})">
        <i class="fa-solid fa-chevron-right"></i>
      </button>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ARTIFACT DETAILS & ACTIONS
// ═══════════════════════════════════════════════════════════════════════════════
async function viewArtifactDetails(artifactId) {
  try {
    showDiscoveryLoading('Loading details...');
    const result = await discoveryFetch(`/getArtifactDetails(artifactId=${artifactId})`);
    hideDiscoveryLoading();
    
    const artifact = JSON.parse(result.artifact);
    const bodyHtml = `
      <div class="artifact-details">
        <div class="detail-section">
          <h4>Basic Information</h4>
          <div class="detail-grid">
            <div class="detail-item"><label>Name</label><span>${artifact.name}</span></div>
            <div class="detail-item"><label>Type</label><span>${formatArtifactType(artifact.artifactType)}</span></div>
            <div class="detail-item"><label>Namespace</label><span>${artifact.namespace || '-'}</span></div>
            <div class="detail-item"><label>SWCV</label><span>${artifact.swcv || '-'}</span></div>
          </div>
        </div>
        
        <div class="detail-section">
          <h4>Sender / Receiver</h4>
          <div class="detail-grid">
            <div class="detail-item"><label>Sender</label><span>${artifact.senderComponent || '-'} / ${artifact.senderInterface || '-'}</span></div>
            <div class="detail-item"><label>Receiver</label><span>${artifact.receiverComponent || '-'} / ${artifact.receiverInterface || '-'}</span></div>
            <div class="detail-item"><label>Adapter</label><span>${artifact.adapterType || '-'}</span></div>
          </div>
        </div>
        
        <div class="detail-section">
          <h4>Migration Assessment</h4>
          <div class="detail-grid">
            <div class="detail-item"><label>Complexity Tier</label><span class="tier-badge ${artifact.migrationTier || 'unknown'}">${artifact.migrationTier || 'Not assessed'}</span></div>
            <div class="detail-item"><label>Complexity Score</label><span>${artifact.complexityScore || '-'}/100</span></div>
            <div class="detail-item"><label>Recommended Tool</label><span>${artifact.recommendedTool || '-'}</span></div>
            <div class="detail-item"><label>Estimated Hours</label><span>${artifact.estimatedHours || '-'}</span></div>
          </div>
        </div>
        
        ${result.dependencies ? `
        <div class="detail-section">
          <h4>Dependencies</h4>
          <pre class="dep-list">${result.dependencies}</pre>
        </div>
        ` : ''}
      </div>
    `;
    
    openModal(`Artifact: ${artifact.name}`, bodyHtml, [
      { label: 'Close', cls: 'btn-btp-cancel', onClick: closeModal },
      { label: 'Run AI Assessment', cls: 'btn-btp-action', onClick: () => { closeModal(); assessArtifact(artifactId); } },
      { label: 'Approve for Migration', cls: 'btn-btp-gold', onClick: () => { closeModal(); approveArtifact(artifactId); } },
    ]);
    
  } catch (error) {
    hideDiscoveryLoading();
    showToast('Error', `Failed to load details: ${error.message}`, 'danger');
  }
}

async function assessArtifact(artifactId) {
  try {
    showDiscoveryLoading('Running AI assessment...');
    const result = await discoveryAction('assessArtifact', { artifactId });
    hideDiscoveryLoading();
    
    showToast('Assessment Complete', `Tier: ${result.tier}, Est. Hours: ${result.estimatedHours}`, 'success');
    
    // Refresh the artifact list
    if (DiscoveryState.currentSystem) {
      await loadArtifacts(DiscoveryState.currentSystem.ID, DiscoveryState.pagination.page);
    }
    
  } catch (error) {
    hideDiscoveryLoading();
    showToast('Error', `Assessment failed: ${error.message}`, 'danger');
  }
}

async function approveArtifact(artifactId, wave = 1) {
  const bodyHtml = `
    <div class="approve-form">
      <div class="form-group-btp">
        <label>Migration Wave</label>
        <select class="btp-input" id="approve-wave">
          <option value="1">Wave 1 (Priority)</option>
          <option value="2">Wave 2</option>
          <option value="3">Wave 3</option>
          <option value="4">Wave 4 (Later)</option>
        </select>
      </div>
      <div class="form-group-btp">
        <label>Notes</label>
        <textarea class="btp-input" id="approve-notes" placeholder="Optional notes..."></textarea>
      </div>
    </div>
  `;
  
  openModal('Approve for Migration', bodyHtml, [
    { label: 'Cancel', cls: 'btn-btp-cancel', onClick: closeModal },
    { label: 'Approve', cls: 'btn-btp-gold', onClick: async () => {
      try {
        const selectedWave = parseInt($('approve-wave').value);
        const notes = $('approve-notes').value;
        
        await discoveryAction('approveArtifact', { artifactId, wave: selectedWave, notes });
        closeModal();
        showToast('Approved', 'Artifact approved for migration', 'success');
        
        if (DiscoveryState.currentSystem) {
          await loadArtifacts(DiscoveryState.currentSystem.ID, DiscoveryState.pagination.page);
        }
      } catch (error) {
        showToast('Error', error.message, 'danger');
      }
    }},
  ]);
}

async function batchApprove() {
  const selected = Array.from(document.querySelectorAll('.artifact-select:checked')).map(cb => cb.dataset.id);
  
  if (selected.length === 0) {
    showToast('No Selection', 'Please select artifacts to approve', 'warning');
    return;
  }
  
  const bodyHtml = `
    <div class="approve-form">
      <p>${selected.length} artifact(s) selected for batch approval.</p>
      <div class="form-group-btp">
        <label>Migration Wave</label>
        <select class="btp-input" id="batch-approve-wave">
          <option value="1">Wave 1 (Priority)</option>
          <option value="2">Wave 2</option>
          <option value="3">Wave 3</option>
          <option value="4">Wave 4 (Later)</option>
        </select>
      </div>
      <div class="form-group-btp">
        <label>Notes</label>
        <textarea class="btp-input" id="batch-approve-notes" placeholder="Optional notes..."></textarea>
      </div>
    </div>
  `;
  
  openModal('Batch Approve', bodyHtml, [
    { label: 'Cancel', cls: 'btn-btp-cancel', onClick: closeModal },
    { label: `Approve ${selected.length} Artifacts`, cls: 'btn-btp-gold', onClick: async () => {
      try {
        showDiscoveryLoading('Approving artifacts...');
        const wave = parseInt($('batch-approve-wave').value);
        const notes = $('batch-approve-notes').value;
        
        const result = await discoveryAction('batchApprove', { 
          artifactIds: JSON.stringify(selected), 
          wave, 
          notes 
        });
        
        hideDiscoveryLoading();
        closeModal();
        showToast('Batch Approved', `${result.approved} artifacts approved, ${result.failed} failed`, 'success');
        
        if (DiscoveryState.currentSystem) {
          await loadArtifacts(DiscoveryState.currentSystem.ID, DiscoveryState.pagination.page);
        }
      } catch (error) {
        hideDiscoveryLoading();
        showToast('Error', error.message, 'danger');
      }
    }},
  ]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════
function extractHost(url) {
  try {
    const u = new URL(url);
    return u.hostname;
  } catch {
    return url.replace(/^https?:\/\//, '').split(':')[0].split('/')[0];
  }
}

function extractPort(url) {
  try {
    const u = new URL(url);
    return u.port ? parseInt(u.port) : (u.protocol === 'https:' ? 443 : 80);
  } catch {
    const match = url.match(/:(\d+)/);
    return match ? parseInt(match[1]) : 443;
  }
}

function getArtifactIcon(type) {
  const icons = {
    IntegratedConfiguration: 'fa-diagram-project',
    CommunicationChannel: 'fa-plug',
    MessageMapping: 'fa-code-compare',
    ValueMappingGroup: 'fa-table',
    SenderAgreement: 'fa-handshake',
    ReceiverAgreement: 'fa-handshake',
    OperationMapping: 'fa-gear',
    SoftwareComponentVersion: 'fa-cube',
  };
  return icons[type] || 'fa-file';
}

function formatArtifactType(type) {
  const names = {
    IntegratedConfiguration: 'ICO',
    CommunicationChannel: 'Channel',
    MessageMapping: 'Mapping',
    ValueMappingGroup: 'Value Map',
    SenderAgreement: 'Sender Agmt',
    ReceiverAgreement: 'Receiver Agmt',
    OperationMapping: 'Op Mapping',
    SoftwareComponentVersion: 'SWCV',
  };
  return names[type] || type;
}

function formatStatus(status) {
  const labels = {
    discovered: 'Discovered',
    assessed: 'Assessed',
    approved: 'Approved',
    in_progress: 'In Progress',
    migrated: 'Migrated',
    skipped: 'Skipped',
  };
  return labels[status] || status;
}

function showDiscoveryLoading(message) {
  const overlay = document.getElementById('discovery-loading');
  if (overlay) {
    overlay.querySelector('.loading-message').textContent = message || 'Loading...';
    overlay.style.display = 'flex';
  }
}

function hideDiscoveryLoading() {
  const overlay = document.getElementById('discovery-loading');
  if (overlay) overlay.style.display = 'none';
}

function renderSystemList() {
  const container = document.getElementById('pi-systems-list');
  if (!container) return;
  
  if (DiscoveryState.systems.length === 0) {
    container.innerHTML = '<div class="empty-state"><p>No PI/PO systems configured</p></div>';
    return;
  }
  
  container.innerHTML = DiscoveryState.systems.map(sys => `
    <div class="system-card ${sys.status}" data-id="${sys.ID}">
      <div class="system-header">
        <i class="fa-solid fa-server"></i>
        <div>
          <h4>${sys.systemName}</h4>
          <span class="text-muted">${sys.virtualHost}</span>
        </div>
        <span class="status-indicator ${sys.status}">${sys.status}</span>
      </div>
      <div class="system-stats">
        <span><i class="fa-solid fa-cube"></i> ${sys.totalArtifacts || 0} artifacts</span>
        <span><i class="fa-solid fa-clock"></i> ${sys.lastDiscoveryAt ? new Date(sys.lastDiscoveryAt).toLocaleDateString() : 'Never'}</span>
      </div>
      <div class="system-actions">
        <button class="btn-btp-action-small" onclick="openDiscoveryWizard('${sys.ID}')">
          <i class="fa-solid fa-magnifying-glass"></i> Discover
        </button>
        <button class="btn-btp-action-small" onclick="showArtifactBrowser('${sys.ID}')">
          <i class="fa-solid fa-list"></i> Browse
        </button>
      </div>
    </div>
  `).join('');
}

// ═══════════════════════════════════════════════════════════════════════════════
// FILTER HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════
function applyArtifactFilters() {
  DiscoveryState.filters.type = $('filter-type')?.value || '';
  DiscoveryState.filters.status = $('filter-status')?.value || '';
  DiscoveryState.filters.tier = $('filter-tier')?.value || '';
  DiscoveryState.filters.search = $('filter-search')?.value || '';
  
  if (DiscoveryState.currentSystem) {
    loadArtifacts(DiscoveryState.currentSystem.ID, 1);
  }
}

function clearArtifactFilters() {
  DiscoveryState.filters = { type: '', status: '', tier: '', search: '' };
  if ($('filter-type')) $('filter-type').value = '';
  if ($('filter-status')) $('filter-status').value = '';
  if ($('filter-tier')) $('filter-tier').value = '';
  if ($('filter-search')) $('filter-search').value = '';
  
  if (DiscoveryState.currentSystem) {
    loadArtifacts(DiscoveryState.currentSystem.ID, 1);
  }
}

function selectAllArtifacts(checked) {
  document.querySelectorAll('.artifact-select').forEach(cb => cb.checked = checked);
}

// ═══════════════════════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════════
function initDiscoveryModule() {
  console.log('[Discovery] Initializing module...');
  
  // Override the mock testPiPoConnection
  window.testPiPoConnection = testSystemConnection;
  
  // Load systems on init
  loadPISystems().catch(console.error);
  
  // Bind filter handlers
  const filterElements = ['filter-type', 'filter-status', 'filter-tier'];
  filterElements.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', applyArtifactFilters);
  });
  
  const searchEl = document.getElementById('filter-search');
  if (searchEl) {
    let debounceTimer;
    searchEl.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(applyArtifactFilters, 300);
    });
  }
  
  console.log('[Discovery] Module initialized');
}

// Auto-init when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initDiscoveryModule);
} else {
  initDiscoveryModule();
}

// Export for global access
window.DiscoveryModule = {
  loadPISystems,
  addPISystem,
  testSystemConnection,
  openDiscoveryWizard,
  startDiscovery,
  showArtifactBrowser,
  loadArtifacts,
  viewArtifactDetails,
  assessArtifact,
  approveArtifact,
  batchApprove,
  applyArtifactFilters,
  clearArtifactFilters,
  selectAllArtifacts,
  connectDiscoverySSE,
  disconnectDiscoverySSE,
};
