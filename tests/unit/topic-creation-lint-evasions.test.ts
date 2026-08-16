/**
 * lint-no-unfunneled-topic-creation — evasion resistance.
 *
 * This lint guards the topic-creation chokepoint the "Bounded Notification
 * Surface" ceiling depends on: `TelegramAdapter.createForumTopic` is the ONE
 * place forum topics are born, and the last-resort auto-topic budget lives
 * inside it. A callsite that reaches the Bot API's `createForumTopic` method
 * directly bypasses that budget, which is how a topic flood ships.
 *
 * A peer-agent audit classified the check DEFEATABLE by ordinary renaming: it
 * was three line-anchored regexes anchored on the seam being SPELLED `apiCall`,
 * on a `method:` property key, or on a fully-literal URL. Eleven bypasses were
 * reproduced against it first; TEN were confirmed EVADING before this change,
 * and are the BYPASS cases below:
 *
 *   const call = adapter.apiCall.bind(adapter); call('createForumTopic', p);
 *   this['apiCall']('createForumTopic', p);           // computed seam access
 *   this.apiCall('createForum' + 'Topic', p);         // split literal
 *   const M = 'createForumTopic'; this.apiCall(M, p); // const indirection
 *   this.apiCall(\n 'createForumTopic',\n p);         // arg on its own line
 *   this.request('createForumTopic', p);              // seam under another name
 *   { 'method': 'createForumTopic' }                  // quoted property key
 *   { method: M }                                     // method via a const
 *   fetch(`${BASE}/createForumTopic`)                 // URL base in a variable
 *   import { apiCall as ac } from …; ac('createForumTopic', p);
 *
 * The eleventh — a backtick literal passed straight to `apiCall` — was already
 * caught, and is kept below as a regression control rather than dressed up as
 * a fix.
 *
 * The detector is driven DIRECTLY here rather than via the CLI's exit code —
 * a lint that CRASHES also exits 1, so exit-code-only assertions cannot tell
 * "caught it" from "died on startup".
 *
 * The CONTROL cases are the other half and matter more: this lint blocks
 * commits, so a widened rule that flags correct code is the more expensive
 * failure. They pin the shapes that must stay clean — funnel calls, property
 * keys, string-literal types, comments, other Bot-API methods, and prose that
 * merely mentions the name.
 */

import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import {
  collapseConcatenation,
  collectStringConstants,
  findShellViolations,
  findTopicCreationViolations,
  // @ts-expect-error — plain .js lint script, no type declarations
} from '../../scripts/lint-no-unfunneled-topic-creation.js';

const METHOD = 'createForumTopic';

describe('collapseConcatenation (pre-filter cannot be disarmed by splitting)', () => {
  it('folds a split literal so the parse pre-filter still fires', () => {
    expect(collapseConcatenation(`const M = 'create' + 'Forum' + 'Topic';`)).toContain(METHOD);
  });

  it('CONTROL: leaves unrelated text alone', () => {
    expect(collapseConcatenation(`const M = 'sendMessage';`)).toContain('sendMessage');
    expect(collapseConcatenation(`const M = 'sendMessage';`)).not.toContain(METHOD);
  });
});

describe('collectStringConstants (the seam name stops mattering)', () => {
  it('resolves a const, and a chain built from it, to a fixpoint', () => {
    const sourceFile = ts.createSourceFile(
      'f.ts',
      [`const A = 'createForum';`, "const B = A + 'Topic';", 'const C = B;'].join('\n'),
      ts.ScriptTarget.Latest,
      true,
    );
    const consts = collectStringConstants(sourceFile);
    expect(consts.get('B')).toBe(METHOD);
    expect(consts.get('C')).toBe(METHOD);
  });
});

/**
 * The three line-anchored regexes this replaces, verbatim. Keeping them here
 * turns "confirmed evading before the change" from a claim in a comment into
 * an assertion: every BYPASS source below is shown to slip past the OLD rules
 * and to be caught by the new detector, in the same file.
 */
