/**
 * Files page: whole-project name search and image preview.
 *   - searchByName over a real temp tree: key material, a blocked secret name, a symlink to
 *     a key file and folders outside the allowed paths never appear; a symlink loop is
 *     visited once; the result, scan and depth caps say `truncated`.
 *   - sniffImageType: PNG/JPEG/GIF/WebP by their first bytes; SVG and renamed files are null.
 *   - The page model: search results vs an older server (404 → fallback) vs the viewer off;
 *     the preview plan (raster types only, within 5 MB and the server limit) and the answer.
 *   - Awareness: the template carries the line; migrateClaudeMd adds it once.
 *   - In a DOM: the Files page searches the whole project and previews an image through an
 *     object URL fed by GET /api/files/image.
 */
// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { searchByName, sniffImageType } from '../../src/server/fileRoutes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  buildSearch, searchUrl, imageUrl, previewPlan, previewResult, IMAGE_PREVIEW_MAX,
} from '../../dashboard/console/files-model.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
const FILES_SEARCH_MARKER = '/api/files/search?q=';
import { generateClaudeMd } from '../../src/scaffold/templates.js';

describe('searchByName (real files)', () => {
  let dir: string;
  const cfg = (over: Record<string, unknown> = {}) => ({
    enabled: true, allowedPaths: ['./'], editablePaths: ['./'], maxFileSize: 1_048_576, maxEditableFileSize: 204_800,
    blockedFilenames: ['.env', '.env.*', '*.key', '*.pem', 'secrets.*', 'credentials.*', 'token.json'],
    ...over,
  });
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'files-search-'));
    fs.mkdirSync(path.join(dir, 'docs/deep'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'private'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'MEMORY.md'), 'top');
    fs.writeFileSync(path.join(dir, 'docs/memory-notes.md'), 'n');
    fs.writeFileSync(path.join(dir, 'docs/deep/MEMORY.md'), 'd');
    fs.writeFileSync(path.join(dir, '.instar/identity.json'), '{"k":1}');
    fs.writeFileSync(path.join(dir, '.instar/config.json'), '{}');
    fs.writeFileSync(path.join(dir, 'docs/memory.key'), 'secret');
    fs.writeFileSync(path.join(dir, 'private/memory-private.md'), 'p');
    fs.symlinkSync(path.join(dir, '.instar/identity.json'), path.join(dir, 'docs/memory-link.json'));
    fs.symlinkSync(path.join(dir, 'docs'), path.join(dir, 'docs/deep/loop')); // a folder loop
  });
  afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/console-file-search-preview.test.ts:afterEach' }); });

  it('finds names across the project, files first and shallow first; never key material, a secret name, or a link to a key', async () => {
    const out = await searchByName('memory', 50, dir, cfg() as any);
    const paths = out.results.map((r) => r.path);
    expect(paths).toEqual(['MEMORY.md', 'docs/memory-notes.md', 'private/memory-private.md', 'docs/deep/MEMORY.md']);
    expect(paths).not.toContain('docs/memory.key');
    expect(paths).not.toContain('docs/memory-link.json');
    expect((await searchByName('identity', 50, dir, cfg() as any)).results).toEqual([]);
    expect((await searchByName('config', 50, dir, cfg() as any)).results).toEqual([]);
    expect(out.truncated).toBe(false);
    expect(out.results[0]).toMatchObject({ name: 'MEMORY.md', type: 'file', size: 3 });
  });
  it('stays inside the allowed folders', async () => {
    const out = await searchByName('memory', 50, dir, cfg({ allowedPaths: ['docs/'] }) as any);
    expect(out.results.map((r) => r.path).sort()).toEqual(['docs/deep/MEMORY.md', 'docs/memory-notes.md']);
  });
  it('the result cap and the scan cap say truncated', async () => {
    const capped = await searchByName('memory', 1, dir, cfg() as any);
    expect(capped.results).toHaveLength(1);
    expect(capped.truncated).toBe(true);
    const scanCapped = await searchByName('memory', 50, dir, cfg() as any, { maxScanned: 2 });
    expect(scanCapped.truncated).toBe(true);
    expect(scanCapped.scanned).toBe(2);
    const shallow = await searchByName('memory', 50, dir, cfg() as any, { maxDepth: 0 });
    expect(shallow.results.map((r) => r.path)).toEqual(['MEMORY.md']);
    expect(shallow.truncated).toBe(true);
  });
});

