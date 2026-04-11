// src/document-handler.js — Document download, parsing, and summarisation
// Handles PDFs, DOCX, xlsx, and plain text documents from WhatsApp messages.

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

import logger from './logger.js';
import { summariseDocument, parseDocumentWithDocling } from './evo-llm.js';
import { checkEvoHealth, storeDocument } from './memory.js';
import { detectContribution } from './sovren/contribution-detector.js';
import { ingestXlsx, ingestDocument } from './sovren/contribution-pipeline.js';

// Text-based mimetypes we can read and inject into context
const TEXT_MIMETYPES = new Set([
  'text/plain', 'text/markdown', 'text/csv', 'text/html',
  'application/json', 'text/x-python', 'text/javascript',
  'application/xml', 'text/xml',
]);

// Excel mimetypes — handled by the SOVREN xlsx parser, not the generic text path
const XLSX_MIMETYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
]);

function isTextDocument(mimetype) {
  if (TEXT_MIMETYPES.has(mimetype)) return true;
  if (mimetype.startsWith('text/')) return true;
  return false;
}

export function getDocumentInfo(message) {
  const doc = message.message?.documentMessage
    || message.message?.documentWithCaptionMessage?.message?.documentMessage;
  if (!doc) return null;
  return {
    mimetype: doc.mimetype || 'application/octet-stream',
    fileName: doc.fileName || 'unknown',
  };
}

/**
 * Process a document attachment from a WhatsApp message.
 * Downloads, parses, optionally summarises via EVO, caches raw text.
 *
 * @param {Buffer} buffer - Raw document buffer (already downloaded)
 * @param {object} docInfo - { mimetype, fileName }
 * @param {string} messageText - Current message text (caption)
 * @param {string} senderName - Sender display name
 * @param {string} chatJid - Chat JID for caching
 * @param {Map} lastDocByChat - Document cache map
 * @param {object} [opts] - Optional { senderJid, isGroup } for SOVREN contribution detection
 * @returns {{ messageText: string }} - Updated message text with document context injected
 */
