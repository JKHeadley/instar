/**
 * Static, parser-based skip/removal ratchet for local-verify (spec
 * local-verify-merge-authority.md §2 step 5).
 *
 * For each test file changed in the merge-base→head diff, both revisions are
 * parsed with the TypeScript parser and test registrations are counted:
 * call expressions of `it`/`test`/`describe`/`suite` (and `xit`/`xtest`/
 * `xdescribe`, `fit`/`fdescribe`), walking the member chain through modifiers
 * and parameterised `.each`/`.for` forms, so `it.concurrent.skip`,
 * `test.skip.each([...])(...)` and `it.skipIf(c)(...)` are all one registration.
 * A registration is a skip when its chain carries `.skip`/`.todo`/`.skipIf`/
 * `.runIf` or its root is `xit`/`xtest`/`xdescribe`. Runtime `ctx.skip()` /
 * `context.skip()` (any name bound to the first parameter of a test or
 * `beforeEach`/`beforeAll` callback, or a destructured `skip`) also count.
 * Comments and strings are never call expressions and never count.
 *
 * Stated limit (from the spec): tests registered through custom wrapper
 * functions are not seen.
 *
 * `typescript` is a devDependency of instar; it is present wherever a source
 * checkout exists (local-verify is repo-gated), but it is loaded lazily so that
 * importing this module never breaks a server that lacks it. Callers may also
 * inject the module.
 */

import { createRequire } from 'node:module';
import type * as TS from 'typescript';
import { isInventoried } from './inventory.js';

type TsModule = typeof TS;

let cachedTs: TsModule | null = null;
function loadTs(): TsModule {
  if (!cachedTs) {
    const req = createRequire(import.meta.url);
    cachedTs = req('typescript') as TsModule;
  }
  return cachedTs;
}

const TEST_ROOTS = new Set(['it', 'test', 'xit', 'xtest', 'fit']);
const SUITE_ROOTS = new Set(['describe', 'suite', 'xdescribe', 'fdescribe']);
const SKIP_ROOTS = new Set(['xit', 'xtest', 'xdescribe']);
const SKIP_MEMBERS = new Set(['skip', 'todo', 'skipIf', 'runIf']);
/** Members that keep a chain a registration. Anything else (`extend`, `scoped`, ...) is not one. */
const CHAIN_MEMBERS = new Set([
  'skip', 'todo', 'skipIf', 'runIf', 'only', 'each', 'for', 'concurrent', 'sequential', 'fails', 'shuffle',
]);
const CTX_HOOKS = new Set(['beforeEach', 'beforeAll', 'afterEach', 'aroundEach']);

export interface FileSkipCounts {
  /** it/test registrations (including skipped ones). */
  tests: number;
  /** describe/suite registrations. */
  suites: number;
  /** Skip-shaped registrations plus runtime ctx.skip() calls. */
  skips: number;
}

interface Chain {
  root: string;
  members: string[];
}

function chainOf(ts: TsModule, expr: TS.Expression): Chain | null {
  const members: string[] = [];
  let e: TS.Expression = expr;
  for (;;) {
    if (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) {
      e = e.expression;
    } else if (ts.isPropertyAccessExpression(e)) {
      members.unshift(e.name.text);
      e = e.expression;
    } else if (ts.isCallExpression(e)) {
      // `it.each(table)` / `it.skipIf(cond)` — the inner call's callee continues the chain.
      e = e.expression;
    } else if (ts.isTaggedTemplateExpression(e)) {
      e = e.tag;
    } else if (ts.isIdentifier(e)) {
      return { root: e.text, members };
    } else {
      return null;
    }
  }
}

function isRegistrationChain(c: Chain): boolean {
  if (!TEST_ROOTS.has(c.root) && !SUITE_ROOTS.has(c.root)) return false;
  return c.members.every((m) => CHAIN_MEMBERS.has(m));
}

/** True when this call is itself the callee of an outer call / tag (an inner `.each(table)` step). */
function isInnerChainStep(ts: TsModule, node: TS.CallExpression): boolean {
  let child: TS.Node = node;
  let p: TS.Node | undefined = node.parent;
  while (p && (ts.isParenthesizedExpression(p) || ts.isNonNullExpression(p))) {
    child = p;
    p = p.parent;
  }
  if (!p) return false;
  if (ts.isCallExpression(p) && p.expression === child) return true;
  if (ts.isTaggedTemplateExpression(p) && p.tag === child) return true;
  if (ts.isPropertyAccessExpression(p) && p.expression === child) return true;
  return false;
}

