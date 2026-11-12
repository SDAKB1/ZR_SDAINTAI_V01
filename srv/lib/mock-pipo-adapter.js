'use strict';
/**
 * Mock PI/PO Adapter
 *
 * Provides synthetic PI/PO data for demo and testing.
 * Each tenant gets deterministic but distinct data:
 * - Dollarama: Retail EDI/IDoc patterns
 * - Bombardier: Aerospace SOAP/IDoc/File patterns
 *
 * Per North Star Demo Implementation Plan
 */
const cds = require('@sap/cds');

const LOG = cds.log('mock-adapter');

// Tenant-specific fixture templates
const TENANT_FIXTURES = {
  't-dollarama': {
    profile: {
      industry: 'Retail',
      patterns: ['EDI', 'IDoc', 'SFTP'],
      volume: 'high',
    },
    artifacts: [
      {
        artifactType: 'IntegratedConfiguration',
        objectId: 'ICO_DOL_EDI_850_PO',
        name: 'Dollarama EDI 850 Purchase Order Inbound',
        description: 'Receives EDI 850 purchase orders from retail partners',
        direction: 'inbound',
        adapterType: 'SFTP',
        senderComponent: 'BC_RETAIL_PARTNER',
        receiverComponent: 'SAP_ECC',
        receiverInterface: 'ORDERS05.ORDERS05',
        namespace: 'urn:dollarama:edi:po',
        piStatus: 'active',
      },
      {
        artifactType: 'IntegratedConfiguration',
        objectId: 'ICO_DOL_EDI_856_ASN',
        name: 'Dollarama EDI 856 ASN Outbound',
        description: 'Sends EDI 856 Advance Ship Notices to partners',
        direction: 'outbound',
        adapterType: 'SFTP',
        senderComponent: 'SAP_ECC',
        senderInterface: 'DESADV.DESADV01',
        receiverComponent: 'BC_RETAIL_PARTNER',
        namespace: 'urn:dollarama:edi:asn',
        piStatus: 'active',
      },
      {
        artifactType: 'IntegratedConfiguration',
        objectId: 'ICO_DOL_IDOC_MATMAS',
        name: 'Dollarama Material Master Distribution',
        description: 'Distributes material master data via IDoc',
        direction: 'outbound',
        adapterType: 'IDoc',
        senderComponent: 'SAP_ECC',
        senderInterface: 'MATMAS05.MATMAS05',
        receiverComponent: 'SAP_BW',
        namespace: 'urn:dollarama:master:material',
        piStatus: 'active',
      },
      {
        artifactType: 'CommunicationChannel',
        objectId: 'CC_DOL_SFTP_EDI_IN',
        name: 'Dollarama SFTP EDI Inbound',
        description: 'SFTP channel for receiving EDI files',
        direction: 'inbound',
        adapterType: 'SFTP',
        piStatus: 'active',
      },
      {
        artifactType: 'MessageMapping',
        objectId: 'MM_EDI850_TO_ORDERS05',
        name: 'EDI 850 to ORDERS05 Mapping',
        description: 'Transforms EDI 850 to SAP IDoc ORDERS05',
        mappingType: 'graphical',
        namespace: 'urn:dollarama:mapping:edi',
        piStatus: 'active',
      },
    ],
  },
  't-bombardier': {
    profile: {
      industry: 'Aerospace',
      patterns: ['SOAP', 'REST', 'IDoc', 'File'],
      volume: 'medium',
    },
    artifacts: [
      {
        artifactType: 'IntegratedConfiguration',
        objectId: 'ICO_BMB_SOAP_SUPPLIER',
        name: 'Bombardier Supplier Portal Integration',
        description: 'SOAP web service for supplier collaboration',
        direction: 'bidirectional',
        adapterType: 'SOAP',
        senderComponent: 'SUPPLIER_PORTAL',
        receiverComponent: 'SAP_S4',
        receiverInterface: 'SupplierCollaboration_In',
        namespace: 'urn:bombardier:supplier:ws',
        piStatus: 'active',
      },
      {
        artifactType: 'IntegratedConfiguration',
        objectId: 'ICO_BMB_IDOC_AIRCRAFT',
        name: 'Bombardier Aircraft BOM Distribution',
        description: 'Bill of Materials distribution for aircraft programs',
        direction: 'outbound',
        adapterType: 'IDoc',
        senderComponent: 'SAP_PLM',
        senderInterface: 'BOMMAT05.BOMMAT05',
        receiverComponent: 'MES_SYSTEM',
        namespace: 'urn:bombardier:plm:bom',
        piStatus: 'active',
      },
      {
        artifactType: 'IntegratedConfiguration',
        objectId: 'ICO_BMB_REST_QUALITY',
        name: 'Bombardier Quality Inspection API',
        description: 'REST API for quality inspection results',
        direction: 'inbound',
        adapterType: 'REST',
        senderComponent: 'QMS_SYSTEM',
        receiverComponent: 'SAP_QM',
        receiverInterface: 'QualityInspection_Create',
        namespace: 'urn:bombardier:quality:api',
        piStatus: 'active',
      },
      {
        artifactType: 'CommunicationChannel',
        objectId: 'CC_BMB_SOAP_SUPPLIER_OUT',
        name: 'Bombardier SOAP Supplier Outbound',
        description: 'SOAP channel for supplier web services',
        direction: 'outbound',
        adapterType: 'SOAP',
        piStatus: 'active',
      },
      {
        artifactType: 'MessageMapping',
        objectId: 'MM_SUPPLIER_TO_VENDOR',
        name: 'Supplier Portal to SAP Vendor',
        description: 'Transforms supplier data to SAP vendor format',
        mappingType: 'graphical',
        namespace: 'urn:bombardier:mapping:supplier',
        piStatus: 'active',
      },
      {
        artifactType: 'ValueMappingGroup',
        objectId: 'VM_BMB_PARTNER_CODES',
        name: 'Bombardier Partner Code Mappings',
        description: 'Maps external partner codes to SAP vendor numbers',
        piStatus: 'active',
      },
    ],
  },
};

