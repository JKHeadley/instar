import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const LINT = path.join(ROOT, 'scripts', 'lint-dev-agent-dark-gate.js');

/** Run the lint; return { code, out }. Never throws on non-zero exit. */
function runLint(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync('node', [LINT, ...args], { cwd: ROOT, encoding: 'utf-8' });
    return { code: 0, out };
  } catch (e: any) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('lint-dev-agent-dark-gate', () => {
  it('passes clean on the real src/ tree (migration complete, no hardcoded dark-gate defaults)', () => {
    const { code, out } = runLint([]);
    expect(out).toContain('clean');
    expect(code).toBe(0);
  });

  it('Assertion A: flags a hand-rolled `?? !!config.developmentAgent` outside the helper', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkgate-A-'));
    const f = path.join(dir, 'someFeature.ts');
    fs.writeFileSync(f, 'export function f(cfg, config) {\n  const enabled = cfg?.enabled ?? !!config.developmentAgent;\n  return enabled;\n}\n');
    try {
      const { code, out } = runLint([f]);
      expect(code).toBe(1);
      expect(out).toContain('A: hand-rolled gate');
      expect(out).toContain('resolveDevAgentGate');
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/lint-dev-agent-dark-gate.test.ts' });
    }
  });

  it('Assertion A: does NOT flag a comment that merely describes the pattern', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkgate-Aok-'));
    const f = path.join(dir, 'documented.ts');
    fs.writeFileSync(f, '// resolves enabled ?? !!config.developmentAgent at runtime (dev-gate)\nexport const x = 1;\n');
    try {
      const { code } = runLint([f]);
      expect(code).toBe(0);
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/lint-dev-agent-dark-gate.test.ts' });
    }
  });

  it('Assertion B: flags a hardcoded `enabled: false` under a dev-gate marker comment in ConfigDefaults.ts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkgate-B-'));
    const f = path.join(dir, 'ConfigDefaults.ts');
    fs.writeFileSync(
      f,
      [
        'export const defaults = {',
        '  // MyFeature — dark-feature gate (developmentAgent): dark fleet, live dev.',
        '  myFeature: {',
        '    enabled: false,',
        '  },',
        '};',
        '',
      ].join('\n'),
    );
    try {
      const { code, out } = runLint([f]);
      expect(code).toBe(1);
      expect(out).toContain('B: hardcoded enabled under gate marker');
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/lint-dev-agent-dark-gate.test.ts' });
    }
  });

  it('Assertion B: does NOT flag `enabled: true` (allowed fleet-flip) or comment prose under a marker', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkgate-Bok-'));
    const f = path.join(dir, 'ConfigDefaults.ts');
    fs.writeFileSync(
      f,
      [
        'export const defaults = {',
        '  // MyFeature — dark-feature gate (developmentAgent): the fleet-flip',
        '  // registers `enabled: true` here. Default OMITS enabled.',
        '  myFeature: {',
        '    sampleIntervalMs: 1000,',
        '  },',
        '};',
        '',
      ].join('\n'),
    );
    try {
      const { code } = runLint([f]);
      expect(code).toBe(0);
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/lint-dev-agent-dark-gate.test.ts' });
    }
  });

  it('Assertion A: flags the `?? Boolean(config.developmentAgent)` form (not just `!!`)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkgate-Abool-'));
    const f = path.join(dir, 'someFeature.ts');
    fs.writeFileSync(f, 'export function f(cfg, config) {\n  const enabled = cfg?.enabled ?? Boolean(config.developmentAgent);\n  return enabled;\n}\n');
    try {
      const { code, out } = runLint([f]);
      expect(code).toBe(1);
      expect(out).toContain('A: hand-rolled gate');
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/lint-dev-agent-dark-gate.test.ts' });
    }
  });

  it('Assertion B: catches `enabled: false` even when a LONG marker comment precedes the block (the growthAnalyst window regression)', () => {
    // Regression for the fixed-window bug: growthAnalyst ships a ~10-line marker
    // comment, which pushed its config fields past the old 8-line window so a
    // regressed `enabled: false` slipped through. Block-matching must catch it
    // regardless of comment length.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkgate-Blong-'));
    const f = path.join(dir, 'ConfigDefaults.ts');
    const longComment = Array.from({ length: 11 }, (_, k) =>
      k === 0
        ? '  // MyFeature — dark-feature gate (developmentAgent): dark fleet, live dev.'
        : `  // continuation line ${k} of a deliberately long explanatory comment.`,
    ).join('\n');
    fs.writeFileSync(
      f,
      ['export const defaults = {', longComment, '  myFeature: {', '    enabled: false,', '  },', '};', ''].join('\n'),
    );
    try {
      const { code, out } = runLint([f]);
      expect(code).toBe(1);
      expect(out).toContain('B: hardcoded enabled under gate marker');
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/lint-dev-agent-dark-gate.test.ts' });
    }
  });
});
