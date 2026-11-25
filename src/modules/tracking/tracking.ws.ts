import type { Server as HttpServer, IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { AppError } from '../../lib/errors.js';
import { API_PREFIX } from '../auth/cookies.js';
import { resolveAuth, type AuthContext } from '../../middleware/auth.js';
import { trackingBus, trackingView, type BusEvent, type TrackingViewer } from './tracking.service.js';

export const TRACKING_WS_PATH = `${API_PREFIX}/tracking/ws`;

/**
 * Live tracking over WebSocket. Protocol (JSON messages):
 *   client → {type:'auth', token}            within 5 s of connecting, else closed (4401)
 *   client → {type:'subscribe', bookingId, as: 'customer'|'driver'|'owner'}
 *   server → {type:'update', view}            on subscribe, on every new point, and each minute
 *   server → {type:'error', code}             then closes (4401 unauthenticated, 4403/4404 not allowed)
 * The session and the caller's right to see the booking are re-checked before every
 * push, so a sign-out, a suspension or the end of the trip stops the stream at once.
 * Staff never use this channel: their break-glass view is REST-only and audited.
 */
export function attachTrackingSocket(server: HttpServer): WebSocketServer {
  const origins = new Set(env().CORS_ORIGINS);
  const wss = new WebSocketServer({
    server,
    path: TRACKING_WS_PATH,
    maxPayload: 4096,
    // Browsers always send Origin: only RideWELL's own sites may connect. A native app sends none.
    verifyClient: ({ req }: { req: IncomingMessage }) => !req.headers.origin || origins.has(req.headers.origin),
  });

  wss.on('connection', (ws: WebSocket) => {
    let authHeader: string | null = null;
    let auth: AuthContext | null = null;
    let sub: { bookingId: string; as: TrackingViewer } | null = null;
    let busy = false;

    const send = (msg: unknown) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
    const fail = (code: string, close: number) => {
      send({ type: 'error', code });
      ws.close(close, code);
    };
    const authTimer = setTimeout(() => !auth && fail('unauthorized', 4401), 5000);

    const push = async () => {
      if (!sub || !authHeader || busy) return;
      busy = true;
      try {
        auth = await resolveAuth(authHeader);
        if (!auth) return fail('unauthorized', 4401);
        const view = await trackingView(sub.bookingId, auth, sub.as);
        send({ type: 'update', view });
        if (view.state === 'closed') ws.close(1000, 'tracking_closed');
      } catch (err) {
        if (err instanceof AppError) fail(err.code, err.status === 404 ? 4404 : 4403);
        else {
          logger.error({ err }, 'tracking socket push failed');
          fail('server_error', 1011);
        }
      } finally {
        busy = false;
      }
    };

    const onEvent = (e: BusEvent) => {
      if (sub && e.bookingId === sub.bookingId) void push();
    };
    trackingBus.on('event', onEvent);
    const minute = setInterval(() => void push(), 60_000);
    const ping = setInterval(() => ws.readyState === ws.OPEN && ws.ping(), 30_000);

    ws.on('message', async (raw) => {
      let msg: { type?: unknown; token?: unknown; bookingId?: unknown; as?: unknown };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return fail('bad_message', 4400);
      }
      if (msg.type === 'auth' && typeof msg.token === 'string' && msg.token.length < 2048) {
        authHeader = `Bearer ${msg.token}`;
        auth = await resolveAuth(authHeader);
        if (!auth || auth.sessionKind !== 'user') return fail('unauthorized', 4401);
        clearTimeout(authTimer);
        send({ type: 'ready' });
        return;
      }
      if (msg.type === 'subscribe') {
        if (!auth) return fail('unauthorized', 4401);
        const as = msg.as;
        if (typeof msg.bookingId !== 'string' || !/^[a-f0-9]{24}$/i.test(msg.bookingId) || (as !== 'customer' && as !== 'driver' && as !== 'owner')) return fail('bad_message', 4400);
        sub = { bookingId: msg.bookingId, as };
        await push();
        return;
      }
      fail('bad_message', 4400);
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      clearInterval(minute);
      clearInterval(ping);
      trackingBus.off('event', onEvent);
    });
  });
  return wss;
}