// Default fixtures for unknown tenants
const DEFAULT_FIXTURES = {
  profile: {
    industry: 'Generic',
    patterns: ['IDoc', 'HTTP'],
    volume: 'low',
  },
  artifacts: [
    {
      artifactType: 'IntegratedConfiguration',
      objectId: 'ICO_SAMPLE_INBOUND',
      name: 'Sample Inbound Integration',
      description: 'Sample inbound integration configuration',
      direction: 'inbound',
      adapterType: 'HTTP',
      senderComponent: 'EXTERNAL_SYSTEM',
      receiverComponent: 'SAP_ECC',
      namespace: 'urn:sample:integration',
      piStatus: 'active',
    },
  ],
};

class MockPiPoAdapter {
  constructor(tenantId) {
    this.tenantId = tenantId;
    this.fixtures = TENANT_FIXTURES[tenantId] || DEFAULT_FIXTURES;
    LOG.info('Mock adapter initialized', { tenantId, industry: this.fixtures.profile.industry });
  }

  /**
   * Test connection (always succeeds for mock)
   */
  async testConnection() {
    LOG.debug('Mock connection test', { tenantId: this.tenantId });
    return {
      success: true,
      message: 'Mock PI/PO connection successful',
      version: '7.50 (Mock)',
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * List objects by type with pagination
   */
  async listObjects(type, cursor = null) {
    LOG.debug('Mock listObjects', { tenantId: this.tenantId, type, cursor });

    const artifacts = this.fixtures.artifacts.filter(a => !type || a.artifactType === type);

    // Simple pagination (10 per page)
    const pageSize = 10;
    const startIndex = cursor ? parseInt(cursor, 10) : 0;
    const page = artifacts.slice(startIndex, startIndex + pageSize);
    const nextCursor = startIndex + pageSize < artifacts.length ? String(startIndex + pageSize) : null;

    return {
      items: page.map(a => ({
        ...a,
        provenance: 'MOCK',
        tenantId: this.tenantId,
        discoveredAt: new Date().toISOString(),
      })),
      nextCursor,
      total: artifacts.length,
    };
  }

  /**
   * Get single object details
   */
  async getObject(objectId) {
    LOG.debug('Mock getObject', { tenantId: this.tenantId, objectId });

    const artifact = this.fixtures.artifacts.find(a => a.objectId === objectId);

    if (!artifact) {
      return null;
    }

    return {
      ...artifact,
      provenance: 'MOCK',
      tenantId: this.tenantId,
      rawDefinition: JSON.stringify(artifact, null, 2),
      rawFormat: 'json',
      discoveredAt: new Date().toISOString(),
    };
  }

  /**
   * Get all artifacts (for initial discovery)
   */
  async getAllArtifacts() {
    LOG.info('Mock discovery - returning all artifacts', {
      tenantId: this.tenantId,
      count: this.fixtures.artifacts.length,
    });

    return this.fixtures.artifacts.map(a => ({
      ...a,
      provenance: 'MOCK',
      tenantId: this.tenantId,
      rawDefinition: JSON.stringify(a, null, 2),
      rawFormat: 'json',
      discoveredAt: new Date().toISOString(),
    }));
  }
}

module.exports = { MockPiPoAdapter, TENANT_FIXTURES };
