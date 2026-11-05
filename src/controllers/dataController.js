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

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function cleanLimitMessage(access, entry) {
  const limits = access.limits;
  if (access.reason === 'FREE_FILE_SIZE_LIMIT') {
    return `This file is ${formatBytes(entry.size)}. The free plan cleans files up to ${limits.maxFileSizeMb} MB (${limits.maxRows.toLocaleString()} rows). Upgrade to clean large files, run bulk jobs, and unlock NDJSON/TSV exports.`;
  }
  return `This file has ${entry.dataset.rows.length.toLocaleString()} rows. The free plan cleans up to ${limits.maxRows.toLocaleString()} rows and ${limits.maxFileSizeMb} MB per file. Upgrade to clean large files, run bulk jobs, and unlock NDJSON/TSV exports.`;
}

function exportLimitMessage(access, rowCount, format, status) {
  const singlePrice = status.prices.single.display;
  const monthlyPrice = status.prices.monthly.display;

  if (access.reason === 'PREMIUM_FORMAT') {
    return `${format.toUpperCase()} export is a premium format. Buy an export pass for ${singlePrice} or subscribe for ${monthlyPrice}/month to unlock NDJSON/TSV downloads, large files, and bulk processing.`;
  }
  if (access.reason === 'NO_CREDITS') {
    return 'Your export credit has been used. Buy another export pass or subscribe for unlimited premium exports.';
  }

  const limit = status.highVolumeRowLimit.toLocaleString();
  return `This export has ${rowCount.toLocaleString()} rows. Free downloads cover up to ${limit} rows — buy an export pass for ${singlePrice} or subscribe for ${monthlyPrice}/month.`;
}

function sample(req, res) {
  res
    .status(200)
    .set('Content-Type', 'text/csv; charset=utf-8')
    .set('Cache-Control', 'no-store')
    .send(sampleCsv);
}

async function upload(req, res) {
  if (!req.file) {
    throw new AppError(400, 'Please choose a file to upload.', { code: 'NO_FILE' });
  }

  const dataset = parseDataset(req.file.buffer, req.file.originalname);
  const access = await billing.evaluateDatasetAccess(req, {
    rowCount: dataset.rows.length,
    size: req.file.size,
  });
  const id = await fileStore.put({
    kind: 'source',
    name: req.file.originalname,
    format: dataset.format,
    size: req.file.size,
    dataset: { headers: dataset.headers, rows: dataset.rows },
  });
  const entry = await fileStore.get(id);
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
    access: billing.toPublicAccess(access),
  });
}

function optionsForEntry(body, entry) {
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
  return options;
}

async function cleanSourceEntry(entry, options) {
  const result = cleanDataset(entry.dataset, options);
  const cleanedId = await fileStore.put({
    kind: 'cleaned',
    sourceId: entry.id,
    name: entry.name,
    format: entry.format,
    size: entry.size,
    dataset: { headers: result.headers, rows: result.rows },
  });
  const cleanedEntry = await fileStore.get(cleanedId);
  const preview = buildPreview({ headers: result.headers, rows: result.rows });

  return {
    id: cleanedId,
    sourceId: entry.id,
    name: entry.name,
    sourceFormat: entry.format,
    ...preview,
    stats: result.stats,
    warnings: result.warnings,
    droppedColumns: result.droppedColumns,
    options: result.options,
    expiresAt: cleanedEntry.expiresAt,
  };
}

async function clean(req, res) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const { fileId } = body;

  if (typeof fileId !== 'string' || fileId.trim() === '') {
    throw new AppError(400, 'A fileId is required. Upload a file first.', {
      code: 'MISSING_FILE_ID',
    });
  }

  const entry = await fileStore.get(fileId.trim());
  if (!entry || entry.kind !== 'source') {
    throw new AppError(404, 'That file is no longer available. Please upload it again.', {
      code: 'FILE_NOT_FOUND',
    });
  }

  const access = await billing.evaluateDatasetAccess(req, {
    rowCount: entry.dataset.rows.length,
    size: entry.size,
  });

  if (!access.allowed) {
    const status = await billing.getStatus(req);
    res.status(402).json({
      error: {
        code: 'PAYMENT_REQUIRED',
        message: cleanLimitMessage(access, entry),
        details: {
          reason: access.reason,
          fileId: entry.id,
          rowCount: entry.dataset.rows.length,
          size: entry.size,
          limits: access.limits,
        },
      },
      billing: status,
      access: billing.toPublicAccess(access),
      fileId: entry.id,
    });
    return;
  }

  const options = optionsForEntry(body, entry);
  res.json({ cleaned: await cleanSourceEntry(entry, options) });
}

