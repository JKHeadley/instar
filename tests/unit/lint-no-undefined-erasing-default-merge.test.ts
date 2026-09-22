// safe-git-allow: test file — no git calls.
// safe-fs-allow: test file — reads src/ only, no mutations.

/**
 * Pins what lint-no-undefined-erasing-default-merge catches and what it leaves
 * alone, and asserts the live src/ tree is clean — so a regression in either the
 * rule or the codebase fails CI, not a future incident.
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
// @ts-expect-error — plain ESM script without type declarations.
import { scanSource, ALLOWED } from '../../scripts/lint-no-undefined-erasing-default-merge.js';

const hits = (code: string, file = 'x.ts'): number => scanSource(code, file).length;

describe('lint-no-undefined-erasing-default-merge — shapes it catches', () => {
  it('the incident shape: { ...DEFAULT_CONFIG, ...cfg }', () => {
    expect(hits('this.cfg = { ...DEFAULT_CONFIG, ...cfg };')).toBe(1);
  });
  it('every defaults naming style', () => {
    for (const name of ['DEFAULTS', 'defaults', 'defaultLimits', 'ROPE_HEALTH_DEFAULTS', 'configDefaults', 'this.configDefaults', 'mod.DEFAULT_X', 'DEFAULT_LIMITS[trust]']) {
      expect(hits(`x = { ...${name}, ...o };`)).toBe(1);
    }
  });
  it('a defaults factory call: { ...defaultCounters(), ...stored }', () => {
    expect(hits('x = { ...defaultCounters(), ...stored };')).toBe(1);
  });
  it('fallback-wrapped and optional-chained overrides', () => {
    expect(hits('x = { ...DEFAULT_X, ...(cfg ?? {}) };')).toBe(1);
    expect(hits('x = { ...DEFAULT_X, ...cfg.rateLimits?.[trust] };')).toBe(1);
  });
  it('multi-line literals, trailing commas and extra explicit keys', () => {
    expect(hits('x = {\n  ...DEFAULT_X,\n  ...cfg,\n  enabled: true,\n};')).toBe(1);
  });
  it('a defaults spread that is not the first member', () => {
    expect(hits('x = { a: 1, ...DEFAULT_X, ...cfg };')).toBe(1);
  });
  it('Object.assign with a defaults source followed by another source', () => {
    expect(hits('x = Object.assign({}, DEFAULTS, cfg);')).toBe(1);
    expect(hits('x = Object.assign(target, DEFAULTS, cfg);')).toBe(1);
  });
  it('is not desynchronised by regex literals, backticks, or nested templates (the old scanner was)', () => {
    const tricky = [
      'const RE = /`[^`]*`/g;',
      'const Q = /[\'"]/;',
      'const T = `a ${`b ${c}`} d`;',
      'x = { ...DEFAULT_X, ...cfg };',
    ].join('\n');
    expect(hits(tricky)).toBe(1);
  });
  it('a merge nested inside another literal is still found', () => {
    expect(hits('x = { a: 1, inner: { ...DEFAULT_I, ...cfg.inner } };')).toBe(1);
  });
  it('parses .tsx', () => {
    expect(hits('const el = <div />; x = { ...DEFAULTS, ...o };', 'x.tsx')).toBe(1);
  });
});

describe('lint-no-undefined-erasing-default-merge — shapes it leaves alone', () => {
  it('the helper call itself, bare or spread with explicit keys', () => {
    expect(hits('x = mergeDefaults(DEFAULT_X, cfg);')).toBe(0);
    expect(hits('x = { ...mergeDefaults(DEFAULT_X, cfg), enabled: true };')).toBe(0);
  });
  it('a single defaults spread with only explicit keys', () => {
    expect(hits('x = { ...DEFAULT_X, enabled: true };')).toBe(0);
  });
  it('spreads of names that do not say "default"', () => {
    expect(hits('x = { ...base, ...cfg };')).toBe(0);
  });
  it('a conditional spread that merely has a FIELD named default…', () => {
    expect(hits('x = { binaryPath, ...(m ? { defaultModel: m } : {}), ...(s ? { sessionId: s } : {}) };')).toBe(0);
  });
  it('code inside comments and strings', () => {
    expect(hits('// x = { ...DEFAULT_X, ...cfg }\nconst s = "{ ...DEFAULT_X, ...cfg }";')).toBe(0);
  });
  it('the defaults spread LAST (defaults win — a different, intentional pattern)', () => {
    expect(hits('x = { ...cfg, ...DEFAULT_X };')).toBe(0);
  });
});

describe('tracked exceptions', () => {
  it('every allowlist entry is capped, reasoned and tracked', () => {
    for (const [file, entry] of Object.entries(ALLOWED as Record<string, { max: number; reason: string; tracked: string }>)) {
      expect(entry.max, file).toBeGreaterThan(0);
      expect(entry.reason.length, file).toBeGreaterThan(40);
      expect(entry.tracked, file).toMatch(/^(ACT|CMT)-\d+$/);
    }
  });
});

describe('the live src/ tree', () => {
  it('the lint exits 0 over the real repository', () => {
    const repo = path.resolve(__dirname, '..', '..');
    const run = spawnSync(process.execPath, [path.join(repo, 'scripts', 'lint-no-undefined-erasing-default-merge.js')], {
      cwd: repo, encoding: 'utf-8',
    });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/clean \(\d+ files\)/);
  }, 120_000);

  it('refuses to report clean when nothing could be parsed', () => {
    const repo = path.resolve(__dirname, '..', '..');
    const run = spawnSync(process.execPath, [path.join(repo, 'scripts', 'lint-no-undefined-erasing-default-merge.js')], {
      cwd: repo, encoding: 'utf-8', env: { ...process.env, INSTAR_LINT_FORCE_PARSE_FAILURE: '1' },
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/COULD NOT INSPECT/);
  }, 120_000);
});
