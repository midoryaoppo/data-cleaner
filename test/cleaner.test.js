'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  cleanDataset,
  normalizeNumber,
  normalizeBoolean,
  normalizeDate,
  normalizeOptions,
} = require('../src/services/cleaner');
const { datasetToCSV, datasetToJSON, buildDownloadFilename } = require('../src/services/exporter');

const messy = {
  headers: [' id ', ' Full Name ', 'email', 'active', 'joined', 'score', 'blank'],
  rows: [
    ['1', '  Alice Johnson ', 'alice@example.com', 'YES', '01/15/2024', '1,234.50', ''],
    ['2', 'Bob Smith', 'bob@example.com', 'true', '2024-02-20', '2000', ' '],
    ['2', 'Bob Smith', 'bob@example.com', 'true', '2024-02-20', '2000', ' '],
    ['3', 'Carol White', 'carol@example.com', 'no', 'Mar 5, 2024', 'NaN', ''],
    ['', ' ', '', '', '', '', ''],
  ],
};

test('cleans rows, headers, and values with recommended defaults', () => {
  const result = cleanDataset(messy);

  assert.deepEqual(result.headers, ['id', 'full_name', 'email', 'active', 'joined', 'score']);
  assert.equal(result.rows.length, 3);
  assert.equal(result.stats.duplicatesRemoved, 1);
  assert.equal(result.stats.emptyRowsRemoved, 1);
  assert.equal(result.stats.emptyColumnsDropped, 1);
  assert.equal(result.stats.rowsOut, 3);
  assert.ok(result.stats.cellsTrimmed >= 2);

  assert.deepEqual(result.rows[0], [1, 'Alice Johnson', 'alice@example.com', true, '2024-01-15', 1234.5]);
  assert.deepEqual(result.rows[2], [3, 'Carol White', 'carol@example.com', false, '2024-03-05', null]);
});

test('respects disabled options', () => {
  const result = cleanDataset(messy, {
    normalizeHeaders: false,
    normalizeNumbers: false,
    normalizeBooleans: false,
    normalizeDates: false,
    emptyToNull: false,
    dropEmptyColumns: false,
    removeEmptyRows: false,
    removeDuplicates: false,
    trimWhitespace: false,
  });

  assert.equal(result.rows.length, 5);
  assert.equal(result.headers[0], 'id');
  assert.equal(result.headers[1], 'Full Name');
  assert.equal(result.rows[0][1], '  Alice Johnson ');
  assert.equal(result.rows[0][3], 'YES');
  assert.equal(result.rows[0][5], '1,234.50');
  assert.equal(result.rows[0][6], '');
});

test('deduplicates on a single selected column', () => {
  const result = cleanDataset(
    {
      headers: ['id', 'email'],
      rows: [
        ['1', 'same@example.com'],
        ['2', 'same@example.com'],
        ['3', 'different@example.com'],
      ],
    },
    { dedupeColumn: 1, normalizeHeaders: false, emptyToNull: false },
  );

  assert.equal(result.rows.length, 2);
  assert.equal(result.stats.duplicatesRemoved, 1);
  assert.deepEqual(result.rows.map((row) => row[0]), [1, 3]);
});

test('falls back to all columns when the dedupe index is out of range', () => {
  const result = cleanDataset(
    {
      headers: ['id'],
      rows: [['1'], ['1']],
    },
    { dedupeColumn: 7 },
  );

  assert.equal(result.warnings.length, 1);
  assert.equal(result.stats.duplicatesRemoved, 1);
});

test('normalizes header edge cases safely', () => {
  const result = cleanDataset({
    headers: ['', 'First Name', 'first name', '2nd_value', 'Already_Snake'],
    rows: [['a', 'b', 'c', 'd', 'e']],
  });

  assert.deepEqual(result.headers, [
    'column_1',
    'first_name',
    'first_name_2',
    'col_2nd_value',
    'already_snake',
  ]);
});

test('normalizes numbers without destroying identifiers', () => {
  assert.deepEqual(normalizeNumber('1,234.50'), { value: 1234.5, changed: true });
  assert.deepEqual(normalizeNumber('+42'), { value: 42, changed: true });
  assert.deepEqual(normalizeNumber('00123'), { value: '00123', changed: false });
  assert.deepEqual(normalizeNumber('12345678901234567890'), {
    value: '12345678901234567890',
    changed: false,
  });
  assert.deepEqual(normalizeNumber('N/A'), { value: 'N/A', changed: false });
  assert.deepEqual(normalizeNumber(7), { value: 7, changed: false });
});

test('normalizes booleans and leaves other words alone', () => {
  assert.equal(normalizeBoolean('YES').value, true);
  assert.equal(normalizeBoolean('n').value, false);
  assert.equal(normalizeBoolean('maybe').value, 'maybe');
  assert.equal(normalizeBoolean(false).value, false);
});

test('normalizes common dates and validates real calendar dates', () => {
  assert.equal(normalizeDate('01/15/2024').value, '2024-01-15');
  assert.equal(normalizeDate('2024/2/3').value, '2024-02-03');
  assert.equal(normalizeDate('Mar 5, 2024').value, '2024-03-05');
  assert.equal(normalizeDate('5 March 2024').value, '2024-03-05');
  assert.equal(normalizeDate('15/03/2024').value, '2024-03-15');
  assert.equal(normalizeDate('02/30/2024').value, '02/30/2024');
  assert.equal(normalizeDate('2024-01-15T10:00:00Z').value, '2024-01-15T10:00:00Z');
  assert.equal(normalizeDate('not a date').value, 'not a date');
});

test('normalizeOptions ignores unknown keys and coerces dedupe indexes', () => {
  const options = normalizeOptions({
    trimWhitespace: false,
    normalizeBooleans: 'yes',
    dedupeColumn: '2',
    unexpected: true,
  });

  assert.equal(options.trimWhitespace, false);
  assert.equal(options.normalizeBooleans, true);
  assert.equal(options.dedupeColumn, 2);
  assert.equal('unexpected' in options, false);
});

test('exports CSV with a BOM, CRLF endings, and proper quoting', () => {
  const buffer = datasetToCSV({
    headers: ['name', 'note'],
    rows: [['Alice', 'likes, commas'], ['Bob', null]],
  });
  const text = buffer.toString('utf8');

  assert.ok(text.startsWith('\uFEFFname,note\r\n'));
  assert.ok(text.includes('Alice,"likes, commas"'));
  assert.ok(text.includes('Bob,\r\n'));
});

test('exports JSON as an array of objects', () => {
  const buffer = datasetToJSON({
    headers: ['id', 'label'],
    rows: [
      [1, 'one'],
      [2, null],
    ],
  });

  assert.deepEqual(JSON.parse(buffer.toString('utf8')), [
    { id: 1, label: 'one' },
    { id: 2, label: null },
  ]);
});

test('builds safe download filenames', () => {
  assert.equal(buildDownloadFilename('My Data (final).csv', 'csv'), 'My-Data-final-cleaned.csv');
  assert.equal(buildDownloadFilename('report.json', 'json'), 'report-cleaned.json');
  assert.equal(buildDownloadFilename('...', 'csv'), 'data-cleaned.csv');
});
