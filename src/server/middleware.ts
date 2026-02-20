/**
 * Express middleware — JSON parsing, CORS, auth, error handling.
 */

import type { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'node:crypto';

export function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
}

/**
 * Auth middleware — enforces Bearer token on API endpoints.
 * Health endpoint is exempt (used for external monitoring).
 */
export function authMiddleware(authToken?: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Skip auth if no token configured
    if (!authToken) {
      next();
      return;
    }

    // Health endpoint is always public
    if (req.path === '/health') {
      next();
      return;
    }

    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid Authorization header' });
      return;
    }

    const token = header.slice(7);
    // Timing-safe comparison to prevent timing attacks
    const a = Buffer.from(token);
    const b = Buffer.from(authToken);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      res.status(403).json({ error: 'Invalid auth token' });
      return;
    }

    next();
  };
}

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  console.error(`[server] Error: ${err.message}`);
  res.status(500).json({
    error: err.message,
    timestamp: new Date().toISOString(),
  });
}
