/**
 * Dated learned preferences (GET /preferences + the console Learned page).
 *   - PreferencesListView: the pure list builder (scrubbed, origin-stamped, newest first,
 *     never violationPattern / provenance / bookkeeping, capped) and the union → rows map.
 *   - learned-model.js: the structured entries (date, "new this week" vs "seen again this
 *     week", machine named only when there is more than one and never as a raw id) and the
 *     fallback to the session-context block when an older server answers 404.
 *   - Awareness: the CLAUDE.md template carries the line, and migrateClaudeMd adds it to an
 *     existing agent exactly once, as a bullet under the session-context bullet.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPreferenceList, unionToPreferenceRows, MAX_LIST_ENTRIES } from '../../src/core/PreferencesListView.js';
import type { PreferenceEntry } from '../../src/core/PreferencesManager.js';
import {
  buildPreferenceEntries, isMissingRoute, recencyWords, dateWords, learnedFacts, WEEK_MS,
} from '../../dashboard/console/learned-model.js';
import { PostUpdateMigrator, PREFERENCES_LIST_CLAUDEMD_LINE, PREFERENCES_LIST_MARKER } from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const pref = (over: Partial<PreferenceEntry> & Record<string, unknown> = {}): PreferenceEntry => ({
  learning: 'Lead with the short answer',
  provenance: 'correction-loop',
  dedupeKey: 'user-preference:abc',
  recordedAt: '2026-10-20T10:00:00.000Z',
  confidence: 0.8,
  dedupeCount: 2,
  ...over,
} as PreferenceEntry);

describe('PreferencesListView.buildPreferenceList', () => {
  it('serves only the listed fields: no violationPattern, provenance or bookkeeping', () => {
    const { entries } = buildPreferenceList([{ entry: pref({ violationPattern: 'regex:secret-rule', lastMutatedSeq: 9 }), origin: 'm_self' }]);
    expect(entries).toEqual([{ dedupeKey: 'user-preference:abc', learning: 'Lead with the short answer', recordedAt: '2026-10-20T10:00:00.000Z', confidence: 0.8, dedupeCount: 2, origin: 'm_self' }]);
    expect(JSON.stringify(entries)).not.toContain('secret-rule');
    expect(JSON.stringify(entries)).not.toContain('correction-loop');
  });

  it('scrubs a credential in the learning text and marks it; clean text and unknown origin untouched', () => {
    const key = 'AKIAABCDEFGHIJKLMNOP';
    const { entries } = buildPreferenceList([{ entry: pref({ learning: `Use ${key} for the bench` }) }, { entry: pref({ dedupeKey: 'k2', learning: 'Plainer wording' }) }]);
    const dirty = entries.find((e) => e.dedupeKey === 'user-preference:abc')!;
    expect(dirty.learning).not.toContain(key);
    expect(dirty.textRedacted).toBe(true);
    const clean = entries.find((e) => e.dedupeKey === 'k2')!;
    expect(clean.learning).toBe('Plainer wording');
    expect(clean.textRedacted).toBeUndefined();
    expect(clean.origin).toBeUndefined();
  });

  it('keeps an upstream redaction mark', () => {
    const { entries } = buildPreferenceList([{ entry: pref(), redacted: true }]);
    expect(entries[0].textRedacted).toBe(true);
  });

  it('newest first; malformed rows dropped; numbers clamped; capped with truncated', () => {
    const { entries } = buildPreferenceList([
      { entry: pref({ dedupeKey: 'old', recordedAt: '2026-01-01T00:00:00Z' }) },
      { entry: pref({ dedupeKey: 'new', recordedAt: '2026-10-25T00:00:00Z', dedupeCount: 0, confidence: Number.NaN }) },
      { entry: pref({ dedupeKey: 'blank', learning: '   ' }) },
      { entry: null as unknown as PreferenceEntry },
    ]);
    expect(entries.map((e) => e.dedupeKey)).toEqual(['new', 'old']);
    expect(entries[0]).toMatchObject({ dedupeCount: 1, confidence: 0.5 });
    const many = Array.from({ length: MAX_LIST_ENTRIES + 3 }, (_, i) => ({ entry: pref({ dedupeKey: `k${i}` }) }));
    const big = buildPreferenceList(many);
    expect(big.entries).toHaveLength(MAX_LIST_ENTRIES);
    expect(big).toMatchObject({ total: MAX_LIST_ENTRIES + 3, truncated: true });
    expect(buildPreferenceList([{ entry: pref() }])).toMatchObject({ total: 1, truncated: false });
  });

  it('union rows keep each variant machine; a conflict yields both, a tombstone nothing', () => {
    const rec = (origin: string, learning: string, op: 'put' | 'delete' = 'put') => ({
      origin,
      envelope: { recordKey: 'k', hlc: { physical: 1, logical: 0, node: origin }, op, origin },
      data: { learning, confidence: 0.7, dedupeCount: 1, recordedAt: '2026-10-21T00:00:00Z', dedupeKey: 'k' },
    });
    const union = new Map<string, any>([
      ['a', { recordKey: 'a', value: rec('m_a', 'From A'), conflict: null, divergenceFlag: false }],
      ['b', { recordKey: 'b', value: null, conflict: { conflictId: 'c', recordKey: 'b', versions: [rec('m_b', 'From B'), rec('m_c', 'From C')] }, divergenceFlag: true }],
      ['d', { recordKey: 'd', value: rec('m_d', 'gone', 'delete'), conflict: null, divergenceFlag: false }],
    ]);
    const rows = unionToPreferenceRows(union);
    expect(rows.map((r) => r.origin).sort()).toEqual(['m_a', 'm_b', 'm_c']);
  });
});

describe('learned-model: dated entries', () => {
  const now = Date.parse('2026-10-26T12:00:00Z');
  const res = (entries: unknown[], extra: Record<string, unknown> = {}) => ({ ok: true, data: { entries, total: entries.length, truncated: false, scope: 'local', ...extra } });

  it('recency: new this week, seen again this week, older, bad date', () => {
    expect(recencyWords('2026-10-24T00:00:00Z', 1, now)).toBe('new this week');
    expect(recencyWords('2026-10-24T00:00:00Z', 3, now)).toBe('seen again this week');
    expect(recencyWords(new Date(now - WEEK_MS - 1000).toISOString(), 1, now)).toBeNull();
    expect(recencyWords('not a date', 1, now)).toBeNull();
    expect(recencyWords(new Date(0).toISOString(), 1, now)).toBeNull();
  });

  it('dates read as month and day this year, with the year otherwise', () => {
    expect(dateWords('2026-10-20T12:00:00Z', now)).toBe('Oct 20');
    expect(dateWords('2025-03-02T12:00:00Z', now)).toBe('Mar 2, 2025');
    expect(dateWords('', now)).toBeNull();
  });

  it('builds rows with the date, how often, how sure; marks this week; counts new ones', () => {
    const m = buildPreferenceEntries(res([
      { dedupeKey: 'a', learning: 'Plainer words', recordedAt: '2026-10-25T12:00:00Z', confidence: 0.9, dedupeCount: 1, origin: 'm1' },
      { dedupeKey: 'b', learning: 'Answer first', recordedAt: '2026-09-01T12:00:00Z', confidence: 0.4, dedupeCount: 4, origin: 'm1' },
    ]), { now, machines: { m1: 'Mac Studio' } });
    expect(m.ok).toBe(true);
    expect(m.structured).toBe(true);
    expect(m.total).toBe(2);
    expect(m.newThisWeek).toBe(1);
    expect(m.rows[0]).toMatchObject({ text: 'Plainer words', fresh: 'new this week', when: 'Oct 25', machine: 'Mac Studio' });
    expect(m.rows[0].sub).toBe('last seen Oct 25 · seen once · sure');
    expect(m.rows[1].sub).toBe('last seen Sep 1 · seen 4 times · not yet sure');
    expect(learnedFacts({ prefs: m, corrections: null, conflicts: null })).toContainEqual({ n: 1, label: 'new this week' });
  });

  it('names the machine only when there is more than one, and never shows a raw machine id', () => {
    const entries = [
      { dedupeKey: 'a', learning: 'X', recordedAt: '2026-10-25T00:00:00Z', confidence: 0.9, dedupeCount: 1, origin: 'm2' },
      { dedupeKey: 'b', learning: 'Y', recordedAt: '2026-10-25T00:00:00Z', confidence: 0.9, dedupeCount: 1, origin: 'm_unknown_123' },
    ];
    const many = buildPreferenceEntries(res(entries, { scope: 'mesh' }), { now, machines: { m1: 'Mac Studio', m2: 'Laptop' } });
    expect(many.rows[0].sub).toContain('on Laptop');
    expect(many.rows[1].machine).toBeNull();
    expect(JSON.stringify(many.rows.map((r: { sub: string }) => r.sub))).not.toContain('m_unknown_123');
    expect(many.meshWords).toBeTruthy();
    const one = buildPreferenceEntries(res(entries), { now, machines: { m2: 'Laptop' } });
    expect(one.rows[0].sub).not.toContain('Laptop');
  });

  it('says the list was cut when the server truncated it', () => {
    const m = buildPreferenceEntries({ ok: true, data: { entries: [{ dedupeKey: 'a', learning: 'X', recordedAt: '2026-10-25T00:00:00Z', dedupeCount: 1 }], total: 600, truncated: true } }, { now });
    expect(m.notLoadedWords).toBe('Showing the newest 1 of 600.');
  });

  it('an answer with no list is a cannot-tell, never an empty list', () => {
    const m = buildPreferenceEntries({ ok: true, data: { present: true } }, { now });
    expect(m.ok).toBe(false);
    expect(m.reason).toMatch(/no preference list/);
  });

  it('off and failed reads go through the same words as before', () => {
    expect(buildPreferenceEntries({ ok: false, reason: 'switched off on this agent' }, { now })).toMatchObject({ ok: false, off: true });
    expect(buildPreferenceEntries({ ok: false, reason: 'the server could not be reached' }, { now })).toMatchObject({ ok: false, off: false });
  });

  it('only a 404 counts as an older server without the route', () => {
    expect(isMissingRoute({ ok: false, reason: 'the server answered 404' })).toBe(true);
    expect(isMissingRoute({ ok: false, reason: 'the server answered 500, twice' })).toBe(false);
    expect(isMissingRoute({ ok: true, data: {} })).toBe(false);
  });
});

describe('Agent awareness for GET /preferences', () => {
  it('the CLAUDE.md template carries the line', () => {
    const md = generateClaudeMd('demo', 'Demo', 4321, true);
    expect(md).toContain(PREFERENCES_LIST_MARKER);
    expect(md).toContain('http://localhost:4321/preferences`');
  });

  it('migrateClaudeMd adds it under the session-context bullet once, never inside the table row', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prefs-list-mig-'));
    try {
      const stateDir = path.join(tmp, '.instar');
      fs.mkdirSync(stateDir, { recursive: true });
      const md = [
        '# CLAUDE.md',
        '| What preferences have I learned? | `curl http://localhost:4321/preferences/session-context` |',
        '',
        '## Preferences I\'ve learned about you',
        '- See what\'s currently injected: `curl -H "Authorization: Bearer $AUTH" http://localhost:4321/preferences/session-context` (the block)',
        '- Next bullet',
        '',
      ].join('\n');
      const mdPath = path.join(tmp, 'CLAUDE.md');
      fs.writeFileSync(mdPath, md);
      const migrator = new PostUpdateMigrator({ projectDir: tmp, stateDir, port: 4321, hasTelegram: false, projectName: 'demo' } as any);
      const run = () => (migrator as any).migrateClaudeMd({ upgraded: [], skipped: [], errors: [] });
      run();
      run();
      const out = fs.readFileSync(mdPath, 'utf-8');
      expect(out.split(PREFERENCES_LIST_MARKER).length - 1).toBe(1);
      const lines = out.split('\n');
      const at = lines.findIndex((l) => l.includes(PREFERENCES_LIST_MARKER));
      expect(lines[at - 1]).toMatch(/^- See what's currently injected/);
      expect(lines[at]).toBe(PREFERENCES_LIST_CLAUDEMD_LINE(4321));
    } finally {
      SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/console-dated-preferences.test.ts' });
    }
  });
});

describe('the Learned page reads the dated list (jsdom)', () => {
  const okR = (data: unknown) => ({ ok: true, status: 200, data });
  const failR = (reason = 'the server answered 500') => ({ ok: false, status: 500, reason });
  let reads: Record<string, unknown> = {};
  let asked: string[] = [];
  beforeEach(async () => {
    const { JSDOM } = await import('jsdom');
    const dom = new JSDOM('<!doctype html><body></body></html>', { url: 'http://localhost/dashboard/console/#/settings/learned', pretendToBeVisual: true });
    const w: any = dom.window;
    for (const k of ['document', 'location', 'history', 'HTMLElement', 'Node', 'CSS', 'MutationObserver', 'getSelection', 'requestAnimationFrame', 'cancelAnimationFrame']) if (k in w) (globalThis as any)[k] = w[k];
    (globalThis as any).window = w;
    (globalThis as any).sessionStorage = w.sessionStorage;
    (globalThis as any).fetch = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => '' }));
    w.scrollTo = vi.fn();
    w.HTMLElement.prototype.scrollIntoView = vi.fn();
    asked = [];
    reads = {
      '/corrections?limit=20': okR({ records: [], count: 0, totalRecords: 0, nextBefore: null }),
      '/state/conflicts': { ok: false, status: 503, reason: 'switched off on this agent' }, '/pool': okR({ enabled: false, machines: [] }),
      '/skills/learned': { ok: false, status: 503, reason: 'switched off on this agent' },
    };
  });
  async function render() {
    const { renderLearned, _resetLearnedState } = await import('../../dashboard/console/learned.js');
    _resetLearnedState();
    const main = document.createElement('main'); document.body.replaceChildren(main);
    const get = vi.fn(async (p: string) => { asked.push(p); return p in reads ? reads[p] : failR(); });
    await renderLearned(main, { get, post: vi.fn(async () => ({ ok: true })), getCommitments: vi.fn(async () => failR()) });
    return main;
  }

  it('shows each preference with its date and marks a new one', async () => {
    const recent = new Date(Date.now() - 24 * 3600_000).toISOString();
    reads['/preferences'] = okR({ entries: [
      { dedupeKey: 'a', learning: 'Plainer words', recordedAt: recent, confidence: 0.9, dedupeCount: 1 },
      { dedupeKey: 'b', learning: 'Answer first', recordedAt: '2025-03-02T12:00:00Z', confidence: 0.6, dedupeCount: 3 },
    ], total: 2, truncated: false, scope: 'local' });
    const main = await render();
    const cards = [...main.querySelectorAll('.pref-card')];
    expect(cards).toHaveLength(2);
    expect(cards[0].querySelector('[data-new]')?.textContent).toBe('New this week');
    expect(cards[1].querySelector('[data-new]')).toBeNull();
    expect(cards[1].textContent).toContain('last seen Mar 2, 2025');
    expect(asked).not.toContain('/preferences/session-context');
  });

  it('falls back to the session-context block on an older server (404)', async () => {
    reads['/preferences'] = { ok: false, status: 404, reason: 'the server answered 404' };
    reads['/preferences/session-context'] = okR({ present: true, count: 1, block: "<auto-learned-preference src='correction-loop'>\n- Plainer words (confidence 0.80, seen 2×)\n</auto-learned-preference>" });
    const main = await render();
    expect(asked).toContain('/preferences/session-context');
    expect(main.querySelectorAll('.pref-card')).toHaveLength(1);
    expect(main.textContent).toContain('Plainer words');
  });
});
