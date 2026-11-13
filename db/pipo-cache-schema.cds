namespace pipo.cache;

// Internal persistence only: deliberately not projected into an OData service.
@cds.autoexpose: false
entity Entries {
  key ID    : String(64);
  payload   : LargeString;
  fetchedAt : Timestamp;
  expiresAt : Timestamp;
}