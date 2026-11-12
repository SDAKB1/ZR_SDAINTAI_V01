// test-pipo-destinations.js - Test PI/PO connectivity via Cloud SDK
const { listPipoPackages, listIcos } = require('./srv/utils/pipoClient');

async function test() {
  console.log('=== PI/PO Destination Test ===');
  console.log('Testing ESR destination (PO_PJ2_ESR)...');
  
  try {
    const packages = await listPipoPackages();
    console.log('ESR Result:', JSON.stringify(packages).slice(0, 500));
  } catch (e) {
    console.error('ESR Error:', e.message);
  }

  console.log('Testing DIR destination (PO_PJ2_DIR)...');
  try {
    const icos = await listIcos();
    console.log('DIR Result:', JSON.stringify(icos).slice(0, 500));
  } catch (e) {
    console.error('DIR Error:', e.message);
  }
  
  console.log('=== Test Complete ===');
}

test();
