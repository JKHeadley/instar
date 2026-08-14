#!/usr/bin/env node
/**
 * lint-no-unfunneled-headless-launch.js — refuses direct `buildHeadlessLaunch`
 * use outside the subscription-path funnel.
 *
 * Part of the June-15 readiness arc (docs/specs/june15-headless-spawn-reroute.md,
 * review finding F5 — Structure > Willpower). After 2026-06-15, a headless
 * `claude -p` one-shot bills the Agent SDK credit pot. The reroute that sends
 * those spawns down the subscription lane lives in ONE funnel:
 * `SessionManager.spawnSession()`. A future callsite that imports
 * `buildHeadlessLaunch` directly bypasses the reroute — silently
 * re-introducing SDK-pot traffic that fails hard when the pot drains. That
 * bypass must fail CI, not be discovered on the bill.
 *
 * Rule: outside the allowlist below, no source file may reference
 * `buildHeadlessLaunch` (import OR call — an import is the bypass's first
 * commit, flag it at the door), NOR any name an allowlisted module hands out
 * that resolves to it.
 *
 * ── Evasion resistance (2026-08-14) ──────────────────────────────────────
 * A peer audit classed this check DEFEATABLE and SAFETY-FLOOR, with this
 * bypass stated verbatim: "Export a wrapper or alias from an allowlisted
 * module, then call makeHeadlessLaunch(...) elsewhere; the non-funnel launch
 * path is real, but the name is gone."
 *
 * Both halves were reproduced against the shipped check before this change,
 * with a positive control caught in the same run:
 *
 *   // in src/core/frameworkSessionLaunch.ts — ALLOWLISTED, so free
 *   export const makeHeadlessLaunch = buildHeadlessLaunch;
 *   // anywhere else — shipped lint said "clean", exit 0
 *   import { makeHeadlessLaunch } from './frameworkSessionLaunch.js';
 *   makeHeadlessLaunch(fw, opts);
 *
 *   import * as m from './frameworkSessionLaunch.js';   // computed + split literal
 *   const fn = m['buildHeadless' + 'Launch'];
 *   fn(fw, opts);
 *
 * The first was reproduced end-to-end in the real tree: a live non-funnel
 * launch path existed while this script printed `clean`.
 *
 * The close has two parts. Locally, bindings resolve to a fixpoint (aliased
 * import, `{ X: Alias }` destructure, `const C = X` re-binding, namespace
 * member, computed access over a collapsed concatenation). Across modules,
 * the CLOSED allowlist is parsed for names it hands out that resolve to the
 * builder, and those names are guarded at any non-allowlisted importer.
 *
 * ── What this deliberately does NOT classify as an alias ─────────────────
 * Only a DIRECT re-binding (`export const X = buildHeadlessLaunch`,
 * `export { buildHeadlessLaunch as X }`) or a PASS-THROUGH wrapper (a single
 * `return buildHeadlessLaunch(...)`) counts. An exported function that does
 * real work around the builder is NOT an alias — that is precisely the shape
 * of the funnel itself, so treating it as one would flag every caller of
 * `SessionManager.spawnSession()`. This check blocks commits; a widening that
 * flags correct code is worse than the hole, because a noisy check gets
 * switched off. The boundary is drawn there on purpose.
 *
 * ── Residuals, named rather than left to be discovered ───────────────────
 *   - A NON-pass-through wrapper in an allowlisted module (two statements
 *     instead of one) is not an alias. This is the price of the rule above.
 *   - A computed member resolved at RUNTIME (`m[process.env.K]`) cannot be
 *     read statically.
 *   - Re-assignment after declaration (`let mk; mk = buildHeadlessLaunch;`)
 *     is caught at the ASSIGNMENT, not at the later call.
 *   - A consumer importing an alias through a BARREL is not itself checked —
 *     but the barrel is not allowlisted, so re-exporting the alias through it
 *     fails here first; the chain cannot be built without tripping this.
 * All four are pinned by tests asserting exactly this, so the boundary is
 * documented rather than assumed.
 *
 * Exit codes: 0 — clean; 1 — at least one violation.
 *
 * Usage:
 *   node scripts/lint-no-unfunneled-headless-launch.js            # full repo
 *   node scripts/lint-no-unfunneled-headless-launch.js --staged   # staged files
 *   node scripts/lint-no-unfunneled-headless-launch.js <file…>    # explicit files (tests)
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

/** The one name the funnel is built on. Every other guarded name derives from it. */
export const CANONICAL = 'buildHeadlessLaunch';

