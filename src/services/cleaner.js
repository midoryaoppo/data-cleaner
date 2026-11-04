'use strict';

const DEFAULT_OPTIONS = Object.freeze({
  removeDuplicates: true,
  dedupeColumn: null,
  removeEmptyRows: true,
  dropEmptyColumns: true,
  trimWhitespace: true,
  normalizeNumbers: true,
  normalizeBooleans: true,
  normalizeDates: true,
  normalizeHeaders: true,
  emptyToNull: true,
});

const BOOLEAN_OPTION_KEYS = [
  'removeDuplicates',
  'removeEmptyRows',
  'dropEmptyColumns',
  'trimWhitespace',
  'normalizeNumbers',
  'normalizeBooleans',
  'normalizeDates',
  'normalizeHeaders',
  'emptyToNull',
];

const EMPTY_TOKENS = new Set([
  '',
  '-',
  '--',
  '—',
  'n/a',
  'na',
  'null',
  'none',
  'nil',
  'nan',
  'undefined',
]);

const TRUE_TOKENS = new Set(['true', 'yes', 'y']);
const FALSE_TOKENS = new Set(['false', 'no', 'n']);
const NUMBER_PATTERN = /^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/;
const MONTHS = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

function isBlank(value) {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

function toCell(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeOptions(input = {}) {
  const options = { ...DEFAULT_OPTIONS };
  for (const key of BOOLEAN_OPTION_KEYS) {
    if (typeof input?.[key] === 'boolean') options[key] = input[key];
  }

  let dedupeColumn = input?.dedupeColumn;
  if (typeof dedupeColumn === 'string' && /^\d+$/.test(dedupeColumn)) {
    dedupeColumn = Number.parseInt(dedupeColumn, 10);
  }
  options.dedupeColumn = Number.isInteger(dedupeColumn) && dedupeColumn >= 0 ? dedupeColumn : null;
  return options;
}

function cleanHeaders(headers, snakeCase) {
  return headers.map((header, index) => {
    let next = String(header ?? '').replace(/\uFEFF/g, '').trim();
    if (snakeCase) {
      next = next
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
      if (!next) next = `column_${index + 1}`;
      if (/^\d/.test(next)) next = `col_${next}`;
    }
    return next || `Column ${index + 1}`;
  });
}

function dedupeHeaderNames(headers) {
  const seen = new Set();
  return headers.map((header) => {
    const base = header;
    let candidate = base;
    let counter = 2;
    while (seen.has(candidate.toLowerCase())) {
      candidate = `${base}_${counter}`;
      counter += 1;
    }
    seen.add(candidate.toLowerCase());
    return candidate;
  });
}

function trimCell(value) {
  if (typeof value !== 'string') return { value, changed: false };
  const next = value.replace(/\uFEFF/g, '').trim();
  return { value: next, changed: next !== value };
}

function normalizeNumber(value) {
  if (typeof value !== 'string') return { value, changed: false };
  const trimmed = value.trim();
  if (!NUMBER_PATTERN.test(trimmed)) return { value, changed: false };

  const plain = trimmed.replace(/,/g, '');
  if (/^[+-]?0\d/.test(plain)) return { value, changed: false }; // preserve IDs / ZIP codes
  const digits = plain.replace(/^[+-]/, '').replace('.', '');
  if (digits.length > 15) return { value, changed: false }; // avoid precision loss

  const number = Number(plain);
  if (!Number.isFinite(number)) return { value, changed: false };
  return { value: Object.is(number, -0) ? 0 : number, changed: true };
}

function normalizeBoolean(value) {
  if (typeof value !== 'string') return { value, changed: false };
  const token = value.toLowerCase();
  if (TRUE_TOKENS.has(token)) return { value: true, changed: true };
  if (FALSE_TOKENS.has(token)) return { value: false, changed: true };
  return { value, changed: false };
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function buildISODate(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || y < 1000 || y > 9999) return null;
  if (!Number.isInteger(m) || m < 1 || m > 12) return null;
  if (!Number.isInteger(d) || d < 1 || d > daysInMonth(y, m)) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function monthNumber(token) {
  return MONTHS[String(token).slice(0, 3).toLowerCase()] || null;
}

/** Convert common unambiguous date formats to YYYY-MM-DD. Month/day/year is assumed for ambiguous slash dates. */
function normalizeDate(value) {
  if (typeof value !== 'string') return { value, changed: false };
  const input = value.trim();
  if (input.length < 6 || input.length > 40) return { value, changed: false };

  let iso = null;
  let match = input.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (match) {
    iso = buildISODate(match[1], match[2], match[3]);
  }

  if (!iso) {
    match = input.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
    if (match) {
      const first = Number(match[1]);
      const second = Number(match[2]);
      // If the first value can't be a month, treat it as day/month/year.
      iso =
        first > 12 && second <= 12
          ? buildISODate(match[3], second, first)
          : buildISODate(match[3], first, second);
    }
  }

  if (!iso) {
    match = input.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/);
    if (match) iso = buildISODate(match[3], monthNumber(match[1]), match[2]);
  }

  if (!iso) {
    match = input.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/);
    if (match) iso = buildISODate(match[3], monthNumber(match[2]), match[1]);
  }

  if (!iso) return { value, changed: false };
  return { value: iso, changed: iso !== value };
}

function cleanDataset(dataset, rawOptions = {}) {
  const startedAt = Date.now();
  const options = normalizeOptions(rawOptions);
  const warnings = [];
  const stats = {
    rowsIn: dataset.rows.length,
    rowsOut: 0,
    columnsIn: dataset.headers.length,
    columnsOut: 0,
    duplicatesRemoved: 0,
    emptyRowsRemoved: 0,
    emptyColumnsDropped: 0,
    cellsTrimmed: 0,
    valuesFormatted: 0,
    emptyValuesNormalized: 0,
    headersAdjusted: 0,
    processingMs: 0,
  };

  const originalHeaders = dataset.headers.map((header) => String(header ?? ''));
  let formattedHeaders = cleanHeaders(originalHeaders, options.normalizeHeaders);
  formattedHeaders = dedupeHeaderNames(formattedHeaders);
  stats.headersAdjusted = formattedHeaders.reduce(
    (count, header, index) => count + (header === originalHeaders[index] ? 0 : 1),
    0,
  );

  let rows = dataset.rows.map((row) =>
    Array.from({ length: formattedHeaders.length }, (_, index) => toCell(row[index])),
  );

  if (options.trimWhitespace) {
    rows = rows.map((row) =>
      row.map((cell) => {
        const result = trimCell(cell);
        if (result.changed) stats.cellsTrimmed += 1;
        return result.value;
      }),
    );
  }

  rows = rows.map((row) =>
    row.map((cell) => {
      let next = cell;

      if (options.normalizeNumbers) {
        const result = normalizeNumber(next);
        next = result.value;
        if (result.changed) stats.valuesFormatted += 1;
      }

      if (options.normalizeBooleans) {
        const result = normalizeBoolean(next);
        next = result.value;
        if (result.changed) stats.valuesFormatted += 1;
      }

      if (options.normalizeDates) {
        const result = normalizeDate(next);
        next = result.value;
        if (result.changed) stats.valuesFormatted += 1;
      }

      if (
        options.emptyToNull &&
        typeof next === 'string' &&
        EMPTY_TOKENS.has(next.trim().toLowerCase())
      ) {
        if (next !== null) stats.emptyValuesNormalized += 1;
        next = null;
      }

      return next;
    }),
  );

  if (options.removeEmptyRows) {
    const before = rows.length;
    rows = rows.filter((row) => row.some((cell) => !isBlank(cell)));
    stats.emptyRowsRemoved = before - rows.length;
  }

  let dedupeIndex = null;
  if (options.removeDuplicates && options.dedupeColumn !== null) {
    if (options.dedupeColumn < formattedHeaders.length) {
      dedupeIndex = options.dedupeColumn;
    } else {
      warnings.push('The selected duplicate-check column no longer exists, so all columns were compared.');
    }
  }

  if (options.removeDuplicates) {
    const seenRows = new Set();
    const uniqueRows = [];
    for (const row of rows) {
      const key = JSON.stringify(dedupeIndex === null ? row : [row[dedupeIndex]]);
      if (seenRows.has(key)) {
        stats.duplicatesRemoved += 1;
      } else {
        seenRows.add(key);
        uniqueRows.push(row);
      }
    }
    rows = uniqueRows;
  }

  const droppedColumns = [];
  if (options.dropEmptyColumns && rows.length > 0) {
    const keepIndexes = [];
    formattedHeaders.forEach((header, index) => {
      if (rows.some((row) => !isBlank(row[index]))) {
        keepIndexes.push(index);
      } else {
        droppedColumns.push(header);
      }
    });

    if (keepIndexes.length !== formattedHeaders.length) {
      formattedHeaders = keepIndexes.map((index) => formattedHeaders[index]);
      rows = rows.map((row) => keepIndexes.map((index) => row[index]));
    }
  }
  stats.emptyColumnsDropped = droppedColumns.length;

  stats.rowsOut = rows.length;
  stats.columnsOut = formattedHeaders.length;
  stats.processingMs = Date.now() - startedAt;

  return {
    headers: formattedHeaders,
    rows,
    stats,
    droppedColumns,
    options,
    warnings,
  };
}

module.exports = {
  DEFAULT_OPTIONS,
  cleanDataset,
  cleanHeaders,
  dedupeHeaderNames,
  normalizeOptions,
  normalizeNumber,
  normalizeBoolean,
  normalizeDate,
  isBlank,
};
