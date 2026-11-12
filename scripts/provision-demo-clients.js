const http = require('http');

const clients = [
  {
    systemName: 'Dollarama_PI',
    description: 'Dollarama Retail - PI/PO System',
    virtualHost: 'pipo-dollarama.internal',
    virtualPort: 443,
    protocol: 'https',
    locationId: 'DOLLARAMA_CC',
    techUser: 'PIPO_TECH',
    piVersion: '7.50',
    tenantId: 't-dollarama'
  },
  {
    systemName: 'Bombardier_PI',
    description: 'Bombardier Aerospace - PI/PO System',
    virtualHost: 'pipo-bombardier.internal',
    virtualPort: 443,
    protocol: 'https',
    locationId: 'BOMBARDIER_CC',
    techUser: 'PIPO_TECH',
    piVersion: '7.50',
    tenantId: 't-bombardier'
  },
  {
    systemName: 'Acme_PI',
    description: 'Acme Manufacturing - PI/PO System',
    virtualHost: 'pipo-acme.internal',
    virtualPort: 443,
    protocol: 'https',
    locationId: 'ACME_CC',
    techUser: 'PIPO_TECH',
    piVersion: '7.40',
    tenantId: 't-acme'
  }
];

function provisionClient(client) {
  const data = JSON.stringify(client);
  const options = {
    hostname: 'localhost',
    port: 4004,
    path: '/odata/v4/discovery/PISystems',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data),
      'Authorization': 'Basic YWxpY2U6'
    }
  };
  return new Promise((resolve) => {
    const req = http.request(options, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        console.log(client.systemName + ': ' + res.statusCode + ' - ' + body.substring(0, 200));
        resolve();
      });
    });
    req.on('error', e => { console.error(client.systemName + ' error:', e.message); resolve(); });
    req.write(data);
    req.end();
  });
}

function provision() {
  return Promise.all(clients.map(provisionClient));
}

provision().then(() => console.log('Done')).catch(e => { console.error('Provision failed:', e.message); process.exit(1); });
