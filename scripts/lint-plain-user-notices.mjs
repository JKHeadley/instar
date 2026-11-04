#!/usr/bin/env node
/**
 * lint-plain-user-notices.mjs — Plain and Complete (docs/UX-AND-AGENT-AGENCY-STANDARD.md Rule 8).
 *
 * Notices the server writes itself (telegram.sendToTopic, slack sendToChannel,
 * sendDeterministicTelegramNotice, …) go out on deterministic paths that skip
 * the LLM tone gate on purpose: an alarm must arrive even when the model is
 * down. That is why their wording has to be held at BUILD time instead. This
 * lint finds the send call sites in src/ and flags, inside the text argument:
 *
 *   RAW_REASON     — an internal value pasted into user text: `${detail}`,
 *                    `${reason}`, `${err.message}`, `${String(err)}` …
 *                    (the 2026-11-03 "drain bound (30000ms) reached" notice).
 *   INTERNAL_TERM  — a word from src/data/plain-notice-terms.json in a string
 *                    literal of the text argument ("respawned", "final turn" …).
 *
 * Ratchet: a frozen per-file baseline (scripts/plain-user-notices-baseline.json)
 * grandfathers today's hits; a file whose count GROWS fails. Shrinking a count
 * is reported so the baseline can be lowered (--update rewrites it).
 * A deliberate exception carries `@plain-notice-ok: <why>` on the call line or
 * the line above (e.g. a reply that echoes an id the person asked for).
 *
 * COVERAGE HONESTY: static and approximate. A notice whose text is built in a
 * variable away from the send call is not seen here; those belong in the
 * catalog (src/messaging/userNotices.ts), whose test runs the full check on
 * rendered text. Exit codes: 0 pass · 1 new violation · 2 cannot-read.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function argVal(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const ROOT = path.resolve(argVal('--root') ?? path.join(__dirname, '..'));
const BASELINE = path.resolve(argVal('--baseline') ?? path.join(ROOT, 'scripts', 'plain-user-notices-baseline.json'));
const TERMS_PATH = path.join(ROOT, 'src', 'data', 'plain-notice-terms.json');
const UPDATE = process.argv.includes('--update');

const SEND_CALL_RE = /\b(?:sendToTopic|sendToChannel|sendDeterministicTelegramNotice|sendToLifeline|postToChannel)\s*\(/g;
const WAIVER = '@plain-notice-ok';
// A bare internal value (identifier / member chain, no call) named like a reason.
const RAW_EXPR_RE = /^[\w$?.!]*\b(?:detail|details|reason|err|error|cause|stderr|stdout)\b[\w$?.!]*$/;
// Any expression that reads an error's message or stringifies an error, in any form:
// `err.message`, `(err as Error).message`, `err instanceof Error ? err.message : String(err)`.
const RAW_CALL_RE = /(?:\b(?:e|err|error)\b\)?\??\.message\b|\bString\(\s*(?:e|err|error)\s*\)|^JSON\.stringify\()/i;

function readTerms() {
  const raw = JSON.parse(fs.readFileSync(TERMS_PATH, 'utf-8'));
  return raw.internalTerms.map((t) => ({
    term: t,
    re: new RegExp(`(^|[^A-Za-z0-9_-])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_-])`,
      t === t.toUpperCase() && t.length <= 4 ? '' : 'i'),
  }));
}

/** From the char after "(", return the index of the matching ")" (strings/templates aware). */
function argSpanEnd(src, start) {
  let depth = 1;
  const stack = []; // template-literal nesting
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'") {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (c === '`') {
      // walk the template; recurse on ${ … }
      for (i++; i < src.length && src[i] !== '`'; i++) {
        if (src[i] === '\\') { i++; continue; }
        if (src[i] === '$' && src[i + 1] === '{') {
          let d = 1; i += 2;
          for (; i < src.length && d > 0; i++) {
            if (src[i] === '{') d++;
            else if (src[i] === '}') d--;
            else if (src[i] === '`') { for (i++; i < src.length && src[i] !== '`'; i++) if (src[i] === '\\') i++; }
          }
          i--;
        }
      }
      continue;
    }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2); if (i < 0) return src.length; i++; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i; }
  }
  void stack;
  return src.length;
}

