#!/usr/bin/env node
/**
 * lint-no-undefined-erasing-default-merge — structural guard for the
 * "undefined erases the default" class.
 *
 * `{ ...DEFAULTS, ...cfg }` looks like "fill in what the caller left out", but
 * object spread copies every OWN key — including one whose value is `undefined`.
 * Callers routinely build cfg objects as `{ tickIntervalMs: fooCfg.tickIntervalMs }`
 * from optional operator config, so an omitted field arrives as an explicit
 * `undefined` and REPLACES the default.
 *
 * 2026-09-21: exactly that made ContextWedgeSentinel call
 * `setInterval(tick, undefined)` — Node runs it every ~1ms — on every agent whose
 * config left `tickIntervalMs` unset. Each tick synchronously captured every live
 * session's tmux pane; an agent with five live conversations spent ~78% of its
 * main thread blocked, its 250ms Telegram send permits expired, and user replies
 * were held 5–25 minutes. The same class had already bitten SystemReviewer
 * (`disabledProbes: undefined` → TypeError), fixed locally with an inline filter;
 * nothing stopped the next constructor repeating it. This lint is what does.
 *
 * Rule (checked on the TypeScript AST, so regex literals, nested templates and
 * comments cannot desynchronise it):
 *   1. An object literal in which a spread whose expression text mentions
 *      "default" (case-insensitive — `DEFAULTS`, `DEFAULT_X`, `defaults`,
 *      `mod.DEFAULT_X`, `DEFAULT_LIMITS[k]`, `configDefaults`, `X_DEFAULTS`) is
 *      followed by ANY later spread.
 *   2. `Object.assign(target, …, <default-ish>, …, <later source>)`.
 * A `mergeDefaults(...)` call is the sanctioned form and never matches.
 * Use `mergeDefaults(DEFAULTS, cfg, …)` from `src/core/mergeDefaults.ts` —
 * identical semantics except an `undefined` value never erases the value to its
 * left.
 *
 * Structure > Willpower — a comment asking authors to remember is a wish; this
 * is the guarantee.
 *
 * Honest scope: the "default" in the name is the key. A defaults object held
 * under a name that does not say so (`{ ...base, ...cfg }`) is invisible here;
 * the naming convention is universal in src/ today.
 *
 * Exit codes: 0 clean · 1 violations · 2 could not inspect (nothing parsed —
 * an environment problem such as a missing `typescript`, never a clean result).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const SRC = path.join(REPO, 'src');

/** The helper itself documents the hazard it replaces. */
const EXEMPT = new Set([path.join('src', 'core', 'mergeDefaults.ts')]);

/**
 * Known, tracked exceptions — a file may carry AT MOST `max` violations. Any
 * further violation in the same file still fails. Each entry needs a reason and a
 * tracking id; remove the entry when the tracked work lands.
 */
export const ALLOWED = {
  [path.join('src', 'core', 'InboundDeliveryStore.ts')]: {
    max: 2,
    reason: 'Stage-B certified file (src/data/stageBCertifiedSet.ts): editing it requires a fresh approved canary + '
      + 'fingerprint rebind. Both merges take overrides from JSON config, which cannot carry undefined.',
    tracked: 'ACT-1291',
  },
};

const DEFAULTISH = /default/i;