function countCtxSkips(ts: TsModule, fn: TS.SignatureDeclarationBase & { body?: TS.Node }): number {
  const first = fn.parameters[0];
  if (!first || !fn.body) return 0;
  const objNames = new Set<string>();
  const fnNames = new Set<string>();
  if (ts.isIdentifier(first.name)) {
    objNames.add(first.name.text);
  } else if (ts.isObjectBindingPattern(first.name)) {
    for (const el of first.name.elements) {
      const prop = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text
        : ts.isIdentifier(el.name) ? el.name.text : undefined;
      if (prop === 'skip' && ts.isIdentifier(el.name)) fnNames.add(el.name.text);
    }
  }
  let n = 0;
  const visit = (node: TS.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'skip'
        && ts.isIdentifier(callee.expression) && objNames.has(callee.expression.text)) n++;
      else if (ts.isIdentifier(callee) && fnNames.has(callee.text)) n++;
    }
    ts.forEachChild(node, visit);
  };
  visit(fn.body);
  return n;
}

function isFunctionLike(ts: TsModule, n: TS.Node): n is TS.ArrowFunction | TS.FunctionExpression {
  return ts.isArrowFunction(n) || ts.isFunctionExpression(n);
}

/** Count registrations and skips in one file's source text. */
export function countSkips(source: string, fileName = 'file.test.ts', tsModule?: TsModule): FileSkipCounts {
  const ts = tsModule ?? loadTs();
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: FileSkipCounts = { tests: 0, suites: 0, skips: 0 };
  const visit = (node: TS.Node): void => {
    if (ts.isCallExpression(node)) {
      const c = chainOf(ts, node.expression);
      if (c && isRegistrationChain(c) && !isInnerChainStep(ts, node)) {
        if (TEST_ROOTS.has(c.root)) out.tests++;
        else out.suites++;
        if (SKIP_ROOTS.has(c.root) || c.members.some((m) => SKIP_MEMBERS.has(m))) out.skips++;
        if (TEST_ROOTS.has(c.root)) {
          for (const a of node.arguments) if (isFunctionLike(ts, a)) out.skips += countCtxSkips(ts, a);
        }
      } else if (ts.isIdentifier(node.expression) && CTX_HOOKS.has(node.expression.text)) {
        for (const a of node.arguments) if (isFunctionLike(ts, a)) out.skips += countCtxSkips(ts, a);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

export interface ChangedTestFile {
  path: string;
  /** Source at the merge base; null when the file is added at head. */
  base: string | null;
  /** Source at head; null when the file is deleted at head. */
  head: string | null;
}

export interface SkipRatchetResult {
  netSkipsAdded: number;
  /** Net removed it/test registrations across the inventoried changed files. */
  netTestsRemoved: number;
  /** Net inventoried test files lost (deleted, or moved out of the inventory). */
  netFilesRemoved: number;
  deletedFiles: string[];
  skipsAdded: boolean;
  testsRemoved: boolean;
  perFile: Array<{ path: string; base: FileSkipCounts | null; head: FileSkipCounts | null }>;
}

/**
 * Evaluate the ratchet over the changed files. Pass every changed path that is
 * a test file on EITHER side (including paths outside the inventory, e.g. the
 * new location of a file moved into tests/fixtures/**); only inventoried
 * paths are counted, so a move out of the inventory is a loss.
 */
export function evaluateSkipRatchet(changed: readonly ChangedTestFile[], tsModule?: TsModule): SkipRatchetResult {
  const ts = tsModule ?? loadTs();
  let baseSkips = 0, headSkips = 0, baseTests = 0, headTests = 0, baseFiles = 0, headFiles = 0;
  const deletedFiles: string[] = [];
  const perFile: SkipRatchetResult['perFile'] = [];
  for (const f of changed) {
    if (!isInventoried(f.path)) continue;
    const b = f.base != null ? countSkips(f.base, f.path, ts) : null;
    const h = f.head != null ? countSkips(f.head, f.path, ts) : null;
    if (b) { baseSkips += b.skips; baseTests += b.tests; baseFiles++; }
    if (h) { headSkips += h.skips; headTests += h.tests; headFiles++; }
    if (b && !h) deletedFiles.push(f.path);
    perFile.push({ path: f.path, base: b, head: h });
  }
  const netSkipsAdded = headSkips - baseSkips;
  const netTestsRemoved = baseTests - headTests;
  const netFilesRemoved = baseFiles - headFiles;
  return {
    netSkipsAdded,
    netTestsRemoved,
    netFilesRemoved,
    deletedFiles,
    skipsAdded: netSkipsAdded > 0,
    testsRemoved: netTestsRemoved > 0 || netFilesRemoved > 0,
    perFile,
  };
}
