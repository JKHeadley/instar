import { describe, it, expect } from 'vitest';
import {
  foldAdjacentLiterals,
  collectStringConsts,
  resolveLine,
  scanFile,
} from '../../scripts/lint-no-unfunneled-topic-creation.js';

/**
 * `lint-no-unfunneled-topic-creation` guards the Bounded Notification Surface —
 * the last-resort budget on automatically-created Telegram topics, added after
 * the THIRD topic-spam incident. Its three rules each required `createForumTopic`
 * as a string LITERAL adjacent to the seam, so lifting the name into a named
 * constant walked straight past a safety floor while making the code tidier.
 *
 * THE DEFECT tests fail against the shipped lint. The CONTROL tests pass against
 * BOTH, which is what makes them controls rather than echoes: this lint blocks
 * commits, so a version that flags correct code would be worse than the hole.
 *
 * These tests can only import this module because it now carries a
 * direct-invocation guard. Without it, importing runs the whole repo scan and
 * calls process.exit(1) on the first real violation, killing the test run.
 */

const CATCHABLE = (src: string) => scanFile('src/probe.ts', src).length > 0;

describe('THE DEFECT — a resolved name reaches the Bot API unseen', () => {
  it('catches a method name lifted into a local const', () => {
    expect(
      CATCHABLE('const M = "createForumTopic";\nawait apiCall(M, { name: "x" });\n'),
    ).toBe(true);
  });

  it('catches a method name split across a literal concatenation', () => {
    expect(CATCHABLE('await apiCall("createForum" + "Topic", { name: "x" });\n')).toBe(true);
  });

  it('catches a const reaching the hand-rolled `method:` param', () => {
    expect(
      CATCHABLE('const M = "createForumTopic";\nconst p = { method: M, name: "x" };\n'),
    ).toBe(true);
  });

  it('catches let and var bindings, not only const', () => {
    expect(CATCHABLE('let M = "createForumTopic";\napiCall(M, {});\n')).toBe(true);
    expect(CATCHABLE('var M = "createForumTopic";\napiCall(M, {});\n')).toBe(true);
  });

  it('resolves a const declared AFTER its use — the scan is per file, not per line', () => {
    expect(CATCHABLE('apiCall(M, {});\nconst M = "createForumTopic";\n')).toBe(true);
  });
});

describe('CONTROL — the plain forms the shipped lint already caught still fire', () => {
  it('still catches the bare literal', () => {
    expect(CATCHABLE('await apiCall("createForumTopic", { name: "x" });\n')).toBe(true);
  });

  it('still catches the raw Bot-API URL form', () => {
    expect(CATCHABLE('const u = "https://api.telegram.org/bot123/createForumTopic";\n')).toBe(true);
  });

  it('still catches the literal `method:` param', () => {
    expect(CATCHABLE('const p = { method: "createForumTopic" };\n')).toBe(true);
  });
});

describe('CONTROL — correct code stays legal (over-block is the dominant risk)', () => {
  it('does not flag a const bound to a different method', () => {
    expect(CATCHABLE('const M = "sendMessage";\napiCall(M, {});\n')).toBe(false);
  });

  it('does not flag an identifier that never reaches a seam', () => {
    expect(CATCHABLE('const M = "createForumTopic";\nexport const label = M.length;\n')).toBe(false);
  });

  it('does not flag an identifier bound twice to DIFFERENT values — unresolvable', () => {
    // Ambiguity must fail toward NOT flagging. Substituting either value would
    // be a guess, and a guess that fails a build is the expensive direction.
    expect(
      CATCHABLE('const M = "createForumTopic";\nlet M = "sendMessage";\napiCall(M, {});\n'),
    ).toBe(false);
  });

  it('does not fold a concatenation that involves an identifier', () => {
    // `'createForum' + suffix` is not resolvable without dataflow. Folding it
    // would mean inventing text the source never contains.
    expect(CATCHABLE('apiCall("createForum" + suffix, {});\n')).toBe(false);
  });

  it('does not flag a longer name that merely starts with the method', () => {
    expect(CATCHABLE('const M = "createForumTopicIconStickers";\napiCall(M, {});\n')).toBe(false);
  });

  it('does not substitute globally — only at the two seam positions', () => {
    // An unrelated call taking the same identifier must not become a violation
    // just because the value matches somewhere else in the file.
    expect(CATCHABLE('const M = "createForumTopic";\nlogger.debug(M);\n')).toBe(false);
  });
});

describe('the resolution primitives, pinned directly', () => {
  it('folds only ADJACENT literals and invents no text', () => {
    expect(foldAdjacentLiterals('"a" + "b"')).toContain('ab');
    expect(foldAdjacentLiterals('"a" + b')).toBe('"a" + b');
  });

  it('drops an identifier with conflicting bindings rather than picking one', () => {
    const consts = collectStringConsts(['const M = "one";', 'const M = "two";']);
    expect(consts.has('M')).toBe(false);
  });

  it('keeps an identifier bound twice to the SAME value', () => {
    const consts = collectStringConsts(['const M = "one";', 'const M = "one";']);
    expect(consts.get('M')).toBe('one');
  });

  it('leaves a line untouched when nothing resolves', () => {
    const line = 'apiCall(unknownIdent, {});';
    expect(resolveLine(line, collectStringConsts([]))).toBe(line);
  });
});
