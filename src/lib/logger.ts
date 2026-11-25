import { pino } from 'pino';

/**
 * Structured logger. Secrets and personal data are redacted at the logger level so a
 * careless log call cannot leak them.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.password',
      '*.newPassword',
      '*.code',
      '*.totpCode',
      '*.recoveryCode',
      '*.token',
      '*.refreshToken',
      '*.passwordHash',
      '*.secret',
    ],
    censor: '[redacted]',
  },
});
