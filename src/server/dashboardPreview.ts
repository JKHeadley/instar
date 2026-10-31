/**
 * The dashboard preview: one fixed address (/dashboard/preview/) that serves the
 * console pages from a folder in the agent's state directory instead of the
 * installed package. Work in progress is published there in seconds, without a
 * merge or a release, and an Instar update never overwrites it (the folder is
 * not part of the package). Static files only: the pages talk to this same
 * server's API with the operator's own token, exactly like the console.
 *
 * No folder, no preview: the address answers a plain 404 that says so.
 */
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import type { Express, Request, Response, NextFunction } from 'express';

export const DASHBOARD_PREVIEW_MOUNT = '/dashboard/preview';

export function dashboardPreviewDir(stateDir: string): string {
  return path.join(stateDir, 'dashboard-preview');
}

export function mountDashboardPreview(app: Express, stateDir: string): void {
  const dir = dashboardPreviewDir(stateDir);
  // Relative module and style paths need the trailing slash.
  app.get(DASHBOARD_PREVIEW_MOUNT, (req: Request, res: Response, next: NextFunction) => {
    const q = req.originalUrl.indexOf('?');
    if ((q >= 0 ? req.originalUrl.slice(0, q) : req.originalUrl).endsWith('/')) { next(); return; }
    res.redirect(302, `${DASHBOARD_PREVIEW_MOUNT}/${q >= 0 ? req.originalUrl.slice(q) : ''}`);
  });
  app.use(DASHBOARD_PREVIEW_MOUNT, (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!fs.existsSync(path.join(dir, 'index.html'))) {
      res.status(404).type('text/plain').send('No dashboard preview has been published on this machine.');
      return;
    }
    next();
  }, express.static(dir, { dotfiles: 'ignore', fallthrough: false, etag: false, lastModified: false, cacheControl: false }));
}

/** What the preview banner shows: which work it is and when it was published. */
export interface DashboardPreviewMeta {
  branch: string | null;
  commit: string | null;
  /** True when the published files include uncommitted edits; null when not checked. */
  uncommitted: boolean | null;
  publishedAt: string;
}

/**
 * Publish a folder of console pages as the preview. The new copy is written
 * beside the old one and swapped in by two renames, so a reader never sees a
 * half copy (between the renames the address briefly answers 404). If the swap
 * fails, the previous copy is put back. The previous copy is removed afterwards.
 */
export function publishDashboardPreview(stateDir: string, sourceDir: string, meta: DashboardPreviewMeta): string {
  if (!fs.existsSync(path.join(sourceDir, 'index.html'))) {
    throw new Error(`publishDashboardPreview: ${sourceDir} has no index.html`);
  }
  const dir = dashboardPreviewDir(stateDir);
  const staging = `${dir}.staging-${process.pid}-${Date.now()}`;
  const previous = `${dir}.previous-${process.pid}-${Date.now()}`;
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.cpSync(sourceDir, staging, { recursive: true });
  fs.writeFileSync(path.join(staging, 'preview.json'), JSON.stringify(meta, null, 2) + '\n');
  const hadPrevious = fs.existsSync(dir);
  if (hadPrevious) fs.renameSync(dir, previous);
  try {
    fs.renameSync(staging, dir);
  } catch (err) {
    if (hadPrevious) fs.renameSync(previous, dir);
    throw err;
  }
  if (hadPrevious) {
    SafeFsExecutor.safeRmSync(previous, { recursive: true, force: true, operation: 'dashboard-preview:remove-previous-copy' });
  }
  return dir;
}