let _ts = null;
function ts() {
  if (process.env.INSTAR_LINT_FORCE_PARSE_FAILURE === '1') {
    throw new Error('forced parse failure (INSTAR_LINT_FORCE_PARSE_FAILURE=1)');
  }
  if (!_ts) _ts = require('typescript');
  return _ts;
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** True for the sanctioned helper call — `mergeDefaults(...)` or `x.mergeDefaults(...)`. */
function isMergeDefaultsCall(t, expr) {
  let e = expr;
  while (t.isParenthesizedExpression(e) || t.isAsExpression(e) || t.isNonNullExpression(e)) e = e.expression;
  if (!t.isCallExpression(e)) return false;
  const callee = e.expression;
  return (t.isIdentifier(callee) && callee.text === 'mergeDefaults')
    || (t.isPropertyAccessExpression(callee) && callee.name.text === 'mergeDefaults');
}

/**
 * The NAME a merge source is referenced by: an identifier, a property/element
 * access chain (`mod.DEFAULT_X`, `this.configDefaults`, `DEFAULT_LIMITS[k]`), or
 * the callee of a factory call (`defaultCounters()`). Anything else — a
 * conditional, an inline object literal — has no name, so a field NAMED
 * `defaultModel` inside `...(m ? { defaultModel: m } : {})` never matches.
 */
function referenceName(t, expr, sf) {
  let e = expr;
  while (t.isParenthesizedExpression(e) || t.isAsExpression(e) || t.isNonNullExpression(e)
    || (t.isSatisfiesExpression && t.isSatisfiesExpression(e))) e = e.expression;
  if (t.isCallExpression(e)) e = e.expression;
  if (t.isElementAccessExpression(e)) e = e.expression;
  if (t.isIdentifier(e) || t.isPropertyAccessExpression(e)) return e.getText(sf);
  return null;
}

function isDefaultish(t, expr, sf) {
  if (isMergeDefaultsCall(t, expr)) return false;
  const name = referenceName(t, expr, sf);
  return name !== null && DEFAULTISH.test(name);
}

/**
 * Every violation in one source text, as {line, text}. `fileName` only picks the
 * parser dialect (.tsx vs .ts).
 */
export function scanSource(code, fileName = 'file.ts') {
  const t = ts();
  const sf = t.createSourceFile(fileName, code, t.ScriptTarget.Latest, true,
    fileName.endsWith('.tsx') ? t.ScriptKind.TSX : t.ScriptKind.TS);
  const hits = [];
  const report = (node) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    hits.push({ line: line + 1, text: node.getText(sf).replace(/\s+/g, ' ').trim().slice(0, 160) });
  };
  const visit = (node) => {
    if (t.isObjectLiteralExpression(node)) {
      const props = node.properties;
      const firstDefault = props.findIndex(p => t.isSpreadAssignment(p) && isDefaultish(t, p.expression, sf));
      if (firstDefault >= 0 && props.slice(firstDefault + 1).some(p => t.isSpreadAssignment(p))) report(node);
    } else if (t.isCallExpression(node)) {
      const callee = node.expression;
      if (t.isPropertyAccessExpression(callee) && callee.name.text === 'assign'
        && t.isIdentifier(callee.expression) && callee.expression.text === 'Object') {
        const sources = node.arguments.slice(1);
        const firstDefault = sources.findIndex(a => isDefaultish(t, a, sf));
        if (firstDefault >= 0 && firstDefault < sources.length - 1) report(node);
      }
    }
    t.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) process.exit(runLint());

function runLint() {
  const violations = [];
  let attempted = 0;
  let parsed = 0;
  for (const file of walk(SRC)) {
    const rel = path.relative(REPO, file);
    if (EXEMPT.has(rel)) continue;
    attempted++;
    let hits;
    try {
      hits = scanSource(fs.readFileSync(file, 'utf-8'), file);
      parsed++;
    } catch (err) {
      process.stderr.write(`[lint-no-undefined-erasing-default-merge] failed to parse ${rel}: ${err.message}\n`);
      continue;
    }
    const allowed = ALLOWED[rel];
    if (allowed && hits.length <= allowed.max) continue;
    for (const hit of hits) violations.push(`${rel}:${hit.line}  ${hit.text}`);
  }
  if (attempted > 0 && parsed === 0) {
    process.stderr.write('[lint-no-undefined-erasing-default-merge] COULD NOT INSPECT — no file parsed '
      + '(most often a missing `typescript` dependency — run `npm install`). This is not a clean result.\n');
    return 2;
  }
  if (violations.length > 0) {
    console.error('lint-no-undefined-erasing-default-merge: a defaults merge lets an `undefined` value erase a default.');
    console.error('Use mergeDefaults(DEFAULTS, cfg, …) from src/core/mergeDefaults.ts instead.\n');
    for (const v of violations) console.error(`  ${v}`);
    console.error(`\n${violations.length} violation(s).`);
    return 1;
  }
  console.log(`lint-no-undefined-erasing-default-merge: clean (${parsed} files)`);
  return 0;
}
