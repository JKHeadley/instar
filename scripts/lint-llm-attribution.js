#!/usr/bin/env node
/**
 * lint-llm-attribution.js — every funnel LLM callsite must carry attribution.
 *
 * token-audit-completeness spec, Slice 3 (operator directive: "full token
 * auditability — per feature AND per model — is a requirement for any
 * feature"). An LLM call without `attribution.component` records under the
 * `unlabeled` bucket — visible but unattributable. The baseline was driven to
 * ZERO in the same PR that added this lint; the allowlist below is seeded
 * EMPTY and a unit-tier ratchet test (tests/unit/llm-attribution-ratchet.test.ts)
 * pins it there.
 *
 * WHAT COUNTS AS A FUNNEL CALLSITE (heuristic, house pattern of
 * lint-no-direct-llm-http.js): a `.evaluate(` whose receiver chain matches
 * /intelligence|provider|llm/i. Out of scope by construction:
 * src/providers/parity/scenarios/ and _smoketest/_stresstest files (they call
 * one-shot adapters directly, bypass the funnel, and record no ledger rows).
 *
 * WHAT PASSES: the options argument lexically contains `attribution:` with a
 * `component:` whose STRING LITERAL value is non-empty after trim and does
 * not case-insensitively equal "unlabeled" — inline, or on a same-file
 * `const`/`let`/`var` declaration of the options object with the same literal
 * rule. `attribution: {}`, a missing `component:`, `component: ''`, and
 * `component: 'Unlabeled'` are all violations.
 *
 * SANCTIONED FIX for the cross-file-spread shape (`evaluate(p, {...sharedOpts})`)
 * is INLINING `attribution:` at the callsite — never allowlisting. A
 * constructor property assignment (`this.defaultOptions`) is NOT covered by
 * the same-file-declaration rule; inline the attribution there too (see
 * src/security/LLMSanitizer.ts for the canonical example).
 *
 * ACCEPTED LIMITATIONS (documented, runtime-backstopped): conditional
 * attribution and helper-wrapper indirection pass lexically. The funnel's
 * runtime backstop (`unlabeled-llm-call` degradation event, once per process)
 * plus the unlabeledCallShare/unlabeledTokenShare metrics catch what the
 * lexical rule cannot.
 *
 * FUNNEL_FILES (infrastructure pass-through exemption class, DISTINCT from
 * the violations allowlist): the funnel's own forwarders match the heuristic
 * but MUST NOT carry inline attribution — stamping a component there would
 * clobber every routed caller's real tag, corrupting the exact audit this
 * lint protects. Entries must be IntelligenceProvider implementations or
 * option-forwarding funnel components. The same ratchet test pins this list;
 * additions fail CI.
 *
 * Exit codes: 0 — clean; 1 — at least one violation (or a stale allowlist
 * entry: an entry with no remaining violation fails with "remove me").
 *
 * Usage:
 *   node scripts/lint-llm-attribution.js                # full src/
 *   node scripts/lint-llm-attribution.js --staged       # staged files only
 *   node scripts/lint-llm-attribution.js path1 path2    # specific files
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

/**
 * Violations allowlist — seeded EMPTY (the baseline-zero pass tagged every
 * callsite). Entries are 'relative/path.ts:<line>' strings. Any addition
 * fails the ratchet test pointing at the Token-Audit Completeness standard;
 * an entry with no remaining violation fails this lint with "remove me".
 */
export const VIOLATIONS_ALLOWLIST = new Set([]);

/**
 * Infrastructure pass-through exemption class. Entries must be
 * IntelligenceProvider implementations or option-forwarding funnel
 * components (documented constraint, pinned by the ratchet test).
 */
export const FUNNEL_FILES = new Set([
  // IntelligenceProvider implementations (they ARE the funnel's leaves).
  'src/core/ClaudeCliIntelligenceProvider.ts',
  'src/core/CodexCliIntelligenceProvider.ts',
  'src/core/GeminiCliIntelligenceProvider.ts',
  'src/core/PiCliIntelligenceProvider.ts',
  'src/core/InteractivePoolIntelligenceProvider.ts',
  // Option-forwarding funnel components — stamping attribution here would
  // clobber every routed caller's real tag.
  'src/core/CircuitBreakingIntelligenceProvider.ts',
  'src/core/IntelligenceRouter.ts',
  'src/core/AnthropicSubscriptionRouter.ts',
  // createQueuedIntelligence wrapper (LlmQueue lane composition) — forwards
  // the caller's options verbatim.
  'src/core/TopicIntentCapture.ts',
]);

