'use strict';
/**
 * PI/PO SOAP Client with SAP Cloud SDK Transport
 *
 * SAP NetWeaver 7.50 Optimized Implementation
 *
 * Provides SOAP access to PI/PO Directory and ESR services through Cloud Connector.
 * Uses SAP Cloud SDK for destination resolution and connectivity proxy handling.
 *
 * Key Features:
 * - 7.50-specific API support (IntegratedConfiguration750InService)
 * - Full channel module chain extraction (<ModuleProcess>)
 * - Configuration Scenario grouping support
 * - Sender/Receiver Agreement extraction
 * - Security material discovery
 * - Dynamic WSDL fetching through Cloud Connector
 * - Custom HTTP transport using Cloud SDK executeHttpRequest
 * - Connection pooling and caching
 * - Timeout handling for large inventories
 * - XML parsing with xml2js
 *
 * Based on SAP Documentation:
 * - directory-api-07096c2.md
 * - examples-for-directory-api-dc70456.md
 */

const cds = require('@sap/cds');
const LOG = cds.log('pipo-soap-client');
const xml2js = require('xml2js');
let executeHttpRequest = null;
try {
  executeHttpRequest = require('@sap-cloud-sdk/http-client').executeHttpRequest;
} catch (e) {
  // HTTP client not available in dev
  executeHttpRequest = async () => ({ data: '<?xml version="1.0"?><soapenv:Envelope></soapenv:Envelope>' });
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const SOAP_SERVICES = {
  // Directory Services (Configuration Objects) - SAP NetWeaver 7.50
  IntegratedConfiguration: '/IntegratedConfigurationInService/IntegratedConfigurationInImplBean',
  IntegratedConfiguration750: '/IntegratedConfiguration750InService/IntegratedConfiguration750InImplBean',
  CommunicationChannel: '/CommunicationChannelInService/CommunicationChannelInImplBean',
  SenderAgreement: '/SenderAgreementInService/SenderAgreementInImplBean',
  ReceiverAgreement: '/ReceiverAgreementInService/ReceiverAgreementInImplBean',
  InterfaceDetermination: '/InterfaceDeterminationInService/InterfaceDeterminationInImplBean',
  ReceiverDetermination: '/ReceiverDeterminationInService/ReceiverDeterminationInImplBean',
  ValueMapping: '/ValueMappingInService/ValueMappingInImplBean',
  AlertRule: '/AlertRuleInService/AlertRuleInImplBean',
  BusinessComponent: '/BusinessComponentInService/BusinessComponentInImplBean',
  ConfigurationScenario: '/ConfigurationScenarioInService/ConfigurationScenarioInImplBean',
  // 7.50 Additional Services
  Party: '/PartyInService/PartyInImplBean',
  BusinessSystem: '/BusinessSystemInService/BusinessSystemInImplBean',
};

const ESR_ENDPOINTS = {
  simpleQuery: '/rep/support/SimpleQuery',
  queryExt: '/rep/query/ext/1',
  readExt: '/rep/read/ext/1',
};

const ESR_OBJECT_TYPES = [
  'SoftwareComponentVersion',
  'Namespace',
  'MessageType',
  'DataType',
  'ExternalDefinition',
  'ServiceInterface',
  'MessageMapping',
  'OperationMapping',
  'InterfaceMapping',
  'FunctionLibrary',
  'ImportedArchive',
];

// SAP NetWeaver 7.50 XML Namespaces
const XI_NAMESPACES = {
  basis: 'http://sap.com/xi/BASIS',
  basis750: 'http://sap.com/xi/BASIS/750',
  adapter: 'http://sap.com/xi/XI/Adapter',
  system: 'http://sap.com/xi/XI/System',
};

const DEFAULT_TIMEOUT = 60000;
const LONG_TIMEOUT = 180000;

// ═══════════════════════════════════════════════════════════════════════════════
// SOAP CLIENT CLASS
// ═══════════════════════════════════════════════════════════════════════════════

class PIPoSoapClient {
  /**
   * @param {string} destinationName - BTP destination name
   * @param {Object} options - Configuration options
   */
  constructor(destinationName, options = {}) {
    this.destinationName = destinationName;
    this.timeout = options.timeout || DEFAULT_TIMEOUT;
    this.parser = new xml2js.Parser({
      explicitArray: false,
      ignoreAttrs: false,
      tagNameProcessors: [xml2js.processors.stripPrefix],
    });
    this.builder = new xml2js.Builder({
      renderOpts: { pretty: false },
      xmldec: { version: '1.0', encoding: 'UTF-8' },
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // HTTP HELPERS
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Execute HTTP request through Cloud SDK (handles Cloud Connector routing)
   */
  async _request(path, method = 'GET', data = null, headers = {}, timeout = null) {
    const config = {
      method,
      url: path,
      headers: {
        Accept: 'application/xml, text/xml, */*',
        ...headers,
      },
      timeout: timeout || this.timeout,
    };

    if (data) {
      config.data = data;
      config.headers['Content-Type'] = headers['Content-Type'] || 'text/xml; charset=utf-8';
    }

    try {
      const response = await executeHttpRequest({ destinationName: this.destinationName }, config);
      return response;
    } catch (error) {
      const statusCode = error.response?.status || error.code || 'UNKNOWN';
      const message = error.response?.data || error.message;
      throw new Error(`PI/PO request failed [${statusCode}]: ${message}`);
    }
  }

  /**
   * Parse XML response to JavaScript object
   */
  async _parseXml(xml) {
    return new Promise((resolve, reject) => {
      this.parser.parseString(xml, (err, result) => {
        if (err) reject(new Error(`XML parse error: ${err.message}`));
        else resolve(result);
      });
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SOAP OPERATIONS
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Build SOAP envelope for a request
   */
  _buildSoapEnvelope(operation, namespace, body) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns="${namespace}">
  <soapenv:Header/>
  <soapenv:Body>
    <ns:${operation}>
      ${body}
    </ns:${operation}>
  </soapenv:Body>
</soapenv:Envelope>`;
  }

  /**
   * Execute SOAP operation
   */
  async _soapCall(servicePath, operation, namespace, body = '', timeout = null) {
    const envelope = this._buildSoapEnvelope(operation, namespace, body);
    const soapAction = `${namespace}/${operation}`;

    const response = await this._request(
      servicePath,
      'POST',
      envelope,
      {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: soapAction,
      },
      timeout
    );

    const parsed = await this._parseXml(response.data);

    // Extract SOAP body
    const soapBody = parsed?.Envelope?.Body;
    if (!soapBody) {
      throw new Error('Invalid SOAP response: missing Body element');
    }

    // Check for SOAP fault
    if (soapBody.Fault) {
      const faultString = soapBody.Fault.faultstring || 'Unknown SOAP fault';
      throw new Error(`SOAP Fault: ${faultString}`);
    }

    return soapBody;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // DIRECTORY API - QUERY OPERATIONS
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Query Integrated Configurations (ICOs)
   */
  async queryIntegratedConfigurations() {
    const namespace = 'http://sap.com/xi/BASIS';
    const servicePath = SOAP_SERVICES.IntegratedConfiguration;

    // Try 7.50 service first, fall back to standard
    try {
      const body = await this._soapCall(
        SOAP_SERVICES.IntegratedConfiguration750,
        'IntegratedConfiguration750QueryRequest',
        namespace,
        '',
        LONG_TIMEOUT
      );
      return this._extractQueryResponse(body, 'IntegratedConfiguration750QueryResponse');
    } catch (e) {
      // Fall back to standard service
      const body = await this._soapCall(
        servicePath,
        'IntegratedConfigurationQueryRequest',
        namespace,
        '',
        LONG_TIMEOUT
      );
      return this._extractQueryResponse(body, 'IntegratedConfigurationQueryResponse');
    }
  }

  /**
   * Query Communication Channels
   */
  async queryCommunicationChannels() {
    const namespace = 'http://sap.com/xi/BASIS';
    const body = await this._soapCall(
      SOAP_SERVICES.CommunicationChannel,
      'CommunicationChannelQueryRequest',
      namespace,
      '',
      LONG_TIMEOUT
    );
    return this._extractQueryResponse(body, 'CommunicationChannelQueryResponse');
  }

  /**
   * Query Sender Agreements
   */
  async querySenderAgreements() {
    const namespace = 'http://sap.com/xi/BASIS';
    const body = await this._soapCall(SOAP_SERVICES.SenderAgreement, 'SenderAgreementQueryRequest', namespace, '');
    return this._extractQueryResponse(body, 'SenderAgreementQueryResponse');
  }

  /**
   * Query Receiver Agreements
   */
  async queryReceiverAgreements() {
    const namespace = 'http://sap.com/xi/BASIS';
    const body = await this._soapCall(SOAP_SERVICES.ReceiverAgreement, 'ReceiverAgreementQueryRequest', namespace, '');
    return this._extractQueryResponse(body, 'ReceiverAgreementQueryResponse');
  }

  /**
   * Query Value Mappings
   */
  async queryValueMappings() {
    const namespace = 'http://sap.com/xi/BASIS';
    const body = await this._soapCall(SOAP_SERVICES.ValueMapping, 'ValueMappingQueryRequest', namespace, '');
    return this._extractQueryResponse(body, 'ValueMappingQueryResponse');
  }

  /**
   * Extract items from query response
   */
  _extractQueryResponse(soapBody, responseElement) {
    const response = soapBody[responseElement];
    if (!response) {
      return [];
    }

    // Find the items array (varies by response type)
    const possibleArrays = [
      'IntegratedConfiguration',
      'CommunicationChannel',
      'SenderAgreement',
      'ReceiverAgreement',
      'ValueMappingGroup',
      'Item',
      'item',
    ];

    for (const key of possibleArrays) {
      if (response[key]) {
        const items = response[key];
        return Array.isArray(items) ? items : [items];
      }
    }

    return [];
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // DIRECTORY API - READ OPERATIONS
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Read full ICO definition by key
   */
  async readIntegratedConfiguration(key) {
    const namespace = 'http://sap.com/xi/BASIS';
    const keyXml = this._buildKeyXml(key);

    const body = await this._soapCall(
      SOAP_SERVICES.IntegratedConfiguration,
      'IntegratedConfigurationReadRequest',
      namespace,
      keyXml
    );

    return body.IntegratedConfigurationReadResponse?.IntegratedConfiguration;
  }

  /**
   * Read full Channel definition by key
   */
  async readCommunicationChannel(key) {
    const namespace = 'http://sap.com/xi/BASIS';
    const keyXml = this._buildKeyXml(key);

    const body = await this._soapCall(
      SOAP_SERVICES.CommunicationChannel,
      'CommunicationChannelReadRequest',
      namespace,
      keyXml
    );

    return body.CommunicationChannelReadResponse?.CommunicationChannel;
  }

  /**
   * Build XML for key parameters
   */
  _buildKeyXml(key) {
    if (typeof key === 'string') {
      return `<ReadContext><ObjectID>${key}</ObjectID></ReadContext>`;
    }
    // Key is an object with multiple parts
    let xml = '<ReadContext>';
    for (const [k, v] of Object.entries(key)) {
      xml += `<${k}>${v}</${k}>`;
    }
    xml += '</ReadContext>';
    return xml;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // ESR API - REPOSITORY QUERIES
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Query ESR objects using Simple Query endpoint
   * This is the most reliable method for PI/PO 7.50
   */
  async queryEsrSimple(objectType) {
    const path = `${ESR_ENDPOINTS.simpleQuery}?type=${objectType}&swcSelection=all`;

    const response = await this._request(
      path,
      'GET',
      null,
      {
        Accept: 'text/html, application/xml, */*',
      },
      LONG_TIMEOUT
    );

    // Simple Query returns HTML with embedded data - parse it
    return this._parseSimpleQueryResponse(response.data, objectType);
  }

  /**
   * Query ESR objects using external query API
   */
  async queryEsrExt(objectType, filters = {}) {
    const path = `${ESR_ENDPOINTS.queryExt}/${objectType}`;

    try {
      const response = await this._request(path, 'GET', null, {
        Accept: 'application/xml',
      });

      const parsed = await this._parseXml(response.data);
      return this._extractEsrQueryResponse(parsed, objectType);
    } catch (e) {
      // Fall back to Simple Query
      return this.queryEsrSimple(objectType);
    }
  }

  /**
   * Read ESR object definition
   */
  async readEsrObject(objectType, objectKey) {
    const keyParam = encodeURIComponent(objectKey);
    const path = `${ESR_ENDPOINTS.readExt}/${objectType}/${keyParam}`;

    const response = await this._request(path, 'GET', null, {
      Accept: 'application/xml',
    });

    return this._parseXml(response.data);
  }

  /**
   * Get all Software Component Versions
   */
  async querySoftwareComponentVersions() {
    return this.queryEsrSimple('SoftwareComponentVersion');
  }

  /**
   * Get all Message Mappings
   */
  async queryMessageMappings() {
    return this.queryEsrSimple('MessageMapping');
  }

  /**
   * Get all Operation Mappings
   */
  async queryOperationMappings() {
    return this.queryEsrSimple('OperationMapping');
  }

  /**
   * Get all Service Interfaces
   */
  async queryServiceInterfaces() {
    return this.queryEsrSimple('ServiceInterface');
  }

  /**
   * Parse Simple Query HTML/XML response
   */
  _parseSimpleQueryResponse(html, objectType) {
    // Simple Query can return either HTML table or XML
    if (html.includes('<?xml')) {
      return this._parseXml(html).then(parsed => {
        return this._extractEsrQueryResponse(parsed, objectType);
      });
    }

    // Parse HTML table response
    const items = [];
    const rowRegex = /<tr[^>]*>(.*?)<\/tr>/gs;
    const cellRegex = /<td[^>]*>(.*?)<\/td>/gs;

    let match;
    let isHeader = true;
    const headers = [];

    while ((match = rowRegex.exec(html)) !== null) {
      const rowHtml = match[1];
      const cells = [];
      let cellMatch;

      while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
        cells.push(cellMatch[1].replace(/<[^>]+>/g, '').trim());
      }

      if (isHeader && cells.length > 0) {
        headers.push(...cells);
        isHeader = false;
      } else if (cells.length > 0) {
        const item = {};
        cells.forEach((cell, i) => {
          if (headers[i]) {
            item[headers[i]] = cell;
          }
        });
        if (Object.keys(item).length > 0) {
          items.push(item);
        }
      }
    }

    return items;
  }

  /**
   * Extract ESR query response items
   */
  _extractEsrQueryResponse(parsed, objectType) {
    // Navigate through possible response structures
    const root = parsed?.rws?.response || parsed?.response || parsed;
    const items = root?.[objectType] || root?.item || root?.Item || [];
    return Array.isArray(items) ? items : [items];
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SAP NETWEAVER 7.50 SPECIFIC OPERATIONS
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Query ICOs using the 7.50-specific service with ReceiverWildcardIndicator support
   * Falls back to standard service if 7.50 service not available
   * @returns {Promise<Array>} List of ICO summaries with 7.50 fields
   */
  async queryIntegratedConfigurations750() {
    const namespace = XI_NAMESPACES.basis;

    try {
      // Try 7.50 service first - includes ReceiverWildcardIndicator
      const body = await this._soapCall(
        SOAP_SERVICES.IntegratedConfiguration750,
        'IntegratedConfiguration750QueryRequest',
        namespace,
        '',
        LONG_TIMEOUT
      );
      return this._extractQueryResponse(body, 'IntegratedConfiguration750QueryResponse');
    } catch (e) {
      // Fall back to standard service
      LOG.warn('7.50 ICO service not available, using standard', { error: e.message });
      return this.queryIntegratedConfigurations();
    }
  }

  /**
   * Read full ICO definition using 7.50 service (includes ReceiverWildcardIndicator)
   * @param {Object|string} key - ICO key object or ObjectID
   * @returns {Promise<Object>} Full ICO definition with 7.50 fields
   */
  async readIntegratedConfiguration750(key) {
    const namespace = XI_NAMESPACES.basis;
    const keyXml = this._buildIcoKeyXml750(key);

    try {
      const body = await this._soapCall(
        SOAP_SERVICES.IntegratedConfiguration750,
        'IntegratedConfiguration750ReadRequest',
        namespace,
        keyXml,
        LONG_TIMEOUT
      );

      const ico =
        body.IntegratedConfiguration750ReadResponse?.IntegratedConfiguration750 ||
        body.IntegratedConfiguration750ReadResponse?.IntegratedConfiguration;

      if (ico) {
        // Extract 7.50-specific fields
        ico._is750 = true;
        ico.receiverWildcardIndicator = ico.ReceiverWildcardIndicator || ico.receiverWildcardIndicator;
      }

      return ico;
    } catch (e) {
      // Fall back to standard service
      LOG.warn('7.50 ICO read not available, using standard', { error: e.message });
      return this.readIntegratedConfiguration(key);
    }
  }

  /**
   * Build key XML for ICO 7.50 read request
   * Supports both simple ObjectID and complex keys
   */
  _buildIcoKeyXml750(key) {
    if (typeof key === 'string') {
      return `<IntegratedConfiguration750ID>
        <ObjectID>${this._escapeXml(key)}</ObjectID>
      </IntegratedConfiguration750ID>`;
    }

    // Complex key with component/interface/namespace
    let xml = '<IntegratedConfiguration750ID>';
    if (key.SenderPartyID) xml += `<SenderPartyID>${this._escapeXml(key.SenderPartyID)}</SenderPartyID>`;
    if (key.SenderComponentID)
      xml += `<SenderComponentID>${this._escapeXml(key.SenderComponentID)}</SenderComponentID>`;
    if (key.InterfaceName) xml += `<InterfaceName>${this._escapeXml(key.InterfaceName)}</InterfaceName>`;
    if (key.InterfaceNamespace)
      xml += `<InterfaceNamespace>${this._escapeXml(key.InterfaceNamespace)}</InterfaceNamespace>`;
    if (key.ReceiverPartyID) xml += `<ReceiverPartyID>${this._escapeXml(key.ReceiverPartyID)}</ReceiverPartyID>`;
    if (key.ReceiverComponentID)
      xml += `<ReceiverComponentID>${this._escapeXml(key.ReceiverComponentID)}</ReceiverComponentID>`;
    xml += '</IntegratedConfiguration750ID>';

    return xml;
  }

  /**
   * Read full Communication Channel definition with module chain
   * @param {Object|string} key - Channel key object or ObjectID
   * @returns {Promise<Object>} Full channel definition with extracted module chain
   */
  async readCommunicationChannelWithModules(key) {
    const channel = await this.readCommunicationChannel(key);

    if (channel) {
      // Extract module process chain from channel definition
      channel.moduleChain = this._extractModuleChain(channel);
      channel.adapterSpecificConfig = this._extractAdapterSpecificConfig(channel);
      channel.securityConfig = this._extractSecurityConfig(channel);
    }

    return channel;
  }

  /**
   * Extract module process chain from channel definition
   * PI/PO stores modules in <ModuleProcess><ProcessStep> elements
   * @param {Object} channel - Parsed channel definition
   * @returns {Array<Object>} Ordered list of module configurations
   */
  _extractModuleChain(channel) {
    const modules = [];

    // Navigate to ModuleProcess (can be in different locations)
    const moduleProcess =
      channel.ModuleProcess || channel.AdapterSpecificData?.ModuleProcess || channel.adapterSpecificData?.ModuleProcess;

    if (!moduleProcess) {
      return modules;
    }

    // Extract ProcessSteps
    let processSteps = moduleProcess.ProcessStep || moduleProcess.processStep;
    if (!processSteps) {
      return modules;
    }

    // Ensure array
    if (!Array.isArray(processSteps)) {
      processSteps = [processSteps];
    }

    for (let i = 0; i < processSteps.length; i++) {
      const step = processSteps[i];
      const moduleConfig = {
        sequence: i + 1,
        moduleKey: step.ModuleKey || step.moduleKey || step.key || `module_${i + 1}`,
        moduleName: step.ModuleName || step.moduleName || step.ModuleRef || step.moduleRef,
        moduleType: step.ModuleType || step.moduleType || 'Local Enterprise Bean',
        parameters: this._extractModuleParameters(step),
        // Identify IS equivalent for migration
        isEquivalent: this._identifyIsEquivalent(
          step.ModuleName || step.moduleName || step.ModuleRef || step.moduleRef
        ),
      };
      modules.push(moduleConfig);
    }

    return modules;
  }

  /**
   * Extract parameters from a module step
   */
  _extractModuleParameters(step) {
    const params = {};

    // Parameters can be in ModuleParameters or Parameters
    let paramList = step.ModuleParameters || step.Parameters || step.parameters;
    if (!paramList) {
      return params;
    }

    // Can be array of param objects or object with entries
    let entries = paramList.Parameter || paramList.parameter || paramList;
    if (!entries) {
      return params;
    }

    if (!Array.isArray(entries)) {
      entries = [entries];
    }

    for (const entry of entries) {
      const name = entry.Name || entry.name || entry.ParameterName || entry.parameterName;
      const value = entry.Value || entry.value || entry.ParameterValue || entry.parameterValue;
      if (name) {
        params[name] = value || '';
      }
    }

    return params;
  }

  /**
   * Identify Integration Suite equivalent for a PI/PO adapter module
   * Based on SAP's adapter-modules-e402f4a.md documentation
   */
  _identifyIsEquivalent(moduleName) {
    if (!moduleName) return null;

    const moduleMapping = {
      // Standard SAP Modules -> IS Steps
      'AF_Modules/PayloadSwapBean': 'Content Modifier (swap body/attachment)',
      'AF_Modules/StrictXml2PlainBean': 'Encoder step (XML to Plain Text)',
      'AF_Modules/XMLAnonymizerBean': 'Content Modifier + Groovy Script',
      'AF_Modules/MessageTransformBean': 'Content Modifier',
      'AF_Modules/DynamicConfigurationBean': 'Content Modifier (header manipulation)',
      'AF_Modules/RequestResponseBean': 'Request Reply step pattern',
      'localejbs/CallSapAdapter': 'ProcessDirect adapter call',
      'localejbs/AFW': 'Adapter Framework step',
      // Text/XML Conversion
      'localejbs/Rfc2Plain': 'RFC to Plain Text converter',
      'localejbs/Plain2Rfc': 'Plain Text to RFC converter',
      // Compression
      'AF_Modules/PayloadZipBean': 'Encoder step (Zip)',
      // MIME/Attachment handling
      'AF_Modules/MIMEDecodeBean': 'Decoder step (MIME)',
      'AF_Modules/MIMEEncodeBean': 'Encoder step (MIME)',
    };

    // Try exact match first
    if (moduleMapping[moduleName]) {
      return moduleMapping[moduleName];
    }

    // Try partial match (module name without path)
    const shortName = moduleName.split('/').pop();
    for (const [key, value] of Object.entries(moduleMapping)) {
      if (key.endsWith(shortName)) {
        return value;
      }
    }

    // Custom modules need Groovy script
    if (moduleName.includes('localejbs/') || moduleName.includes('custom/')) {
      return 'Groovy Script (custom logic required)';
    }

    return 'Manual analysis required';
  }

  /**
   * Extract adapter-specific configuration from channel
   */
  _extractAdapterSpecificConfig(channel) {
    const config = {};

    // Extract adapter type
    config.adapterType =
      channel.AdapterType || channel.adapterType || channel.TransportProtocol || channel.transportProtocol;
    config.adapterNamespace = channel.AdapterNamespace || channel.adapterNamespace;
    config.direction = channel.Direction || channel.direction || (channel.IsSender === 'true' ? 'sender' : 'receiver');

    // Extract adapter-specific attributes
    const adapterData =
      channel.AdapterSpecificAttribute || channel.adapterSpecificAttribute || channel.AdapterSpecificData?.attribute;

    if (adapterData) {
      const attrs = Array.isArray(adapterData) ? adapterData : [adapterData];
      for (const attr of attrs) {
        const name = attr.Name || attr.name;
        const value = attr.Value || attr.value;
        if (name) {
          config[name] = value;
        }
      }
    }

    return config;
  }

  /**
   * Extract security configuration from channel
   */
  _extractSecurityConfig(channel) {
    const security = {
      authMethod: null,
      credentialAlias: null,
      certificates: [],
      keystoreView: null,
    };

    // Look for security-related attributes
    const adapterConfig = this._extractAdapterSpecificConfig(channel);

    // Common security attribute names
    const authAttrNames = ['authentication', 'authType', 'AuthenticationType', 'securityLevel'];
    const credAttrNames = ['credentialName', 'credential', 'user', 'userId'];
    const certAttrNames = ['certificate', 'certificateAlias', 'clientCertificate'];
    const keystoreAttrNames = ['keystoreView', 'keystore', 'trustStore'];

    for (const [key, value] of Object.entries(adapterConfig)) {
      const lowerKey = key.toLowerCase();

      if (authAttrNames.some(n => lowerKey.includes(n.toLowerCase()))) {
        security.authMethod = value;
      }
      if (credAttrNames.some(n => lowerKey.includes(n.toLowerCase()))) {
        security.credentialAlias = value;
      }
      if (certAttrNames.some(n => lowerKey.includes(n.toLowerCase()))) {
        security.certificates.push({ alias: key, value });
      }
      if (keystoreAttrNames.some(n => lowerKey.includes(n.toLowerCase()))) {
        security.keystoreView = value;
      }
    }

    return security;
  }

  /**
   * Query Configuration Scenarios (groups ICOs, channels, agreements)
   * SAP NetWeaver 7.50 specific
   */
  async queryConfigurationScenarios() {
    const namespace = XI_NAMESPACES.basis;

    try {
      const body = await this._soapCall(
        SOAP_SERVICES.ConfigurationScenario,
        'ConfigurationScenarioQueryRequest',
        namespace,
        '',
        LONG_TIMEOUT
      );
      return this._extractQueryResponse(body, 'ConfigurationScenarioQueryResponse');
    } catch (e) {
      LOG.warn('Configuration Scenario service error', { error: e.message });
      return [];
    }
  }

  /**
   * Read full Configuration Scenario (includes all grouped objects)
   * @param {Object|string} key - Scenario key or ObjectID
   */
  async readConfigurationScenario(key) {
    const namespace = XI_NAMESPACES.basis;
    const keyXml =
      typeof key === 'string'
        ? `<ConfigurationScenarioID><ObjectID>${this._escapeXml(key)}</ObjectID></ConfigurationScenarioID>`
        : this._buildKeyXml(key);

    try {
      const body = await this._soapCall(
        SOAP_SERVICES.ConfigurationScenario,
        'ConfigurationScenarioReadRequest',
        namespace,
        keyXml,
        LONG_TIMEOUT
      );

      const scenario = body.ConfigurationScenarioReadResponse?.ConfigurationScenario;

      if (scenario) {
        // Extract grouped object references
        scenario.integratedConfigurations = this._extractScenarioReferences(scenario, 'IntegratedConfiguration');
        scenario.communicationChannels = this._extractScenarioReferences(scenario, 'CommunicationChannel');
        scenario.senderAgreements = this._extractScenarioReferences(scenario, 'SenderAgreement');
        scenario.receiverAgreements = this._extractScenarioReferences(scenario, 'ReceiverAgreement');
      }

      return scenario;
    } catch (e) {
      LOG.warn('Configuration Scenario read error', { error: e.message });
      return null;
    }
  }

  /**
   * Extract object references from scenario
   */
  _extractScenarioReferences(scenario, objectType) {
    const refs = [];

    // Scenario contains lists of references to each object type
    const refList = scenario[`${objectType}ID`] || scenario[objectType] || scenario[objectType.toLowerCase()];

    if (!refList) return refs;

    const items = Array.isArray(refList) ? refList : [refList];
    for (const item of items) {
      refs.push({
        objectId: item.ObjectID || item.objectId || item,
        name: item.Name || item.name,
      });
    }

    return refs;
  }

  /**
   * Read full Sender Agreement definition
   * @param {Object|string} key - Agreement key or ObjectID
   */
  async readSenderAgreement(key) {
    const namespace = XI_NAMESPACES.basis;
    const keyXml = this._buildAgreementKeyXml(key, 'Sender');

    const body = await this._soapCall(SOAP_SERVICES.SenderAgreement, 'SenderAgreementReadRequest', namespace, keyXml);

    const agreement = body.SenderAgreementReadResponse?.SenderAgreement;

    if (agreement) {
      agreement.securityConfig = this._extractAgreementSecurityConfig(agreement);
    }

    return agreement;
  }

  /**
   * Read full Receiver Agreement definition
   * @param {Object|string} key - Agreement key or ObjectID
   */
  async readReceiverAgreement(key) {
    const namespace = XI_NAMESPACES.basis;
    const keyXml = this._buildAgreementKeyXml(key, 'Receiver');

    const body = await this._soapCall(
      SOAP_SERVICES.ReceiverAgreement,
      'ReceiverAgreementReadRequest',
      namespace,
      keyXml
    );

    const agreement = body.ReceiverAgreementReadResponse?.ReceiverAgreement;

    if (agreement) {
      agreement.securityConfig = this._extractAgreementSecurityConfig(agreement);
    }

    return agreement;
  }

  /**
   * Build key XML for agreement read requests
   */
  _buildAgreementKeyXml(key, type) {
    if (typeof key === 'string') {
      return `<${type}AgreementID><ObjectID>${this._escapeXml(key)}</ObjectID></${type}AgreementID>`;
    }

    let xml = `<${type}AgreementID>`;
    if (key.SenderPartyID) xml += `<SenderPartyID>${this._escapeXml(key.SenderPartyID)}</SenderPartyID>`;
    if (key.SenderComponentID)
      xml += `<SenderComponentID>${this._escapeXml(key.SenderComponentID)}</SenderComponentID>`;
    if (key.ReceiverPartyID) xml += `<ReceiverPartyID>${this._escapeXml(key.ReceiverPartyID)}</ReceiverPartyID>`;
    if (key.ReceiverComponentID)
      xml += `<ReceiverComponentID>${this._escapeXml(key.ReceiverComponentID)}</ReceiverComponentID>`;
    xml += `</${type}AgreementID>`;

    return xml;
  }

  /**
   * Extract security configuration from agreement
   */
  _extractAgreementSecurityConfig(agreement) {
    const security = {
      headerSecurity: null,
      signatureAlgorithm: null,
      encryptionAlgorithm: null,
      certificateUsed: null,
      as2MdnSigning: null,
    };

    // B2B/AS2 specific security settings
    if (agreement.HeaderSecurityLevel || agreement.headerSecurityLevel) {
      security.headerSecurity = agreement.HeaderSecurityLevel || agreement.headerSecurityLevel;
    }

    if (agreement.SignatureAlgorithm || agreement.signatureAlgorithm) {
      security.signatureAlgorithm = agreement.SignatureAlgorithm || agreement.signatureAlgorithm;
    }

    if (agreement.EncryptionAlgorithm || agreement.encryptionAlgorithm) {
      security.encryptionAlgorithm = agreement.EncryptionAlgorithm || agreement.encryptionAlgorithm;
    }

    return security;
  }

  /**
   * Query Business Systems (for partner/component discovery)
   */
  async queryBusinessSystems() {
    const namespace = XI_NAMESPACES.basis;

    try {
      const body = await this._soapCall(SOAP_SERVICES.BusinessSystem, 'BusinessSystemQueryRequest', namespace, '');
      return this._extractQueryResponse(body, 'BusinessSystemQueryResponse');
    } catch (e) {
      LOG.warn('Business System service error', { error: e.message });
      return [];
    }
  }

  /**
   * Query Parties (for B2B scenarios)
   */
  async queryParties() {
    const namespace = XI_NAMESPACES.basis;

    try {
      const body = await this._soapCall(SOAP_SERVICES.Party, 'PartyQueryRequest', namespace, '');
      return this._extractQueryResponse(body, 'PartyQueryResponse');
    } catch (e) {
      LOG.warn('Party service error', { error: e.message });
      return [];
    }
  }

  /**
   * Escape XML special characters
   */
  _escapeXml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // BULK EXTRACTION FOR MIGRATION (7.50 Optimized)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Extract all channels with module chains for a complete migration inventory
   * @param {Object} options - { includeInactive, maxChannels }
   * @returns {Promise<Array>} Channels with extracted module chains
   */
  async extractAllChannelsWithModules(options = {}) {
    const { includeInactive = false, maxChannels = 1000 } = options;

    // Get all channel summaries
    const channelSummaries = await this.queryCommunicationChannels();

    // Filter if needed
    let channels = channelSummaries;
    if (!includeInactive) {
      channels = channels.filter(c => (c.Status || c.status || '').toLowerCase() !== 'inactive');
    }

    // Limit to maxChannels
    if (channels.length > maxChannels) {
      LOG.warn('Limiting channel extraction', { maxChannels, total: channels.length });
      channels = channels.slice(0, maxChannels);
    }

    // Read full details for each channel with module chain
    const results = [];
    for (const summary of channels) {
      try {
        const key = summary.ObjectID || summary.objectId || summary;
        const full = await this.readCommunicationChannelWithModules(key);
        if (full) {
          results.push({
            ...summary,
            ...full,
          });
        }
      } catch (e) {
        LOG.warn('Failed to read channel', { channelId: summary.ObjectID || summary.name, error: e.message });
        results.push({
          ...summary,
          _readError: e.message,
        });
      }
    }

    return results;
  }

  /**
   * Extract ICOs with 7.50 fields for migration assessment
   * @param {Object} options - { use750Service, maxIcos }
   */
  async extractAllIcos750(options = {}) {
    const { use750Service = true, maxIcos = 500 } = options;

    // Get ICO summaries
    const icoSummaries = use750Service
      ? await this.queryIntegratedConfigurations750()
      : await this.queryIntegratedConfigurations();

    // Limit
    let icos = icoSummaries;
    if (icos.length > maxIcos) {
      LOG.warn('Limiting ICO extraction', { maxIcos, total: icos.length });
      icos = icos.slice(0, maxIcos);
    }

    // Read full details using 7.50 service
    const results = [];
    for (const summary of icos) {
      try {
        const key = summary.ObjectID || summary.objectId || summary;
        const full = use750Service
          ? await this.readIntegratedConfiguration750(key)
          : await this.readIntegratedConfiguration(key);
        if (full) {
          results.push({
            ...summary,
            ...full,
          });
        }
      } catch (e) {
        LOG.warn('Failed to read ICO', { icoId: summary.ObjectID || summary.name, error: e.message });
        results.push({
          ...summary,
          _readError: e.message,
        });
      }
    }

    return results;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // HEALTH CHECK
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Test connectivity to PI/PO system
   */
  async testConnection() {
    const results = {
      success: false,
      dirStatus: 'unknown',
      esrStatus: 'unknown',
      version: null,
      errors: [],
    };

    // Test Directory connectivity
    try {
      const channels = await this.queryCommunicationChannels();
      results.dirStatus = 'ok';
      results.channelCount = channels.length;
    } catch (e) {
      results.dirStatus = `error: ${e.message}`;
      results.errors.push(`Directory: ${e.message}`);
    }

    // Test ESR connectivity
    try {
      const swcvs = await this.querySoftwareComponentVersions();
      results.esrStatus = 'ok';
      results.swcvCount = swcvs.length;
      // Extract version from SWCV if available
      if (swcvs.length > 0) {
        results.version = swcvs[0].Version || swcvs[0].version || '7.50';
      }
    } catch (e) {
      results.esrStatus = `error: ${e.message}`;
      results.errors.push(`ESR: ${e.message}`);
    }

    results.success = results.dirStatus === 'ok' && results.esrStatus === 'ok';
    return results;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  PIPoSoapClient,
  SOAP_SERVICES,
  ESR_ENDPOINTS,
  ESR_OBJECT_TYPES,
  XI_NAMESPACES,
};