const LEGACY_PATTERNS = [
  /apiCall\(\s*['"`]createForumTopic['"`]/,
  /\/bot[^\s'"`]*\/createForumTopic/,
  /method\s*:\s*['"`]createForumTopic['"`]/,
];
const legacyCatches = (src: string) =>
  src.split('\n').some((line) => LEGACY_PATTERNS.some((re) => re.test(line)));

/** Each bypass source, as it was reproduced against the shipped lint. */
const BYPASSES: Array<[string, string]> = [
  ['re-bound seam receiver', `const call = adapter.apiCall.bind(adapter);\nawait call('${METHOD}', p);`],
  ['computed seam access', `await this['apiCall']('${METHOD}', p);`],
  ['split literal', "await this.apiCall('createForum' + 'Topic', p);"],
  ['const indirection', `const M = '${METHOD}';\nawait this.apiCall(M, p);`],
  ['argument on its own line', `await this.apiCall(\n  '${METHOD}',\n  params,\n);`],
  ['seam under another name', `await this.request('${METHOD}', p);`],
  ['quoted method key', `await http.post(url, { 'method': '${METHOD}' });`],
  ['method value via const', `const M = '${METHOD}';\nawait http.post(url, { method: M });`],
  [
    'URL base in a variable',
    'const BASE = `https://api.telegram.org/bot${token}`;\nawait fetch(`${BASE}/createForumTopic`);',
  ],
  ['aliased seam import', `import { apiCall as ac } from './t.js';\nawait ac('${METHOD}', p);`],
];

describe('the bypasses FAIL without this change and pass with it', () => {
  for (const [name, src] of BYPASSES) {
    it(`${name}: evades the legacy regexes, caught by the AST detector`, () => {
      expect(legacyCatches(src)).toBe(false);
      expect(findTopicCreationViolations(src).length).toBeGreaterThan(0);
    });
  }

  it('CONTROL: the plain form was caught by the legacy regexes too — no credit claimed for it', () => {
    const plain = `await this.apiCall('${METHOD}', p);`;
    expect(legacyCatches(plain)).toBe(true);
    expect(findTopicCreationViolations(plain)).toHaveLength(1);
  });

  it('CONTROL: the legacy regexes flagged COMMENTS; the AST detector does not (fewer false positives)', () => {
    const comment = `// await this.apiCall('${METHOD}', p);`;
    expect(legacyCatches(comment)).toBe(true);
    expect(findTopicCreationViolations(comment)).toEqual([]);
  });
});

describe('findTopicCreationViolations — the reproduced bypasses', () => {
  it('CONTROL: the plain literal form is still caught', () => {
    expect(findTopicCreationViolations(`await this.apiCall('${METHOD}', p);`)).toHaveLength(1);
  });

  it('CONTROL (already caught before this change): a backtick literal argument', () => {
    expect(findTopicCreationViolations('await this.apiCall(`createForumTopic`, p);')).toHaveLength(1);
  });

  it('BYPASS 1: a RE-BOUND seam receiver is caught', () => {
    const src = ['const call = adapter.apiCall.bind(adapter);', `await call('${METHOD}', p);`].join('\n');
    expect(findTopicCreationViolations(src)).toHaveLength(1);
  });

  it('BYPASS 2: COMPUTED access to the seam is caught', () => {
    expect(findTopicCreationViolations(`await this['apiCall']('${METHOD}', p);`)).toHaveLength(1);
  });

  it('BYPASS 3: a SPLIT string literal is caught', () => {
    expect(findTopicCreationViolations("await this.apiCall('createForum' + 'Topic', p);")).toHaveLength(1);
    expect(findTopicCreationViolations("await this.apiCall('create' + 'Forum' + 'Topic', p);")).toHaveLength(1);
  });

  it('BYPASS 4: the method name hoisted into a CONST is caught', () => {
    const src = [`const M = '${METHOD}';`, 'await this.apiCall(M, p);'].join('\n');
    const hits = findTopicCreationViolations(src);
    // Both the declaration and the indirected call site are named.
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.map((h: { line: number }) => h.line)).toContain(2);
  });

  it('BYPASS 5: the argument on its OWN LINE is caught (the regexes were line-anchored)', () => {
    const src = ['await this.apiCall(', `  '${METHOD}',`, '  params,', ');'].join('\n');
    expect(findTopicCreationViolations(src)).toHaveLength(1);
  });

  it('BYPASS 6: a seam under ANOTHER NAME is caught', () => {
    expect(findTopicCreationViolations(`await this.request('${METHOD}', p);`)).toHaveLength(1);
    expect(findTopicCreationViolations(`await rpc('${METHOD}', p);`)).toHaveLength(1);
  });

  it('BYPASS 7: a QUOTED method property key is caught', () => {
    expect(findTopicCreationViolations(`await http.post(url, { 'method': '${METHOD}' });`)).toHaveLength(1);
  });

  it('BYPASS 8: a method property whose VALUE is a const is caught', () => {
    const src = [`const M = '${METHOD}';`, 'await http.post(url, { method: M });'].join('\n');
    expect(findTopicCreationViolations(src).map((h: { line: number }) => h.line)).toContain(2);
  });

  it('BYPASS 9: a URL whose BASE is a variable is caught', () => {
    const src = [
      'const BASE = `https://api.telegram.org/bot${token}`;',
      'await fetch(`${BASE}/createForumTopic`, { method: "POST" });',
    ].join('\n');
    expect(findTopicCreationViolations(src).map((h: { line: number }) => h.line)).toContain(2);
  });

  it('BYPASS 10: an ALIASED import of the seam is caught', () => {
    const src = [`import { apiCall as ac } from './telegram-api.js';`, `await ac('${METHOD}', p);`].join('\n');
    expect(findTopicCreationViolations(src)).toHaveLength(1);
  });

  it('a fully-literal Bot-API URL is still caught', () => {
    expect(
      findTopicCreationViolations('await fetch("https://api.telegram.org/bot123:abc/createForumTopic");'),
    ).toHaveLength(1);
  });
});

// ── The other direction. Widening the rule without these would swap a missed
//    violation for a wall of false ones on correct code — and this lint blocks
//    commits, so that is the more expensive failure.
describe('findTopicCreationViolations — CONTROLS: correct code stays clean', () => {
  it('CONTROL: a FUNNEL call is not flagged', () => {
    expect(
      findTopicCreationViolations(`const t = await adapter.createForumTopic('name', 5, { origin: 'system' });`),
    ).toEqual([]);
  });

  it('CONTROL: findOrCreateForumTopic is not flagged', () => {
    expect(findTopicCreationViolations(`await this.findOrCreateForumTopic('Attention', 7);`)).toEqual([]);
  });

  it('CONTROL: a re-bound FUNNEL method is not flagged', () => {
    const src = [
      'const createTopic = adapter.createForumTopic.bind(adapter);',
      `await createTopic('x', 5, { origin: 'user' });`,
    ].join('\n');
    expect(findTopicCreationViolations(src)).toEqual([]);
  });

  it('CONTROL: a property KEY lookup table is not flagged (src/messaging/invisible-payload.ts shape)', () => {
    expect(
      findTopicCreationViolations(`export const PARAM_BY_METHOD = { createForumTopic: 'name', sendMessage: 'text' };`),
    ).toEqual([]);
  });

  it('CONTROL: a string-literal TYPE is not flagged', () => {
    expect(findTopicCreationViolations(`type BotMethod = '${METHOD}' | 'sendMessage';`)).toEqual([]);
  });

  it('CONTROL: comments are not violations', () => {
    const src = [
      `// Historically this called apiCall('${METHOD}', …) directly.`,
      '/**',
      ` * method: '${METHOD}' was the hand-rolled form.`,
      ' */',
      'const x = 1;',
    ].join('\n');
    expect(findTopicCreationViolations(src)).toEqual([]);
  });

  it('CONTROL: other Bot-API methods are not flagged', () => {
    const src = [
      `await this.apiCall('sendMessage', p);`,
      `await this.apiCall('editForumTopic', p);`,
      `await this.apiCall('deleteForumTopic', p);`,
    ].join('\n');
    expect(findTopicCreationViolations(src)).toEqual([]);
  });

  it('CONTROL: prose MENTIONING the method is not flagged (only the exact name is)', () => {
    expect(findTopicCreationViolations(`throw new Error('${METHOD} budget exceeded for this source');`)).toEqual([]);
  });

  it('CONTROL: a file with no forum reference at all is not flagged', () => {
    expect(findTopicCreationViolations(`await this.apiCall('getUpdates', { offset });`)).toEqual([]);
  });
});

/**
 * The boundary, pinned rather than assumed. These assert the detector does NOT
 * catch things — so the limits are documented, and closing one properly makes
 * a test fail loudly instead of silently overstating what the check is worth.
 */
describe('KNOWN GAPS — pinned deliberately (see the lint header)', () => {
  it('a name assembled at RUNTIME is not caught (needs dataflow)', () => {
    expect(findTopicCreationViolations("await seam(['create','Forum','Topic'].join(''), p);")).toEqual([]);
  });

  it('a name imported from ANOTHER module is not caught (resolution is file-local)', () => {
    const src = [`import { M } from './names.js';`, 'await seam(M, p);'].join('\n');
    expect(findTopicCreationViolations(src)).toEqual([]);
  });

  it('COMPUTED member access on the method name is not caught — deliberate, the funnel shares the name', () => {
    expect(findTopicCreationViolations(`await client['${METHOD}'](p);`)).toEqual([]);
  });

  it('a shell name assembled across lines is not caught (.sh is text-checked)', () => {
    expect(findShellViolations('M=create\nM="${M}ForumTopic"\ncurl "$API/$M"')).toEqual([]);
  });
});

describe('beyond the reproduced set', () => {
  it('a URL base that does NOT resolve is still caught by the path segment', () => {
    expect(findTopicCreationViolations('await fetch(`${cfg.base}/createForumTopic`);')).toHaveLength(1);
  });

  it('the method name in a spread ARGUMENT ARRAY is caught', () => {
    const src = [`const a = ['${METHOD}', p];`, 'await seam(...a);'].join('\n');
    expect(findTopicCreationViolations(src).length).toBeGreaterThan(0);
  });
});

describe('findShellViolations (shell is checked as text — no parser)', () => {
  it('catches a curl to the Bot-API method', () => {
    expect(
      findShellViolations('curl -s -X POST "https://api.telegram.org/bot$TOKEN/createForumTopic" -d name=x'),
    ).toHaveLength(1);
  });

  it('catches a shell variable holding the method name', () => {
    expect(findShellViolations('M=createForumTopic\ncurl "$API/$M"')).toHaveLength(1);
  });

  it('CONTROL: a shell comment is not a violation', () => {
    expect(findShellViolations('# createForumTopic is the funnel method')).toEqual([]);
  });

  it('CONTROL: an unrelated curl is not flagged', () => {
    expect(findShellViolations('curl -s "https://api.telegram.org/bot$TOKEN/sendMessage" -d text=hi')).toEqual([]);
  });
});
