import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { validate, valid } from '../../lib/validate.js';
import type { RateLimiters } from '../../middleware/rateLimits.js';
import { mapsProvider } from './maps.provider.js';

/**
 * Place search for the booking form (open to signed-out visitors, rate-limited).
 * It returns public places only, never anyone's location. The server key never
 * leaves the server; the browser key (Maps JavaScript API, domain-restricted) is
 * the only key the browser sees.
 */
export function mapsRouter(limits: RateLimiters): Router {
  const r = Router();
  const token = z.string().regex(/^[A-Za-z0-9-]{8,64}$/);

  r.get('/config', (_req, res) => {
    const p = mapsProvider();
    res.json({ provider: p.name, search: p.supportsSearch, browserKey: p.name === 'google' ? (env().MAPS_BROWSER_KEY ?? null) : null });
  });

  r.get('/autocomplete', limits.maps, validate({ query: z.strictObject({ q: z.string().trim().min(3).max(120), session: token }) }), async (req, res) => {
    const { q, session } = valid<{ q: string; session: string }>(req, 'query');
    const p = mapsProvider();
    res.json({ available: p.supportsSearch, suggestions: p.supportsSearch ? await p.autocomplete(q, session) : [] });
  });

  r.get('/place/:placeId', limits.maps, validate({ params: z.strictObject({ placeId: z.string().regex(/^[A-Za-z0-9_-]{10,300}$/) }), query: z.strictObject({ session: token.optional() }) }), async (req, res) => {
    const { placeId } = valid<{ placeId: string }>(req, 'params');
    res.json({ place: await mapsProvider().place(placeId, valid<{ session?: string }>(req, 'query').session ?? null) });
  });

  r.get(
    '/reverse',
    limits.maps,
    validate({ query: z.strictObject({ lat: z.coerce.number().min(-90).max(90), lng: z.coerce.number().min(-180).max(180) }) }),
    async (req, res) => {
      // The coordinates are used for this lookup only and are not stored or logged.
      const q = valid<{ lat: number; lng: number }>(req, 'query');
      res.json({ address: await mapsProvider().reverse(q) });
    },
  );
  return r;
}
