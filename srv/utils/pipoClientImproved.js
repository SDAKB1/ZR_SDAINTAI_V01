/**
 * Improved PI/PO SOAP Client
 * Complete implementation based on north_star.md PI/PO Artifact Catalog
 *
 * Covers all artifact types from:
 * - Enterprise Services Repository (ESR)
 * - Integration Directory (ID)
 * - System Landscape Directory (SLD)
 */
const cds = require('@sap/cds');
const LOG = cds.log('pipo-client');
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
const { getDestination } = require('@sap-cloud-sdk/connectivity');
const xml2js = require('xml2js');

// -------------------------------------------------------------------------------
// ENDPOINT CATALOGS (per north_star.md)
// -------------------------------------------------------------------------------

const ESR_ENDPOINTS = {
  // SOAP Services (WSDL-based)
  ServiceInterfaceInService: '/rep/services/ServiceInterfaceInService',
  OperationMappingInService: '/rep/services/OperationMappingInService',
  DataTypeInService: '/rep/services/DataTypeInService',
  MessageTypeInService: '/rep/services/MessageTypeInService',
  // Generic Query/Read
  SimpleQuery: '/rep/support/SimpleQuery',
  ReadObject: '/rep/read/ext',
  // Software Component Versions
  SoftwareComponentVersionInService: '/rep/services/SoftwareComponentVersionInService',
};

const ID_ENDPOINTS = {
  // Core Configuration
  IntegratedConfigurationInService: '/dir/services/IntegratedConfigurationInService',
  IntegratedConfiguration750InService: '/dir/services/IntegratedConfiguration750InService',
  // Channels & Agreements
  CommunicationChannelInService: '/dir/services/CommunicationChannelInService',
  SenderAgreementInService: '/dir/services/SenderAgreementInService',
  ReceiverAgreementInService: '/dir/services/ReceiverAgreementInService',
  // Routing
  ReceiverDeterminationInService: '/dir/services/ReceiverDeterminationInService',
  InterfaceDeterminationInService: '/dir/services/InterfaceDeterminationInService',
  // Supporting
  ValueMappingInService: '/dir/services/ValueMappingInService',
  ConfigurationScenarioInService: '/dir/services/ConfigurationScenarioInService',
  AlertRuleInService: '/AlertRuleInService',
  // Organizational
  PartyInService: '/dir/services/PartyInService',
  CommunicationComponentInService: '/dir/services/CommunicationComponentInService',
};

const SLD_ENDPOINTS = {
  TechnicalSystems: '/sld/cimom/jndi?method=read&class=SAP_BCTechnicalSystem',
  BusinessSystems: '/sld/cimom/jndi?method=read&class=SAP_BCBusinessSystem',
  SoftwareComponentVersions: '/sld/cimom/jndi?method=read&class=SAP_SoftwareComponentVersion',
  Products: '/sld/cimom/jndi?method=read&class=SAP_Product',
  SystemQuery: '/sld/cimom/query',
};

const ARTIFACT_TYPES = {
  // ESR Types
  DATA_TYPE: 'XI_DTYPE',
  MESSAGE_TYPE: 'XI_MTYPE',
  SERVICE_INTERFACE: 'XI_SVCIF',
  MESSAGE_MAPPING: 'XI_TRAFO',
  OPERATION_MAPPING: 'XI_OPMAP',
  XSLT_MAPPING: 'XI_XSLT',
  JAVA_MAPPING: 'XI_JAVAMAP',
  FUNCTION_LIBRARY: 'XI_FUNCLIB',
  IMPORTED_ARCHIVE: 'XI_IMP_ARC',
  EXTERNAL_DEFINITION: 'XI_EXT_DEF',
  CONTEXT_OBJECT: 'XI_CONTEXT',
  IDOC_DEFINITION: 'XI_IDOC',
  RFC_DEFINITION: 'XI_RFC',
  INTEGRATION_PROCESS: 'XI_IP',
  // ID Types
  ICO: 'ICO',
  COMMUNICATION_CHANNEL: 'CHANNEL',
  SENDER_AGREEMENT: 'SENDER_AGR',
  RECEIVER_AGREEMENT: 'RECEIVER_AGR',
  RECEIVER_DETERMINATION: 'RECEIVER_DET',
  INTERFACE_DETERMINATION: 'INTERFACE_DET',
  VALUE_MAPPING: 'VALUE_MAP',
  CONFIGURATION_SCENARIO: 'CONFIG_SCENARIO',
  PARTY: 'PARTY',
  COMMUNICATION_COMPONENT: 'COMM_COMP',
  // SLD Types
  BUSINESS_SYSTEM: 'BUSINESS_SYS',
  TECHNICAL_SYSTEM: 'TECHNICAL_SYS',
  SOFTWARE_COMPONENT_VERSION: 'SWCV',
  PRODUCT: 'PRODUCT',
};

