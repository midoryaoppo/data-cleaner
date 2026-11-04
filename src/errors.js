'use strict';

class AppError extends Error {
  constructor(status, message, { code = 'REQUEST_FAILED', details = undefined } = {}) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function isAppError(error) {
  return error instanceof AppError;
}

module.exports = { AppError, isAppError };
