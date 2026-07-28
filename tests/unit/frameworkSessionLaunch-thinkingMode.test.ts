/**
 * Unit tests — the Topic Profile §6 thinking-mode launch arm in
 * buildInteractiveLaunch: claude `--effort` flag + MAX_THINKING_TOKENS=0
 * off-channel; codex `-c model_reasoning_effort` (max→xhigh, off→low);
 * gemini/pi strict no-op.
 */

import { describe, it, expect } from 'vitest';
import {
  buildInteractiveLaunch,
  claudeEffortForThinkingMode,
  codexReasoningEffortForThinkingMode,
} from '../../src/core/frameworkSessionLaunch.js';

describe('claude thinking-mode launch arm (§6)', () => {
  it('emits --effort for low/medium/high/max', () => {
    for (const mode of ['low', 'medium', 'high', 'max'] as const) {
      const spec = buildInteractiveLaunch('claude-code', {
        binaryPath: '/usr/local/bin/claude',
        thinkingMode: mode,
      });
      const idx = spec.argv.indexOf('--effort');
      expect(idx).toBeGreaterThan(-1);
      expect(spec.argv[idx + 1]).toBe(mode);
    }
  });

  it('off rides the MAX_THINKING_TOKENS=0 env channel (no --effort flag)', () => {
    const spec = buildInteractiveLaunch('claude-code', {
      binaryPath: '/usr/local/bin/claude',
      thinkingMode: 'off',
    });
    expect(spec.argv).not.toContain('--effort');
    expect(spec.envOverrides.MAX_THINKING_TOKENS).toBe('0');
  });

  it('unset emits neither flag nor env (account default preserved)', () => {
    const spec = buildInteractiveLaunch('claude-code', { binaryPath: '/usr/local/bin/claude' });
    expect(spec.argv).not.toContain('--effort');
    expect(spec.envOverrides.MAX_THINKING_TOKENS).toBeUndefined();
  });
});

describe('codex thinking-mode launch arm (§6)', () => {
  function effortArg(spec: { argv: string[] }): string | null {
    for (let i = 0; i < spec.argv.length - 1; i++) {
      if (spec.argv[i] === '-c' && spec.argv[i + 1].startsWith('model_reasoning_effort=')) {
        return spec.argv[i + 1];
      }
    }
    return null;
  }

  it('maps low/medium/high directly and max→xhigh', () => {
    const cases: Array<['low' | 'medium' | 'high' | 'max', string]> = [
      ['low', 'low'],
      ['medium', 'medium'],
      ['high', 'high'],
      ['max', 'xhigh'],
    ];
    for (const [mode, expected] of cases) {
      const spec = buildInteractiveLaunch('codex-cli', {
        binaryPath: '/usr/local/bin/codex',
        thinkingMode: mode,
      });
      expect(effortArg(spec)).toBe(`model_reasoning_effort=${JSON.stringify(expected)}`);
    }
  });

  it('off maps to LOWEST effort (codex has no off — §4 explicit remap)', () => {
    const spec = buildInteractiveLaunch('codex-cli', {
      binaryPath: '/usr/local/bin/codex',
      thinkingMode: 'off',
    });
    expect(effortArg(spec)).toBe(`model_reasoning_effort=${JSON.stringify('low')}`);
  });

  it('unset emits no reasoning-effort override', () => {
    const spec = buildInteractiveLaunch('codex-cli', { binaryPath: '/usr/local/bin/codex' });
    expect(effortArg(spec)).toBeNull();
  });
});

describe('gemini/pi thinking-mode (strict no-op)', () => {
  it('gemini argv is unchanged by thinkingMode', () => {
    const without = buildInteractiveLaunch('gemini-cli', { binaryPath: '/usr/local/bin/gemini' });
    const withMode = buildInteractiveLaunch('gemini-cli', {
      binaryPath: '/usr/local/bin/gemini',
      thinkingMode: 'max',
    });
    expect(withMode.argv).toEqual(without.argv);
  });

  it('pi argv is unchanged by thinkingMode', () => {
    const without = buildInteractiveLaunch('pi-cli', { binaryPath: '/usr/local/bin/pi' });
    const withMode = buildInteractiveLaunch('pi-cli', {
      binaryPath: '/usr/local/bin/pi',
      thinkingMode: 'high',
    });
    expect(withMode.argv).toEqual(without.argv);
  });
});

describe('mapping helpers (exported for the L5 canary)', () => {
  it('claudeEffortForThinkingMode covers the enum', () => {
    expect(claudeEffortForThinkingMode('off')).toBeNull();
    expect(claudeEffortForThinkingMode('low')).toBe('low');
    expect(claudeEffortForThinkingMode('max')).toBe('max');
    expect(claudeEffortForThinkingMode(undefined)).toBeNull();
  });
  it('codexReasoningEffortForThinkingMode covers the enum', () => {
    expect(codexReasoningEffortForThinkingMode('off')).toBe('low');
    expect(codexReasoningEffortForThinkingMode('max')).toBe('xhigh');
    expect(codexReasoningEffortForThinkingMode(undefined)).toBeNull();
  });
});
