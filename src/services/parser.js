'use strict';

const path = require('node:path');
const { parse } = require('csv-parse/sync');
const config = require('../config');
const { AppError } = require('../errors');
const { cleanHeaderList } = require('../utils/headers');

function badFile(message, code = 'INVALID_FILE') {
  return new AppError(400, message, { code });
}

function decodeBuffer(buffer) {
  if (!buffer || buffer.length === 0) {
    throw badFile('That file is empty. Please choose a file with data in it.', 'EMPTY_FILE');
  }

  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { text: buffer.subarray(2).toString('utf16le').replace(/^\uFEFF/, ''), encoding: 'utf-16le' };
  }

  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2));
    swapped.swap16();
    return { text: swapped.toString('utf16le').replace(/^\uFEFF/, ''), encoding: 'utf-16be' };
  }

  if (buffer.subarray(0, 2000).includes(0)) {
    throw badFile(
      'This looks like a binary file. Please upload a CSV, TSV, JSON, or NDJSON file.',
      'BINARY_FILE',
    );
  }

  return { text: buffer.toString('utf8').replace(/^\uFEFF/, ''), encoding: 'utf-8' };
}

function detectFormat(filename, text) {
  const ext = path.extname(filename || '').toLowerCase();
  if (ext === '.json' || ext === '.jsonl' || ext === '.ndjson') return 'json';
  if (ext === '.csv' || ext === '.tsv') return 'csv';

  const firstCharacter = text.trimStart()[0];
  return firstCharacter === '{' || firstCharacter === '[' ? 'json' : 'csv';
}

function detectDelimiter(text) {
  const lines = text.split(/\r?\n/).slice(0, 12).join('\n');
  const candidates = [',', ';', '\t', '|'];
  const scores = new Map(candidates.map((candidate) => [candidate, 0]));
  let inQuotes = false;

  for (let index = 0; index < lines.length; index += 1) {
    const char = lines[index];
    if (char === '"') {
      if (inQuotes && lines[index + 1] === '"') {
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (!inQuotes && scores.has(char)) {
      scores.set(char, scores.get(char) + 1);
    }
  }

  let best = ',';
  let bestScore = 0;
  for (const candidate of candidates) {
    const score = scores.get(candidate);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

function normalizeCsvCell(value) {
  return value === undefined || value === null ? null : String(value);
}

function checkLimits(rowCount, columnCount) {
  if (rowCount > config.maxRows) {
    throw badFile(
      `This file has too many rows (${rowCount.toLocaleString()}). The limit is ${config.maxRows.toLocaleString()} rows.`,
      'TOO_MANY_ROWS',
    );
  }
  if (columnCount > config.maxColumns) {
    throw badFile(
      `This file has too many columns (${columnCount.toLocaleString()}). The limit is ${config.maxColumns} columns.`,
      'TOO_MANY_COLUMNS',
    );
  }
}

function parseCSV(text) {
  const delimiter = detectDelimiter(text);
  let records;

  try {
    records = parse(text, {
      bom: true,
      columns: false,
      delimiter,
      skip_empty_lines: true,
      relax_quotes: true,
      relax_column_count: true,
      max_record_size: 2 * 1024 * 1024,
    });
  } catch (error) {
    throw badFile(
      `We couldn't read this CSV file. ${String(error.message || '').slice(0, 180)}`,
      'INVALID_CSV',
    );
  }

  if (!records || records.length === 0) {
    throw badFile('No rows were found in this CSV file.', 'EMPTY_FILE');
  }

  const headerRow = records[0].map(normalizeCsvCell);
  const dataRows = records.slice(1);
  const width = dataRows.reduce((max, row) => Math.max(max, row.length), headerRow.length);
  checkLimits(dataRows.length, width);

  const rawHeaders = Array.from({ length: width }, (_, index) => headerRow[index] ?? '');
  const headers = cleanHeaderList(rawHeaders);
  const rows = dataRows.map((row) =>
    Array.from({ length: width }, (_, index) => normalizeCsvCell(row[index])),
  );

  return { format: 'csv', headers, rows, delimiter, encoding: 'utf-8' };
}

function extractJsonArray(value, filename) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    for (const key of ['data', 'rows', 'records', 'results', 'items']) {
      if (Array.isArray(value[key])) return value[key];
    }
    return [value];
  }
  throw badFile(
    'This JSON file must contain an array of records, or an object with a "data", "rows", or "records" array.',
    'UNSUPPORTED_JSON',
  );
}

function parseNDJSON(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length === 0) return null;
  const records = [];
  for (const line of lines) {
    try {
      records.push(JSON.parse(line));
    } catch {
      return null;
    }
  }
  return records;
}

function jsonCell(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return JSON.stringify(value);
}

function rowsFromObjects(records) {
  const headers = [];
  const headerIndex = new Map();

  for (const record of records) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw badFile(
        'Every record in this JSON array must be an object. Arrays of primitives are supported only when the array contains no objects.',
        'UNSUPPORTED_JSON',
      );
    }
    for (const key of Object.keys(record)) {
      if (!headerIndex.has(key)) {
        headerIndex.set(key, headers.length);
        headers.push(key);
      }
    }
  }

  if (headers.length === 0) {
    throw badFile('This JSON file does not contain any columns.', 'EMPTY_FILE');
  }
  checkLimits(records.length, headers.length);

  const rows = records.map((record) =>
    headers.map((header) => jsonCell(record[header])),
  );
  return { headers: cleanHeaderList(headers), rows };
}

