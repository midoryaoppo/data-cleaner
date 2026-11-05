'use strict';

const path = require('node:path');
const { stringify } = require('csv-stringify/sync');

function serializeCell(cell) {
  if (cell === null || cell === undefined) return '';
  if (typeof cell === 'object') return JSON.stringify(cell);
  return String(cell);
}

/** CSV with a UTF-8 BOM and CRLF line endings so Excel opens it correctly. */
function datasetToCSV(dataset) {
  const records = [dataset.headers, ...dataset.rows.map((row) => row.map(serializeCell))];
  const csv = stringify(records, {
    record_delimiter: '\r\n',
    quoted_empty: false,
  });
  return Buffer.from(`\uFEFF${csv}`, 'utf8');
}

function datasetToJSON(dataset) {
  const rows = dataset.rows.map((row) =>
    Object.fromEntries(dataset.headers.map((header, index) => [header, row[index] ?? null])),
  );
  return Buffer.from(`${JSON.stringify(rows, null, 2)}\n`, 'utf8');
}

function datasetToNDJSON(dataset) {
  const lines = dataset.rows.map((row) =>
    JSON.stringify(
      Object.fromEntries(dataset.headers.map((header, index) => [header, row[index] ?? null])),
    ),
  );
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

function datasetToTSV(dataset) {
  const records = [dataset.headers, ...dataset.rows.map((row) => row.map(serializeCell))];
  const tsv = stringify(records, {
    delimiter: '\t',
    record_delimiter: '\r\n',
    quoted_empty: false,
  });
  return Buffer.from(`\uFEFF${tsv}`, 'utf8');
}

function baseFilename(originalName) {
  const withoutExtension = path
    .basename(String(originalName || 'data'))
    .replace(/\.[^.]+$/, '');
  const safe = withoutExtension
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '')
    .slice(0, 80);
  return safe || 'data';
}

function buildDownloadFilename(originalName, format) {
  const extension = ['csv', 'json', 'ndjson', 'tsv'].includes(format) ? format : 'csv';
  return `${baseFilename(originalName)}-cleaned.${extension}`;
}

function contentDisposition(filename) {
  return `attachment; filename="${filename.replace(/["\\]/g, '')}"`;
}

function buildExport(dataset, format) {
  if (format === 'json') {
    return {
      buffer: datasetToJSON(dataset),
      contentType: 'application/json; charset=utf-8',
      extension: 'json',
    };
  }
  if (format === 'ndjson') {
    return {
      buffer: datasetToNDJSON(dataset),
      contentType: 'application/x-ndjson; charset=utf-8',
      extension: 'ndjson',
    };
  }
  if (format === 'tsv') {
    return {
      buffer: datasetToTSV(dataset),
      contentType: 'text/tab-separated-values; charset=utf-8',
      extension: 'tsv',
    };
  }
  return {
    buffer: datasetToCSV(dataset),
    contentType: 'text/csv; charset=utf-8',
    extension: 'csv',
  };
}

module.exports = {
  datasetToCSV,
  datasetToJSON,
  datasetToNDJSON,
  datasetToTSV,
  buildDownloadFilename,
  contentDisposition,
  buildExport,
};
