'use strict';

const multer = require('multer');
const config = require('../config');
const { AppError } = require('../errors');

const BLOCKED_EXTENSIONS = new Set([
  '.zip',
  '.rar',
  '.7z',
  '.tar',
  '.gz',
  '.xls',
  '.xlsx',
  '.pdf',
  '.doc',
  '.docx',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.mp3',
  '.mp4',
  '.mov',
  '.exe',
  '.dll',
]);

const uploader = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.maxFileSizeBytes,
    files: 1,
    fields: 8,
    parts: 12,
  },
  fileFilter(req, file, callback) {
    const extension = file.originalname
      ? `.${file.originalname.split('.').pop().toLowerCase()}`
      : '';
    const blockedMime = /^(image|audio|video|font)\//i.test(file.mimetype || '');

    if (BLOCKED_EXTENSIONS.has(extension) || blockedMime) {
      callback(
        new AppError(
          415,
          'That file type is not supported. Please upload a CSV, TSV, JSON, or NDJSON file.',
          { code: 'UNSUPPORTED_FILE_TYPE' },
        ),
      );
      return;
    }
    callback(null, true);
  },
});

module.exports = { uploader };
