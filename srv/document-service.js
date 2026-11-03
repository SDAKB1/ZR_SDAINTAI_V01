const cds = require('@sap/cds');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');

const { verifyKey, isBrainEnabled } = require('./ai/brainConfig');
const { getVectorStore } = require('./ai/vectorStore');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

const SUPPORTED_DOCUMENT_TYPES = new Set(['application/pdf']);
const SUPPORTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

function buildExtractionPrompt(fileName) {
  return `You are extracting structured data from a document for a downstream tool that renders a flat field/value table.

The file is "${fileName}".

Return ONLY a JSON array (no prose, no markdown fences) of objects shaped like {"field": "...", "value": "..."}.

Rules:
- Cover every header field (names, dates, IDs, amounts, addresses, contact details, bank details — whatever the document actually has).
- If the document contains a table or repeating line items, emit one row per (line item × column), with "field" written as "Row <n> · <column name>" so every cell is individually addressable.
- Use the values exactly as they appear in the document (currency symbols, formatting, casing) — do not normalize or compute anything that isn't printed.
- If a field is genuinely not present, omit it rather than inventing a value.
- Do not summarize or truncate a long table — extract every row.`;
}

function contentBlockFor(mimeType, base64) {
  if (SUPPORTED_DOCUMENT_TYPES.has(mimeType)) {
    return { type: 'document', source: { type: 'base64', media_type: mimeType, data: base64 } };
  }
  if (SUPPORTED_IMAGE_TYPES.has(mimeType)) {
    return { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } };
  }
  return null;
}

function extractJSONArray(text) {
  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fencedMatch ? fencedMatch[1] : text;
  const arrayMatch = candidate.match(/\[[\s\S]*\]/);
  if (!arrayMatch) return null;
  try {
    const parsed = JSON.parse(arrayMatch[0]);
    if (!Array.isArray(parsed)) return null;
    return parsed
      .map((item) => ({
        field: String(item.field ?? item.key ?? '').trim(),
        value: String(item.value ?? '').trim(),
      }))
      .filter((row) => row.field);
  } catch {
    return null;
  }
}

function fallbackLineRows(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, i) => {
      const m = line.match(/^([^:]{1,80}):\s*(.*)$/);
      return m
        ? { field: m[1].trim(), value: m[2].trim() }
        : { field: `Line ${i + 1}`, value: line };
    });
}

module.exports = class DocumentService extends cds.ApplicationService {
  async init() {
    const { Documents, DocumentFields } = this.entities;

    this.on('parseDocument', async (req) => {
      const { key, fileName, mimeType, contentBase64, sourceContext } = req.data;

      if (!verifyKey(key)) return req.error(403, 'Invalid master key');
      if (!process.env.ANTHROPIC_API_KEY) {
        return req.error(500, 'ANTHROPIC_API_KEY is not configured on the server.');
      }
      if (!fileName || !contentBase64) {
        return req.error(400, 'fileName and contentBase64 are required.');
      }

      const block = contentBlockFor(mimeType, contentBase64);
      if (!block) {
        return req.error(
          415,
          `Unsupported mimeType "${mimeType}" for AI parsing. Supported: PDF, PNG, JPEG, WEBP, GIF.`
        );
      }

      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      let message;
      try {
        message = await anthropic.messages.create({
          model: MODEL,
          max_tokens: 8192,
          messages: [
            { role: 'user', content: [block, { type: 'text', text: buildExtractionPrompt(fileName) }] },
          ],
        });
      } catch (err) {
        return req.error(502, 'Claude request failed: ' + (err.message || String(err)));
      }

      const textBlock = message.content.find((c) => c.type === 'text');
      const rawText = textBlock ? textBlock.text : '';
      const rows = extractJSONArray(rawText) || fallbackLineRows(rawText);

      // ── Post to the brain: register the content in the shared vector store,
      //    and — only when the brain is actually enabled — also record a proper
      //    BrainEvent so it shows up in the Brain UI/exports like any other capture. ──
      const documentId = `sdaintdoc_id_${crypto.randomUUID()}`;
      const vs = getVectorStore();
      const embeddingText = rows.map((r) => `${r.field}: ${r.value}`).join('\n');
      const vectorId = vs.add(embeddingText, {
        source: 'document_parser',
        documentId,
        fileName,
        mimeType,
        fieldCount: rows.length,
      });

      let brainEventId = null;
      if (isBrainEnabled()) {
        try {
          const { Events } = cds.entities('brain');
          const eventRecord = await INSERT.into(Events).entries({
            eventType: 'document_parsed',
            source: sourceContext || 'document_parser',
            payload: JSON.stringify({ documentId, fileName, rows }),
            summary: `Parsed ${rows.length} fields from ${fileName}`,
            embeddingId: vectorId,
            sessionId: '',
            processed: false,
          });
          brainEventId = eventRecord?.[0]?.ID || null;
        } catch (err) {
          console.error('[DocumentService] Could not write BrainEvent (continuing):', err.message);
        }
      }

      await INSERT.into(Documents).entries({
        ID: documentId,
        fileName,
        mimeType,
        sizeBytes: Math.round((contentBase64.length * 3) / 4),
        model: MODEL,
        status: 'parsed',
        vectorId,
        brainEventId,
        fieldCount: rows.length,
        sourceContext: sourceContext || '',
        rawResponse: rawText,
      });

      if (rows.length) {
        await INSERT.into(DocumentFields).entries(
          rows.map((r, i) => ({
            document_ID: documentId,
            rowIndex: i,
            fieldKey: r.field,
            fieldValue: r.value,
          }))
        );
      }

      return {
        documentId,
        vectorId,
        brainEventId,
        fieldCount: rows.length,
        model: MODEL,
        message: isBrainEnabled()
          ? `Parsed ${rows.length} fields from ${fileName} and posted to the brain (vector + event).`
          : `Parsed ${rows.length} fields from ${fileName} and posted to the brain vector store (brain is off, so no Events row was created).`,
      };
    });

    return super.init();
  }
};
