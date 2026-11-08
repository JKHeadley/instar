import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { errorHandler } from '../../src/server/middleware.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let dir: string;
afterEach(() => { if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/storage-error-machine.test.ts' }); });
describe('storage errors over HTTP', () => {
  it('names the failing machine without exposing internal paths, preserving other errors', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-http-'));
    fs.mkdirSync(path.join(dir, 'machine')); fs.mkdirSync(path.join(dir, 'machines'));
    fs.writeFileSync(path.join(dir, 'machine/identity.json'), JSON.stringify({ machineId: 'm_studio' }));
    fs.writeFileSync(path.join(dir, 'machines/registry.json'), JSON.stringify({ version: 1, machines: { m_studio: { nickname: 'Mac Studio' } } }));
    const app = express(); app.locals.stateDir = dir;
    app.get('/full', () => { throw new Error('ENOSPC: /private/sensitive/file'); });
    app.get('/readonly', () => { throw new Error('EROFS: /private/sensitive/file'); });
    app.get('/other', () => { throw new Error('private failure'); });
    app.use(errorHandler);
    for (const route of ['/full', '/readonly']) {
      const res = await request(app).get(route);
      expect(res.status).toBe(500); expect(res.body.error).toMatch(/Storage error on Mac Studio/);
      expect(JSON.stringify(res.body)).not.toMatch(/sensitive|ENOSPC|EROFS/);
    }
    expect((await request(app).get('/other')).body.error).toBe('Internal server error');
  });
});