describe('sniffImageType', () => {
  it('reads the real type from the first bytes; SVG and renamed files are refused', () => {
    expect(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))).toBe('image/png');
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImageType(new TextEncoder().encode('GIF89a...'))).toBe('image/gif');
    expect(sniffImageType(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffImageType(new TextEncoder().encode('<svg onload=alert(1)>'))).toBeNull();
    expect(sniffImageType(new TextEncoder().encode('<?xml version="1.0"?><svg/>'))).toBeNull();
    expect(sniffImageType(new Uint8Array([]))).toBeNull();
  });
});

describe('the Files page model for search and image preview', () => {
  it('search results, an older server (404 → fallback), and the viewer off are three different answers', () => {
    expect(searchUrl(' MEM ')).toBe('/api/files/search?q=MEM&limit=50');
    const found = buildSearch({ status: 200, data: { results: [{ path: 'docs/a.md', name: 'a.md', type: 'file' }, { path: 'docs', name: 'docs', type: 'directory' }, { bad: 1 }], truncated: false } }, 'A');
    expect(found).toMatchObject({ ok: true, query: 'a', truncated: false, note: 'Searched every folder you allow this page to browse.' });
    expect(found.rows.map((r: { sub: string }) => r.sub)).toEqual(['docs/', 'folder · top folder']);
    expect(buildSearch({ status: 200, data: { results: [], truncated: true } }, 'x').note).toMatch(/^Showing the first 0 matches/);
    expect(buildSearch({ status: 200, data: { results: [] } }, 'x').empty).toMatch(/No file or folder/);
    expect(buildSearch({ status: 404, data: {} }, 'x')).toMatchObject({ ok: false, unsupported: true });
    expect(buildSearch({ status: 404, data: { error: 'file viewer is disabled' } }, 'x')).toMatchObject({ ok: false, unsupported: false, kind: 'off' });
    expect(buildSearch({ status: 0, data: {} }, 'x')).toMatchObject({ ok: false, unsupported: false, kind: 'unreachable' });
  });

  it('previews raster images only, within 5 MB and the server limit', () => {
    const img = (size: number, image: string | null = 'image/png') => ({ kind: 'binary', image, size });
    expect(previewPlan(img(1000))).toEqual({ preview: true, why: null });
    expect(previewPlan(img(IMAGE_PREVIEW_MAX + 1)).preview).toBe(false);
    expect(previewPlan(img(2000), { maxFileSize: 1000 })).toMatchObject({ preview: false, why: expect.stringMatching(/not previewed here/) });
    expect(previewPlan(img(0)).preview).toBe(false);
    expect(previewPlan(img(1000, 'image/svg+xml')).preview).toBe(false);
    expect(previewPlan(img(1000, null))).toEqual({ preview: false, why: null });
    expect(previewPlan({ kind: 'code' })).toEqual({ preview: false, why: null });
    expect(imageUrl('docs/a b.png')).toBe('/api/files/image?path=docs%2Fa%20b.png');
  });

  it('the preview answer: only a raster type is shown; refusals say why in words', () => {
    expect(previewResult(200, 'image/png', null)).toEqual({ ok: true, mime: 'image/png' });
    expect(previewResult(200, 'image/svg+xml', null)).toMatchObject({ ok: false });
    expect(previewResult(200, 'text/html; charset=utf-8', null)).toMatchObject({ ok: false });
    expect(previewResult(415, '', {})).toMatchObject({ ok: false, text: expect.stringMatching(/not one this page can show/) });
    expect(previewResult(413, '', { maxSize: 1_048_576 })).toMatchObject({ ok: false, text: expect.stringMatching(/too large/) });
    expect(previewResult(403, '', { error: 'Access to this file is blocked for security reasons' })).toMatchObject({ ok: false, text: expect.stringMatching(/never shown/) });
  });
});

describe('Agent awareness for file search', () => {
  it('the CLAUDE.md template carries the line', () => {
    const md = generateClaudeMd('demo', 'Demo', 4321, true);
    expect(md).toContain(FILES_SEARCH_MARKER);
    expect(md).toContain('/api/files/image?path=');
  });
  it('migrateClaudeMd gives an existing agent the line once, from the awareness entry', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'files-search-mig-'));
    try {
      const stateDir = path.join(tmp, '.instar');
      fs.mkdirSync(stateDir, { recursive: true });
      const mdPath = path.join(tmp, 'CLAUDE.md');
      fs.writeFileSync(mdPath, ['# CLAUDE.md', '**File Viewer**', '- **Generate a file link**: `curl "http://localhost:4321/api/files/link?path=x"`', '- next', ''].join('\n'));
      const migrator = new PostUpdateMigrator({ projectDir: tmp, stateDir, port: 4321, hasTelegram: false, projectName: 'demo' } as any);
      const run = () => (migrator as any).migrateClaudeMd({ upgraded: [], skipped: [], errors: [] });
      run(); run();
      const out = fs.readFileSync(mdPath, 'utf-8');
      expect(out.split(FILES_SEARCH_MARKER).length - 1).toBe(1);
      expect(out).toContain('**Finding a file by name** — ');
      expect(out).toContain('http://localhost:4321/api/files/search?q=MEMORY');
    } finally {
      SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/console-file-search-preview.test.ts' });
    }
  });
});

