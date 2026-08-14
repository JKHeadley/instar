/**
 * lint-no-unfunneled-headless-launch — evasion resistance.
 *
 * This lint guards a SAFETY FLOOR: the headless-launch funnel is the
 * resource/control boundary for spawned subprocesses, and the June-15 reroute
 * that keeps those spawns off the SDK credit pot lives behind it
 * (docs/specs/june15-headless-spawn-reroute.md, finding F5).
 *
 * A peer audit classed the check DEFEATABLE by ordinary renaming, stating the
 * bypass verbatim: "Export a wrapper or alias from an allowlisted module, then
 * call makeHeadlessLaunch(...) elsewhere; the non-funnel launch path is real,
 * but the name is gone."
 *
 * Reproduced against the SHIPPED check before this change, with a positive
 * control caught in the same run:
 *
 *   BYPASS B (the audit's, cross-module)  — 0 hits, `clean`, exit 0
 *   BYPASS C (namespace + split literal)  — 0 hits, `clean`, exit 0
 *   BYPASS A (aliased import)             — import line caught, CALL SITE blind
 *   positive control (plain import+call)  — caught, both lines
 *
 * B was additionally reproduced end-to-end in the real tree: appending
 * `export const makeHeadlessLaunch = buildHeadlessLaunch;` to the ALLOWLISTED
 * src/core/frameworkSessionLaunch.ts and calling that name from a new
 * src/core file left a live non-funnel launch path while the script printed
 * `clean`.
 *
 * The detectors are driven DIRECTLY here rather than only via the CLI's exit
 * code — a lint that CRASHES also exits 1, so exit-code-only assertions cannot
 * tell "caught it" from "died on startup". The CLI cases below assert on
 * stderr CONTENT for the same reason.
 *
 * The second half of this file is not optional. This lint blocks commits, so a
 * widening that flags correct code is worse than the hole: a noisy check gets
 * switched off. Every control below is a shape that MUST stay clean.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CANONICAL,
  collapseConcatenation,
  collectFunnelAliasExports,
  collectLocalBindings,
  findHeadlessLaunchViolations,
  readAllowlistSources,
  // @ts-expect-error — plain .js lint script, no type declarations
} from '../../scripts/lint-no-unfunneled-headless-launch.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LINT_SCRIPT = path.join(REPO_ROOT, 'scripts', 'lint-no-unfunneled-headless-launch.js');

/** The allowlisted module that hands the alias out, as the bypass has it. */
const FUNNEL_MODULE = 'src/core/frameworkSessionLaunch.ts';
const aliasFrom = (body: string) =>
  collectFunnelAliasExports([{ path: FUNNEL_MODULE, content: body }]) as Map<string, string>;

const NO_ALIASES = new Map<string, string>();

