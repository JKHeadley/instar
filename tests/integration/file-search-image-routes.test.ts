// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Integration — GET /api/files/search and GET /api/files/image through the real
 * createFileRoutes() behind the real authMiddleware, over a real temp project.
 *   search: 401 / 400 / results / key material, secret names, a link to a key and
 *           folders outside allowedPaths never appear / limit + truncated / viewer off
 *   image:  real PNG served inline with its sniffed type and nosniff + sandbox CSP;
 *           SVG and a renamed text file are 415; too large is 413; a secret name and
 *           key material are 403; a link to a key is refused; outside allowedPaths 403
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFileRoutes } from '../../src/server/fileRoutes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const AUTH = 'test-file-search-image';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

function appFor(projectDir: string, fileViewer: Record<string, unknown> = {}): express.Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware(AUTH));
  app.use(createFileRoutes({ config: { projectDir, stateDir: path.join(projectDir, '.instar'), dashboard: { fileViewer } } as any }));
  return app;
}

describe('file search and image preview routes (integration)', () => {
  let dir: string;
  let app: express.Express;
  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-search-image-'));
    fs.mkdirSync(path.join(dir, 'docs/deep'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'node_modules/pkg'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'docs/memory-notes.md'), 'n');
    fs.writeFileSync(path.join(dir, 'docs/deep/MEMORY.md'), 'd');
    fs.writeFileSync(path.join(dir, 'node_modules/pkg/memory.js'), 'x');
    fs.writeFileSync(path.join(dir, '.instar/identity.json'), '{"privateKey":"SEARCH-KEY-MARKER"}');
    fs.writeFileSync(path.join(dir, 'docs/memory.key'), 'secret');
    fs.symlinkSync(path.join(dir, '.instar/identity.json'), path.join(dir, 'docs/memory-link.json'));
    fs.writeFileSync(path.join(dir, 'docs/logo.png'), PNG);
    fs.writeFileSync(path.join(dir, 'docs/vector.svg'), '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');
    fs.writeFileSync(path.join(dir, 'docs/fake.png'), '<html><script>alert(1)</script></html>');
    fs.writeFileSync(path.join(dir, 'docs/big.png'), Buffer.concat([PNG, Buffer.alloc(2_000_000)]));
    fs.symlinkSync(path.join(dir, '.instar/identity.json'), path.join(dir, 'docs/link.png'));
    app = appFor(dir);
  });
  afterAll(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/file-search-image-routes.test.ts' }); });

  describe('GET /api/files/search', () => {
    it('401 without the bearer token; 400 without q or with an over-long q', async () => {
      expect((await request(app).get('/api/files/search').query({ q: 'memory' })).status).toBe(401);
      expect((await request(app).get('/api/files/search').set(auth())).status).toBe(400);
      expect((await request(app).get('/api/files/search').query({ q: 'x'.repeat(201) }).set(auth())).status).toBe(400);
    });

    it('finds names across the project and never returns key material, a secret name, a link to a key or node_modules contents', async () => {
      const res = await request(app).get('/api/files/search').query({ q: 'memory' }).set(auth());
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const paths = res.body.results.map((r: { path: string }) => r.path);
      expect(paths).toEqual(['docs/memory-notes.md', 'docs/deep/MEMORY.md']);
      expect(JSON.stringify(res.body)).not.toContain('SEARCH-KEY-MARKER');
      expect(res.body.truncated).toBe(false);
      const id = await request(app).get('/api/files/search').query({ q: 'identity' }).set(auth());
      expect(id.body.results).toEqual([]);
    });

    it('limit caps the results and says truncated', async () => {
      const res = await request(app).get('/api/files/search').query({ q: 'memory', limit: '1' }).set(auth());
      expect(res.body.results).toHaveLength(1);
      expect(res.body.truncated).toBe(true);
    });

    it('stays inside allowedPaths', async () => {
      fs.mkdirSync(path.join(dir, 'private'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'private/memory-private.md'), 'p');
      const narrow = appFor(dir, { allowedPaths: ['docs/'] });
      const res = await request(narrow).get('/api/files/search').query({ q: 'memory' }).set(auth());
      expect(res.body.results.map((r: { path: string }) => r.path)).not.toContain('private/memory-private.md');
      const wide = await request(app).get('/api/files/search').query({ q: 'memory-private' }).set(auth());
      expect(wide.body.results.map((r: { path: string }) => r.path)).toEqual(['private/memory-private.md']);
    });

    it('answers 404 when the file viewer is off', async () => {
      const off = appFor(dir, { enabled: false });
      const res = await request(off).get('/api/files/search').query({ q: 'memory' }).set(auth());
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/disabled/);
    });
  });

  describe('GET /api/files/image', () => {
    it('401 without the bearer token; 400 without a path', async () => {
      expect((await request(app).get('/api/files/image').query({ path: 'docs/logo.png' })).status).toBe(401);
      expect((await request(app).get('/api/files/image').set(auth())).status).toBe(400);
    });

    it('serves a real PNG inline with its sniffed type, nosniff and a sandbox CSP', async () => {
      const res = await request(app).get('/api/files/image').query({ path: 'docs/logo.png' }).set(auth()).buffer(true).parse((r, cb) => { const c: Buffer[] = []; r.on('data', (d: Buffer) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-security-policy']).toContain('sandbox');
      expect(res.headers['content-disposition']).toBe('inline');
      expect(Buffer.compare(res.body as Buffer, PNG)).toBe(0);
    });

    it('refuses SVG and a renamed non-image with 415', async () => {
      const svg = await request(app).get('/api/files/image').query({ path: 'docs/vector.svg' }).set(auth());
      expect(svg.status).toBe(415);
      expect(svg.headers['content-type']).toMatch(/json/);
      const fake = await request(app).get('/api/files/image').query({ path: 'docs/fake.png' }).set(auth());
      expect(fake.status).toBe(415);
      expect(fake.text).not.toContain('<script>');
    });

    it('refuses an image over the size cap with 413', async () => {
      const res = await request(app).get('/api/files/image').query({ path: 'docs/big.png' }).set(auth());
      expect(res.status).toBe(413);
      expect(res.body.maxSize).toBe(1_048_576);
    });

    it('refuses a secret name, key material, a link to a key, and a path outside allowedPaths', async () => {
      expect((await request(app).get('/api/files/image').query({ path: 'docs/memory.key' }).set(auth())).status).toBe(403);
      const key = await request(app).get('/api/files/image').query({ path: '.instar/identity.json' }).set(auth());
      expect(key.status).toBe(403);
      expect(key.text).not.toContain('SEARCH-KEY-MARKER');
      const link = await request(app).get('/api/files/image').query({ path: 'docs/link.png' }).set(auth());
      expect(link.status).toBe(403);
      expect(link.text).not.toContain('SEARCH-KEY-MARKER');
      const narrow = appFor(dir, { allowedPaths: ['docs/deep/'] });
      expect((await request(narrow).get('/api/files/image').query({ path: 'docs/logo.png' }).set(auth())).status).toBe(403);
      expect((await request(app).get('/api/files/image').query({ path: '../etc/passwd' }).set(auth())).status).toBe(403);
    });
  });
});
