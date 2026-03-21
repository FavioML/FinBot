const pino = require('pino');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: {
    paths: [
      'access_token', 'refresh_token', 'gmail_access_token', 'gmail_refresh_token',
      'ADMIN_KEY', 'apiKey', 'token', 'password',
      '*.access_token', '*.refresh_token', '*.gmail_access_token', '*.gmail_refresh_token',
    ],
    censor: '[REDACTED]',
  },
  transport: process.env.NODE_ENV !== 'production' ? {
    target: 'pino/file',
    options: { destination: 1 }, // stdout
  } : undefined,
});

module.exports = logger;
