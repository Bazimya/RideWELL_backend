import type { AuthContext } from '../middleware/auth.js';

declare global {
  namespace Express {
    interface Request {
      /** Parsed, validated request parts. Set by the validate() middleware. */
      valid?: { body?: unknown; query?: unknown; params?: unknown };
      /** Set by authenticate(). */
      auth?: AuthContext;
    }
  }
}

export {};
