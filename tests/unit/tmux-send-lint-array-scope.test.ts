import { describe, it, expect } from 'vitest';
import {
  stripComments,
  collectStringConsts,
  arrayRegions,
  scanSource,
} from '../../scripts/lint-no-unfunneled-tmux-literal-send.js';

/**
 * `lint-no-unfunneled-tmux-literal-send` guards the `send-keys -l` argv ceiling.
 * On 2026-08-04 a ~40 KB prompt blew that ceiling and took down the whole
 * internal-LLM substrate on one machine: the breaker misread the opaque send
 * error as a rate limit and tripped 14 consecutive times while ten LLM-backed
 * components sat at 76-100% error rate.
 *
 * The check required `send-keys` and `'-l'` on the SAME LINE, so four plain
 * literal forms evaded it. THE DEFECT tests fail against that behaviour. The
 * CONTROL tests pass against BOTH — this lint blocks commits, so a version that
 * flags correct code would be worse than the hole it closes.
 *
 * These tests can import the module only because it now carries a
 * direct-invocation guard; before, importing ran the whole src/ scan and could
 * call process.exit(1), killing the test run.
 */

const flags = (src: string) => scanSource(src).length > 0;

describe('THE DEFECT — plain literal sends that walked past a line-oriented check', () => {
  it('catches a multi-line argv array — the form any formatter produces', () => {
    // The one that matters: nobody has to try. Prettier writes this.
    expect(flags('const a = [\n  "send-keys",\n  "-l",\n  payload,\n];\n')).toBe(true);
  });

  it('catches the -l flag lifted into a constant', () => {
    expect(flags('const F = "-l";\nconst a = ["send-keys", F, payload];\n')).toBe(true);
  });

  it('catches the send-keys verb lifted into a constant', () => {
    expect(flags('const C = "send-keys";\nconst a = [C, "-l", payload];\n')).toBe(true);
  });

  it('is not silenced by merely NAMING the funnel in a comment', () => {
    // Worse in kind than the others: `// TODO: use buildLiteralSendArgs` beside a
    // raw send silenced the very guard the TODO was admitting was needed.
    expect(flags('const a = ["send-keys", "-l", p]; // TODO: buildLiteralSendArgs\n')).toBe(true);
  });

  it('catches both spellings together — multi-line AND a resolved constant', () => {
    expect(flags('const F = "-l";\nconst a = [\n  "send-keys",\n  F,\n  payload,\n];\n')).toBe(true);
  });
});

describe('CONTROL — the one-line form the shipped check already caught still fires', () => {
  it('still catches the plain single-line argv', () => {
    expect(flags('const a = ["send-keys", "-l", payload];\n')).toBe(true);
  });
});

describe('CONTROL — correct code stays legal (over-block is the dominant risk)', () => {
  it('does not flag send-keys without the -l flag', () => {
    expect(flags('const a = ["send-keys", "Enter"];\n')).toBe(false);
  });

  it('does not flag a genuinely funnelled call', () => {
    expect(flags('const a = buildLiteralSendArgs(target, payload);\n')).toBe(false);
  });

  it('does not join two SEPARATE arrays into one violation', () => {
    // The whole reason the unit is the bracket-matched array and not a line
    // window: an unrelated ["ls", "-l"] must not complete a send-keys array.
    expect(flags('const a = ["send-keys", "Enter"];\nconst b = ["ls", "-l"];\n')).toBe(false);
  });

  it('does not flag a constant bound to a different flag', () => {
    expect(flags('const F = "-x";\nconst a = ["send-keys", F, p];\n')).toBe(false);
  });

  it('does not flag an example that lives entirely inside a comment', () => {
    expect(flags('// example: ["send-keys", "-l", payload]\nconst a = 1;\n')).toBe(false);
  });

  it('does not flag an identifier bound twice to DIFFERENT values — unresolvable', () => {
    // Ambiguity must fail toward NOT flagging. Substituting either value is a
    // guess, and a guess that fails a build is the expensive direction.
    expect(flags('const F = "-l";\nlet F = "-x";\nconst a = ["send-keys", F, p];\n')).toBe(false);
  });
});

describe('the primitives, pinned directly', () => {
  it('strips comments without touching string contents, preserving line numbers', () => {
    const out = stripComments('const s = "// not a comment";\n// real\nconst t = 1;\n');
    expect(out).toContain('// not a comment');
    expect(out).not.toContain('real');
    expect(out.split('\n').length).toBe(4);
  });

  it('drops an identifier with conflicting bindings rather than picking one', () => {
    expect(collectStringConsts('const M = "a";\nconst M = "b";\n').has('M')).toBe(false);
  });

  it('keeps an identifier bound twice to the SAME value', () => {
    expect(collectStringConsts('const M = "a";\nconst M = "a";\n').get('M')).toBe('a');
  });

  it('matches nested arrays as one region and reports the opening line', () => {
    const regions = arrayRegions('const a = 1;\nconst b = ["x", ["y"], "z"];\n');
    expect(regions.length).toBeGreaterThan(0);
    expect(regions[0].line).toBe(2);
    expect(regions[0].text).toContain('"y"');
  });

  it('yields no region for an unbalanced bracket — fails toward NOT flagging', () => {
    expect(arrayRegions('const a = ["send-keys", "-l"\n').length).toBe(0);
  });

  it('ignores a bracket that appears inside a string', () => {
    const regions = arrayRegions('const a = "[not an array";\nconst b = ["x"];\n');
    expect(regions.length).toBe(1);
    expect(regions[0].line).toBe(2);
  });
});
