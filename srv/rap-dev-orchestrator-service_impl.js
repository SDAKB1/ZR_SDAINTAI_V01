const cds = require('@sap/cds');

const LOG = cds.log('rap-dev-orchestrator');

module.exports = class RapDevOrchestratorService extends cds.ApplicationService {
  async init() {
    LOG.info('Service initialized');
    return super.init();
  }
};
