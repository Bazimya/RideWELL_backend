import crypto from 'node:crypto';
import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';
import mongoose from 'mongoose';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { errorHandler, notFoundHandler } from './lib/errors.js';
import { rejectOperatorKeys } from './lib/sanitize.js';
import { buildRateLimiters, defaultRateLimits, type RateLimitConfig } from './middleware/rateLimits.js';
import { API_PREFIX } from './modules/auth/cookies.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { meRouter } from './modules/users/me.routes.js';
import { adminRouter } from './modules/admin/admin.routes.js';
import { partnerRouter } from './modules/partners/partner.routes.js';
import { adminPartnerRouter } from './modules/partners/adminPartner.routes.js';
import { documentRouter } from './modules/documents/document.routes.js';
import { adminBookingRouter, customerBookingRouter, partnerTripRouter, publicRouter } from './modules/bookings/booking.routes.js';
import { adminFinanceRouter, partnerFinanceRouter } from './modules/finance/finance.routes.js';
import { mapsRouter } from './modules/maps/maps.routes.js';
import { trackingRouter } from './modules/tracking/tracking.routes.js';
import { adminNotificationsRouter, myNotificationsRouter } from './modules/notifications/notification.routes.js';
import { adminSupportRouter, supportRouter } from './modules/support/support.js';
import { adminDashboardRouter, myDashboardRouter } from './modules/dashboards/dashboard.routes.js';

export interface AppOptions {
  rateLimits?: Partial<RateLimitConfig>;
}

export function createApp(options: AppOptions = {}): Express {
  const e = env();
  const app = express();
  const devAdminLogin = e.DEV_RATE_LIMIT_ADMIN_LOGIN ? { adminLogin: e.DEV_RATE_LIMIT_ADMIN_LOGIN } : {};
  const limits = buildRateLimiters({ ...defaultRateLimits, ...devAdminLogin, ...options.rateLimits });

  app.disable('x-powered-by');
  app.set('trust proxy', e.TRUST_PROXY_HOPS);
  // Express 5's default 'simple' parser does not build nested objects from query strings.
  app.set('query parser', 'simple');

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const id = crypto.randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
    }),
  );

  app.use(
    helmet({
      // The API serves JSON only; nothing on it should ever be rendered or framed.
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || e.CORS_ORIGINS.includes(origin)),
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-RideWELL-Client', 'X-2FA-Code'],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  app.use(rejectOperatorKeys);
  app.use(limits.general);
  app.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.get('/ready', (_req, res) => {
    const ready = mongoose.connection.readyState === 1;
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready' });
  });

  app.use(`${API_PREFIX}/auth`, authRouter(limits));
  // Before /me, whose router authenticates every path it sees.
  app.use(`${API_PREFIX}/me/notifications`, myNotificationsRouter());
  app.use(`${API_PREFIX}/me/dashboard`, myDashboardRouter());
  app.use(`${API_PREFIX}/me`, meRouter());
  app.use(`${API_PREFIX}/support`, limits.booking, supportRouter());
  app.use(`${API_PREFIX}/public`, publicRouter());
  app.use(`${API_PREFIX}/maps`, mapsRouter(limits));
  // Before the booking routers so /bookings/:id/tracking is matched here, with its own auth.
  app.use(API_PREFIX, trackingRouter(limits));
  app.use(`${API_PREFIX}/bookings`, limits.booking, customerBookingRouter());
  app.use(API_PREFIX, partnerTripRouter());
  app.use(`${API_PREFIX}/partners`, partnerFinanceRouter());
  app.use(`${API_PREFIX}/partners`, partnerRouter(limits));
  app.use(`${API_PREFIX}/documents`, documentRouter());
  // Mounted before /admin, whose router ends in a catch-all 404.
  app.use(`${API_PREFIX}/admin/partners`, adminPartnerRouter());
  app.use(`${API_PREFIX}/admin`, adminBookingRouter());
  app.use(`${API_PREFIX}/admin/finance`, adminFinanceRouter());
  app.use(`${API_PREFIX}/admin/notifications`, adminNotificationsRouter());
  app.use(`${API_PREFIX}/admin/support`, adminSupportRouter());
  app.use(`${API_PREFIX}/admin`, adminDashboardRouter());
  app.use(`${API_PREFIX}/admin`, adminRouter());

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
