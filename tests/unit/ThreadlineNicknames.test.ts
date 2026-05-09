/**
 * Unit tests — ThreadlineNicknames store.
 *
 * Focus: reverse-lookup (name → fingerprint), which is what the
 * `/threadline/relay-send` resolver uses to short-circuit relay discovery.
 *
 * Regression for the "Dawn → wrong fingerprint" silent-delivery bug:
 * the resolver used to consult only the relay's discovery cache, which
 * returned a stale/imposter fingerprint for the name "Dawn" while the
 * user's curated mapping at .instar/threadline/nicknames.json had the
 * correct one. resolveByName() is the authority lookup.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ThreadlineNicknames } from '../../src/threadline/ThreadlineNicknames.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('ThreadlineNicknames.resolveByName', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nicknames-test-'));
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmp, {
      recursive: true,
      force: true,
      operation: 'tests/unit/ThreadlineNicknames.test.ts:cleanup',
    });
  });

  it('returns null when nicknames file is absent', () => {
    const store = new ThreadlineNicknames({ stateDir: tmp });
    expect(store.resolveByName('Dawn')).toBeNull();
  });

  it('returns null for empty/whitespace input', () => {
    const store = new ThreadlineNicknames({ stateDir: tmp });
    store.set('8c7928aa9f04fbda947172a2f9b2d81a', 'Dawn');
    expect(store.resolveByName('')).toBeNull();
    expect(store.resolveByName('   ')).toBeNull();
  });

  it('resolves a single user-curated nickname → fingerprint (case-insensitive)', () => {
    const store = new ThreadlineNicknames({ stateDir: tmp });
    const fp = '8c7928aa9f04fbda947172a2f9b2d81a';
    store.set(fp, 'Dawn');

    const lower = store.resolveByName('dawn');
    const upper = store.resolveByName('DAWN');
    const exact = store.resolveByName('Dawn');

    expect(lower).not.toBeNull();
    expect(upper).not.toBeNull();
    expect(exact).not.toBeNull();
    if (lower && !('ambiguous' in lower)) {
      expect(lower.fingerprint).toBe(fp);
      expect(lower.entry.nickname).toBe('Dawn');
      expect(lower.entry.source).toBe('user');
    }
  });

  it('flags ambiguity when multiple fingerprints share the same nickname', () => {
    const store = new ThreadlineNicknames({ stateDir: tmp });
    store.set('8c7928aa9f04fbda947172a2f9b2d81a', 'Dawn');
    store.set('5c338c63cd2ecebc8f52483d5bba6486', 'Dawn');

    const result = store.resolveByName('Dawn');
    expect(result).not.toBeNull();
    expect(result && 'ambiguous' in result).toBe(true);
    if (result && 'ambiguous' in result) {
      expect(result.candidates).toHaveLength(2);
      const fps = result.candidates.map(c => c.fingerprint).sort();
      expect(fps).toEqual([
        '5c338c63cd2ecebc8f52483d5bba6486',
        '8c7928aa9f04fbda947172a2f9b2d81a',
      ]);
    }
  });

  it('reads the on-disk nickname file written outside the process', () => {
    // Simulate the user editing .instar/threadline/nicknames.json by hand
    // (or via the dashboard) — the store's load() should pick it up.
    const dir = path.join(tmp, 'threadline');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'nicknames.json'),
      JSON.stringify({
        version: 1,
        nicknames: {
          '8c7928aa9f04fbda947172a2f9b2d81a': {
            nickname: 'Dawn',
            source: 'user',
            updatedAt: '2026-05-07T00:44:34.234Z',
          },
        },
      }),
      'utf-8',
    );

    const store = new ThreadlineNicknames({ stateDir: tmp });
    const result = store.resolveByName('Dawn');
    expect(result).not.toBeNull();
    if (result && !('ambiguous' in result)) {
      expect(result.fingerprint).toBe('8c7928aa9f04fbda947172a2f9b2d81a');
    }
  });

  it('does not throw when nicknames.json is corrupt; treats as empty', () => {
    const dir = path.join(tmp, 'threadline');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'nicknames.json'), '{not-json', 'utf-8');

    const store = new ThreadlineNicknames({ stateDir: tmp });
    expect(() => store.resolveByName('Dawn')).not.toThrow();
    expect(store.resolveByName('Dawn')).toBeNull();
  });

  it('returns null for nicknames that do not match anything', () => {
    const store = new ThreadlineNicknames({ stateDir: tmp });
    store.set('8c7928aa9f04fbda947172a2f9b2d81a', 'Dawn');
    expect(store.resolveByName('NotDawn')).toBeNull();
  });

  it('canonicalizes whitespace and Unicode form so hand-edits resolve', () => {
    // Convergence-review finding: a hand-edited "Dawn " (trailing space)
    // or "Dawn  Q" (double space) or NFD-form input would silently fail
    // resolution under naive trim+lowercase. Canonicalization fixes both
    // store-side and lookup-side.
    const dir = path.join(tmp, 'threadline');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'nicknames.json'),
      JSON.stringify({
        version: 1,
        nicknames: {
          '8c7928aa9f04fbda947172a2f9b2d81a': {
            // Hand-edited with trailing whitespace + double internal space
            nickname: 'Dawn  Q ',
            source: 'user',
            updatedAt: '2026-05-07T00:44:34.234Z',
          },
        },
      }),
      'utf-8',
    );
    const store = new ThreadlineNicknames({ stateDir: tmp });
    const result = store.resolveByName('dawn q');
    expect(result).not.toBeNull();
    if (result && !('ambiguous' in result)) {
      expect(result.fingerprint).toBe('8c7928aa9f04fbda947172a2f9b2d81a');
    }
  });
});
