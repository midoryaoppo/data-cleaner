'use strict';

/**
 * Make column names safe to display and use as JSON keys. Always:
 *  - trims surrounding whitespace
 *  - replaces blank names with "Column N"
 *  - de-duplicates names case-insensitively with a `_2`, `_3` suffix
 * Optionally normalises to lowercase snake_case.
 */
function cleanHeaderList(headers, { snakeCase = false } = {}) {
  const seen = new Map();

  return headers.map((rawHeader, index) => {
    let name = String(rawHeader ?? '')
      .replace(/\uFEFF/g, '')
      .trim();

    if (snakeCase) {
      name = name
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');

      if (!name) name = `column_${index + 1}`;
      if (/^\d/.test(name)) name = `col_${name}`;
    }

    if (!name) name = `Column ${index + 1}`;

    const base = name;
    let candidate = base;
    let counter = 2;
    while (seen.has(candidate.toLowerCase())) {
      candidate = `${base}_${counter}`;
      counter += 1;
    }
    seen.set(candidate.toLowerCase(), true);
    return candidate;
  });
}

module.exports = { cleanHeaderList };
