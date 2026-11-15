/**
 * T2 (frozen acceptance list, step3/acceptance-tests.md): the thinkingMode launch intent on
 * BOTH builders x every engine x every mode (spec job-launch-intent-record §2, D1-D3).
 * Red on main: the builders return no `applied` / `dropped`.
 *
 * Matrix: 5 modes x 5 engines x 2 builders = 50 cases, each checking the exact record AND the
 * exact native argv/env it stands for. Interactive grok-build runs with its existing opt-in
 * (grokInteractiveOptIn: true, from sessions.grokInteractiveSessions).
 *
 * Native-setting checks are exact pairs, never bare membership:
 *   - claude argv: exactly one `--effort`, immediately followed by the value.
 *   - claude env (`off`): MAX_THINKING_TOKENS=0, and no `--effort` at all.
 *   - codex argv: exactly one `-c` immediately followed by `model_reasoning_effort="<value>"`.
 *   - unsupported engines: argv and env byte-identical to the same launch with the field absent.
 */
import { describe, it, expect } from 'vitest';
import { buildInteractiveLaunch, buildHeadlessLaunch } from '../../src/core/frameworkSessionLaunch.js';

type Feature = { feature: string; requestedValue: string; value: string; channel: 'argv' | 'env' };
type Drop = { feature: string; requestedValue?: string; reason: string };
type Spec = { argv: string[]; envOverrides: Record<string, string>; applied?: Feature[]; dropped?: Drop[] };

const MODES = ['off', 'low', 'medium', 'high', 'max'] as const;
const ENGINES = ['claude-code', 'codex-cli', 'gemini-cli', 'pi-cli', 'grok-build'] as const;
const UNSUPPORTED = ['gemini-cli', 'pi-cli', 'grok-build'] as const;
const CODEX_VALUE: Record<(typeof MODES)[number], string> = { off: 'low', low: 'low', medium: 'medium', high: 'high', max: 'xhigh' };

const headless = (engine: string, extra: Record<string, unknown> = {}): Spec =>
  buildHeadlessLaunch(engine as never, { binaryPath: '/bin/engine', prompt: 'run the job', ...extra } as never) as Spec;
const interactive = (engine: string, extra: Record<string, unknown> = {}): Spec =>
  buildInteractiveLaunch(engine as never, {
    binaryPath: '/bin/engine', ...(engine === 'grok-build' ? { grokInteractiveOptIn: true } : {}), ...extra,
  } as never) as Spec;
const LANES = [['headless', headless], ['interactive', interactive]] as const;

/** Grok headless writes its prompt to a fresh mkdtemp path each call; normalise it for comparison. */
const norm = (s: Spec) => ({
  argv: s.argv.map((x) => x.replace(/.*\/grok-scratch-[^/]+\/prompt\.txt$/, '<grok-prompt>')),
  env: s.envOverrides,
});

function indicesOf(argv: string[], flag: string): number[] {
  return argv.flatMap((a, i) => (a === flag ? [i] : []));
}
/** The value following the single `--effort`; fails if there are zero or several. */
function effortValue(argv: string[]): string {
  const at = indicesOf(argv, '--effort');
  expect(at, `expected exactly one --effort in ${JSON.stringify(argv)}`).toHaveLength(1);
  expect(at[0] + 1, '--effort is the last argument').toBeLessThan(argv.length);
  return argv[at[0] + 1];
}
/** Index of the single `-c` whose next argument is a model_reasoning_effort assignment. */
function codexEffortIndex(argv: string[]): number {
  const at = argv.flatMap((a, i) => (a === '-c' && argv[i + 1]?.startsWith('model_reasoning_effort=') ? [i] : []));
  expect(at, `expected exactly one -c model_reasoning_effort=... pair in ${JSON.stringify(argv)}`).toHaveLength(1);
  expect(argv.filter((a) => a.includes('model_reasoning_effort')), 'model_reasoning_effort outside a -c pair').toHaveLength(1);
  return at[0];
}

describe('T2 5 modes x 5 engines x 2 builders', () => {
  for (const [lane, build] of LANES) {
    for (const engine of ENGINES) {
      for (const mode of MODES) {
        it(`${lane} ${engine} ${mode}`, () => {
          const base = build(engine);
          const s = build(engine, { thinkingMode: mode });
          if (engine === 'claude-code' && mode === 'off') {
            // D1: off rides the env channel; no flag.
            expect(s.argv).not.toContain('--effort');
            expect(s.envOverrides.MAX_THINKING_TOKENS).toBe('0');
            expect(s.argv).toEqual(base.argv);
            expect(s.applied).toEqual([{ feature: 'thinkingMode', requestedValue: 'off', value: 'MAX_THINKING_TOKENS=0', channel: 'env' }]);
            expect(s.dropped).toEqual([]);
          } else if (engine === 'claude-code') {
            expect(effortValue(s.argv)).toBe(mode);
            expect(s.envOverrides.MAX_THINKING_TOKENS).toBeUndefined();
            expect(s.applied).toEqual([{ feature: 'thinkingMode', requestedValue: mode, value: mode, channel: 'argv' }]);
            expect(s.dropped).toEqual([]);
          } else if (engine === 'codex-cli') {
            // D2: off -> low, max -> xhigh, both values carried.
            const i = codexEffortIndex(s.argv);
            expect(s.argv[i + 1]).toBe(`model_reasoning_effort=${JSON.stringify(CODEX_VALUE[mode])}`);
            expect(s.applied).toEqual([{ feature: 'thinkingMode', requestedValue: mode, value: CODEX_VALUE[mode], channel: 'argv' }]);
            expect(s.dropped).toEqual([]);
            // Removing exactly that pair gives back the absent-field argv.
            expect([...s.argv.slice(0, i), ...s.argv.slice(i + 2)]).toEqual(base.argv);
          } else {
            expect(norm(s)).toEqual(norm(base));
            expect(s.applied).toEqual([]);
            expect(s.dropped).toEqual([{ feature: 'thinkingMode', requestedValue: mode, reason: 'not-supported' }]);
          }
        });
      }
    }
  }
});

