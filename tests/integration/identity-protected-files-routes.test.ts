import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IDENTITY_AUTO_ACCEPT_PROTECTED_PATHS } from '../../src/core/IdentityStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createFileRoutes } from '../../src/server/fileRoutes.js';
import type { InstarConfig } from '../../src/core/types.js';

describe('identity authority files are unreachable through the real file HTTP pipeline', () => {
  let root: string;
  let app: express.Express;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-file-routes-'));
    const stateDir = path.join(root, '.instar');
    fs.mkdirSync(path.join(stateDir, 'machine'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'machine', 'identity.json'), '{"secret":"authority"}');
    const config = {
      projectDir: root, stateDir, projectName: 'identity-files', authToken: 'test', port: 0,
      dashboard: { fileViewer: { enabled: true, allowedPaths: ['./'], editablePaths: ['./'] } },
    } as unknown as InstarConfig;
    app = express();
    app.use(express.json());
    app.use(createFileRoutes({ config }));
  });

  afterEach(() => SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'identity-protected-files-routes:cleanup' }));

  it('denies read, download, link, and edit for the canonical local identity path', async () => {
    const p = '.instar/machine/identity.json';
    expect(IDENTITY_AUTO_ACCEPT_PROTECTED_PATHS).toContain('.instar/machine/');
    await request(app).get('/api/files/read').query({ path: p }).expect(403);
    await request(app).get('/api/files/download').query({ path: p }).expect(403);
    await request(app).get('/api/files/link').query({ path: p }).expect(403);
    await request(app).post('/api/files/save').set('X-Instar-Request', '1').send({ path: p, content: 'attacker' }).expect(403);
    expect(fs.readFileSync(path.join(root, p), 'utf8')).toContain('authority');
  });

  it('denies every file-API operation for propagation authority journals', async () => {
    for (const p of [
      '.instar/state/identity-rotation-ack-propagation.json',
      '.instar/state/identity-recovery-establishment.json',
    ]) {
      fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
      fs.writeFileSync(path.join(root, p), '{"authority":true}');
      expect(IDENTITY_AUTO_ACCEPT_PROTECTED_PATHS).toContain(p);
      await request(app).get('/api/files/read').query({ path: p }).expect(403);
      await request(app).get('/api/files/download').query({ path: p }).expect(403);
      await request(app).get('/api/files/link').query({ path: p }).expect(403);
      await request(app).post('/api/files/save').set('X-Instar-Request', '1').send({ path: p, content: 'attacker' }).expect(403);
      expect(fs.readFileSync(path.join(root, p), 'utf8')).toBe('{"authority":true}');
    }
  });
});
