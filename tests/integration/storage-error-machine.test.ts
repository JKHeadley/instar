import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { errorHandler } from '../../src/server/middleware.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createRecoverySetupRoutes } from '../../src/server/recoverySetupRoutes.js';

let dir: string;
afterEach(() => { if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/storage-error-machine.test.ts' }); });
describe('storage errors over HTTP', () => {
  it.each(['prepare', 'install', 'owner-link'])('recovery %s names storage failures without exposing private exception details', async (action) => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-recovery-http-'));
    fs.mkdirSync(path.join(dir, 'machine')); fs.mkdirSync(path.join(dir, 'machines'));
    fs.writeFileSync(path.join(dir, 'machine/identity.json'), JSON.stringify({ machineId: 'm_studio' }));
    fs.writeFileSync(path.join(dir, 'machines/registry.json'), JSON.stringify({ version: 1, machines: { m_studio: { nickname: 'Mac Studio' } } }));
    let error = new Error('ENOSPC: /private/sensitive/authority-key');
    const fail = async (): Promise<never> => { throw error; };
    const app = express(); app.locals.stateDir = dir;
    app.use(createRecoverySetupRoutes({ verifyOperator: () => true, status: () => ({}), relayOrigin: () => 'https://recovery.example', agentId: 'echo', grantRequest: fail, prepare: fail, install: fail }));
    const storage = await request(app).post(`/recovery/setup/${action}`);
    expect(storage.status).toBe(409);
    expect(storage.body.error).toBe('recovery-setup-unavailable');
    expect(storage.body.detail).toContain('Mac Studio');
    expect(JSON.stringify(storage.body)).not.toMatch(/sensitive|authority-key|ENOSPC/);

    error = new Error('private credential failure');
    const other = await request(app).post(`/recovery/setup/${action}`);
    expect(other.status).toBe(409);
    expect(other.body.error).toBe('recovery-setup-unavailable');
    expect(JSON.stringify(other.body)).not.toMatch(/private credential|Mac Studio/);

    error = new Error('recovery-authority-setup-required');
    expect((await request(app).post(`/recovery/setup/${action}`)).body.error).toBe('recovery-authority-setup-required');
  });

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