async function bulkClean(req, res) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const rawIds = body.fileIds;

  if (!Array.isArray(rawIds) || rawIds.length < 2) {
    throw new AppError(400, 'Bulk cleaning needs at least two fileIds.', {
      code: 'BULK_FILES_REQUIRED',
    });
  }

  const fileIds = Array.from(
    new Set(
      rawIds.map((id) => (typeof id === 'string' ? id.trim() : '')).filter((id) => id !== ''),
    ),
  );

  if (fileIds.length < 2) {
    throw new AppError(400, 'Bulk cleaning needs at least two different fileIds.', {
      code: 'BULK_FILES_REQUIRED',
    });
  }

  if (fileIds.length > config.billing.bulkMaxFiles) {
    throw new AppError(400, `Bulk cleaning accepts up to ${config.billing.bulkMaxFiles} files at once.`, {
      code: 'BULK_LIMIT_EXCEEDED',
      details: { maxFiles: config.billing.bulkMaxFiles },
    });
  }

  const entitlement = await billing.getRequestEntitlement(req);
  if (!billing.hasPremiumAccess(entitlement)) {
    const status = await billing.getStatus(req);
    res.status(402).json({
      error: {
        code: 'PAYMENT_REQUIRED',
        message: `Bulk processing is a premium feature. Buy an export pass for ${status.prices.single.display} or subscribe for ${status.prices.monthly.display}/month to clean up to ${config.billing.bulkMaxFiles} files in one run.`,
        details: {
          reason: 'BULK_PREMIUM',
          maxFiles: config.billing.bulkMaxFiles,
          limits: billing.freeTierLimits(),
        },
      },
      billing: status,
    });
    return;
  }

  const entries = [];
  for (const fileId of fileIds) {
    const entry = await fileStore.get(fileId);
    if (!entry || entry.kind !== 'source') {
      throw new AppError(404, 'One of those files is no longer available. Please upload it again.', {
        code: 'FILE_NOT_FOUND',
        details: { fileId },
      });
    }
    entries.push(entry);
  }

  const optionsList = entries.map((entry) => optionsForEntry(body, entry));
  const cleaned = [];
  for (let index = 0; index < entries.length; index += 1) {
    cleaned.push(await cleanSourceEntry(entries[index], optionsList[index]));
  }

  res.json({ cleaned, count: cleaned.length });
}

async function download(req, res) {
  const entry = await fileStore.get(req.params.id);
  if (!entry || entry.kind !== 'cleaned') {
    throw new AppError(
      404,
      'That cleaned file is no longer available. Please clean your data again.',
      { code: 'FILE_NOT_FOUND' },
    );
  }

  const requestedFormat = billing.normalizeExportFormat(req.query.format || 'csv');
  if (!requestedFormat) {
    throw new AppError(400, 'Choose "csv", "json", "ndjson", or "tsv" as the download format.', {
      code: 'INVALID_FORMAT',
    });
  }

  const rowCount = entry.dataset.rows.length;
  const access = await billing.evaluateExportAccess(req, rowCount, requestedFormat);
  if (!access.allowed) {
    const billingStatus = await billing.getStatus(req);
    res.status(402).json({
      error: {
        code: 'PAYMENT_REQUIRED',
        message: exportLimitMessage(access, rowCount, requestedFormat, billingStatus),
        details: {
          reason: access.reason,
          format: requestedFormat,
          rowCount,
          highVolumeRowLimit: billingStatus.highVolumeRowLimit,
          premiumExportFormats: billingStatus.premiumExportFormats,
        },
      },
      billing: billingStatus,
      access: {
        allowed: false,
        highVolume: access.highVolume,
        premiumFormat: access.premiumFormat,
        reason: access.reason,
        format: requestedFormat,
        rowCount,
      },
    });
    return;
  }

  const { buffer, contentType } = buildExport(entry.dataset, requestedFormat);
  const filename = buildDownloadFilename(entry.name, requestedFormat);

  if (access.billable) await billing.consumeExport(access.entitlement);

  res.status(200);
  res.set({
    'Content-Type': contentType,
    'Content-Length': String(buffer.length),
    'Content-Disposition': contentDisposition(filename),
    'Cache-Control': 'private, no-store',
  });
  res.send(buffer);
}

async function remove(req, res) {
  await fileStore.delete(req.params.id);
  res.status(204).end();
}

module.exports = { sample, upload, clean, bulkClean, download, remove };