function runLint(...args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('node', [LINT_SCRIPT, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Direction 1 — the bypasses are caught
// ─────────────────────────────────────────────────────────────────────────

describe('collectFunnelAliasExports — what the closed allowlist hands out', () => {
  it('finds a direct re-binding export (the audit bypass, alias form)', () => {
    const aliases = aliasFrom(`export const makeHeadlessLaunch = ${CANONICAL};`);
    expect(aliases.get('makeHeadlessLaunch')).toBe(FUNNEL_MODULE);
  });

  it('finds a renamed re-export', () => {
    expect(aliasFrom(`export { ${CANONICAL} as mkLaunch };`).has('mkLaunch')).toBe(true);
  });

  it('finds a pass-through wrapper (the audit bypass, wrapper form)', () => {
    const src = `export function makeHeadlessLaunch(fw, o) { return ${CANONICAL}(fw, o); }`;
    expect(aliasFrom(src).has('makeHeadlessLaunch')).toBe(true);
  });

  it('finds an arrow pass-through', () => {
    expect(aliasFrom(`export const mk = (fw, o) => ${CANONICAL}(fw, o);`).has('mk')).toBe(true);
  });

  it('closes to a fixpoint: an alias of an alias', () => {
    const src = [`const inner = ${CANONICAL};`, 'const outer = inner;', 'export const mk = outer;'].join('\n');
    expect(aliasFrom(src).has('mk')).toBe(true);
  });

  it('closes across modules: one allowlisted module re-exporting another\'s alias', () => {
    const aliases = collectFunnelAliasExports([
      { path: FUNNEL_MODULE, content: `export const mkA = ${CANONICAL};` },
      { path: 'src/core/SessionManager.ts', content: `import { mkA } from './frameworkSessionLaunch.js';\nexport const mkB = mkA;` },
    ]) as Map<string, string>;
    expect(aliases.has('mkA')).toBe(true);
    expect(aliases.has('mkB')).toBe(true);
  });
});

describe('findHeadlessLaunchViolations — the reproduced bypasses', () => {
  it('CONTROL: the plain form is still caught, at import AND call', () => {
    const src = [
      `import { ${CANONICAL} } from '../core/frameworkSessionLaunch.js';`,
      `export const s = ${CANONICAL}(fw, o);`,
    ].join('\n');
    expect(findHeadlessLaunchViolations(src, NO_ALIASES)).toHaveLength(2);
  });

  it('BYPASS A: an ALIASED import — the call site was blind, now caught', () => {
    const src = [
      `import { ${CANONICAL} as mkLaunch } from '../core/frameworkSessionLaunch.js';`,
      'export const s = mkLaunch(fw, o);',
    ].join('\n');
    const hits = findHeadlessLaunchViolations(src, NO_ALIASES);
    // Confirmed EVADING at line 2 before this change (the import line alone caught).
    expect(hits.map((h: { line: number }) => h.line)).toEqual([1, 2]);
  });

  it('BYPASS B: the audit\'s verbatim cross-module alias — was 0 hits', () => {
    const aliases = aliasFrom(`export const makeHeadlessLaunch = ${CANONICAL};`);
    const src = [
      "import { makeHeadlessLaunch } from '../core/frameworkSessionLaunch.js';",
      'export const s = makeHeadlessLaunch(fw, o);',
    ].join('\n');
    const hits = findHeadlessLaunchViolations(src, aliases);
    // Confirmed EVADING (zero hits, exit 0) before this change.
    expect(hits).toHaveLength(2);
    expect(hits[0].msg).toContain('resolves to buildHeadlessLaunch');
  });

  it('BYPASS C: namespace import + computed access over a SPLIT literal — was 0 hits', () => {
    const src = [
      "import * as m from '../core/frameworkSessionLaunch.js';",
      "const fn = m['buildHeadless' + 'Launch'];",
      'export const s = fn(fw, o);',
    ].join('\n');
    const hits = findHeadlessLaunchViolations(src, NO_ALIASES);
    // Confirmed EVADING (zero hits, exit 0) before this change.
    expect(hits.map((h: { line: number }) => h.line)).toEqual([2, 3]);
  });

  it.each([
    ['returned', `export function f() { return m['buildHeadless' + 'Launch'](fw, o); }`],
    ['bare statement', `m['buildHeadless' + 'Launch'](fw, o);`],
    ['object property', `export const reg = { launch: m['buildHeadless' + 'Launch'] };`],
  ])('a computed call over a split literal, NOT in a binding: %s', (_label, body) => {
    // Found by mutation, twice. Removing the per-line concatenation collapse
    // left the whole suite green: every computed case written as
    // `const x = m['a'+'b'](…)` is caught by the BINDING rule instead, so it
    // proves nothing about that line. These three have no binding to catch
    // them, and are the only cases that actually red when it is removed.
    const src = ["import * as m from '../core/frameworkSessionLaunch.js';", body].join('\n');
    expect(findHeadlessLaunchViolations(src, NO_ALIASES).map((h: { line: number }) => h.line)).toEqual([2]);
  });

  it('a re-binding CHAIN off an alias import closes too', () => {
    const aliases = aliasFrom(`export const makeHeadlessLaunch = ${CANONICAL};`);
    const src = [
      "import { makeHeadlessLaunch } from '../core/frameworkSessionLaunch.js';",
      'const a = makeHeadlessLaunch;',
      'const b = a;',
      'export const s = b(fw, o);',
    ].join('\n');
    expect(findHeadlessLaunchViolations(src, aliases)).toHaveLength(4);
  });

  it('a { X: alias } destructure off a dynamic import is caught', () => {
    const src = [
      `const { ${CANONICAL}: mk } = await import('../core/frameworkSessionLaunch.js');`,
      'export const s = mk(fw, o);',
    ].join('\n');
    expect(findHeadlessLaunchViolations(src, NO_ALIASES)).toHaveLength(2);
  });

  it('a namespace MEMBER re-binding is caught', () => {
    const src = [
      "import * as m from '../core/frameworkSessionLaunch.js';",
      `const mk = m.${CANONICAL};`,
      'export const s = mk(fw, o);',
    ].join('\n');
    expect(findHeadlessLaunchViolations(src, NO_ALIASES)).toHaveLength(2);
  });
});

describe('collapseConcatenation', () => {
  it('folds a split literal so computed access cannot hide the name', () => {
    expect(collapseConcatenation(`m['buildHeadless' + 'Launch']`)).toContain(CANONICAL);
  });

  it('folds a chain', () => {
    expect(collapseConcatenation(`m['build' + 'Headless' + 'Lau' + 'nch']`)).toContain(CANONICAL);
  });

  it('CONTROL: leaves unrelated text alone', () => {
    const out = collapseConcatenation(`const s = 'spawn' + 'Session';`);
    expect(out).toContain('spawnSession');
    expect(out).not.toContain(CANONICAL);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Direction 2 — OPPOSITE-DIRECTION CONTROLS. Correct code must stay clean.
// ─────────────────────────────────────────────────────────────────────────

describe('CONTROLS — shapes that must NOT be flagged', () => {
  it('a comment is not a call', () => {
    const src = [
      `// model tiers resolve per-framework inside ${CANONICAL}`,
      ` * see ${CANONICAL} for the headless spec`,
      `/* ${CANONICAL} is the builder */`,
      `# shell comment about ${CANONICAL}`,
      'export const x = 1;',
    ].join('\n');
    expect(findHeadlessLaunchViolations(src, NO_ALIASES)).toHaveLength(0);
  });

  it('an unrelated similar NAME is not the symbol', () => {
    const src = [
      'export const a = buildHeadlessLaunchTelemetry(x);',
      'export const b = rebuildHeadlessLaunch(x);',
      'export const c = makeHeadlessLaunchers(x);',
      'export const d = buildHeadlessLaunch2(x);',
    ].join('\n');
    expect(findHeadlessLaunchViolations(src, aliasFrom(`export const makeHeadlessLaunch = ${CANONICAL};`))).toHaveLength(0);
  });

  it('an unrelated RE-BINDING is not absorbed', () => {
    const src = ['const mk = somethingElse;', 'const mk2 = mk;', 'export const s = mk2(fw);'].join('\n');
    expect(findHeadlessLaunchViolations(src, NO_ALIASES)).toHaveLength(0);
    expect([...(collectLocalBindings(src, NO_ALIASES) as { names: Set<string> }).names]).toEqual([CANONICAL]);
  });

  it('a LOCALLY DEFINED function that happens to share an alias name is not the funnel\'s', () => {
    // The sharpest false positive available: the alias set is global to the
    // repo, so a same-named local helper must not be absorbed. Only a name
    // IMPORTED from the module that hands it out counts.
    const aliases = aliasFrom(`export const makeHeadlessLaunch = ${CANONICAL};`);
    const src = [
      'function makeHeadlessLaunch(a, b) { return { a, b }; }',
      'export const s = makeHeadlessLaunch(1, 2);',
    ].join('\n');
    expect(findHeadlessLaunchViolations(src, aliases)).toHaveLength(0);
  });

  it('the same alias name imported from an UNRELATED module is not the funnel\'s', () => {
    const aliases = aliasFrom(`export const makeHeadlessLaunch = ${CANONICAL};`);
    const src = [
      "import { makeHeadlessLaunch } from './someUnrelatedHelper.js';",
      'export const s = makeHeadlessLaunch(fw, o);',
    ].join('\n');
    expect(findHeadlessLaunchViolations(src, aliases)).toHaveLength(0);
  });

  it('a REAL-WORK exported function in an allowlisted module is NOT an alias', () => {
    // This is the control that keeps the fix from becoming a false-positive
    // storm: the funnel itself calls the builder. If "any exported function
    // that touches it" counted, every caller of spawnSession() would be
    // flagged, and the check would be switched off within a day.
    const src = [
      'export async function spawnSession(o) {',
      '  const gate = await checkQuota(o);',
      '  if (!gate.ok) return null;',
      `  const spec = ${CANONICAL}(o.framework, o);`,
      '  return launch(spec);',
      '}',
    ].join('\n');
    expect([...aliasFrom(src).keys()]).toEqual([]);
  });

  it('the LIVE allowlist mints no alias today — spawnSession is not absorbed', () => {
    const aliases = collectFunnelAliasExports(readAllowlistSources(REPO_ROOT)) as Map<string, string>;
    expect([...aliases.keys()]).toEqual([]);
  });

  it('an ordinary spawn through the funnel stays clean', () => {
    const src = [
      "import { SessionManager } from '../core/SessionManager.js';",
      'export const s = await sessionManager.spawnSession({ framework: fw });',
    ].join('\n');
    expect(findHeadlessLaunchViolations(src, NO_ALIASES)).toHaveLength(0);
  });

  it('a whole real source file with no reference is clean', () => {
    const real = fs.readFileSync(path.join(REPO_ROOT, 'src/core/StateManager.ts'), 'utf-8');
    expect(findHeadlessLaunchViolations(real, NO_ALIASES)).toHaveLength(0);
  });
});

describe('RESIDUALS — pinned as still open, so the boundary is documented not assumed', () => {
  it('a NON-pass-through wrapper in an allowlisted module is not an alias', () => {
    // Deliberate, and the price of the control above: two statements instead
    // of one puts it on the funnel's side of the line. Closing it needs a
    // "does this do real work" judgment that a lint blocking commits should
    // not be making. Pinned so a future reader sees a decision, not a miss.
    const src = `export function mk(fw, o) { const x = ${CANONICAL}(fw, o); return x; }`;
    expect([...aliasFrom(src).keys()]).toEqual([]);
  });

  it('a computed member built at RUNTIME is not resolvable', () => {
    const src = [
      "import * as m from '../core/frameworkSessionLaunch.js';",
      'const mk = m[process.env.K];',
      'export const s = mk(fw, o);',
    ].join('\n');
    expect(findHeadlessLaunchViolations(src, NO_ALIASES)).toHaveLength(0);
  });

  it('re-assignment after declaration is caught at the assignment, NOT at the call', () => {
    const hits = findHeadlessLaunchViolations(
      ['let mk;', `mk = ${CANONICAL};`, 'export const s = mk(fw, o);'].join('\n'),
      NO_ALIASES,
    );
    expect(hits.map((h: { line: number }) => h.line)).toEqual([2]); // line 3 is not reached
  });

  it('a BARREL re-export breaks the chain at the barrel — worth knowing', () => {
    // The barrel is not allowlisted, so re-exporting the alias through it is
    // itself a violation. A consumer importing from the barrel is not checked,
    // but the chain cannot be built without failing here first.
    const aliases = aliasFrom(`export const makeHeadlessLaunch = ${CANONICAL};`);
    const barrel = "export { makeHeadlessLaunch } from './frameworkSessionLaunch.js';";
    expect(findHeadlessLaunchViolations(barrel, aliases)).toHaveLength(1);
  });
});

describe('an IMPORT is deliberately a violation here (not a widening)', () => {
  it('flags the import even with no call, by the shipped rule', () => {
    // Unlike its sibling lints, this check treats the import itself as the
    // violation: there is no legitimate non-funnel consumer of the headless
    // builder, so the door is the right place to stop it. Asserted so the
    // semantic is deliberate rather than incidental.
    const src = `import { ${CANONICAL} } from '../core/frameworkSessionLaunch.js';`;
    expect(findHeadlessLaunchViolations(src, NO_ALIASES)).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// End-to-end: the CLI, asserted on OUTPUT (a crash also exits 1)
// ─────────────────────────────────────────────────────────────────────────

describe('CLI', () => {
  it('the real tree is clean, and says so on stdout', () => {
    const r = runLint();
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('lint-no-unfunneled-headless-launch: clean');
    expect(r.code).toBe(0);
  });

  it('importing the detectors does NOT run the scan (direct-invocation guard)', () => {
    // Without the guard, importing this module would run the walk and could
    // process.exit(1), killing the whole test run the moment the repo had a
    // violation. Proven by importing it and observing we are still alive.
    expect(typeof findHeadlessLaunchViolations).toBe('function');
    expect(typeof collectFunnelAliasExports).toBe('function');
  });
});
