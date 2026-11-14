'use strict';

// CAP-local, dependency-free copy: production builds do not include mcp/.
// Keep descriptors identical to the MCP registry via the test-only contract check.
const definitions = [
    ['/AdapterFramework/ChannelAdminServlet', 'channel_admin', 'Monitoring', 'diagnostic'],
    ['/AlertRuleInService', 'alert_rule', 'Directory', 'soap', 'AlertRule'],
    ['/BPMFacadeBeanImplService', 'bpm_facade', 'Metadata', 'soap'],
    ['/BusinessComponentInService', 'business_component', 'Directory', 'soap', 'BusinessComponent'],
    ['/CPACache', 'cpa_cache', 'Monitoring', 'diagnostic'],
    ['/CommunicationChannelInService', 'communication_channel', 'Directory', 'soap', 'CommunicationChannel'],
    ['/ConfigurationScenarioInService', 'configuration_scenario', 'Directory', 'soap', 'ConfigurationScenario'],
    ['/IntegratedConfiguration750InService', 'integrated_configuration_750', 'Directory', 'soap', 'IntegratedConfiguration'],
    ['/IntegratedConfigurationInService', 'integrated_configuration', 'Directory', 'soap', 'IntegratedConfiguration'],
    ['/IntegrationProcessInService', 'integration_process', 'Directory', 'soap', 'IntegrationProcess'],
    ['/InterfaceDeterminationInService', 'interface_determination', 'Directory', 'soap', 'InterfaceDetermination'],
    ['/ReceiverAgreementInService', 'receiver_agreement', 'Directory', 'soap', 'ReceiverAgreement'],
    ['/ReceiverDeterminationInService', 'receiver_determination', 'Directory', 'soap', 'ReceiverDetermination'],
    ['/ReceiverRuleInService', 'receiver_rule', 'Directory', 'soap', 'ReceiverRule'],
    ['/SenderAgreementInService', 'sender_agreement', 'Directory', 'soap', 'SenderAgreement'],
    ['/ValueMappingInService', 'value_mapping', 'Directory', 'soap', 'ValueMapping'],
    ['/dir/query/ext', 'directory_query_ext', 'Directory', 'query'],
    ['/dir/read/ext', 'directory_read_ext', 'Directory', 'read'],
    ['/mdt', 'message_diagnostics', 'Monitoring', 'diagnostic'],
    ['/rep/query/ext', 'repository_query_ext', 'Repository', 'query'],
    ['/rep/query/int', 'repository_query_int', 'Repository', 'query'],
    ['/rep/read/ext', 'repository_read_ext', 'Repository', 'read'],
    ['/rep/support/SimpleQuery', 'repository_simple_query', 'Repository', 'simple-query']
];

const ENDPOINTS = Object.freeze(definitions.map(([path, suffix, category, kind, entity]) => {
    const descriptor = {
        path, tool: `fetch_pi8_${suffix}`, category, kind,
        destination: path.startsWith('/rep/') ? 'PO_PJ2_ESR' : 'PO_PJ2_DIR'
    };
    if (entity) descriptor.entity = entity;
    if (path === '/mdt') descriptor.probePath = '/mdt/index.jsp';
    if (path === '/CPACache') descriptor.probePath = '/CPACache/monitor.jsp';
    if (kind === 'soap') {
        // BPM's implementation address is not established; never derive it.
        descriptor.wsdlPaths = Object.freeze(entity
            ? [`${path}/${path.slice(1).replace(/Service$/, '')}ImplBean?wsdl`, `${path}?wsdl`]
            : [`${path}?wsdl`]);
    }
    return Object.freeze(descriptor);
}));

function getEndpoint(toolOrPath) {
    return typeof toolOrPath === 'string'
        ? ENDPOINTS.find(entry => entry.tool === toolOrPath || entry.path === toolOrPath)
        : undefined;
}

module.exports = { ENDPOINTS, getEndpoint };