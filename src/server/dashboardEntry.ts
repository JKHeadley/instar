/**
 * The dashboard's front door and the pairing code page
 * (docs/specs/dashboard-console-default-and-pair-page.md §3.1, §3.2, §3.5).
 *
 * Shared by AgentServer and the integration tests, so the tested routes are the shipped routes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Application, Request, Response } from 'express';
import { dashboardCacheControl } from './middleware.js';

import { CONSOLE_PATH, LEGACY_PATH, PAIR_PAGE_PATH } from './dashboardPaths.js';
export { CONSOLE_PATH, LEGACY_PATH, PAIR_PAGE_PATH, codePageUrlForDevice, codePageUrlForOrigin } from './dashboardPaths.js';

/**
 * The pairing page's policy: only its own files run, nothing inline, nothing third-party, no
 * framing, no form posts. Set by the page's own handlers (never by path matching in middleware),
 * replacing the loose dashboard policy the middleware already wrote.
 */
export const PAIR_PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** The page's files, by the path they are served at. Nothing else in the folder is served. */
const PAIR_FILES: Record<string, { file: string; type: string }> = {
  [PAIR_PAGE_PATH]: { file: 'pair.html', type: 'html' },
  '/dashboard/pair.js': { file: 'pair.js', type: 'application/javascript' },
  '/dashboard/pair-model.js': { file: 'pair-model.js', type: 'application/javascript' },
  '/dashboard/pair.css': { file: 'pair.css', type: 'text/css' },
  // A recommended service's confirm page: the same strict policy, because a PIN is typed here.
  '/dashboard/service-yes': { file: 'service-yes.html', type: 'html' },
  '/dashboard/service-yes.js': { file: 'service-yes.js', type: 'application/javascript' },
};

/**
 * Where a request for `/dashboard` goes. Any query string → the legacy page with the same query
 * (every existing `?tab=` deep link keeps opening the tab it names); none → the console.
 */
export function dashboardEntryTarget(originalUrl: string): string {
  const q = originalUrl.indexOf('?');
  if (q < 0 || q === originalUrl.length - 1) return CONSOLE_PATH;
  return LEGACY_PATH + originalUrl.slice(q);
}

/**
 * `/dashboard` → console (302, never 301 so a revert takes effect), `/dashboard/legacy` → the
 * legacy page. Register before the static `/dashboard` mount.
 */
export function mountDashboardEntryRoutes(app: Application, opts: { dashboardDir: string }): void {
  app.get('/dashboard', (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, dashboardEntryTarget(req.originalUrl));
  });
  app.get(LEGACY_PATH, (req: Request, res: Response) => {
    // One address for the legacy page: a trailing slash would move relative URLs under
    // /dashboard/legacy/, so it redirects to the bare form (query kept).
    if (req.path.endsWith('/')) {
      const q = req.originalUrl.indexOf('?');
      res.setHeader('Cache-Control', 'no-store');
      res.redirect(302, LEGACY_PATH + (q >= 0 ? req.originalUrl.slice(q) : ''));
      return;
    }
    dashboardCacheControl(res);
    // cacheControl:false so send() does not re-stamp `public, max-age=0` over the no-cache header;
    // etag/lastModified stay on for cheap 304 revalidation.
    res.sendFile(path.join(opts.dashboardDir, 'index.html'), { cacheControl: false, etag: true, lastModified: true });
  });
}

/**
 * The pairing code page. Its files live in `dashboard-pair/`, outside the static `/dashboard`
 * mount, so only these handlers can serve them and every response carries the strict policy.
 * Express matches these paths case-insensitively and with or without one trailing slash; any
 * other spelling reaches the static mount, which has no such file (404).
 */
export function mountPairPage(app: Application, opts: { pairDir: string }): void {
  for (const [route, spec] of Object.entries(PAIR_FILES)) {
    app.get(route, (_req: Request, res: Response) => {
      // All four dashboard headers, set here: the middleware matches '/dashboard' case-sensitively,
      // while this route also answers '/Dashboard/PAIR'.
      res.setHeader('Content-Security-Policy', PAIR_PAGE_CSP);
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Cache-Control', 'no-store');
      res.type(spec.type);
      res.sendFile(path.join(opts.pairDir, spec.file), { cacheControl: false, etag: false, lastModified: false });
    });
  }
}

/** `dashboard-pair/` beside `dashboard/`: package root when installed, repository root in source. */
export function resolvePairDir(): string {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const fromDist = path.resolve(thisDir, '..', '..', 'dashboard-pair');
  const fromSrc = path.resolve(thisDir, '..', '..', '..', 'dashboard-pair');
  if (fs.existsSync(fromDist)) return fromDist;
  if (fs.existsSync(fromSrc)) return fromSrc;
  return fromDist;
}