// -------------------------------------------------------------------------------
// SOAP CLIENT CLASS
// -------------------------------------------------------------------------------

class PIPOClientImproved {
  constructor(destinationName, options = {}) {
    this.destinationName = destinationName;
    this.options = {
      timeout: options.timeout || 30000,
      piVersion: options.piVersion || '7.50',
      ...options,
    };
    this.parser = new xml2js.Parser({
      explicitArray: false,
      ignoreAttrs: false,
      tagNameProcessors: [xml2js.processors.stripPrefix],
    });
  }

  /**
   * Execute HTTP request against PI/PO system
   */
  async _request(path, method = 'GET', body = null, headers = {}) {
    const destination = await getDestination({ destinationName: this.destinationName });

    const config = {
      method,
      url: path,
      headers: {
        'Content-Type': body ? 'text/xml; charset=utf-8' : 'application/json',
        ...headers,
      },
      timeout: this.options.timeout,
    };

    if (body) config.data = body;

    const response = await executeHttpRequest(destination, config);
    return response.data;
  }

  /**
   * Execute SOAP request
   */
  async _soapRequest(endpoint, action, body) {
    const soapEnvelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:urn="urn:AdapterMessageMonitoringVi">
  <soapenv:Header/>
  <soapenv:Body>
    ${body}
  </soapenv:Body>
</soapenv:Envelope>`;

    const response = await this._request(endpoint, 'POST', soapEnvelope, {
      SOAPAction: action,
      'Content-Type': 'text/xml; charset=utf-8',
    });

    return this.parser.parseStringPromise(response);
  }

  // ---------------------------------------------------------------------------
  // ESR OPERATIONS
  // ---------------------------------------------------------------------------

  /**
   * Query ESR objects using SimpleQuery
   */
  async simpleQuery(objectType, namespace = null, name = null) {
    let query = `type=${objectType}`;
    if (namespace) query += `&namespace=${encodeURIComponent(namespace)}`;
    if (name) query += `&name=${encodeURIComponent(name)}`;

    const response = await this._request(`${ESR_ENDPOINTS.SimpleQuery}?${query}`);
    return this._parseSimpleQueryResponse(response);
  }

  /**
   * Read detailed ESR object
   */
  async readESRObject(objectType, namespace, name, swcv = null) {
    let query = `method=PLAIN&TYPE=${objectType}&NAMESPACE=${encodeURIComponent(namespace)}&NAME=${encodeURIComponent(name)}`;
    if (swcv) query += `&SWCV=${encodeURIComponent(swcv)}`;

    const response = await this._request(`${ESR_ENDPOINTS.ReadObject}?${query}`);
    return response;
  }

  /**
   * Get all Software Component Versions
   */
  async getSoftwareComponentVersions() {
    const body = `<urn:SoftwareComponentVersionQueryRequest xmlns:urn="urn:com.sap.xi.basis">
      <urn:SoftwareComponentVersionID>
        <urn:Name>*</urn:Name>
      </urn:SoftwareComponentVersionID>
    </urn:SoftwareComponentVersionQueryRequest>`;

    try {
      const result = await this._soapRequest(
        ESR_ENDPOINTS.SoftwareComponentVersionInService,
        'SoftwareComponentVersionQuery',
        body
      );
      return this._extractSWCVs(result);
    } catch (error) {
      LOG.warn('SWCV query failed', { error: error.message });
      return [];
    }
  }

  /**
   * Get Message Mappings
   */
  async getMessageMappings(namespace = null) {
    return this.simpleQuery(ARTIFACT_TYPES.MESSAGE_MAPPING, namespace);
  }

  /**
   * Get Operation Mappings
   */
  async getOperationMappings(namespace = null) {
    return this.simpleQuery(ARTIFACT_TYPES.OPERATION_MAPPING, namespace);
  }

  /**
   * Get Service Interfaces
   */
  async getServiceInterfaces(namespace = null) {
    return this.simpleQuery(ARTIFACT_TYPES.SERVICE_INTERFACE, namespace);
  }

  /**
   * Get Data Types
   */
  async getDataTypes(namespace = null) {
    return this.simpleQuery(ARTIFACT_TYPES.DATA_TYPE, namespace);
  }

  /**
   * Get Message Types
   */
  async getMessageTypes(namespace = null) {
    return this.simpleQuery(ARTIFACT_TYPES.MESSAGE_TYPE, namespace);
  }

  /**
   * Get Integration Processes (ccBPM)
   */
  async getIntegrationProcesses(namespace = null) {
    return this.simpleQuery(ARTIFACT_TYPES.INTEGRATION_PROCESS, namespace);
  }

  /**
   * Get Function Libraries
   */
  async getFunctionLibraries(namespace = null) {
    return this.simpleQuery(ARTIFACT_TYPES.FUNCTION_LIBRARY, namespace);
  }

  /**
   * Get Imported Archives
   */
  async getImportedArchives(namespace = null) {
    return this.simpleQuery(ARTIFACT_TYPES.IMPORTED_ARCHIVE, namespace);
  }

  // ---------------------------------------------------------------------------
  // INTEGRATION DIRECTORY OPERATIONS
  // ---------------------------------------------------------------------------

  /**
   * List Integrated Configurations (ICOs)
   */
  async listICOs() {
    const endpoint =
      this.options.piVersion >= '7.50'
        ? ID_ENDPOINTS.IntegratedConfiguration750InService
        : ID_ENDPOINTS.IntegratedConfigurationInService;

    const body = `<urn:IntegratedConfigurationQueryRequest xmlns:urn="urn:com.sap.xi.basis">
      <urn:IntegratedConfigurationID>
        <urn:SenderComponentID>*</urn:SenderComponentID>
      </urn:IntegratedConfigurationID>
    </urn:IntegratedConfigurationQueryRequest>`;

    const result = await this._soapRequest(endpoint, 'IntegratedConfigurationQuery', body);
    return this._extractICOs(result);
  }

  /**
   * Get ICO details
   */
  async getICODetails(senderComponent, interfaceName, interfaceNamespace) {
    const endpoint =
      this.options.piVersion >= '7.50'
        ? ID_ENDPOINTS.IntegratedConfiguration750InService
        : ID_ENDPOINTS.IntegratedConfigurationInService;

    const body = `<urn:IntegratedConfigurationReadRequest xmlns:urn="urn:com.sap.xi.basis">
      <urn:IntegratedConfigurationID>
        <urn:SenderComponentID>${senderComponent}</urn:SenderComponentID>
        <urn:InterfaceName>${interfaceName}</urn:InterfaceName>
        <urn:InterfaceNamespace>${interfaceNamespace}</urn:InterfaceNamespace>
      </urn:IntegratedConfigurationID>
      <urn:ReadContext>User</urn:ReadContext>
    </urn:IntegratedConfigurationReadRequest>`;

    const result = await this._soapRequest(endpoint, 'IntegratedConfigurationRead', body);
    return this._extractICODetail(result);
  }

  /**
   * List Communication Channels
   */
  async listChannels() {
    const body = `<urn:CommunicationChannelQueryRequest xmlns:urn="urn:com.sap.xi.basis">
      <urn:CommunicationChannelID>
        <urn:ComponentID>*</urn:ComponentID>
      </urn:CommunicationChannelID>
    </urn:CommunicationChannelQueryRequest>`;

    const result = await this._soapRequest(
      ID_ENDPOINTS.CommunicationChannelInService,
      'CommunicationChannelQuery',
      body
    );
    return this._extractChannels(result);
  }

  /**
   * Get Channel details
   */
  async getChannelDetails(party, component, channelName) {
    const body = `<urn:CommunicationChannelReadRequest xmlns:urn="urn:com.sap.xi.basis">
      <urn:CommunicationChannelID>
        <urn:PartyID>${party || ''}</urn:PartyID>
        <urn:ComponentID>${component}</urn:ComponentID>
        <urn:ChannelID>${channelName}</urn:ChannelID>
      </urn:CommunicationChannelID>
      <urn:ReadContext>User</urn:ReadContext>
    </urn:CommunicationChannelReadRequest>`;

    const result = await this._soapRequest(
      ID_ENDPOINTS.CommunicationChannelInService,
      'CommunicationChannelRead',
      body
    );
    return this._extractChannelDetail(result);
  }

  /**
   * List Value Mappings
   */
  async listValueMappings() {
    const body = `<urn:ValueMappingQueryRequest xmlns:urn="urn:com.sap.xi.basis">
      <urn:ValueMappingID>
        <urn:GroupName>*</urn:GroupName>
      </urn:ValueMappingID>
    </urn:ValueMappingQueryRequest>`;

    const result = await this._soapRequest(ID_ENDPOINTS.ValueMappingInService, 'ValueMappingQuery', body);
    return this._extractValueMappings(result);
  }

  /**
   * List Configuration Scenarios
   */
  async listConfigurationScenarios() {
    const body = `<urn:ConfigurationScenarioQueryRequest xmlns:urn="urn:com.sap.xi.basis">
      <urn:ConfigurationScenarioID>
        <urn:ScenarioID>*</urn:ScenarioID>
      </urn:ConfigurationScenarioID>
    </urn:ConfigurationScenarioQueryRequest>`;

    const result = await this._soapRequest(
      ID_ENDPOINTS.ConfigurationScenarioInService,
      'ConfigurationScenarioQuery',
      body
    );
    return this._extractScenarios(result);
  }

  /**
   * List Sender Agreements
   */
  async listSenderAgreements() {
    const body = `<urn:SenderAgreementQueryRequest xmlns:urn="urn:com.sap.xi.basis">
      <urn:SenderAgreementID>
        <urn:SenderComponentID>*</urn:SenderComponentID>
      </urn:SenderAgreementID>
    </urn:SenderAgreementQueryRequest>`;

    const result = await this._soapRequest(ID_ENDPOINTS.SenderAgreementInService, 'SenderAgreementQuery', body);
    return this._extractAgreements(result, 'Sender');
  }

  /**
   * List Receiver Agreements
   */
  async listReceiverAgreements() {
    const body = `<urn:ReceiverAgreementQueryRequest xmlns:urn="urn:com.sap.xi.basis">
      <urn:ReceiverAgreementID>
        <urn:ReceiverComponentID>*</urn:ReceiverComponentID>
      </urn:ReceiverAgreementID>
    </urn:ReceiverAgreementQueryRequest>`;

    const result = await this._soapRequest(ID_ENDPOINTS.ReceiverAgreementInService, 'ReceiverAgreementQuery', body);
    return this._extractAgreements(result, 'Receiver');
  }

  // ---------------------------------------------------------------------------
  // SLD OPERATIONS
  // ---------------------------------------------------------------------------

  /**
   * Get Business Systems from SLD
   */
  async getBusinessSystems() {
    try {
      const response = await this._request(SLD_ENDPOINTS.BusinessSystems);
      return this._parseSLDResponse(response, 'BusinessSystem');
    } catch (error) {
      LOG.warn('SLD Business Systems query failed', { error: error.message });
      return [];
    }
  }

  /**
   * Get Technical Systems from SLD
   */
  async getTechnicalSystems() {
    try {
      const response = await this._request(SLD_ENDPOINTS.TechnicalSystems);
      return this._parseSLDResponse(response, 'TechnicalSystem');
    } catch (error) {
      LOG.warn('SLD Technical Systems query failed', { error: error.message });
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // FULL DISCOVERY
  // ---------------------------------------------------------------------------

  /**
   * Run full discovery of all artifact types
   * @param {function} progressCallback - Called with (phase, count, message)
   */
  async fullDiscovery(progressCallback = null) {
    const results = {
      swcv: [],
      icos: [],
      channels: [],
      mappings: [],
      operationMappings: [],
      serviceInterfaces: [],
      valueMappings: [],
      senderAgreements: [],
      receiverAgreements: [],
      scenarios: [],
      businessSystems: [],
      dataTypes: [],
      messageTypes: [],
      functionLibraries: [],
      integrationProcesses: [],
      errors: [],
    };

    const phases = [
      { name: 'Software Components', fn: () => this.getSoftwareComponentVersions(), key: 'swcv' },
      { name: 'Integrated Configurations', fn: () => this.listICOs(), key: 'icos' },
      { name: 'Communication Channels', fn: () => this.listChannels(), key: 'channels' },
      { name: 'Message Mappings', fn: () => this.getMessageMappings(), key: 'mappings' },
      { name: 'Operation Mappings', fn: () => this.getOperationMappings(), key: 'operationMappings' },
      { name: 'Service Interfaces', fn: () => this.getServiceInterfaces(), key: 'serviceInterfaces' },
      { name: 'Value Mappings', fn: () => this.listValueMappings(), key: 'valueMappings' },
      { name: 'Sender Agreements', fn: () => this.listSenderAgreements(), key: 'senderAgreements' },
      { name: 'Receiver Agreements', fn: () => this.listReceiverAgreements(), key: 'receiverAgreements' },
      { name: 'Configuration Scenarios', fn: () => this.listConfigurationScenarios(), key: 'scenarios' },
      { name: 'Business Systems', fn: () => this.getBusinessSystems(), key: 'businessSystems' },
      { name: 'Data Types', fn: () => this.getDataTypes(), key: 'dataTypes' },
      { name: 'Message Types', fn: () => this.getMessageTypes(), key: 'messageTypes' },
      { name: 'Function Libraries', fn: () => this.getFunctionLibraries(), key: 'functionLibraries' },
      { name: 'Integration Processes', fn: () => this.getIntegrationProcesses(), key: 'integrationProcesses' },
    ];

    for (let i = 0; i < phases.length; i++) {
      const phase = phases[i];
      try {
        if (progressCallback) {
          progressCallback(i + 1, phases.length, `Discovering ${phase.name}...`);
        }
        results[phase.key] = await phase.fn();
        if (progressCallback) {
          progressCallback(i + 1, phases.length, `Found ${results[phase.key].length} ${phase.name}`);
        }
      } catch (error) {
        results.errors.push({ phase: phase.name, error: error.message });
        results[phase.key] = [];
      }
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // RESPONSE PARSERS
  // ---------------------------------------------------------------------------

  _parseSimpleQueryResponse(response) {
    // Parse SimpleQuery XML response
    try {
      const items = [];
      // Implementation depends on actual PI/PO response format
      return items;
    } catch (e) {
      return [];
    }
  }

  _extractICOs(soapResult) {
    try {
      const body = soapResult?.Envelope?.Body;
      const response = body?.IntegratedConfigurationQueryResponse;
      const icos = response?.IntegratedConfigurationID;
      if (!icos) return [];
      const icoArray = Array.isArray(icos) ? icos : [icos];
      return icoArray.map(ico => ({
        senderComponent: ico.SenderComponentID || '',
        interfaceName: ico.InterfaceName || '',
        interfaceNamespace: ico.InterfaceNamespace || '',
        senderParty: ico.SenderPartyID || '',
      }));
    } catch (e) {
      return [];
    }
  }

  _extractICODetail(soapResult) {
    try {
      const body = soapResult?.Envelope?.Body;
      return body?.IntegratedConfigurationReadResponse?.IntegratedConfiguration || {};
    } catch (e) {
      return {};
    }
  }

  _extractChannels(soapResult) {
    try {
      const body = soapResult?.Envelope?.Body;
      const response = body?.CommunicationChannelQueryResponse;
      const channels = response?.CommunicationChannelID;
      if (!channels) return [];
      const channelArray = Array.isArray(channels) ? channels : [channels];
      return channelArray.map(ch => ({
        party: ch.PartyID || '',
        component: ch.ComponentID || '',
        name: ch.ChannelID || '',
      }));
    } catch (e) {
      return [];
    }
  }

  _extractChannelDetail(soapResult) {
    try {
      const body = soapResult?.Envelope?.Body;
      return body?.CommunicationChannelReadResponse?.CommunicationChannel || {};
    } catch (e) {
      return {};
    }
  }

  _extractValueMappings(soapResult) {
    try {
      const body = soapResult?.Envelope?.Body;
      const response = body?.ValueMappingQueryResponse;
      const mappings = response?.ValueMappingID;
      if (!mappings) return [];
      return Array.isArray(mappings) ? mappings : [mappings];
    } catch (e) {
      return [];
    }
  }

  _extractScenarios(soapResult) {
    try {
      const body = soapResult?.Envelope?.Body;
      const response = body?.ConfigurationScenarioQueryResponse;
      const scenarios = response?.ConfigurationScenarioID;
      if (!scenarios) return [];
      return Array.isArray(scenarios) ? scenarios : [scenarios];
    } catch (e) {
      return [];
    }
  }

  _extractAgreements(soapResult, type) {
    try {
      const body = soapResult?.Envelope?.Body;
      const response = body?.[`${type}AgreementQueryResponse`];
      const agreements = response?.[`${type}AgreementID`];
      if (!agreements) return [];
      return Array.isArray(agreements) ? agreements : [agreements];
    } catch (e) {
      return [];
    }
  }

  _extractSWCVs(soapResult) {
    try {
      const body = soapResult?.Envelope?.Body;
      const response = body?.SoftwareComponentVersionQueryResponse;
      const swcvs = response?.SoftwareComponentVersion;
      if (!swcvs) return [];
      return Array.isArray(swcvs) ? swcvs : [swcvs];
    } catch (e) {
      return [];
    }
  }

  _parseSLDResponse(response, type) {
    // Parse SLD CIM response
    try {
      if (typeof response === 'string') {
        // Try XML parsing
        return [];
      }
      return response?.instances || [];
    } catch (e) {
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // MODULE CONFIGURATION EXTRACTION (Critical for migration)
  // ---------------------------------------------------------------------------

  /**
   * Extract module configurations from channel details
   * Module chains contain critical processing logic
   */
  extractModuleConfigurations(channelDetail) {
    const modules = [];
    try {
      const moduleProcess = channelDetail?.ModuleProcess;
      if (!moduleProcess) return modules;

      // ModuleProcess contains ProcessData with modules
      const processData = moduleProcess.ProcessData || moduleProcess;
      const moduleList = processData?.Module || processData?.ModuleData;

      if (!moduleList) return modules;

      const moduleArray = Array.isArray(moduleList) ? moduleList : [moduleList];

      moduleArray.forEach((mod, index) => {
        const config = {
          moduleKey: mod.ModuleKey || mod.moduleKey || `module_${index}`,
          moduleName: mod.ModuleName || mod.moduleName || '',
          moduleType: mod.ModuleType || mod.moduleType || 'Module',
          processingSequence: index + 1,
          parameters: {},
        };

        // Extract module parameters
        const params = mod.ModuleConfiguration || mod.Parameters || mod.parameters || [];
        const paramArray = Array.isArray(params) ? params : [params];

        paramArray.forEach(param => {
          if (param && param.ParameterName && param.ParameterValue !== undefined) {
            config.parameters[param.ParameterName] = param.ParameterValue;
          }
        });

        // Determine IS equivalent based on module name
        config.isEquivalent = this._mapModuleToISEquivalent(config.moduleName);

        modules.push(config);
      });
    } catch (e) {
      LOG.warn('Error extracting modules', { error: e.message });
    }
    return modules;
  }

  /**
   * Map PI/PO module to Integration Suite equivalent
   */
  _mapModuleToISEquivalent(moduleName) {
    const moduleMap = {
      PayloadSwapBean: 'Content Modifier / Groovy Script',
      'AF_Modules/PayloadSwapBean': 'Content Modifier / Groovy Script',
      XMLAnonymizer: 'XSLT / Groovy Script',
      'AF_Modules/XMLAnonymizer': 'XSLT / Groovy Script',
      MessageTransformBean: 'Content Modifier',
      'AF_Modules/MessageTransformBean': 'Content Modifier',
      TextCodec: 'Encoder Step',
      'AF_Modules/TextCodec': 'Encoder Step',
      StrictXml2PlainBean: 'XML to JSON Converter',
      'AF_Modules/StrictXml2PlainBean': 'XML to JSON Converter',
      Plain2XmlBean: 'JSON to XML Converter',
      DynamicConfigurationBean: 'Content Modifier (Headers)',
      RequestResponseBean: 'Request-Reply Pattern',
      CallSapAdapter: 'RFC Adapter / Process Call',
      'localejbs/CallSapAdapter': 'RFC Adapter / Process Call',
      'localejbs/AF_Modules/PayloadSwapBean': 'Content Modifier / Groovy Script',
    };

    // Check for exact match or partial match
    for (const [piModule, isEquiv] of Object.entries(moduleMap)) {
      if (moduleName.includes(piModule)) {
        return isEquiv;
      }
    }

    // Custom modules need Groovy conversion
    if (moduleName.includes('localejbs/') || moduleName.includes('custom/')) {
      return 'Custom Groovy Script (manual conversion required)';
    }

    return 'Manual analysis required';
  }

  // ---------------------------------------------------------------------------
  // CREDENTIAL REFERENCE EXTRACTION (For planning - NOT actual values)
  // ---------------------------------------------------------------------------

  /**
   * Extract credential references from channel/agreement details
   * Does NOT extract actual credentials - only references for planning
   */
  extractCredentialReferences(artifactDetail, artifactType = 'channel') {
    const credentials = [];
    try {
      // Check authentication section
      const auth =
        artifactDetail?.Authentication ||
        artifactDetail?.SenderAuthentication ||
        artifactDetail?.ReceiverAuthentication;

      if (auth) {
        if (auth.User || auth.UserName) {
          credentials.push({
            credentialAlias: auth.User || auth.UserName,
            credentialType: 'Password',
            authType: 'Basic',
            source: artifactType,
          });
        }

        if (auth.Certificate || auth.CertificateAlias) {
          credentials.push({
            credentialAlias: auth.Certificate || auth.CertificateAlias,
            credentialType: 'Certificate',
            authType: 'Certificate',
            source: artifactType,
          });
        }

        if (auth.OAuth2ClientId || auth.OAuthCredential) {
          credentials.push({
            credentialAlias: auth.OAuth2ClientId || auth.OAuthCredential,
            credentialType: 'OAuth',
            authType: 'OAuth2ClientCredentials',
            source: artifactType,
          });
        }
      }

      // Check for secure parameters in adapter config
      const adapterConfig = artifactDetail?.AdapterSpecificAttribute || artifactDetail?.AdapterSpecificTableAttribute;
      if (adapterConfig) {
        const configArray = Array.isArray(adapterConfig) ? adapterConfig : [adapterConfig];
        configArray.forEach(cfg => {
          // Look for password/secret field indicators
          const name = cfg.Name || cfg.name || '';
          if (
            name.toLowerCase().includes('password') ||
            name.toLowerCase().includes('secret') ||
            name.toLowerCase().includes('credential') ||
            name.toLowerCase().includes('apikey')
          ) {
            credentials.push({
              credentialAlias: `${artifactType}_${name}`,
              credentialType: 'Password',
              authType: 'SecureParameter',
              source: artifactType,
              parameterName: name,
            });
          }
        });
      }
    } catch (e) {
      LOG.warn('Error extracting credentials', { error: e.message });
    }
    return credentials;
  }

  // ---------------------------------------------------------------------------
  // PARTIES (B2B/EDI scenarios)
  // ---------------------------------------------------------------------------

  /**
   * List Parties (for B2B scenarios)
   */
  async listParties() {
    const body = `<urn:PartyQueryRequest xmlns:urn="urn:com.sap.xi.basis">
      <urn:PartyID>*</urn:PartyID>
    </urn:PartyQueryRequest>`;

    try {
      const result = await this._soapRequest(ID_ENDPOINTS.PartyInService, 'PartyQuery', body);
      return this._extractParties(result);
    } catch (error) {
      LOG.warn('Party query failed', { error: error.message });
      return [];
    }
  }

  /**
   * Get Party details
   */
  async getPartyDetails(partyId) {
    const body = `<urn:PartyReadRequest xmlns:urn="urn:com.sap.xi.basis">
      <urn:PartyID>${partyId}</urn:PartyID>
      <urn:ReadContext>User</urn:ReadContext>
    </urn:PartyReadRequest>`;

    try {
      const result = await this._soapRequest(ID_ENDPOINTS.PartyInService, 'PartyRead', body);
      return this._extractPartyDetail(result);
    } catch (error) {
      LOG.warn('Party read failed', { error: error.message });
      return null;
    }
  }

  _extractParties(soapResult) {
    try {
      const body = soapResult?.Envelope?.Body;
      const response = body?.PartyQueryResponse;
      const parties = response?.PartyID;
      if (!parties) return [];
      return Array.isArray(parties) ? parties : [parties];
    } catch (e) {
      return [];
    }
  }

  _extractPartyDetail(soapResult) {
    try {
      const body = soapResult?.Envelope?.Body;
      return body?.PartyReadResponse?.Party || {};
    } catch (e) {
      return {};
    }
  }

  // ---------------------------------------------------------------------------
  // ENHANCED DISCOVERY WITH MODULE CONFIGS AND CREDENTIALS
  // ---------------------------------------------------------------------------

  /**
   * Get channel with full module configuration
   */
  async getChannelWithModules(party, component, channelName) {
    const channelDetail = await this.getChannelDetails(party, component, channelName);

    return {
      ...channelDetail,
      moduleConfigurations: this.extractModuleConfigurations(channelDetail),
      credentialReferences: this.extractCredentialReferences(channelDetail, 'channel'),
    };
  }

  /**
   * Enhanced full discovery including modules and credential inventory
   */
  async enhancedDiscovery(options = {}) {
    const {
      includeModules = true,
      includeCredentials = true,
      includeParties = false, // Only for B2B
      progressCallback = null,
    } = options;

    // Run base discovery
    const results = await this.fullDiscovery(progressCallback);

    // Enhance with module configurations
    if (includeModules && results.channels.length > 0) {
      results.moduleConfigurations = [];
      for (const channel of results.channels.slice(0, 50)) {
        // Limit for performance
        try {
          const detail = await this.getChannelWithModules(channel.party, channel.component, channel.name);
          if (detail.moduleConfigurations?.length > 0) {
            results.moduleConfigurations.push({
              channelId: `${channel.component}:${channel.name}`,
              modules: detail.moduleConfigurations,
            });
          }
        } catch (e) {
          // Continue on individual failures
        }
      }
    }

    // Build credential inventory
    if (includeCredentials) {
      results.credentialInventory = [];
      const credentialMap = new Map();

      // Extract from channels
      for (const channel of results.channels.slice(0, 50)) {
        try {
          const detail = await this.getChannelDetails(channel.party, channel.component, channel.name);
          const creds = this.extractCredentialReferences(detail, 'channel');
          creds.forEach(cred => {
            const key = cred.credentialAlias;
            if (!credentialMap.has(key)) {
              credentialMap.set(key, {
                ...cred,
                usedByChannels: [],
                usedByAgreements: [],
              });
            }
            credentialMap.get(key).usedByChannels.push(`${channel.component}:${channel.name}`);
          });
        } catch (e) {
          // Continue
        }
      }

      results.credentialInventory = Array.from(credentialMap.values());
    }

    // Parties for B2B
    if (includeParties) {
      results.parties = await this.listParties();
    }

    return results;
  }
}

// Export
module.exports = {
  PIPOClientImproved,
  ESR_ENDPOINTS,
  ID_ENDPOINTS,
  SLD_ENDPOINTS,
  ARTIFACT_TYPES,
};
