#!/usr/bin/env node
/**
 * lint-no-unfunneled-topic-creation.js — refuses raw Telegram topic creation
 * outside the budgeted funnel.
 *
 * Part of the "Bounded Notification Surface" standard
 * (docs/STANDARDS-REGISTRY.md), born from the THIRD topic-spam incident
 * (2026-06-05). `TelegramAdapter.createForumTopic` is the ONE chokepoint
 * where forum topics are born, and it enforces the last-resort auto-topic
 * budget. A feature that calls the Telegram Bot API's `createForumTopic`
 * method directly (via `apiCall(...)`, a hand-rolled fetch, or curl in a
 * shipped script) bypasses that budget — which is exactly how notification
 * floods ship.
 *
 * WHAT CHANGED, AND WHY THE QUESTION MOVED
 *
 * This used to ask "is the raw method invoked through a seam SPELLED
 * `apiCall`, or written into a URL, or set as a `method:` property?" — three
 * line-anchored regexes. A peer audit classified it defeatable by ordinary
 * renaming, and ten bypasses were then reproduced against it, all confirmed
 * EVADING before this change:
 *
 *   const call = adapter.apiCall.bind(adapter); call('createForumTopic', p);
 *   this['apiCall']('createForumTopic', p);          // computed seam access
 *   this.apiCall('createForum' + 'Topic', p);        // split literal
 *   const M = 'createForumTopic'; this.apiCall(M, p);// const indirection
 *   this.apiCall(\n  'createForumTopic',\n  p);      // argument on its own line
 *   this.request('createForumTopic', p);             // seam under another name
 *   { 'method': 'createForumTopic' }                 // quoted property key
 *   { method: M }                                    // method via a const
 *   fetch(`${BASE}/createForumTopic`)                // URL base in a variable
 *   import { apiCall as ac } from …; ac('createForumTopic', p);
 *
 * Every one is a property of the QUESTION: naming the seam means each new
 * spelling of the seam is a fresh hole. The question asked here instead is
 * "does this file NAME the raw Bot-API method at all?" — which needs no seam
 * inventory, because the method name has to appear for the call to reach
 * Telegram, whatever the receiver is called. That question is answered on the
 * TypeScript AST with constant resolution, so a name assembled from
 * concatenations, template literals, or a local `const` still resolves.
 *
 * Rule: outside the allowlist below, no source file may contain an expression
 * that statically resolves to the Bot-API method name `createForumTopic`, or
 * to a string carrying it as a URL path segment (`…/createForumTopic`).
 * Calls to the FUNNEL — `adapter.createForumTopic(...)` /
 * `findOrCreateForumTopic(...)` — are property accesses, not strings, and are
 * not flagged. Nor is a property KEY, a string-literal TYPE, or a comment.
 *
 * WHAT THIS DOES NOT PROVE, named here rather than left to be discovered:
 *   - A method name assembled at RUNTIME (`['create','Forum','Topic'].join('')`,
 *     a char-code build, a name read from config or an env var) resolves to
 *     nothing static and is not caught. That needs dataflow this does not do.
 *   - A name imported from ANOTHER module (`import { M } from './names.js'`)
 *     is not followed; resolution is file-local.
 *   - Computed member access on the method name (`client['createForumTopic'](p)`)
 *     is NOT flagged, deliberately: the funnel method and the raw API method
 *     share a name, so `adapter['createForumTopic'](…)` — legitimate funnel
 *     use — is indistinguishable from it by name alone. Flagging it would
 *     break correct code, which for a commit-blocking lint is the more
 *     expensive failure.
 *   - Shell files (.sh) are checked as TEXT, not parsed: any non-comment line
 *     naming the method is a violation. A shell variable assembled across
 *     lines (`M=create; M="${M}ForumTopic"`) escapes that.
 *
 * Exit codes: 0 — clean; 1 — at least one violation.
 *
 * Usage:
 *   node scripts/lint-no-unfunneled-topic-creation.js            # full repo
 *   node scripts/lint-no-unfunneled-topic-creation.js --staged   # staged files
 *   node scripts/lint-no-unfunneled-topic-creation.js <file…>    # explicit files (tests)
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

// ── Allowlist (closed). Adding entries requires review of WHY the callsite
//    cannot route through the funnel, and how its volume is bounded. ──────
const ALLOWLIST = new Set([
  // THE funnel — the budget lives here.
  'src/messaging/TelegramAdapter.ts',
  // The lifeline runs in a separate process without a TelegramAdapter
  // instance. Its single createForumTopic call is the create-once,
  // self-healing '🛡️ Lifeline' system topic — cardinality fixed at 1.
  'src/lifeline/TelegramLifeline.ts',
  // Setup-wizard doc string: a curl EXAMPLE shown to the codex driver, not
  // an executed call path.
  'src/commands/setup-wizard/codex-driver.ts',
  // This lint file mentions the patterns it looks for.
  'scripts/lint-no-unfunneled-topic-creation.js',
  // A VOCABULARY table, not a callsite: SELF_ACTION_VERB_TOKENS lists the verb
  // names the self-action lint's regex is built from, and `createForumTopic`
  // is one of the notify-family tokens. This module is imported by lint
  // scripts, has no Telegram client and no network reach, so the name here can
  // create no topic. Volume is bounded at zero. (Found by the AST rule below —
  // the previous regex version never looked at a bare string literal.)
  'scripts/lib/self-action-detect.mjs',
]);

const SCAN_DIRS = ['src', 'scripts', 'templates'];
const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.sh']);
const SHELL_EXTENSIONS = new Set(['.sh']);

/** The raw Bot-API method the funnel owns. */
const METHOD = 'createForumTopic';

