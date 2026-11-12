const cds = require('@sap/cds');
const express = require('express');
const path = require('node:path');

const LOG = cds.log('simple-server');

const app = express();
const PORT = process.env.PORT || 4004;

app.use(express.json({ limit: '25mb' }));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'SDAINT-AI Migration Cockpit',
    status: 'running',
    version: '1.0.0'
  });
});

// Stub OData endpoint
app.get('/odata/v4/*', (req, res) => {
  res.json({ value: [] });
});

app.listen(PORT, () => {
  LOG.info('Server started', { port: PORT });
});