/** Template interpolation expressions + plain string literal bodies inside a span. */
function scanSpan(span) {
  const exprs = [];
  const literals = [];
  const tpl = /`((?:\\.|[^`\\])*)`/gs;
  for (const m of span.matchAll(tpl)) {
    const body = m[1];
    let lit = '';
    for (let i = 0; i < body.length; i++) {
      if (body[i] === '$' && body[i + 1] === '{') {
        let d = 1; let j = i + 2;
        for (; j < body.length && d > 0; j++) { if (body[j] === '{') d++; else if (body[j] === '}') d--; }
        exprs.push(body.slice(i + 2, j - 1).trim());
        lit += ' ';
        i = j - 1;
      } else lit += body[i];
    }
    literals.push(lit);
  }
  for (const m of span.matchAll(/'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"/g)) literals.push(m[1] ?? m[2] ?? '');
  return { exprs, literals };
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); }
    else if (/\.(ts|js|mjs)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

export function lintSource(src, terms) {
  const hits = [];
  for (const m of src.matchAll(SEND_CALL_RE)) {
    const open = m.index + m[0].length;
    const end = argSpanEnd(src, open);
    const span = src.slice(open, end);
    const line = src.slice(0, m.index).split('\n').length;
    const lines = src.split('\n');
    const context = `${lines[line - 2] ?? ''}\n${lines[line - 1] ?? ''}`;
    if (context.includes(WAIVER) || span.includes(WAIVER)) continue;
    const { exprs, literals } = scanSpan(span);
    for (const x of exprs) {
      if (RAW_EXPR_RE.test(x) || RAW_CALL_RE.test(x)) hits.push({ line, code: 'RAW_REASON', match: `\${${x}}` });
    }
    for (const lit of literals) {
      for (const { term, re } of terms) if (re.test(lit)) hits.push({ line, code: 'INTERNAL_TERM', match: term });
    }
  }
  return hits;
}

function main() {
  let terms;
  try { terms = readTerms(); } catch (e) { console.error(`lint-plain-user-notices: cannot read ${TERMS_PATH}: ${e.message}`); process.exit(2); }
  const files = walk(path.join(ROOT, 'src'));
  const counts = {};
  const detail = {};
  for (const f of files) {
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    const hits = lintSource(fs.readFileSync(f, 'utf-8'), terms);
    if (hits.length) { counts[rel] = hits.length; detail[rel] = hits; }
  }
  if (UPDATE) {
    fs.writeFileSync(BASELINE, JSON.stringify(Object.fromEntries(Object.entries(counts).sort()), null, 2) + '\n');
    console.log(`lint-plain-user-notices: baseline written (${Object.keys(counts).length} files).`);
    return;
  }
  let baseline = {};
  try { baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf-8')); } catch { /* no baseline = zero allowance */ }
  const failures = [];
  const lowered = [];
  for (const [rel, n] of Object.entries(counts)) {
    const allowed = baseline[rel] ?? 0;
    if (n > allowed) failures.push({ rel, n, allowed });
    else if (n < allowed) lowered.push({ rel, n, allowed });
  }
  for (const [rel, allowed] of Object.entries(baseline)) if (!(rel in counts) && allowed > 0) lowered.push({ rel, n: 0, allowed });
  if (lowered.length) {
    console.log(`lint-plain-user-notices: ${lowered.length} file(s) improved — lower the baseline with --update:`);
    for (const l of lowered) console.log(`  ${l.rel}: ${l.allowed} → ${l.n}`);
  }
  if (failures.length) {
    console.error('lint-plain-user-notices: new jargon or raw internal detail in a notice sent to the user.');
    console.error('Standard: docs/UX-AND-AGENT-AGENCY-STANDARD.md Rule 8 (Plain and Complete).');
    for (const f of failures) {
      console.error(`\n  ${f.rel}: ${f.n} hit(s), baseline allows ${f.allowed}`);
      for (const h of detail[f.rel]) console.error(`    line ${h.line}: ${h.code} ${h.match}`);
    }
    console.error(`\nFix: say what happened, what it means and what to do, in plain words; keep reasons/ids in logs.`);
    console.error(`Fixed wording belongs in src/messaging/userNotices.ts (tested). Deliberate exception: "// ${WAIVER}: <why>".`);
    process.exit(1);
  }
  console.log(`lint-plain-user-notices: ok (${files.length} files scanned).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