/** Marks a substitution this analysis could not resolve (`${token}`). */
const HOLE = '\u0000';

const MSG_METHOD =
  `raw Bot-API method name '${METHOD}' outside the budgeted funnel. `
  + `Route topic creation through TelegramAdapter.createForumTopic / findOrCreateForumTopic `
  + `(declare an origin/label), or add an allowlist entry here with a bounded-volume justification.`;
const MSG_URL =
  `raw Bot-API '${METHOD}' URL outside the budgeted funnel. `
  + `Route topic creation through TelegramAdapter.createForumTopic / findOrCreateForumTopic, `
  + `or add an allowlist entry here with a bounded-volume justification.`;

/**
 * Collapse simple adjacent string concatenation so `'A' + 'B'` reads as `AB`.
 * Used for the cheap pre-filter and the shell path; the AST path resolves
 * concatenation properly and does not need it.
 */
export function collapseConcatenation(content) {
  let out = content;
  for (let i = 0; i < 5; i++) {
    const next = out.replace(/(['"`])\s*\+\s*(['"`])/g, '');
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * Local `const`/`let`/`var` names bound to a statically-resolvable string,
 * resolved to a fixpoint so a chain (`const a = 'x'; const b = a + '/y';`)
 * closes too.
 *
 * This is what makes the seam's NAME irrelevant: the method string is followed
 * to wherever it was declared, so re-binding the receiver, renaming the seam,
 * or hoisting the method into a constant all land on the same value.
 *
 * Deliberately NOT resolved: re-assignment after declaration, function
 * parameters, object-property reads, and cross-module imports. Those need flow
 * and cross-module analysis this does not do.
 */
export function collectStringConstants(sourceFile) {
  const decls = [];
  const walkNode = (n) => {
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(n.name)) {
      decls.push([n.name.text, n.initializer]);
    }
    ts.forEachChild(n, walkNode);
  };
  walkNode(sourceFile);

  const consts = new Map();
  for (let pass = 0; pass < 10; pass++) {
    const before = consts.size;
    for (const [name, init] of decls) {
      if (consts.has(name)) continue;
      const value = resolveStaticString(init, consts);
      if (value !== null) consts.set(name, value);
    }
    if (consts.size === before) break;
  }
  return consts;
}

/**
 * The static string value of an expression, with unresolvable substitutions
 * replaced by HOLE. Returns null when nothing string-shaped is there at all.
 */
export function resolveStaticString(node, consts, depth = 0) {
  if (!node || depth > 12) return null;
  if (ts.isParenthesizedExpression(node)) return resolveStaticString(node.expression, consts, depth + 1);
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression?.(node) || ts.isSatisfiesExpression?.(node)) {
    return resolveStaticString(node.expression, consts, depth + 1);
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isIdentifier(node)) return consts.has(node.text) ? consts.get(node.text) : null;
  if (ts.isTemplateExpression(node)) {
    let out = node.head.text;
    for (const span of node.templateSpans) {
      const sub = resolveStaticString(span.expression, consts, depth + 1);
      out += sub === null ? HOLE : sub;
      out += span.literal.text;
    }
    return out;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = resolveStaticString(node.left, consts, depth + 1);
    const right = resolveStaticString(node.right, consts, depth + 1);
    if (left === null && right === null) return null;
    return (left ?? HOLE) + (right ?? HOLE);
  }
  return null;
}

/** Does a resolved string carry the method as a URL path segment? */
function isMethodUrl(resolved) {
  // A hole stands for an opaque, slash-free blob (`${token}`), so
  // `…/bot${token}/createForumTopic` still reads as a Bot-API URL.
  const filled = resolved.split(HOLE).join('x');
  return new RegExp(`/${METHOD}(?![A-Za-z0-9_])`).test(filled);
}

/** Is this string literal in a position where it cannot be an invocation? */
function isInertStringPosition(node) {
  const parent = node.parent;
  if (!parent) return false;
  // A string-literal TYPE (`type M = 'createForumTopic' | …`) invokes nothing.
  if (ts.isLiteralTypeNode(parent)) return true;
  // A property KEY in a lookup table (`{ 'createForumTopic': 'name' }`) — the
  // real table in src/messaging/invisible-payload.ts is exactly this shape.
  if ((ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isMethodDeclaration(parent))
    && parent.name === node) return true;
  // Computed member access — see the header: the funnel method shares this
  // name, so `adapter['createForumTopic'](…)` is legitimate and unresolvable
  // from the name alone.
  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) return true;
  // Module specifiers: `import … from 'createForumTopic'` is not a call.
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return true;
  return false;
}

/**
 * Violations in `content`, as { line, msg }. Exported so the rules can be
 * driven with fixtures rather than only end-to-end over the tree — and driven
 * DIRECTLY, since a lint that crashes also exits 1.
 */
export function findTopicCreationViolations(content, filePath = 'fixture.ts') {
  const ext = path.extname(filePath);
  if (SHELL_EXTENSIONS.has(ext)) return findShellViolations(content);

  // Cheap pre-filter over the concatenation-collapsed text, so a split literal
  // cannot skip the parse. `forum` is the loosest token any spelling of the
  // method keeps once adjacent literals are folded.
  const collapsed = collapseConcatenation(content);
  if (!/forum/i.test(collapsed) && !collapsed.includes('/bot')) return [];

  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ext === '.ts' || ext === '.tsx' ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  );

  const consts = collectStringConstants(sourceFile);
  const hits = [];
  const seen = new Set();

  const lineOf = (node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  const record = (node, msg) => {
    const line = lineOf(node);
    const key = `${line}|${msg}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({ line, msg });
  };

  /** Classify a resolved string in an invocation-capable position. */
  const classify = (node, resolved) => {
    if (resolved === null) return;
    if (resolved === METHOD) record(node, MSG_METHOD);
    else if (isMethodUrl(resolved)) record(node, MSG_URL);
  };

  const visit = (node) => {
    // String-shaped expressions, wherever they sit.
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
      || ts.isTemplateExpression(node)
      || (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)) {
      if (!isInertStringPosition(node)) classify(node, resolveStaticString(node, consts));
    }
    // Call arguments and property values, where an INDIRECTED name (a local
    // const holding the method) becomes an actual invocation.
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      for (const arg of node.arguments ?? []) {
        if (ts.isIdentifier(arg)) classify(arg, resolveStaticString(arg, consts));
      }
    }
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.initializer)) {
      classify(node.initializer, resolveStaticString(node.initializer, consts));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  hits.sort((a, b) => a.line - b.line);
  return hits;
}

/**
 * Shell path: no parser, so the rule is blunter — any non-comment line naming
 * the method is a violation. Adjacent-quote concatenation (`"create""Forum…"`)
 * is folded first.
 */
export function findShellViolations(content) {
  const hits = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim().startsWith('#')) continue;
    const folded = raw.replace(/(['"])(['"])/g, '');
    if (new RegExp(`(^|[^A-Za-z0-9_])${METHOD}(?![A-Za-z0-9_])`).test(folded)) {
      hits.push({ line: i + 1, msg: MSG_METHOD });
    }
  }
  return hits;
}

function listFiles() {
  if (process.argv.includes('--staged')) {
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

// ── CLI body ─────────────────────────────────────────────────────────────
// Guarded so the exported detector can be imported by tests WITHOUT running
// the scan: this module calls process.exit(1) on a violation, so an unguarded
// import would kill any test run the moment the repo had a violation. Same
// pattern as scripts/lint-no-unfunneled-credential-write.js.
const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;

if (invokedDirectly) {
  let violations = 0;
  for (const rel of listFiles()) {
    const normalized = rel.split(path.sep).join('/');
    if (ALLOWLIST.has(normalized)) continue;
    if (!EXTENSIONS.has(path.extname(normalized))) continue;
    const full = path.isAbsolute(rel) ? rel : path.join(ROOT, normalized);
    let content;
    try {
      content = fs.readFileSync(full, 'utf-8');
    } catch {
      continue;
    }
    for (const { line, msg } of findTopicCreationViolations(content, normalized)) {
      console.error(`${normalized}:${line} — ${msg}`);
      violations++;
    }
  }

  if (violations > 0) {
    console.error(`\nlint-no-unfunneled-topic-creation: ${violations} violation(s). `
      + `See docs/STANDARDS-REGISTRY.md "Bounded Notification Surface".`);
    process.exit(1);
  }
  console.log('lint-no-unfunneled-topic-creation: clean');
}
