const {listPipoPackages} = require('./srv/utils/pipoClient');
listPipoPackages()
  .then(r => console.log('SUCCESS:', JSON.stringify(r).slice(0,500)))
  .catch(e => console.error('ERROR:', e.message));
