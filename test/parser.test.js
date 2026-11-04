'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDataset, buildPreview, detectDelimiter } = require('../src/services/parser');

function buffer(text) {
  return Buffer.from(text, 'utf8');
}

test('parses CSV, trims header names, and deduplicates them', () => {
  const dataset = parseDataset(buffer(' name ,name,age\nAlice,1,30\nBob,2,31\n'), 'people.csv');

  assert.equal(dataset.format, 'csv');
  assert.deepEqual(dataset.headers, ['name', 'name_2', 'age']);
  assert.deepEqual(dataset.rows, [
    ['Alice', '1', '30'],
    ['Bob', '2', '31'],
  ]);
});

test('detects semicolon and tab delimiters', () => {
  assert.equal(detectDelimiter('a;b;c\n1;2;3'), ';');
  assert.equal(detectDelimiter('a\tb\tc\n1\t2\t3'), '\t');
  assert.equal(detectDelimiter('a,b,c\n1,2,3'), ',');

  const dataset = parseDataset(buffer('first;last\nAda;Lovelace\n'), 'people.csv');
  assert.deepEqual(dataset.headers, ['first', 'last']);
  assert.deepEqual(dataset.rows, [['Ada', 'Lovelace']]);
});

test('pads short CSV rows and extends extra columns', () => {
  const dataset = parseDataset(buffer('a,b\n1\n2,3,4\n'), 'ragged.csv');

  assert.deepEqual(dataset.headers, ['a', 'b', 'Column 3']);
  assert.deepEqual(dataset.rows, [
    ['1', null, null],
    ['2', '3', '4'],
  ]);
});

test('parses a JSON array of objects with a union of keys', () => {
  const dataset = parseDataset(
    buffer(JSON.stringify([{ id: 1, name: 'A' }, { id: 2, city: 'Paris' }])),
    'data.json',
  );

  assert.equal(dataset.format, 'json');
  assert.deepEqual(dataset.headers, ['id', 'name', 'city']);
  assert.deepEqual(dataset.rows, [
    [1, 'A', null],
    [2, null, 'Paris'],
  ]);
});

test('parses JSON envelopes and nested cell values', () => {
  const dataset = parseDataset(
    buffer(JSON.stringify({ data: [{ id: 1, tags: ['a', 'b'], meta: { ok: true } }] })),
    'api.json',
  );

  assert.deepEqual(dataset.headers, ['id', 'tags', 'meta']);
  assert.equal(dataset.rows[0][0], 1);
  assert.equal(dataset.rows[0][1], '["a","b"]');
  assert.equal(dataset.rows[0][2], '{"ok":true}');
});

test('parses NDJSON when strict JSON parsing fails', () => {
  const dataset = parseDataset(
    buffer('{"id":1,"name":"A"}\n{"id":2,"name":"B"}\n'),
    'events.ndjson',
  );

  assert.equal(dataset.ndjson, true);
  assert.equal(dataset.rows.length, 2);
  assert.deepEqual(dataset.headers, ['id', 'name']);
});

test('treats a JSON array of arrays like a header row plus records', () => {
  const dataset = parseDataset(
    buffer(JSON.stringify([['name', 'score'], ['Alice', 10], ['Bob', 20]])),
    'table.json',
  );

  assert.deepEqual(dataset.headers, ['name', 'score']);
  assert.deepEqual(dataset.rows, [
    ['Alice', 10],
    ['Bob', 20],
  ]);
});

test('parses a JSON array of primitives into a value column', () => {
  const dataset = parseDataset(buffer(JSON.stringify(['a', 'b', 'c'])), 'list.json');
  assert.deepEqual(dataset.headers, ['value']);
  assert.equal(dataset.rows.length, 3);
});

test('rejects empty, binary, and mixed-structure files', () => {
  assert.throws(() => parseDataset(Buffer.alloc(0), 'empty.csv'), /empty/i);
  assert.throws(() => parseDataset(Buffer.from([0x50, 0x4b, 0x00, 0x01]), 'file.zip'), /binary/i);
  assert.throws(
    () => parseDataset(buffer(JSON.stringify([{ id: 1 }, [2, 3]])), 'mixed.json'),
    /mixes/i,
  );
});

test('preview is capped and reports truncation', () => {
  const rows = Array.from({ length: 60 }, (_, index) => [String(index)]);
  const preview = buildPreview({ headers: ['id'], rows }, 50);

  assert.equal(preview.previewRowCount, 50);
  assert.equal(preview.rowCount, 60);
  assert.equal(preview.truncated, true);
});

test('accepts UTF-8 BOM-prefixed files', () => {
  const dataset = parseDataset(buffer('\uFEFFid,name\n1,Alice\n'), 'bom.csv');
  assert.deepEqual(dataset.headers, ['id', 'name']);
});
