'use strict';

const multer = require('multer');
const config = require('../config');
const { isAppError } = require('../errors');

function notFoundHandler(req, res) {
  if (req.path.startsWith('/api/')) {
    res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: 'That API endpoint does not exist.',
      },
    });
    return;
  }

  res.status(404).type('text/plain').send('Not found. Head back to / to use TidyData.');
}

function errorHandler(error, req, res, next) {
  if (res.headersSent) {
    next(error);
    return;
  }

  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({
        error: {
          code: 'FILE_TOO_LARGE',
          message: `That file is too large. The limit is ${config.maxFileSizeMb} MB.`,
        },
      });
      return;
    }
    if (error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE') {
      res.status(400).json({
        error: {
          code: 'UPLOAD_ERROR',
          message: 'Please upload one file at a time using the "file" field.',
        },
      });
      return;
    }
    res.status(400).json({
      error: { code: 'UPLOAD_ERROR', message: 'The file upload could not be processed.' },
    });
    return;
  }

  if (isAppError(error)) {
    res.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    });
    return;
  }

  if (error?.type === 'entity.parse.failed' || (error instanceof SyntaxError && 'body' in error)) {
    res.status(400).json({
      error: { code: 'INVALID_JSON_BODY', message: 'The request body is not valid JSON.' },
    });
    return;
  }

  console.error('[tidydata] Unhandled error:', error);
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong on our side. Please try again.',
    },
  });
}

module.exports = { notFoundHandler, errorHandler };