const RECEIVER_RE = /intelligence|provider|llm/i;
const EXTENSIONS = new Set(['.ts', '.tsx']);

export function isOutOfScope(rel) {
  if (rel.startsWith('src/providers/parity/scenarios/')) return true;
  const base = path.basename(rel);
  if (/_smoketest|_stresstest/.test(base)) return true;
  return false;
}

/** Walk a call's argument text from the index of its '(' — string-aware. */
function extractArgs(text, openIdx) {
  let i = openIdx + 1;
  let depth = 1;
  const stk = [];
  const n = text.length;
  while (i < n && depth > 0) {
    const c = text[i];
    const top = stk[stk.length - 1];
    if (top && (top.q === "'" || top.q === '"')) {
      if (c === '\\') i++;
      else if (c === top.q || c === '\n') stk.pop();
    } else if (top && top.q === '`') {
      if (c === '\\') i++;
      else if (c === '`') stk.pop();
      else if (c === '$' && text[i + 1] === '{') {
        stk.push({ q: 'expr', depth: 1 });
        i++;
      }
    } else if (top && top.q === 'expr') {
      if (c === "'" || c === '"' || c === '`') stk.push({ q: c });
      else if (c === '{') top.depth++;
      else if (c === '}') {
        top.depth--;
        if (top.depth === 0) stk.pop();
      } else if (c === '(') depth++;
      else if (c === ')') depth--;
    } else {
      if (c === "'" || c === '"' || c === '`') stk.push({ q: c });
      else if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === '/' && text[i + 1] === '/') {
        while (i < n && text[i] !== '\n') i++;
      } else if (c === '/' && text[i + 1] === '*') {
        i += 2;
        while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
        i++;
      }
    }
    i++;
  }
  return text.slice(openIdx + 1, Math.max(openIdx + 1, i - 1));
}

