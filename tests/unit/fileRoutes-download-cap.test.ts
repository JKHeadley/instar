/**
 * Downloads have their own cap, separate from the preview cap (CMT-1819).
 * Before: GET /api/files/download refused anything over maxFileSize (1 MB),
 * so a file too big to preview could not be downloaded either.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { createFileRoutes } from '../../src/server/fileRoutes.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function appWith(projectDir: string, fileViewer?: Record<string, unknown>): express.Express {
  const config = {
    projectDir,
    stateDir: path.join(projectDir, '.instar'),
    projectName: 'download-cap-test',
    port: 0,
    ...(fileViewer ? { dashboard: { fileViewer } } : {}),
  } as unknown as InstarConfig;
  const app = express();
  app.use(express.json());
  app.use(createFileRoutes({ config }));
  return app;
}

describe('file download cap is separate from the preview cap', () => {
  let projectDir: string;
  const big = 2 * 1_048_576 + 7; // over the 1 MB preview cap

  beforeAll(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'download-cap-'));
    fs.mkdirSync(path.join(projectDir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'docs', 'big.bin'), Buffer.alloc(big, 1));
    fs.writeFileSync(path.join(projectDir, 'docs', 'small.txt'), 'hello\n');
  });
  afterAll(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/fileRoutes-download-cap.test.ts' });
  });

  it('a file over the preview cap is refused by read but downloads in full', async () => {
    const app = appWith(projectDir);
    const read = await request(app).get('/api/files/read').query({ path: 'docs/big.bin' });
    expect(read.status).toBe(413);
    const dl = await request(app).get('/api/files/download').query({ path: 'docs/big.bin' }).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(dl.status).toBe(200);
    expect((dl.body as Buffer).length).toBe(big);
  });

  it('a file over the download cap is refused with 413 and names the download limit', async () => {
    const app = appWith(projectDir, { maxDownloadSize: 1_500_000 });
    const dl = await request(app).get('/api/files/download').query({ path: 'docs/big.bin' });
    expect(dl.status).toBe(413);
    expect(dl.body.maxSize).toBe(1_500_000);
    expect(dl.body.size).toBe(big);
  });

  it('the download cap never falls below the preview cap', async () => {
    const app = appWith(projectDir, { maxFileSize: 4 * 1_048_576, maxDownloadSize: 1000 });
    const dl = await request(app).get('/api/files/download').query({ path: 'docs/big.bin' });
    expect(dl.status).toBe(200);
  });

  it('GET /api/files/config reports the download cap (default 1 GB)', async () => {
    const res = await request(appWith(projectDir)).get('/api/files/config');
    expect(res.status).toBe(200);
    expect(res.body.maxFileSize).toBe(1_048_576);
    expect(res.body.maxDownloadSize).toBe(1_073_741_824);
  });
});
