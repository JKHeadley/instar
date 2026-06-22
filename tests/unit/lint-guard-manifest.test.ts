import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { GUARD_MANIFEST, NOT_A_GUARD, manifestComponents, notAGuardComponents } from '../../src/monitoring/guardManifest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const LINT = path.join(ROOT, 'scripts', 'lint-guard-manifest.js');

/** Run the lint; return { code, out }. Never throws on non-zero exit. */
function runLint(args: string[], env?: Record<string, string>): { code: number; out: string } {
  try {
    const out = execFileSync('node', [LINT, ...args], {
      cwd: ROOT,
      encoding: 'utf-8',
      env: { ...process.env, ...(env ?? {}) },
    });
    return { code: 0, out };
  } catch (e: any) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/**
 * Build a fixture pair (a guardManifest.ts with the GUARD_MANIFEST/NOT_A_GUARD
 * arrays + one or more guard-shaped candidate files) in a tmpdir, returning
 * the env override that points the lint's manifest parse at the fixture and
 * the candidate file paths to pass as explicit args. The lint's assertion-A
 * scopes to the explicit args, so a fixture run never touches the real tree.
 */
function writeFixture(opts: {
  manifestEntries?: string;   // contents INSIDE GUARD_MANIFEST `[ ... ]`
  notAGuardEntries?: string;  // contents INSIDE NOT_A_GUARD `[ ... ]`
  candidateFiles?: string[];  // basenames, e.g. ['FooSentinel.ts']
}): { dir: string; env: Record<string, string>; files: string[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardlint-'));
  const manifest = [
    'export const GUARD_MANIFEST = [',
    opts.manifestEntries ?? '',
    '] as const;',
    '',
    'export const NOT_A_GUARD = [',
    opts.notAGuardEntries ?? '',
    '] as const;',
    '',
  ].join('\n');
  const manifestPath = path.join(dir, 'guardManifest.ts');
  fs.writeFileSync(manifestPath, manifest);
  const files: string[] = [];
  for (const base of opts.candidateFiles ?? []) {
    const f = path.join(dir, base);
    fs.writeFileSync(f, 'export const x = 1;\n');
    files.push(f);
  }
  return { dir, env: { INSTAR_GUARDLINT_MANIFEST: manifestPath }, files };
}

function cleanup(dir: string) {
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/lint-guard-manifest.test.ts' });
}

describe('lint-guard-manifest', () => {
  it('passes clean on the real repo (the §2.1 backfill is complete — every guard-shaped component classified)', () => {
    const { code, out } = runLint([]);
    expect(out).toContain('clean');
    expect(code).toBe(0);
  });

  it('Assertion A: an unclassified guard-shaped component FAILS', () => {
    const { dir, env, files } = writeFixture({
      candidateFiles: ['FooSentinel.ts'],
      // both lists empty — FooSentinel is in NEITHER → violation
    });
    try {
      const { code, out } = runLint(files, env);
      expect(code).toBe(1);
      expect(out).toContain('A: unclassified guard-shaped component');
      expect(out).toContain('FooSentinel');
    } finally {
      cleanup(dir);
    }
  });

  it('Assertion A: a component declared in GUARD_MANIFEST (component:) PASSES', () => {
    const { dir, env, files } = writeFixture({
      manifestEntries:
        "  { key: 'monitoring.foo.enabled', kind: 'config', configPath: 'monitoring.foo.enabled', defaultEnabled: true, process: 'server', expectRuntime: false, component: 'FooSentinel', description: 'x' },",
      candidateFiles: ['FooSentinel.ts'],
    });
    try {
      const { code, out } = runLint(files, env);
      expect(out).toContain('clean');
      expect(code).toBe(0);
    } finally {
      cleanup(dir);
    }
  });

  it('Assertion A: a component classified in NOT_A_GUARD with a real reason PASSES', () => {
    const { dir, env, files } = writeFixture({
      notAGuardEntries:
        "  { component: 'FooSentinel', reason: 'Pure signal classifier with no enabled switch; never acts.' },",
      candidateFiles: ['FooSentinel.ts'],
    });
    try {
      const { code, out } = runLint(files, env);
      expect(out).toContain('clean');
      expect(code).toBe(0);
    } finally {
      cleanup(dir);
    }
  });

  it('Assertion A: a non-guard-shaped basename is NOT a candidate', () => {
    const { dir, env, files } = writeFixture({
      candidateFiles: ['SomeHelper.ts'], // matches no suffix in the pattern
    });
    try {
      const { code } = runLint(files, env);
      expect(code).toBe(0);
    } finally {
      cleanup(dir);
    }
  });

  it('Assertion B: a NOT_A_GUARD reason under 12 non-whitespace chars FAILS (placeholder rejected)', () => {
    const { dir, env, files } = writeFixture({
      notAGuardEntries: "  { component: 'FooSentinel', reason: 'not  a   guard' },", // 10 non-ws chars
      candidateFiles: ['FooSentinel.ts'],
    });
    try {
      const { code, out } = runLint(files, env);
      expect(code).toBe(1);
      expect(out).toContain('B: NOT_A_GUARD reason too short');
    } finally {
      cleanup(dir);
    }
  });

  it('Assertion C: a component in BOTH GUARD_MANIFEST and NOT_A_GUARD FAILS', () => {
    const { dir, env, files } = writeFixture({
      manifestEntries:
        "  { key: 'monitoring.foo.enabled', kind: 'config', configPath: 'monitoring.foo.enabled', defaultEnabled: true, process: 'server', expectRuntime: false, component: 'FooSentinel', description: 'x' },",
      notAGuardEntries:
        "  { component: 'FooSentinel', reason: 'Contradicts the manifest entry above deliberately.' },",
      candidateFiles: ['FooSentinel.ts'],
    });
    try {
      const { code, out } = runLint(files, env);
      expect(code).toBe(1);
      expect(out).toContain('C: dual classification');
    } finally {
      cleanup(dir);
    }
  });

  it('a commented-out NOT_A_GUARD entry does NOT satisfy the rule', () => {
    const { dir, env, files } = writeFixture({
      notAGuardEntries:
        "  // { component: 'FooSentinel', reason: 'commented out — must not count as classified' },",
      candidateFiles: ['FooSentinel.ts'],
    });
    try {
      const { code, out } = runLint(files, env);
      expect(code).toBe(1);
      expect(out).toContain('A: unclassified guard-shaped component');
    } finally {
      cleanup(dir);
    }
  });

  // ── Cross-checks against the REAL manifest module (the lint's regex parse
  //    must agree with what TypeScript actually exports) ──

  it('every real NOT_A_GUARD reason meets the ≥12 non-whitespace-char bar', () => {
    for (const e of NOT_A_GUARD) {
      expect(e.reason.replace(/\s/g, '').length, `${e.component} reason length`).toBeGreaterThanOrEqual(12);
    }
  });

  it('no component appears in both GUARD_MANIFEST and NOT_A_GUARD (real manifest)', () => {
    const inManifest = manifestComponents();
    for (const c of notAGuardComponents()) {
      expect(inManifest.has(c), `${c} must not be dual-classified`).toBe(false);
    }
  });

  it('every GUARD_MANIFEST entry carries a component join key (the lint cannot see an entry without one)', () => {
    for (const entry of GUARD_MANIFEST) {
      expect(typeof entry.component, `${entry.key} component`).toBe('string');
      expect((entry.component ?? '').length, `${entry.key} component length`).toBeGreaterThan(0);
    }
  });

  // ── tmux Event-Loop Resilience, Increment 1: the (C) DegradedTmuxGuard entry ──
  describe('DegradedTmuxGuard manifest entry (tmux Event-Loop Resilience C)', () => {
    it('appears in GUARD_MANIFEST exactly ONCE and NOT in NOT_A_GUARD (no dual classification)', () => {
      const manifestMatches = GUARD_MANIFEST.filter(e => e.component === 'DegradedTmuxGuard');
      expect(manifestMatches.length, 'GUARD_MANIFEST DegradedTmuxGuard count').toBe(1);
      expect(notAGuardComponents().has('DegradedTmuxGuard'), 'must not be in NOT_A_GUARD').toBe(false);
    });

    it('is keyed on monitoring.degradedTmuxGuard.enabled with expectRuntime:true + a configPath + NO expectedTickMs (event-driven)', () => {
      const entry = GUARD_MANIFEST.find(e => e.component === 'DegradedTmuxGuard')!;
      expect(entry).toBeDefined();
      expect(entry.key).toBe('monitoring.degradedTmuxGuard.enabled');
      expect(entry.configPath).toBe('monitoring.degradedTmuxGuard.enabled');
      expect(entry.kind).toBe('config');
      expect(entry.process).toBe('server');
      // expectRuntime:true REQUIRES the server-boot guardRegistry.register callsite to exist.
      expect(entry.expectRuntime).toBe(true);
      // defaultEnabled reflects the fleet default (dev-gate resolves the live value).
      expect(entry.defaultEnabled).toBe(false);
      // EVENT-DRIVEN (fed by (A)'s latency + (B)'s 'stall' events) — an expectedTickMs
      // would derive a false `on-stale` on a quiet/healthy tmux, so it must be omitted.
      expect(entry.expectedTickMs).toBeUndefined();
    });

    it('the real lint stays clean with the DegradedTmuxGuard entry present (single-line component literal, classified once)', () => {
      const { code, out } = runLint([]);
      expect(out).toContain('clean');
      expect(code).toBe(0);
    });
  });
});
