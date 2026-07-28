/**
 * Unit tests — the Topic Profile direct `--effort` launch pin in the
 * claude-code interactive + headless builders.
 *
 * `effort` is a DIRECT pin of Claude Code's `--effort` CLI flag
 * (low|medium|high|xhigh|max), distinct from `thinkingMode` (which the
 * builders MAP onto --effort). Contract under test:
 *   - present  → argv contains `--effort <level>` in the right position;
 *   - absent   → no `--effort`;
 *   - invalid  → dropped (defense-in-depth enum check inside the builder);
 *   - a direct pin WINS over the thinkingMode→effort mapping (no duplicate);
 *   - non-claude frameworks ignore it entirely.
 *
 * These assertions FAIL against the pre-change builders, which had no `effort`
 * option at all.
 */

import { describe, it, expect } from 'vitest';
import {
  buildInteractiveLaunch,
  buildHeadlessLaunch,
  validateEffortLevel,
} from '../../src/core/frameworkSessionLaunch.js';
import type { EffortLevel } from '../../src/core/topicProfileValidation.js';

const LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

function effortIdx(argv: string[]): number {
  return argv.indexOf('--effort');
}
function countEffort(argv: string[]): number {
  return argv.filter((a) => a === '--effort').length;
}

describe('validateEffortLevel (defense-in-depth clamp)', () => {
  it('accepts every closed-enum level', () => {
    for (const l of LEVELS) expect(validateEffortLevel(l)).toBe(l);
  });
  it('drops anything off-enum (incl. ultracode/ultra), undefined, null', () => {
    for (const bad of ['ultracode', 'ultra', 'xxhigh', 'HIGH', '', 'minimal', undefined, null]) {
      expect(validateEffortLevel(bad)).toBeNull();
    }
  });
});

describe('claude-code interactive builder — direct --effort pin', () => {
  it('emits --effort <level> right after --dangerously-skip-permissions', () => {
    for (const level of LEVELS) {
      const spec = buildInteractiveLaunch('claude-code', {
        binaryPath: '/usr/local/bin/claude',
        effort: level,
      });
      const idx = effortIdx(spec.argv);
      expect(idx).toBeGreaterThan(-1);
      expect(spec.argv[idx + 1]).toBe(level);
      // Position: immediately after the skip-permissions flag (argv[1]).
      expect(spec.argv[0]).toBe('/usr/local/bin/claude');
      expect(spec.argv[1]).toBe('--dangerously-skip-permissions');
      expect(idx).toBe(2);
    }
  });

  it('absent → no --effort', () => {
    const spec = buildInteractiveLaunch('claude-code', { binaryPath: '/usr/local/bin/claude' });
    expect(spec.argv).not.toContain('--effort');
  });

  it('invalid value is dropped (no --effort reaches the CLI)', () => {
    const spec = buildInteractiveLaunch('claude-code', {
      binaryPath: '/usr/local/bin/claude',
      // Force an unknown value past the type system (the resolver fails open,
      // but the builder is a second untrusted entry point).
      effort: 'ultracode' as unknown as EffortLevel,
    });
    expect(spec.argv).not.toContain('--effort');
  });

  it('a direct effort pin WINS over thinkingMode and emits --effort exactly once', () => {
    const spec = buildInteractiveLaunch('claude-code', {
      binaryPath: '/usr/local/bin/claude',
      effort: 'xhigh',
      thinkingMode: 'low', // would otherwise map to --effort low
    });
    expect(countEffort(spec.argv)).toBe(1);
    const idx = effortIdx(spec.argv);
    expect(spec.argv[idx + 1]).toBe('xhigh');
  });

  it('a direct effort pin overrides thinkingMode:off (no MAX_THINKING_TOKENS=0 suppression)', () => {
    const spec = buildInteractiveLaunch('claude-code', {
      binaryPath: '/usr/local/bin/claude',
      effort: 'high',
      thinkingMode: 'off',
    });
    const idx = effortIdx(spec.argv);
    expect(spec.argv[idx + 1]).toBe('high');
    expect(spec.envOverrides.MAX_THINKING_TOKENS).toBeUndefined();
  });

  it('coexists with --model (both flags present)', () => {
    const spec = buildInteractiveLaunch('claude-code', {
      binaryPath: '/usr/local/bin/claude',
      defaultModel: 'opus',
      effort: 'max',
    });
    expect(spec.argv).toContain('--model');
    const idx = effortIdx(spec.argv);
    expect(spec.argv[idx + 1]).toBe('max');
  });
});

describe('claude-code headless builder — direct --effort pin', () => {
  it('emits --effort <level> after the --model block and before -p', () => {
    const spec = buildHeadlessLaunch('claude-code', {
      binaryPath: '/usr/local/bin/claude',
      prompt: 'do the thing',
      model: 'opus',
      effort: 'high',
    });
    const idx = effortIdx(spec.argv);
    const modelIdx = spec.argv.indexOf('--model');
    const pIdx = spec.argv.indexOf('-p');
    expect(idx).toBeGreaterThan(-1);
    expect(spec.argv[idx + 1]).toBe('high');
    expect(idx).toBeGreaterThan(modelIdx); // after --model block
    expect(idx).toBeLessThan(pIdx); // before the prompt positional
  });

  it('absent → no --effort; prompt is still the final positional', () => {
    const spec = buildHeadlessLaunch('claude-code', {
      binaryPath: '/usr/local/bin/claude',
      prompt: 'hello',
    });
    expect(spec.argv).not.toContain('--effort');
    expect(spec.argv[spec.argv.length - 1]).toBe('hello');
  });

  it('invalid value is dropped', () => {
    const spec = buildHeadlessLaunch('claude-code', {
      binaryPath: '/usr/local/bin/claude',
      prompt: 'hi',
      effort: 'ultracode' as unknown as EffortLevel,
    });
    expect(spec.argv).not.toContain('--effort');
  });
});

describe('claude-code headless builder — ultracode workflow opt-in', () => {
  it('prefixes the supported prompt keyword without inventing a CLI flag', () => {
    const spec = buildHeadlessLaunch('claude-code', {
      binaryPath: '/usr/local/bin/claude',
      prompt: 'trace the race',
      ultracode: true,
    });
    expect(spec.argv).not.toContain('--ultracode');
    expect(spec.argv.at(-1)).toBe('ultracode\n\ntrace the race');
  });

  it('preserves the prompt byte-for-byte when dark and is a non-Claude no-op', () => {
    const plain = buildHeadlessLaunch('claude-code', {
      binaryPath: '/usr/local/bin/claude', prompt: 'trace the race',
    });
    const codex = buildHeadlessLaunch('codex-cli', {
      binaryPath: '/usr/local/bin/codex', prompt: 'trace the race', ultracode: true,
    });
    expect(plain.argv.at(-1)).toBe('trace the race');
    expect(codex.argv.at(-1)).toBe('trace the race');
  });
});

describe('non-claude frameworks ignore effort', () => {
  it('codex interactive does not emit --effort for a direct effort pin', () => {
    const spec = buildInteractiveLaunch('codex-cli', {
      binaryPath: '/usr/local/bin/codex',
      effort: 'max',
    });
    expect(spec.argv).not.toContain('--effort');
  });
  it('gemini headless does not emit --effort', () => {
    const spec = buildHeadlessLaunch('gemini-cli', {
      binaryPath: '/usr/local/bin/gemini',
      prompt: 'hi',
      effort: 'high',
    });
    expect(spec.argv).not.toContain('--effort');
  });
});
