using { docparse } from '../db/documents-schema';

service DocumentService @(path: '/odata/v4/documents', requires: 'any') {

  @readonly entity Documents      as projection on docparse.Document;
  @readonly entity DocumentFields as projection on docparse.DocumentField;

  // ── Parse an uploaded file with Claude, persist it, post it to the brain ──
  action parseDocument(
    key          : String,   // master key, same gate as BrainService actions
    fileName     : String,
    mimeType     : String,   // application/pdf | image/png | image/jpeg | image/webp | image/gif
    contentBase64: LargeString,
    sourceContext: String    // e.g. 'bw_bdc_source_system' — free text, for provenance only
  ) returns {
    documentId : String;   // sdaintdoc_id_<uuid> — also the key for Documents/DocumentFields
    vectorId   : String;   // brain vector store id
    brainEventId: String;  // set only if the brain was enabled at parse time
    fieldCount : Integer;
    model      : String;
    message    : String;
  };
}
