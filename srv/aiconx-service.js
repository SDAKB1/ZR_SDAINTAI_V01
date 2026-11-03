const cds = require('@sap/cds');

const MOCK_ASSETS = [
  {
    assetCode: 'salesforce_t',
    name: 'Send SalesOrder',
    assetType: 'app',
    createdDate: '2025-07-24T18:25:50Z',
    lastUsedDate: '2025-07-25T10:12:00Z',
    proposedTarget: 'IFLOW Integration Flow',
    complexity: 'Medium',
    supported: true,
    mode: 'Auto',
    size: '1.2 GB',
    projectId: 'Mule2BTP'
  },
  {
    assetCode: 'newemployee',
    name: 'Create newemployee',
    assetType: 'app',
    createdDate: '2025-07-24T18:02:01Z',
    lastUsedDate: '2025-07-24T19:40:02Z',
    proposedTarget: 'IFLOW Integration Flow',
    complexity: 'Simple',
    supported: true,
    mode: 'Auto',
    size: '800 MB',
    projectId: 'Mule2BTP'
  },
  {
    assetCode: 'newcustomer',
    name: 'Create newcustomer',
    assetType: 'app',
    createdDate: '2025-07-24T18:07:23Z',
    lastUsedDate: '2025-07-24T18:50:11Z',
    proposedTarget: 'RAP ODATA / BAPI',
    complexity: 'Simple',
    supported: true,
    mode: 'Auto',
    size: '450 MB',
    projectId: 'Mule2BTP'
  }
];

const SIMULATE_TEMPLATES = {
  db_write: {
    source: 'Postgres',
    query: "INSERT INTO transactions (user_id, total, status) VALUES (108, 49.99, 'completed')",
    status: '200 OK',
    logType: 'DB'
  },
  db_error: {
    source: 'Postgres',
    query: "SELECT * FROM payment_methods WHERE card_hash = '8x903' LIMIT 1",
    status: '500 Transaction Aborted',
    duration: '120ms',
    logType: 'DB'
  },
  api_fetch: {
    source: 'SymphonyGateway',
    query: 'GET /api/v3/adaptation/grow-structures',
    status: '200 OK',
    logType: 'API'
  },
  state_mutation: {
    source: 'Client',
    query: 'Navigation tab mutation detected',
    status: 'MUTATED',
    duration: '-',
    logType: 'STATE'
  }
};

const DEFAULT_METRICS = [
  { metricKey: 'syncsCount', metricValue: '1402' },
  { metricKey: 'latency',    metricValue: '42' },
  { metricKey: 'listeners',  metricValue: '28' }
];

module.exports = class AiconxService extends cds.ApplicationService {

  async init() {
    const { DbActivityLogs, SystemMetrics, MigrationAssets } = this.entities;

    this.on('simulateEvent', async (req) => {
      const eventType = req.data.eventType || 'api_fetch';
      const tpl = SIMULATE_TEMPLATES[eventType] || SIMULATE_TEMPLATES.api_fetch;

      const entry = {
        ID: cds.utils.uuid(),
        logTimestamp: new Date().toISOString(),
        duration: tpl.duration || `${Math.floor(Math.random() * 40) + 5}ms`,
        ...tpl
      };

      await INSERT.into(DbActivityLogs).entries(entry);
      return SELECT.one.from(DbActivityLogs).where({ ID: entry.ID });
    });

    this.on('importBtpAssets', async (req) => {
      await DELETE.from(MigrationAssets).where({ projectId: 'Mule2BTP' });

      const entries = MOCK_ASSETS.map(a => ({ ID: cds.utils.uuid(), ...a }));
      await INSERT.into(MigrationAssets).entries(entries);

      return SELECT.from(MigrationAssets).where({ projectId: 'Mule2BTP' });
    });

    // Seed default metrics on first READ if empty
    this.before('READ', SystemMetrics, async () => {
      const count = await SELECT.one`count(*) as n`.from(SystemMetrics);
      if (!count || count.n === 0) {
        await INSERT.into(SystemMetrics).entries(
          DEFAULT_METRICS.map(m => ({ ID: cds.utils.uuid(), ...m }))
        );
      }
    });

    return super.init();
  }
};
