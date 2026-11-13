using { pipo.cache } from '../db/pipo-cache-schema';

@path: 'pipo-discovery'
@requires: 'authenticated-user'
service PipoDiscoveryService {
  action fetchEndpoint(
    tool         : String,
    parameters   : LargeString,
    ttlSeconds   : Integer,
    forceRefresh : Boolean
  ) returns {
    result : LargeString;
    cache  : {
      hit       : Boolean;
      fetchedAt : Timestamp;
      expiresAt : Timestamp;
      backend   : String;
    };
  };
}