function rowsFromArrays(records) {
  const headerRecord = records[0];
  const dataRecords = records.slice(1);
  const width = dataRecords.reduce((max, row) => Math.max(max, row.length), headerRecord.length);
  if (width === 0) throw badFile('This JSON file does not contain any columns.', 'EMPTY_FILE');
  checkLimits(dataRecords.length, width);

  const rawHeaders = Array.from({ length: width }, (_, index) => headerRecord[index] ?? '');
  const headers = cleanHeaderList(rawHeaders);
  const rows = dataRecords.map((row) =>
    Array.from({ length: width }, (_, index) => jsonCell(row[index])),
  );
  return { headers, rows };
}

function parseJSON(text, filename) {
  let data;
  let usedNDJSON = false;

  try {
    data = JSON.parse(text);
  } catch (error) {
    const ndjson = parseNDJSON(text);
    if (!ndjson) {
      throw badFile(
        `We couldn't parse this JSON file. ${String(error.message || '').slice(0, 180)}`,
        'INVALID_JSON',
      );
    }
    data = ndjson;
    usedNDJSON = true;
  }

  const records = extractJsonArray(data, filename);
  if (records.length === 0) {
    throw badFile('This JSON file does not contain any records.', 'EMPTY_FILE');
  }

  const allObjects = records.every((item) => item && typeof item === 'object' && !Array.isArray(item));
  const allArrays = records.every((item) => Array.isArray(item));
  const allPrimitives = records.every((item) => item === null || typeof item !== 'object');

  let result;
  if (allObjects) {
    result = rowsFromObjects(records);
  } else if (allArrays) {
    result = rowsFromArrays(records);
  } else if (allPrimitives) {
    checkLimits(records.length, 1);
    result = {
      headers: ['value'],
      rows: records.map((item) => [jsonCell(item)]),
    };
  } else {
    throw badFile(
      'This JSON array mixes objects, arrays, and values. Please use a consistent structure.',
      'UNSUPPORTED_JSON',
    );
  }

  return {
    format: 'json',
    ...result,
    delimiter: null,
    encoding: 'utf-8',
    ndjson: usedNDJSON,
  };
}

function parseDataset(buffer, filename) {
  const { text, encoding } = decodeBuffer(buffer);
  if (text.trim() === '') {
    throw badFile('That file is empty. Please choose a file with data in it.', 'EMPTY_FILE');
  }
  const format = detectFormat(filename, text);
  const dataset = format === 'json' ? parseJSON(text, filename) : parseCSV(text);
  return { ...dataset, encoding, name: filename || `upload.${format}` };
}

function buildPreview(dataset, limit = config.previewRows) {
  const rows = dataset.rows.slice(0, limit);
  return {
    headers: dataset.headers,
    rows,
    rowCount: dataset.rows.length,
    columnCount: dataset.headers.length,
    previewRowCount: rows.length,
    truncated: dataset.rows.length > rows.length,
  };
}

module.exports = {
  parseDataset,
  buildPreview,
  detectDelimiter,
  detectFormat,
  decodeBuffer,
};