/** Split argument text on top-level commas (string/brace/paren aware, shallow). */
function topLevelSplit(args) {
  const parts = [];
  let depth = 0;
  let cur = '';
  let quote = null;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (quote) {
      cur += c;
      if (c === '\\') {
        cur += args[i + 1] ?? '';
        i++;
      } else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      cur += c;
      continue;
    }
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    if (c === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

/**
 * A body passes when it lexically contains `attribution:` AND at least one
 * `component:` STRING LITERAL that is non-empty after trim and not
 * case-insensitively "unlabeled". This deliberately accepts the conditional
 * shape `attribution: options.attribution ?? { component: 'X' }` — the spec's
 * documented lexical limitation, runtime-backstopped by `unlabeled-llm-call`.
 */
function bodyHasValidAttribution(body) {
  if (!/attribution\s*:/.test(body)) return false;
  const re = /component\s*:\s*(['"`])([^'"`]*)\1/g;
  let cm;
  while ((cm = re.exec(body)) !== null) {
    const v = cm[2].trim();
    if (v.length > 0 && v.toLowerCase() !== 'unlabeled') return true;
  }
  return false;
}

function argsHaveValidAttribution(argsText, fileText) {
  if (bodyHasValidAttribution(argsText)) return true;
  // Same-file variable declaration: second arg is a bare identifier whose
  // const/let/var declaration in THIS file carries the attribution literal.
  const parts = topLevelSplit(argsText);
  const second = (parts[1] ?? '').trim();
  if (/^[A-Za-z_$][\w$]*$/.test(second)) {
    const declRe = new RegExp(`(?:const|let|var)\\s+${second}\\b[^=;]*=\\s*\\{`, 'g');
    let dm;
    while ((dm = declRe.exec(fileText)) !== null) {
      const braceIdx = fileText.indexOf('{', dm.index + dm[0].length - 1);
      const body = extractBraceBody(fileText, braceIdx);
      if (bodyHasValidAttribution(body)) return true;
    }
  }
  return false;
}

/**
 * Replace comment contents with spaces (newlines preserved so reported line
 * numbers stay true). String-aware: `//` inside a string literal is content,
 * not a comment.
 */
export function stripComments(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  let quote = null;
  while (i < n) {
    const c = text[i];
    if (quote) {
      out += c;
      if (c === '\\') {
        out += text[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (c === quote || (c === '\n' && quote !== '`')) quote = null;
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
        out += text[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < n) {
        out += '  ';
        i += 2;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function extractBraceBody(text, openIdx) {
  let i = openIdx + 1;
  let depth = 1;
  let quote = null;
  const n = text.length;
  while (i < n && depth > 0) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}') depth--;
    i++;
  }
  return text.slice(openIdx + 1, Math.max(openIdx + 1, i - 1));
}

function receiverBefore(text, dotIdx) {
  // Scan backwards over an identifier/member chain (this.x!.y, options?.z).
  let i = dotIdx - 1;
  while (i >= 0 && /[\w$.!?\]]/.test(text[i])) i--;
  return text.slice(i + 1, dotIdx);
}

export function checkFileText(rel, rawText) {
  const text = stripComments(rawText);
  const violations = [];
  const re = /\.evaluate\s*\(/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const receiver = receiverBefore(text, m.index);
    if (!RECEIVER_RE.test(receiver)) continue;
    const openIdx = text.indexOf('(', m.index);
    const argsText = extractArgs(text, openIdx);
    if (argsHaveValidAttribution(argsText, text)) continue;
    const line = text.slice(0, m.index).split('\n').length;
    violations.push({ file: rel, line, receiver });
  }
  return violations;
}

function walk(dir, out, skip) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (skip.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out, skip);
    else if (EXTENSIONS.has(path.extname(e.name))) out.push(full);
  }
}

function collectFiles(args) {
  if (args.length === 0) {
    const skip = new Set(['node_modules', 'dist', 'build', '.instar', '.git', 'coverage']);
    const out = [];
    const p = path.join(ROOT, 'src');
    if (fs.existsSync(p)) walk(p, out, skip);
    return out;
  }
  if (args[0] === '--staged') {
    try {
      const stdout = execSync('git diff --cached --name-only --diff-filter=ACMR', {
        cwd: ROOT,
        encoding: 'utf-8',
      });
      return stdout
        .split('\n')
        .filter(Boolean)
        .filter((f) => f.startsWith('src/') && EXTENSIONS.has(path.extname(f)))
        .map((f) => path.join(ROOT, f));
    } catch {
      return [];
    }
  }
  return args.map((a) => path.resolve(ROOT, a)).filter((f) => fs.existsSync(f));
}

/**
 * Run the lint over absolute file paths. Exported for the ratchet/self-test
 * suite (tests/unit/llm-attribution-ratchet.test.ts). `checkStale` is true
 * for full-repo runs only — a partial run can't prove an allowlist entry dead.
 */
export function runLint(files, { allowlist = VIOLATIONS_ALLOWLIST, funnelFiles = FUNNEL_FILES, checkStale = false } = {}) {
  const violations = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    if (!rel.startsWith('src/')) continue;
    if (isOutOfScope(rel)) continue;
    if (funnelFiles.has(rel)) continue;
    let text;
    try {
      text = fs.readFileSync(f, 'utf-8');
    } catch {
      continue;
    }
    violations.push(...checkFileText(rel, text));
  }

  const real = violations.filter((v) => !allowlist.has(`${v.file}:${v.line}`) && !allowlist.has(v.file));
  const allowlisted = violations.filter((v) => allowlist.has(`${v.file}:${v.line}`) || allowlist.has(v.file));

  // Stale-entry rule: an allowlist entry with no remaining violation must be
  // removed (otherwise the allowlist quietly accumulates dead grants).
  const stale = [];
  if (checkStale) {
    const hitFiles = new Set(allowlisted.map((v) => v.file));
    const hitLines = new Set(allowlisted.map((v) => `${v.file}:${v.line}`));
    for (const entry of allowlist) {
      if (!hitFiles.has(entry) && !hitLines.has(entry)) stale.push(entry);
    }
  }
  return { real, allowlisted, stale };
}

function main() {
  const args = process.argv.slice(2);
  const files = collectFiles(args);
  const { real, stale } = runLint(files, { checkStale: args.length === 0 });

  if (real.length === 0 && stale.length === 0) process.exit(0);

  if (real.length > 0) {
    console.error('lint-llm-attribution: funnel LLM callsite(s) without attribution.component found.\n');
    console.error('Every LLM call through the funnel must carry `attribution: { component: \'<Name>\' }`');
    console.error('so /metrics/features can attribute its token spend (Token-Audit Completeness');
    console.error('standard, docs/STANDARDS-REGISTRY.md). The sanctioned fix is INLINING the');
    console.error('attribution at the callsite — never allowlisting. Register the component in');
    console.error('src/core/componentCategories.ts in the same change.\n');
    for (const v of real) {
      console.error(`  ${v.file}:${v.line} — \`${v.receiver}.evaluate(...)\` has no valid attribution.component`);
    }
  }
  for (const entry of stale) {
    console.error(`  STALE allowlist entry "${entry}" — no remaining violation; remove me.`);
  }
  process.exit(1);
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isDirectRun) main();
