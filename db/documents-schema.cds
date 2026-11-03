namespace docparse;

using { cuid, managed } from '@sap/cds/common';

/**
 * A file parsed by the SDAINT-AI document parser. ID is a business key
 * (not a plain UUID) so it doubles as the reference posted into the
 * brain vector store: "sdaintdoc_id_<uuid>".
 */
entity Document : managed {
  key ID          : String(60);
      fileName    : String(255);
      mimeType    : String(100);
      sizeBytes   : Integer;
      model       : String(60);
      status      : String(20) enum { parsed; failed; };
      vectorId    : String(60);   // id returned by the brain's LocalVectorStore.add()
      brainEventId: String(36);   // Events.ID, set only when the brain was enabled at parse time
      fieldCount  : Integer;
      sourceContext: String(60);  // e.g. 'bw_bdc_source_system', 'standalone'
      rawResponse : LargeString;  // full Claude response text, for audit
      fields      : Composition of many DocumentField on fields.document = $self;
}

/**
 * One extracted field/value row per document — "Row 3 · Item" style keys
 * for repeating table content, plain field names for header data.
 */
entity DocumentField : cuid, managed {
  document  : Association to Document;
  rowIndex  : Integer;
  fieldKey  : String(200);
  fieldValue: LargeString;
}