describe('T2 codex flag placement (headless): before -m <model> <prompt>', () => {
  for (const [label, extra] of [['default', {}], ['--oss local provider', { codexLocalProvider: 'ollama' }]] as const) {
    for (const mode of MODES) {
      it(`${label}, ${mode}`, () => {
        const s = headless('codex-cli', { thinkingMode: mode, ...extra });
        const i = codexEffortIndex(s.argv);
        const m = s.argv.lastIndexOf('-m');
        expect(m, 'no -m in the codex argv').toBeGreaterThan(-1);
        expect(i + 1, 'the reasoning-effort pair must sit before -m').toBeLessThan(m);
        // -m <model> <prompt> stays the tail, untouched.
        expect(s.argv.slice(m)).toEqual(headless('codex-cli', extra).argv.slice(headless('codex-cli', extra).argv.lastIndexOf('-m')));
        expect(s.argv[s.argv.length - 1]).toBe('run the job');
        if ('codexLocalProvider' in extra) {
          const oss = s.argv.indexOf('--oss');
          expect(oss).toBeGreaterThan(-1);
          expect(s.argv[oss + 1]).toBe('--local-provider');
          expect(s.argv[oss + 2]).toBe('ollama');
          expect(s.applied).toEqual([{ feature: 'thinkingMode', requestedValue: mode, value: CODEX_VALUE[mode], channel: 'argv' }]);
        }
      });
    }
  }
});

describe('T2 field absent: empty arrays on both builders, every engine', () => {
  for (const [lane, build] of LANES) {
    for (const engine of ENGINES) {
      it(`${lane} ${engine}`, () => {
        const s = build(engine);
        expect(s.applied).toEqual([]);
        expect(s.dropped).toEqual([]);
        expect(s.argv).not.toContain('--effort');
        expect(s.argv.some((a) => a.includes('model_reasoning_effort'))).toBe(false);
        expect(s.envOverrides.MAX_THINKING_TOKENS).toBeUndefined();
      });
    }
  }
});

describe('T2 clamp: an out-of-enum value is dropped as invalid with no requestedValue, on both builders', () => {
  const BAD: Array<[string, unknown]> = [['unknown word', 'ultra'], ['shell text', 'low; rm -rf /'], ['wrong case', 'LOW'], ['object', { evil: true }], ['number', 3], ['empty string', '']];
  for (const [lane, build] of LANES) {
    for (const engine of ENGINES) {
      for (const [label, bad] of BAD) {
        it(`${lane} ${engine}: ${label}`, () => {
          const s = build(engine, { thinkingMode: bad });
          expect(norm(s), 'an invalid value must not change the launch').toEqual(norm(build(engine)));
          expect(s.applied).toEqual([]);
          expect(s.dropped).toEqual([{ feature: 'thinkingMode', reason: 'invalid' }]);
          expect(s.dropped![0]).not.toHaveProperty('requestedValue');
        });
      }
    }
  }
});

describe('T2 direct effort pin precedence (D3), claude-code, both builders', () => {
  for (const [lane, build] of LANES) {
    for (const mode of MODES) {
      it(`${lane}: pin high beats thinkingMode ${mode}`, () => {
        const s = build('claude-code', { thinkingMode: mode, effort: 'high' });
        expect(effortValue(s.argv)).toBe('high');
        // The pin also suppresses the off env channel (interactive builder's existing policy).
        expect(s.envOverrides.MAX_THINKING_TOKENS).toBeUndefined();
        expect(s.applied).toEqual([]);
        expect(s.dropped).toEqual([{ feature: 'thinkingMode', requestedValue: mode, reason: 'overridden-by-effort-pin' }]);
        expect(norm(s)).toEqual(norm(build('claude-code', { effort: 'high' })));
      });
    }
    it(`${lane}: an invalid pin is no pin, so thinkingMode applies`, () => {
      const s = build('claude-code', { thinkingMode: 'low', effort: 'bogus' });
      expect(effortValue(s.argv)).toBe('low');
      expect(s.applied).toEqual([{ feature: 'thinkingMode', requestedValue: 'low', value: 'low', channel: 'argv' }]);
      expect(s.dropped).toEqual([]);
    });
  }
});

describe('T2 unsupported engines name every engine in the drop list', () => {
  it('the not-supported set is exactly gemini-cli, pi-cli, grok-build', () => {
    const notSupported = ENGINES.filter((e) => headless(e, { thinkingMode: 'low' }).dropped?.[0]?.reason === 'not-supported');
    expect(notSupported).toEqual([...UNSUPPORTED]);
  });
});