export async function processDocument(buffer, docInfo, messageText, senderName, chatJid, lastDocByChat, opts = {}) {
  // SOVREN contribution detection — runs on every document, regardless of type
  const sovrenDetect = detectContribution({
    chatJid,
    isGroup: !!opts.isGroup,
    senderJid: opts.senderJid ?? null,
    senderName,
    text: messageText || '',
    fileName: docInfo.fileName,
  });

  // Excel files: handled by the SOVREN xlsx parser if a contribution, or short-circuited otherwise
  if (XLSX_MIMETYPES.has(docInfo.mimetype)) {
    if (sovrenDetect.isContribution && sovrenDetect.contributor) {
      try {
        const result = await ingestXlsx({
          buffer,
          fileName: docInfo.fileName,
          contributorName: sovrenDetect.contributor.displayName,
          contributorSlug: sovrenDetect.contributor.slug,
          coverText: messageText || undefined,
        });
        const docContext = `--- SOVREN contribution ingested: ${docInfo.fileName} ---\n${result.reply}\n--- End contribution ---`;
        lastDocByChat.set(chatJid, { raw: result.reply, fileName: docInfo.fileName, timestamp: Date.now() });
        return { messageText: `${messageText || ''}\n\n${docContext}` };
      } catch (err) {
        logger.warn({ err: err.message, fileName: docInfo.fileName }, 'sovren xlsx ingest failed');
        return { messageText: `${messageText || ''}\n\n[Attached spreadsheet: ${docInfo.fileName} — SOVREN ingest failed: ${err.message}]` };
      }
    }
    // Non-SOVREN xlsx — for now we just acknowledge without parsing.
    return { messageText: `${messageText || ''}\n\n[Attached spreadsheet: ${docInfo.fileName} — outside SOVREN scope, not parsed]` };
  }

  let textContent = null;

  if (isTextDocument(docInfo.mimetype)) {
    textContent = buffer.toString('utf-8');
  } else if (docInfo.mimetype === 'application/pdf') {
    // Try Granite-Docling for structured parsing, fall back to pdf-parse
    const doclingResult = await parseDocumentWithDocling(buffer, docInfo.fileName).catch(() => null);
    if (doclingResult) {
      textContent = doclingResult;
      logger.info({ fileName: docInfo.fileName, chars: doclingResult.length }, 'PDF parsed via Granite-Docling');
    } else {
      const pdf = await pdfParse(buffer);
      textContent = pdf.text;
      logger.info({ fileName: docInfo.fileName, pages: pdf.numpages }, 'PDF parsed via pdf-parse (Docling fallback)');
    }
  } else if (docInfo.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const result = await mammoth.extractRawText({ buffer });
    textContent = result.value;
    logger.info({ fileName: docInfo.fileName }, 'DOCX parsed');
  }

  if (textContent) {
    // If no caption, prompt natural engagement with the document
    if (!messageText.trim()) {
      messageText = `[Document shared: ${docInfo.fileName} — respond naturally. Engage with the content in context of the conversation. Do not just summarise unless asked.]`;
    }

    // Summarise via EVO to save Claude tokens, fall back to truncated raw
    let docContext;
    let docSummary = null;
    const evoUp = await checkEvoHealth();
    if (evoUp && textContent.length > 1000) {
      docSummary = await summariseDocument(textContent.slice(0, 12000), docInfo.fileName);
      if (docSummary) {
        docContext = `--- Summary of ${docInfo.fileName} (${textContent.length} chars original, summarised locally) ---\n${docSummary}\n--- End of summary ---`;
      }
    }
    if (!docContext) {
      // EVO down or doc too short to bother summarising — use raw (truncated)
      const maxChars = 4000;
      const truncated = textContent.length > maxChars
        ? textContent.slice(0, maxChars) + `\n\n[... truncated, ${textContent.length} chars total]`
        : textContent;
      docContext = `--- Attached file: ${docInfo.fileName} ---\n${truncated}\n--- End of file ---`;
    }

    // Cache raw text for follow-up questions
    lastDocByChat.set(chatJid, { raw: textContent, fileName: docInfo.fileName, timestamp: Date.now() });

    // Store document in memory service for long-term retrieval + dream mode (fire-and-forget)
    storeDocument({
      fileName: docInfo.fileName,
      rawText: textContent,
      summary: docSummary || textContent.slice(0, 2000),
      sender: senderName,
      chatJid,
    }).catch(err => logger.warn({ err: err.message, fileName: docInfo.fileName }, 'document memory storage failed'));

    // SOVREN contribution layer: if this document is from a registered contributor
    // in a SOVREN context, ALSO record it in the methodology contribution store.
    // The generic memory storage above is unaffected — this is additional, structured storage.
    if (sovrenDetect.isContribution && sovrenDetect.contributor) {
      ingestDocument({
        buffer,
        fileName: docInfo.fileName,
        mimetype: docInfo.mimetype,
        text: textContent,
        contributorName: sovrenDetect.contributor.displayName,
        contributorSlug: sovrenDetect.contributor.slug,
        coverText: messageText || undefined,
      }).then((result) => {
        if (result.entry) {
          logger.info({ id: result.entry.id, kind: result.entry.kind }, 'sovren document contribution stored');
        }
      }).catch((err) => {
        logger.warn({ err: err.message, fileName: docInfo.fileName }, 'sovren document ingest failed');
      });
    }

    messageText = `${messageText}\n\n${docContext}`;
    logger.info({ fileName: docInfo.fileName, mime: docInfo.mimetype, chars: textContent.length, summarised: !!docSummary, sovrenContribution: sovrenDetect.isContribution }, 'document content injected');
  } else {
    messageText = `${messageText}\n\n[Attached file: ${docInfo.fileName} (${docInfo.mimetype}) — unsupported format, cannot read contents]`;
    logger.info({ fileName: docInfo.fileName, mime: docInfo.mimetype }, 'unsupported document format');
  }

  return { messageText };
}