// ── Allowlist (closed). Adding an entry requires review of WHY the callsite
//    cannot route through SessionManager.spawnSession() (where the
//    subscription-path reroute lives), and how its post-June-15 billing is
//    accounted for. ──────────────────────────────────────────────────────
const ALLOWLIST = new Set([
  // The definition itself.
  'src/core/frameworkSessionLaunch.ts',
  // THE funnel — the subscription-path reroute decision lives here.
  'src/core/SessionManager.ts',
  // Deliberately-isolated fast path (spec Class 7): under force-mode it
  // refuses + degradation-reports instead of spawning; full SessionManager
  // integration is tracked under CMT-1112.
  'src/threadline/PipeSessionSpawner.ts',
  // This lint file mentions the symbol it greps for.
  'scripts/lint-no-unfunneled-headless-launch.js',
]);

const SCAN_DIRS = ['src', 'scripts', 'templates'];
const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.sh']);

const VIOLATION_MSG =
  `direct ${CANONICAL} reference outside the subscription-path funnel. ` +
  `Spawn through SessionManager.spawnSession() (which carries the June-15 reroute), ` +
  `or add an allowlist entry here with a billing-accountability justification.`;

const aliasMsg = (name, from) =>
  `'${name}' resolves to ${CANONICAL} (handed out by ${from}) — reaching the headless ` +
  `builder under another name is the same bypass of the subscription-path funnel. ` +
  `Spawn through SessionManager.spawnSession(), or add an allowlist entry here with a ` +
  `billing-accountability justification.`;

/** Comment lines are documentation, not a bypass — code cannot call through one. */
export function isCommentLine(line) {
  const t = line.trimStart();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('#');
}

/**
 * Collapse simple adjacent string concatenation so `'A' + 'B'` reads as `AB`.
 * Applied PER LINE so reported line numbers stay exact.
 */
export function collapseConcatenation(text) {
  let out = text;
  for (let i = 0; i < 5; i++) {
    const next = out.replace(/(['"`])\s*\+\s*(['"`])/g, '');
    if (next === out) break;
    out = next;
  }
  return out;
}

const basenameKey = (p) => path.basename(p).replace(/\.(ts|tsx|js|mjs|cjs)$/, '');

// ── Cross-module: what names does the closed allowlist hand out? ──────────

/** Is this expression the guarded builder itself (identifier or namespace member)? */
function denotesGuarded(node, known) {
  if (!node) return false;
  if (ts.isIdentifier(node)) return known.has(node.text);
  if (ts.isPropertyAccessExpression(node)) return known.has(node.name.text);
  if (ts.isElementAccessExpression(node)) {
    const a = node.argumentExpression;
    return !!a && ts.isStringLiteralLike(a) && known.has(a.text);
  }
  if (ts.isParenthesizedExpression(node)) return denotesGuarded(node.expression, known);
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression?.(node)) {
    return denotesGuarded(node.expression, known);
  }
  return false;
}

/** A body that is nothing but `return <guarded>(...)` — a pass-through wrapper. */
function isPassThroughBody(body, known) {
  if (!body) return false;
  if (ts.isCallExpression(body)) return denotesGuarded(body.expression, known); // arrow shorthand
  if (!ts.isBlock(body) || body.statements.length !== 1) return false;
  const only = body.statements[0];
  if (!ts.isReturnStatement(only) || !only.expression) return false;
  return ts.isCallExpression(only.expression) && denotesGuarded(only.expression.expression, known);
}

const isExported = (node) =>
  !!node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

/**
 * Names each allowlisted module hands out that resolve to the builder.
 *
 * `sources` is [{ path, content }]. Returns Map<aliasName, sourcePath>, run to
 * a fixpoint across files so an allowlisted module re-exporting ANOTHER
 * allowlisted module's alias closes too.
 */
export function collectFunnelAliasExports(sources) {
  const aliases = new Map();
  for (let pass = 0; pass < 10; pass++) {
    const before = aliases.size;
    for (const { path: p, content } of sources) {
      let sf;
      try {
        sf = ts.createSourceFile(p, content, ts.ScriptTarget.Latest, true);
      } catch {
        continue;
      }
      // Names bound to the builder INSIDE this module, to a fixpoint.
      const known = new Set([CANONICAL, ...aliases.keys()]);
      for (let inner = 0; inner < 10; inner++) {
        const size = known.size;
        const seed = (n) => {
          if (ts.isImportSpecifier(n) && known.has((n.propertyName ?? n.name).text)) {
            known.add(n.name.text);
          }
          if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && denotesGuarded(n.initializer, known)) {
            known.add(n.name.text);
          }
          ts.forEachChild(n, seed);
        };
        ts.forEachChild(sf, seed);
        if (known.size === size) break;
      }

      const record = (name) => {
        if (name && name !== CANONICAL && !aliases.has(name)) aliases.set(name, p);
      };
      const visit = (n) => {
        // export const X = <guarded>;   /  export const X = (...) => <guarded>(...)
        if (ts.isVariableStatement(n) && isExported(n)) {
          for (const d of n.declarationList.declarations) {
            if (!ts.isIdentifier(d.name) || !d.initializer) continue;
            if (denotesGuarded(d.initializer, known)) record(d.name.text);
            else if (
              (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)) &&
              isPassThroughBody(d.initializer.body, known)
            ) record(d.name.text);
          }
        }
        // export function X(...) { return <guarded>(...); }
        if (ts.isFunctionDeclaration(n) && isExported(n) && n.name && isPassThroughBody(n.body, known)) {
          record(n.name.text);
        }
        // export { A as B };  /  export { A as B } from '...';
        if (ts.isExportDeclaration(n) && n.exportClause && ts.isNamedExports(n.exportClause)) {
          for (const el of n.exportClause.elements) {
            if (known.has((el.propertyName ?? el.name).text)) record(el.name.text);
          }
        }
        ts.forEachChild(n, visit);
      };
      ts.forEachChild(sf, visit);
    }
    if (aliases.size === before) break;
  }
  return aliases;
}

