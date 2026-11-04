'use strict';

const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const { AppError } = require('../errors');
const { parseDataset, buildPreview } = require('../services/parser');
const { cleanDataset, normalizeOptions } = require('../services/cleaner');
const { fileStore } = require('../services/fileStore');
const {
  buildExport,
  buildDownloadFilename,
  contentDisposition,
} = require('../services/exporter');
const billing = require('../services/billing');

const sampleCsv = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'sample.csv'), 'utf8');

function sample(req, res) {
  res
    .status(200)
    .set('Content-Type', 'text/csv; charset=utf-8')
    .set('Cache-Control', 'no-store')
    .send(sampleCsv);
}

function upload(req, res) {
  if (!req.file) {
    throw new AppError(400, 'Please choose a file to upload.', { code: 'NO_FILE' });
  }

  const dataset = parseDataset(req.file.buffer, req.file.originalname);
  const id = fileStore.put({
    kind: 'source',
    name: req.file.originalname,
    format: dataset.format,
    size: req.file.size,
    dataset: { headers: dataset.headers, rows: dataset.rows },
  });
  const entry = fileStore.get(id);
  const preview = buildPreview(dataset);

  res.status(201).json({
    file: {
      id,
      name: dataset.name,
      format: dataset.format,
      size: req.file.size,
      encoding: dataset.encoding,
      ...preview,
      expiresAt: entry.expiresAt,
    },
  });
}

function clean(req, res) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const { fileId } = body;

  if (typeof fileId !== 'string' || fileId.trim() === '') {
    throw new AppError(400, 'A fileId is required. Upload a file first.', {
      code: 'MISSING_FILE_ID',
    });
  }

  const entry = fileStore.get(fileId.trim());
  if (!entry || entry.kind !== 'source') {
    throw new AppError(404, 'That file is no longer available. Please upload it again.', {
      code: 'FILE_NOT_FOUND',
    });
  }

  const options = normalizeOptions(
    body.options && typeof body.options === 'object' ? body.options : {},
  );

  if (
    options.dedupeColumn !== null &&
    (!Number.isInteger(options.dedupeColumn) ||
      options.dedupeColumn < 0 ||
      options.dedupeColumn >= entry.dataset.headers.length)
  ) {
    throw new AppError(400, 'The selected duplicate-check column is not valid for this file.', {
      code: 'INVALID_DEDUPE_COLUMN',
    });
  }

  if (!options.removeDuplicates) options.dedupeColumn = null;

  const result = cleanDataset(entry.dataset, options);
  const cleanedId = fileStore.put({
    kind: 'cleaned',
    sourceId: fileId,
    name: entry.name,
    format: entry.format,
    size: entry.size,
    dataset: { headers: result.headers, rows: result.rows },
  });
  const cleanedEntry = fileStore.get(cleanedId);
  const preview = buildPreview({ headers: result.headers, rows: result.rows });

  res.json({
    cleaned: {
      id: cleanedId,
      sourceId: fileId,
      name: entry.name,
      sourceFormat: entry.format,
      ...preview,
      stats: result.stats,
      warnings: result.warnings,
      droppedColumns: result.droppedColumns,
      options: result.options,
      expiresAt: cleanedEntry.expiresAt,
    },
  });
}

function download(req, res) {
  const entry = fileStore.get(req.params.id);
  if (!entry || entry.kind !== 'cleaned') {
    throw new AppError(
      404,
      'That cleaned file is no longer available. Please clean your data again.',
      { code: 'FILE_NOT_FOUND' },
    );
  }

  const requestedFormat = String(req.query.format || 'csv').toLowerCase();
  if (requestedFormat !== 'csv' && requestedFormat !== 'json') {
    throw new AppError(400, 'Choose either "csv" or "json" as the download format.', {
      code: 'INVALID_FORMAT',
    });
  }

  const rowCount = entry.dataset.rows.length;
  const access = billing.evaluateExportAccess(req, rowCount);
  if (!access.allowed) {
    const billingStatus = billing.getStatus(req);
    const singlePrice = billingStatus.prices.single.display;
    const monthlyPrice = billingStatus.prices.monthly.display;
    const limit = billingStatus.highVolumeRowLimit.toLocaleString();
    res.status(402).json({
      error: {
        code: 'PAYMENT_REQUIRED',
        message:
          access.reason === 'NO_CREDITS'
            ? 'Your export credit has been used. Buy another export pass or subscribe for unlimited exports.'
            : `This export has ${rowCount.toLocaleString()} rows. Free downloads cover up to ${limit} rows — buy an export pass for ${singlePrice} or subscribe for ${monthlyPrice}/month.`,
      },
      billing: billingStatus,
    });
    return;
  }

  const { buffer, contentType } = buildExport(entry.dataset, requestedFormat);
  const filename = buildDownloadFilename(entry.name, requestedFormat);

  if (access.billable) billing.consumeExport(access.entitlement);

  res.status(200);
  res.set({
    'Content-Type': contentType,
    'Content-Length': String(buffer.length),
    'Content-Disposition': contentDisposition(filename),
    'Cache-Control': 'private, no-store',
  });
  res.send(buffer);
}

function remove(req, res) {
  fileStore.delete(req.params.id);
  res.status(204).end();
}

module.exports = { sample, upload, clean, download, remove };
