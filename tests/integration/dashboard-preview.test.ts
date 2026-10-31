import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mountDashboardPreview, publishDashboardPreview } from '../../src/server/dashboardPreview.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'dashboard-preview integration cleanup' }); });

describe('/dashboard/preview over HTTP', () => {
  it('says plainly when nothing is published, then serves the published pages uncached', async () => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-http-')); dirs.push(state);
    const app = express();
    mountDashboardPreview(app, state);
    const none = await request(app).get('/dashboard/preview/');
    expect(none.status).toBe(404);
    expect(none.text).toBe('No dashboard preview has been published on this machine.');

    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-src-')); dirs.push(src);
    fs.writeFileSync(path.join(src, 'index.html'), '<title>Instar console</title>');
    fs.writeFileSync(path.join(src, 'console.js'), 'export {};');
    publishDashboardPreview(state, src, { branch: 'b', commit: 'c', uncommitted: true, publishedAt: '2026-10-31T19:00:00.000Z' });

    const redirect = await request(app).get('/dashboard/preview?x=1');
    expect(redirect.status).toBe(302);
    expect(redirect.headers.location).toBe('/dashboard/preview/?x=1');
    const page = await request(app).get('/dashboard/preview/');
    expect(page.status).toBe(200);
    expect(page.text).toContain('Instar console');
    expect(page.headers['cache-control']).toBe('no-store');
    expect((await request(app).get('/dashboard/preview/console.js')).status).toBe(200);
    expect((await request(app).get('/dashboard/preview/preview.json')).body).toMatchObject({ branch: 'b', uncommitted: true });
    expect((await request(app).get('/dashboard/preview/missing.js')).status).toBe(404);
    expect((await request(app).get('/dashboard/preview/../../etc/passwd')).status).toBe(404);
  });
});
