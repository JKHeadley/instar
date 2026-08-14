/**
 * lint-no-unbounded-llm-spawn — alias + namespace awareness.
 *
 * This lint guards a SAFETY floor: the host-wide spawn cap added after the
 * 2026-06-20 OOM fork-bomb (~230-289 concurrent LLM spawns, ~90-115GB). It
 * exists to stop a provider being constructed outside the capped funnel.
 *
 * It located its targets by matching the class NAME as literal text, so two
 * ordinary import styles walked straight past it:
 *
 *   import { ClaudeCliIntelligenceProvider as Provider } from '...';
 *   new Provider(...)                             // real, uncapped, invisible
 *
 *   import * as mod from '...';
 *   new mod.ClaudeCliIntelligenceProvider(...)    // `\bnew\s+Cls` cannot match
 *                                                 // across the `mod.`
 *
 * Found by a peer-agent audit for checks defeatable by renaming (the same class
 * of blindness fixed in PR #1872 for the ParallelActivityIndex invariant).
 *
 * These tests drive the detector DIRECTLY rather than asserting on the CLI's
 * exit code: a lint that CRASHES also exits 1, so an exit-code-only assertion
 * cannot tell "caught the violation" from "died on startup" (earned 2026-08-14,
 * round 7 — 11 of 15 assertions in another suite had that hole).
 */

import { describe, expect, it } from 'vitest';
import {
  findProviderConstructions,
  localProviderBindings,
  // @ts-expect-error — plain .js lint script, no type declarations
} from '../../scripts/lint-no-unbounded-llm-spawn.js';

const CLS = 'ClaudeCliIntelligenceProvider';

describe('localProviderBindings', () => {
  it('always includes the canonical name', () => {
    expect(localProviderBindings('const x = 1;', CLS)).toContain(CLS);
  });

  it('resolves `import { Cls as Alias }`', () => {
    const src = `import { ${CLS} as Provider } from '../core/x.js';`;
    expect(localProviderBindings(src, CLS)).toContain('Provider');
  });

  it('resolves `const { Cls: Alias } = await import(...)`', () => {
    const src = `const { ${CLS}: P } = await import('../core/x.js');`;
    expect(localProviderBindings(src, CLS)).toContain('P');
  });
});

describe('findProviderConstructions — the bypasses', () => {
  it('CONTROL: catches the plain construction (the case that always worked)', () => {
    const hits = findProviderConstructions(`const p = new ${CLS}({});`);
    expect(hits).toHaveLength(1);
    expect(hits[0].cls).toBe(CLS);
  });

  it('THE BYPASS: catches an ALIASED construction', () => {
    const src = [
      `import { ${CLS} as Provider } from '../core/x.js';`,
      'const p = new Provider({});',
    ].join('\n');
    const hits = findProviderConstructions(src);
    // Before this change: zero hits — a real uncapped spawn construction.
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(2);
  });

  it('THE BYPASS: catches a NAMESPACE construction', () => {
    const src = [
      "import * as mod from '../core/x.js';",
      `const p = new mod.${CLS}({});`,
    ].join('\n');
    const hits = findProviderConstructions(src);
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(2);
  });

  it('THE BYPASS: catches a destructured dynamic import under a new name', () => {
    const src = [
      `const { ${CLS}: Spawner } = await import('../core/x.js');`,
      'const p = new Spawner({});',
    ].join('\n');
    expect(findProviderConstructions(src)).toHaveLength(1);
  });

  // ── Found by a peer-agent SABOTAGE pass against the first version of this
  //    fix (2026-08-14). Both are SAME-FILE — squarely inside what the per-file
  //    approach claimed to close — and I had anticipated neither. The PR's
  //    class-closure declaration said only "re-export chains still evade",
  //    which covered three of the five evasions found and understated the gap.
  //    Snippets below are Codey's verbatim.

  it('SABOTAGE: a local re-binding — `const C = Cls; new C()` — is caught', () => {
    const src = [
      `import { ${CLS} } from './core.js';`,
      `const C = ${CLS};`,
      'const p = new C({});',
    ].join('\n');
    expect(findProviderConstructions(src)).toHaveLength(1);
  });

  it('SABOTAGE: a CHAIN of re-bindings cannot walk out of the set', () => {
    const src = [
      `import { ${CLS} } from './core.js';`,
      `const C = ${CLS};`,
      'const D = C;',
      'const p = new D({});',
    ].join('\n');
    expect(findProviderConstructions(src)).toHaveLength(1);
  });

  it('SABOTAGE: computed namespace access — `new NS[\'Cls\']()` — is caught', () => {
    const src = [
      "import * as Providers from './core.js';",
      `const p = new Providers['${CLS}']({});`,
    ].join('\n');
    expect(findProviderConstructions(src)).toHaveLength(1);
  });

  it('SABOTAGE: an aliased re-binding of an aliased import is caught', () => {
    const src = [
      `import { ${CLS} as Provider } from './core.js';`,
      'const Spawner = Provider;',
      'const p = new Spawner({});',
    ].join('\n');
    expect(findProviderConstructions(src)).toHaveLength(1);
  });

  it('KNOWN GAP, pinned honestly: a cross-module re-export chain still EVADES', () => {
    // Per-file text resolution cannot follow `export { Cls as X } from '...'`
    // in another module. Stated in PR #1874 and NOT closed here — this test
    // documents the boundary so a future reader does not assume otherwise.
    const consumer = ["import { X } from './reexport-a.js';", 'const p = new X({});'].join('\n');
    expect(findProviderConstructions(consumer)).toEqual([]);
  });

  // ── The other direction. Without these, a detector that flagged everything
  //    would pass every test above and be useless on a healthy tree.
  it('CONTROL: an IMPORT alone is not a construction', () => {
    const src = `import { ${CLS} as Provider } from '../core/x.js';`;
    expect(findProviderConstructions(src)).toEqual([]);
  });

  it('CONTROL: a comment mentioning the class is not a construction', () => {
    const src = [`// new ${CLS}({}) — documentation only`, ` * new ${CLS}({})`].join('\n');
    expect(findProviderConstructions(src)).toEqual([]);
  });

  it('CONTROL: an unrelated class with a similar name is not flagged', () => {
    expect(findProviderConstructions('const p = new SomeOtherProvider({});')).toEqual([]);
  });

  it('CONTROL: a bare identical-name variable is not a construction', () => {
    expect(findProviderConstructions(`const ${CLS} = 1;`)).toEqual([]);
  });

  it('CONTROL: re-binding an UNRELATED symbol is not flagged', () => {
    const src = ['const C = SomethingElse;', 'const p = new C({});'].join('\n');
    expect(findProviderConstructions(src)).toEqual([]);
  });
});
