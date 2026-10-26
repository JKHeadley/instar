/**
 * Console follow-up reads (docs/specs/console-features/people-settings.md):
 *   - GET /preferences: the pure list builder (scrubbed, origin-stamped, newest first, no
 *     violationPattern) and the union → rows mapping; the page model on both sides
 *     (structured entries vs the session-context fallback on a 404, "new this week" vs
 *     "seen again this week", the machine named only when there is more than one).
 *   - GET /api/files/search: searchByName over a real temp tree — key material, a blocked
 *     secret name, a symlink to a key file and a folder outside the allowed paths never
 *     appear; a symlink loop is visited once; the result and scan caps say `truncated`.
 *     The page model: results vs an older server (404 → fallback) vs the viewer being off.
 *   - Image preview: the plan (raster types only, ≤ 5 MB and the server limit), the
 *     first-bytes sniff (a renamed non-image is never shown), and the console-only CSP.
 *   - In a DOM: the Files page searching the whole project and previewing an image through
 *     an object URL, and the Learned page reading /preferences.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPreferenceList, unionToPreferenceRows, MAX_LIST_ENTRIES } from '../../src/core/PreferencesListView.js';
import type { PreferenceEntry } from '../../src/core/PreferencesManager.js';
import { searchByName } from '../../src/server/fileRoutes.js';
import { dashboardCsp } from '../../src/server/middleware.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  buildSearch, searchUrl, previewPlan, sniffImage, previewResult, IMAGE_PREVIEW_MAX,
} from '../../dashboard/console/files-model.js';
import {
  buildPreferenceEntries, isMissingRoute, recencyWords, learnedFacts, buildPreferences,
} from '../../dashboard/console/learned-model.js';

const pref = (over: Partial<PreferenceEntry> = {}): PreferenceEntry => ({
  learning: 'Lead with the short answer',
  provenance: 'correction-loop',
  dedupeKey: 'user-preference:abc',
  recordedAt: '2026-10-20T10:00:00.000Z',
  confidence: 0.8,
  dedupeCount: 2,
  ...over,
});

describe('GET /preferences list builder', () => {
  it('serves only the spec fields: no violationPattern, no provenance, no bookkeeping', () => {
    const { entries } = buildPreferenceList([{ entry: pref({ violationPattern: 'regex:secret-rule', lastMutatedSeq: 9 }), origin: 'm_self' }]);
    expect(entries).toEqual([{ dedupeKey: 'user-preference:abc', learning: 'Lead with the short answer', recordedAt: '2026-10-20T10:00:00.000Z', confidence: 0.8, dedupeCount: 2, origin: 'm_self' }]);
    expect(JSON.stringify(entries)).not.toContain('secret-rule');
  });
  it('scrubs a credential in the learning text (own entries too) and marks it; clean text is untouched', () => {
    const key = 'AKIAABCDEFGHIJKLMNOP'; // an AWS-shaped access key the shared scrubber recognises
    const { entries } = buildPreferenceList([{ entry: pref({ learning: `Use ${key} for the bench` }) }, { entry: pref({ dedupeKey: 'k2', learning: 'Plainer wording' }) }]);
    const dirty = entries.find((e) => e.dedupeKey === 'user-preference:abc')!;
    expect(dirty.learning).not.toContain(key);
    expect(dirty.textRedacted).toBe(true);
    const clean = entries.find((e) => e.dedupeKey === 'k2')!;
    expect(clean.learning).toBe('Plainer wording');
    expect(clean.textRedacted).toBeUndefined();
    expect(clean.origin).toBeUndefined(); // unknown origin is omitted, not invented
  });
  it('newest first; malformed rows dropped; numbers clamped; capped with truncated', () => {
    const { entries } = buildPreferenceList([
      { entry: pref({ dedupeKey: 'old', recordedAt: '2026-01-01T00:00:00Z' }) },
      { entry: pref({ dedupeKey: 'new', recordedAt: '2026-10-25T00:00:00Z', dedupeCount: 0, confidence: Number.NaN }) },
      { entry: pref({ dedupeKey: 'blank', learning: '   ' }) },
    ]);
    expect(entries.map((e) => e.dedupeKey)).toEqual(['new', 'old']);
    expect(entries[0]).toMatchObject({ dedupeCount: 1, confidence: 0.5 });
    const many = Array.from({ length: MAX_LIST_ENTRIES + 3 }, (_, i) => ({ entry: pref({ dedupeKey: `k${i}` }) }));
    const big = buildPreferenceList(many);
    expect(big.entries).toHaveLength(MAX_LIST_ENTRIES);
    expect(big).toMatchObject({ total: MAX_LIST_ENTRIES + 3, truncated: true });
    expect(buildPreferenceList([{ entry: pref() }])).toMatchObject({ total: 1, truncated: false });
  });
  it('union rows keep each variant’s machine; a conflict yields both, a tombstone nothing', () => {
    const rec = (origin: string, learning: string, op: 'put' | 'delete' = 'put') => ({
      origin,
      envelope: { recordKey: 'k', hlc: { physical: 1, logical: 0, node: origin }, op, origin },
      data: { learning, confidence: 0.7, dedupeCount: 1, recordedAt: '2026-10-21T00:00:00Z' },
    });
    const union = new Map<string, any>([
      ['k', { recordKey: 'k', value: null, conflict: { conflictId: 'c', versions: [rec('m_a', 'A'), rec('m_b', 'B'), rec('m_c', 'x', 'delete')] }, divergenceFlag: true }],
      ['j', { recordKey: 'j', value: rec('m_a', 'J'), conflict: null, divergenceFlag: false }],
      ['t', { recordKey: 't', value: rec('m_b', 'gone', 'delete'), conflict: null, divergenceFlag: false }],
    ]);
    const rows = unionToPreferenceRows(union);
    expect(rows.map((r) => [r.entry.learning, r.origin])).toEqual([['A', 'm_a'], ['B', 'm_b'], ['J', 'm_a']]);
  });
});

describe('the Learned page model for /preferences', () => {
  const now = Date.parse('2026-10-26T12:00:00Z');
  const okRes = (entries: unknown[], extra: Record<string, unknown> = {}) => ({ ok: true, data: { entries, total: entries.length, truncated: false, scope: 'local', ...extra } });
  it('an older server (404) is a missing route; 503 and other failures are not', () => {
    expect(isMissingRoute({ ok: false, reason: 'the server answered 404' })).toBe(true);
    expect(isMissingRoute({ ok: false, reason: 'switched off on this agent' })).toBe(false);
    expect(isMissingRoute({ ok: false, reason: 'the server answered 500' })).toBe(false);
    expect(isMissingRoute({ ok: true, data: {} })).toBe(false);
  });
  it('new this week vs seen again this week vs older', () => {
    expect(recencyWords('2026-10-24T00:00:00Z', 1, now)).toBe('new this week');
    expect(recencyWords('2026-10-24T00:00:00Z', 3, now)).toBe('seen again this week');
    expect(recencyWords('2026-10-01T00:00:00Z', 1, now)).toBeNull();
    expect(recencyWords('garbage', 1, now)).toBeNull();
  });
  it('rows say when, how often, how sure; the machine only when there are two', () => {
    const entries = [
      { dedupeKey: 'a', learning: 'No approvals at night', recordedAt: '2026-10-25T00:00:00Z', confidence: 0.9, dedupeCount: 1, origin: 'm_mini' },
      { dedupeKey: 'b', learning: 'Plainer wording', recordedAt: '2026-10-03T00:00:00Z', confidence: 0.4, dedupeCount: 6, origin: 'm_studio' },
    ];
    const solo = buildPreferenceEntries(okRes(entries), { now, machines: { m_studio: 'Studio' } });
    expect(solo).toMatchObject({ ok: true, structured: true, total: 2, newThisWeek: 1, showMachine: false });
    expect(solo.rows[0].sub).not.toContain('Mini');
    expect(solo.rows[0].sub).toMatch(/^new this week · .+ · seen once · sure$/);
    const pool = buildPreferenceEntries(okRes(entries), { now, machines: { m_studio: 'Studio', m_mini: 'Mini' } });
    expect(pool.rows[0].sub.endsWith(' · Mini')).toBe(true);
    expect(pool.rows[1].sub).toMatch(/seen 6 times · not yet sure · Studio$/);
    expect(learnedFacts({ prefs: pool, corrections: null, conflicts: null })[1]).toEqual({ n: 1, label: 'new this week' });
  });
  it('a failure falls through to the shared failure words; a malformed answer is can’t tell', () => {
    expect(buildPreferenceEntries({ ok: false, reason: 'switched off on this agent' })).toMatchObject({ ok: false, off: true });
    expect(buildPreferenceEntries({ ok: true, data: { nope: 1 } })).toMatchObject({ ok: false, reason: expect.stringMatching(/no preference list/) });
    const lastGood = { prefs: buildPreferenceEntries(okRes([{ dedupeKey: 'a', learning: 'x', recordedAt: '2026-10-25T00:00:00Z', confidence: 1, dedupeCount: 1 }]), { now }), at: now - 60_000 };
    expect(buildPreferenceEntries({ ok: false, reason: 'no answer' }, { lastGood, now })).toMatchObject({ ok: true, stale: true });
    // the fallback builder is unchanged
    expect(buildPreferences({ ok: true, data: { present: false, block: '' } })).toMatchObject({ ok: true, total: 0 });
  });
});

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
  afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/console-followup-reads.test.ts:afterEach' }); });

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
    expect(previewPlan(img(1000, null))).toEqual({ preview: false, why: null });
    expect(previewPlan({ kind: 'code' })).toEqual({ preview: false, why: null });
  });
  it('the first bytes decide the type; a renamed non-image is never shown', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    expect(sniffImage(png)).toBe('image/png');
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImage(new TextEncoder().encode('GIF89a...'))).toBe('image/gif');
    expect(sniffImage(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffImage(new TextEncoder().encode('<svg onload=alert(1)>'))).toBeNull();
    expect(previewResult(200, png)).toEqual({ ok: true, mime: 'image/png' });
    expect(previewResult(200, new TextEncoder().encode('<html>'))).toMatchObject({ ok: false, text: expect.stringMatching(/not one/) });
    expect(previewResult(403, null)).toMatchObject({ ok: false });
    expect(previewResult(200, new Uint8Array(IMAGE_PREVIEW_MAX + 1))).toMatchObject({ ok: false, text: expect.stringMatching(/not previewed/) });
  });
  it('the CSP allows blob: images on the console only; the legacy dashboard keeps the exact old policy', () => {
    const legacy = "default-src 'self'; script-src 'self' 'unsafe-inline' cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' cdn.jsdelivr.net; connect-src 'self'";
    expect(dashboardCsp('/dashboard')).toBe(legacy);
    expect(dashboardCsp('/dashboard/index.html')).toBe(legacy);
    expect(dashboardCsp('/dashboard/consoles/x')).toBe(legacy);
    expect(dashboardCsp('/dashboard/console/')).toBe(`${legacy}; img-src 'self' blob:`);
    expect(dashboardCsp('/dashboard/console')).toBe(`${legacy}; img-src 'self' blob:`);
    expect(dashboardCsp('/dashboard/console/')).not.toMatch(/data:|\*/);
  });
});