// ── Per-file: local bindings, resolved to a fixpoint ─────────────────────

/** Named specifiers imported (or re-exported) in `content`, with their offsets. */
function importSpecifiers(content) {
  const out = [];
  const re = /(?:import|export)\s*(?:type\s+)?(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  for (const m of content.matchAll(re)) {
    const body = m[1];
    const bodyStart = m.index + m[0].indexOf('{') + 1;
    for (const spec of body.split(',')) {
      const t = spec.trim();
      if (!t) continue;
      const parts = t.replace(/^type\s+/, '').split(/\s+as\s+/);
      const imported = parts[0].trim();
      const local = (parts[1] ?? parts[0]).trim();
      if (!/^[A-Za-z_$][\w$]*$/.test(imported)) continue;
      out.push({ imported, local, from: m[2], offset: bodyStart + body.indexOf(t) });
    }
  }
  return out;
}

const lineOf = (content, offset) => content.slice(0, offset).split('\n').length;

/**
 * Local names in `content` bound to something guarded, to a fixpoint.
 *
 * Seeds are the canonical name plus any allowlist-exported alias that is
 * actually IMPORTED here from the module that hands it out — a locally
 * DEFINED function of the same name is not absorbed, which is what keeps this
 * from flagging unrelated code.
 */
export function collectLocalBindings(content, aliasExports = new Map()) {
  const names = new Set([CANONICAL]);
  const seededAliases = [];
  for (const spec of importSpecifiers(content)) {
    const owner = aliasExports.get(spec.imported);
    if (owner && basenameKey(spec.from) === basenameKey(owner)) {
      names.add(spec.local);
      seededAliases.push({ ...spec, owner });
    }
  }
  // Local re-binding chains, incl. destructures, namespace members and
  // computed access over a collapsed concatenation.
  for (let pass = 0; pass < 10; pass++) {
    const before = names.size;
    for (const known of [...names]) {
      const esc = known.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const forms = [
        // import { known as alias }  /  const { known: alias } = …
        new RegExp(`\\b${esc}\\s*(?:as|:)\\s*([A-Za-z_$][\\w$]*)`, 'g'),
        // const alias = known;  /  const alias = ns.known;  /  const alias = ns['known'];
        new RegExp(`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:[\\w$.]*\\.)?${esc}\\s*[;,\\n)]`, 'g'),
        new RegExp(`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*[\\w$.]*\\[\\s*['"\`]${esc}['"\`]\\s*\\]`, 'g'),
      ];
      for (const re of forms) {
        for (const m of collapseConcatenation(content).matchAll(re)) names.add(m[1]);
      }
    }
    if (names.size === before) break;
  }
  return { names, seededAliases };
}

/**
 * Violations in `content`, as { line, msg }. Exported so the rules can be
 * driven with fixtures rather than only end-to-end over the tree.
 */
export function findHeadlessLaunchViolations(content, aliasExports = new Map()) {
  const hits = [];
  const { names, seededAliases } = collectLocalBindings(content, aliasExports);
  // A guarded alias arriving by import is a violation AT THE DOOR, reported
  // against the import even though the name itself is unremarkable.
  const importLines = new Set();
  for (const spec of seededAliases) {
    const line = lineOf(content, spec.offset);
    importLines.add(line);
    hits.push({ line, msg: aliasMsg(spec.imported, path.basename(spec.owner)) });
  }
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (isCommentLine(lines[i])) continue;
    if (importLines.has(i + 1)) continue;
    const line = collapseConcatenation(lines[i]);
    for (const name of names) {
      const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`\\b${esc}\\b`).test(line) || new RegExp(`['"\`]${esc}['"\`]`).test(line)) {
        hits.push({ line: i + 1, msg: name === CANONICAL ? VIOLATION_MSG : aliasMsg(name, 'the funnel') });
        break;
      }
    }
  }
  return hits.sort((a, b) => a.line - b.line);
}