describe('the Files page in a DOM', () => {
  let dom: JSDOM;
  afterEach(() => { dom?.window.close(); });
  const tick = async (n = 25) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 20)); };

  it('finds a file in an unopened folder through the server, and previews an image through an object URL', async () => {
    const created: Blob[] = [];
    (URL as unknown as Record<string, unknown>).createObjectURL = (b: Blob) => { created.push(b); return 'blob:http://localhost:4040/fake'; };
    (URL as unknown as Record<string, unknown>).revokeObjectURL = () => {};
    dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:4040/dashboard/console/#/settings/files' });
    const g = globalThis as Record<string, unknown>;
    Object.assign(g, { window: dom.window, document: dom.window.document, location: dom.window.location, history: dom.window.history, localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage, requestAnimationFrame: (f: () => void) => setTimeout(f, 0) });
    dom.window.localStorage.setItem('instar_token', 't');
    const calls: string[] = [];
    g.fetch = async (url: string) => {
      calls.push(url);
      const u = new URL(url, 'http://localhost:4040');
      const p = u.searchParams.get('path') || '';
      let r: { status: number; body?: unknown; type?: string } = { status: 404, body: { error: 'no such route in the test' } };
      if (url === '/sessions') r = { status: 200, body: { sessions: [] } };
      else if (url === '/pool') r = { status: 200, body: { machines: [] } };
      else if (url === '/api/files/config') r = { status: 200, body: { enabled: true, allowedPaths: ['./'], editablePaths: ['./'], maxFileSize: 1_048_576, maxEditableFileSize: 204_800 } };
      else if (u.pathname === '/api/files/list') r = { status: 200, body: { path: p, entries: p === '' ? [{ name: 'docs', type: 'directory' }] : [] } };
      else if (u.pathname === '/api/files/search') r = { status: 200, body: { query: u.searchParams.get('q'), results: [{ path: 'docs/deep/logo.png', name: 'logo.png', type: 'file', size: 11 }], truncated: false, scanned: 3 } };
      else if (u.pathname === '/api/files/read' && p === 'docs/deep/logo.png') r = { status: 200, body: { path: p, binary: true, size: 11, modified: 'm1' } };
      else if (u.pathname === '/api/files/image' && p === 'docs/deep/logo.png') r = { status: 200, type: 'image/png' };
      return {
        ok: r.status < 400, status: r.status,
        headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? (r.type || 'application/json') : null) },
        json: async () => JSON.parse(JSON.stringify(r.body ?? {})), blob: async () => new Blob([new Uint8Array([1, 2, 3])]), text: async () => '',
      };
    };
    vi.resetModules();
    await import('../../dashboard/console/console.js');
    await tick();
    const doc = dom.window.document;
    const find = doc.querySelector('.files-find') as HTMLInputElement;
    expect(find).not.toBeNull();
    find.value = 'logo';
    find.dispatchEvent(new dom.window.Event('input'));
    await tick(20);
    expect(calls).toContain('/api/files/search?q=logo&limit=50');
    expect(doc.querySelector('.files-results [data-search="project"]')).not.toBeNull();
    expect([...doc.querySelectorAll('.files-results .row-title')].map((n) => n.textContent)).toEqual(['logo.png']);
    (doc.querySelector('.files-results [data-path="docs/deep/logo.png"]') as HTMLButtonElement).click();
    await tick(20);
    expect(calls).toContain('/api/files/image?path=docs%2Fdeep%2Flogo.png');
    expect(calls.some((c) => c.startsWith('/api/files/download'))).toBe(false);
    const img = doc.querySelector('[data-image-preview] img') as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.getAttribute('src')).toBe('blob:http://localhost:4040/fake');
    expect(created[0].type).toBe('image/png');
    expect(doc.querySelector('[data-download]')).not.toBeNull();
    expect(doc.body.textContent).not.toContain('not previewed here yet');
  });
});
