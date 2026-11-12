const http = require('http');

const options = {
  hostname: 'localhost',
  port: 4004,
  path: '/odata/v4/discovery/PISystems',
  method: 'GET',
  headers: {
    'Authorization': 'Basic YWxpY2U6'
  }
};

const req = http.request(options, res => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    console.log('Status:', res.statusCode);
    console.log('Body:', body);
  });
});
req.on('error', e => console.error('Error:', e.message));
req.end();