function listFiles() {
  const staged = process.argv.includes('--staged');
  if (staged) {
    // Read-only staged-file detection (same bootstrap escape as the other
    // lint scripts — runs pre-compile, can't use the TS funnel).
    const out = execSync('git diff --cached --name-only', { cwd: ROOT, encoding: 'utf-8' });
    return out.split('\n').filter(Boolean);
  }
  const explicit = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (explicit.length) return explicit;

  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (EXTENSIONS.has(path.extname(e.name))) files.push(path.relative(ROOT, full));
    }
  };
  for (const d of SCAN_DIRS) walk(path.join(ROOT, d));
  return files;
}

/** Read the allowlisted SOURCE modules — the only places an alias can be minted. */
export function readAllowlistSources(root = ROOT) {
  const sources = [];
  for (const rel of ALLOWLIST) {
    if (!rel.startsWith('src/')) continue; // the lint script itself is not an alias source
    try {
      sources.push({ path: rel, content: fs.readFileSync(path.join(root, rel), 'utf-8') });
    } catch {
      /* a missing allowlist entry is the allowlist test's problem, not this scan's */
    }
  }
  return sources;
}

// ── CLI body ─────────────────────────────────────────────────────────────
// Guarded so the exported detectors can be imported by tests WITHOUT running
// the scan: this module calls process.exit(1) on a violation, so an unguarded
// import would kill any test run the moment the repo had one. Same pattern as
// lint-no-unfunneled-credential-write.js and lint-telegram-egress-boundary.mjs.
const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  const aliasExports = collectFunnelAliasExports(readAllowlistSources());
  let violations = 0;
  for (const rel of listFiles()) {
    const normalized = rel.split(path.sep).join('/');
    if (ALLOWLIST.has(normalized)) continue;
    if (!EXTENSIONS.has(path.extname(normalized))) continue;
    // Explicit args may be absolute (e.g. the lint's own self-test sandbox);
    // repo-walk entries are always ROOT-relative.
    const full = path.isAbsolute(normalized) ? normalized : path.join(ROOT, normalized);
    let content;
    try {
      content = fs.readFileSync(full, 'utf-8');
    } catch {
      continue;
    }
    for (const hit of findHeadlessLaunchViolations(content, aliasExports)) {
      console.error(`${normalized}:${hit.line} — ${hit.msg}`);
      violations++;
    }
  }

  if (violations > 0) {
    console.error(`\nlint-no-unfunneled-headless-launch: ${violations} violation(s). ` +
      `See docs/specs/june15-headless-spawn-reroute.md (finding F5).`);
    process.exit(1);
  }
  console.log('lint-no-unfunneled-headless-launch: clean');
}