describe('the follow-up reads in a DOM', () => {
  let dom: JSDOM;
  afterEach(() => { dom?.window.close(); });
  const tick = async (n = 25) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 20)); };
  const boot = (hash: string, route: (url: string) => { status: number; body?: unknown; bytes?: Uint8Array }) => {
    dom = new JSDOM('<!doctype html><html><body></body></html>', { url: `http://localhost:4040/dashboard/console/${hash}` });
    const g = globalThis as Record<string, unknown>;
    Object.assign(g, { window: dom.window, document: dom.window.document, location: dom.window.location, history: dom.window.history, localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage, requestAnimationFrame: (f: () => void) => setTimeout(f, 0) });
    dom.window.localStorage.setItem('instar_token', 't');
    const calls: string[] = [];
    g.fetch = async (url: string) => {
      calls.push(url);
      const r = route(url);
      return { ok: r.status < 400, status: r.status, json: async () => JSON.parse(JSON.stringify(r.body ?? {})), arrayBuffer: async () => (r.bytes ?? new Uint8Array()).buffer, blob: async () => new Blob([]) };
    };
    return calls;
  };

  it('Files: finds a file in an unopened folder through the server, and previews an image through an object URL', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const created: Blob[] = [];
    (URL as unknown as Record<string, unknown>).createObjectURL = (b: Blob) => { created.push(b); return 'blob:http://localhost:4040/fake'; };
    (URL as unknown as Record<string, unknown>).revokeObjectURL = () => {};
    const calls = boot('#/settings/files', (url) => {
      const u = new URL(url, 'http://localhost:4040');
      const p = u.searchParams.get('path') || '';
      if (url === '/sessions') return { status: 200, body: { sessions: [] } };
      if (url === '/pool') return { status: 200, body: { machines: [] } };
      if (url === '/api/files/config') return { status: 200, body: { enabled: true, allowedPaths: ['./'], editablePaths: ['./'], maxFileSize: 1_048_576, maxEditableFileSize: 204_800 } };
      if (u.pathname === '/api/files/list') return { status: 200, body: { path: p, entries: p === '' ? [{ name: 'docs', type: 'directory' }] : [] } };
      if (u.pathname === '/api/files/search') return { status: 200, body: { query: u.searchParams.get('q'), results: [{ path: 'docs/deep/logo.png', name: 'logo.png', type: 'file', size: 11 }], truncated: false } };
      if (u.pathname === '/api/files/read' && p === 'docs/deep/logo.png') return { status: 200, body: { path: p, binary: true, size: 11, modified: 'm1' } };
      if (u.pathname === '/api/files/download' && p === 'docs/deep/logo.png') return { status: 200, bytes: png };
      return { status: 404, body: { error: 'no such route in the test' } };
    });
    vi.resetModules();
    await import('../../dashboard/console/console.js');
    await tick();
    const doc = dom.window.document;
    const find = doc.querySelector('.files-find') as HTMLInputElement;
    find.value = 'logo';
    find.dispatchEvent(new dom.window.Event('input'));
    await tick(20);
    expect(calls).toContain('/api/files/search?q=logo&limit=50');
    expect(doc.querySelector('.files-results [data-search="project"]')).not.toBeNull();
    expect([...doc.querySelectorAll('.files-results .row-title')].map((n) => n.textContent)).toEqual(['logo.png']);
    (doc.querySelector('.files-results [data-path="docs/deep/logo.png"]') as HTMLButtonElement).click();
    await tick(20);
    const img = doc.querySelector('[data-image-preview] img') as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.getAttribute('src')).toBe('blob:http://localhost:4040/fake');
    expect(created[0].type).toBe('image/png');
    expect(doc.querySelector('[data-download]')).not.toBeNull();
  });

  it('Learned: reads /preferences (when, how often, which machine, new this week) without the session-context parse', async () => {
    const recent = new Date(Date.now() - 24 * 3600_000).toISOString();
    const calls = boot('#/settings/learned', (url) => {
      if (url === '/sessions') return { status: 200, body: { sessions: [] } };
      if (url === '/preferences') return { status: 200, body: { entries: [
        { dedupeKey: 'a', learning: 'No approvals to you at night', recordedAt: recent, confidence: 0.9, dedupeCount: 1, origin: 'm_mini' },
        { dedupeKey: 'b', learning: 'Plainer wording', recordedAt: '2026-01-03T00:00:00Z', confidence: 0.6, dedupeCount: 4, origin: 'm_studio' },
      ], total: 2, truncated: false, scope: 'mesh' } };
      if (url.startsWith('/corrections')) return { status: 200, body: { records: [], count: 0, totalRecords: 0, nextBefore: null } };
      if (url === '/state/conflicts') return { status: 200, body: { open: [] } };
      if (url === '/pool') return { status: 200, body: { machines: [{ machineId: 'm_mini', nickname: 'Mini' }, { machineId: 'm_studio', nickname: 'Studio' }] } };
      return { status: 404, body: { error: 'no such route in the test' } };
    });
    vi.resetModules();
    await import('../../dashboard/console/console.js');
    await tick();
    const doc = dom.window.document;
    expect(calls).toContain('/preferences');
    expect(calls).not.toContain('/preferences/session-context');
    expect(doc.querySelector('.page-title')!.textContent).toBe('I’ve picked up 2 things about how you like to work.');
    expect([...doc.querySelectorAll('.pref-quote')].map((n) => n.textContent)).toEqual(['“No approvals to you at night”', '“Plainer wording”']);
    expect(doc.querySelectorAll('[data-new]')).toHaveLength(1);
    const subs = [...doc.querySelectorAll('.pref-card .row-sub')].map((n) => n.textContent);
    expect(subs[0]).toMatch(/^new this week · .+ · seen once · sure · Mini$/);
    expect(subs[1]).toMatch(/seen 4 times · fairly sure · Studio$/);
    (doc.querySelector('.pref-card') as HTMLButtonElement).click();
    expect(doc.querySelector('.sheet .story')!.textContent).toContain('Which machine');
    expect(doc.querySelector('.sheet .story')!.textContent).toContain('Mini');
    const { _resetLearnedState } = await import('../../dashboard/console/learned.js');
    _resetLearnedState();
  });
});
