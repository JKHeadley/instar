#!/usr/bin/env node
/**
 * lint-no-unfunneled-tmux-literal-send — structural guard for the
 * `tmux send-keys -l` argv ceiling.
 *
 * `send-keys -l` passes its whole payload as ONE argv element, which is bounded
 * by ARG_MAX minus the environment (~16.2 KB measured on tmux 3.6a / darwin).
 * A raw call therefore works fine in every test and every small prompt, then
 * fails with a bare `command too long` the first time real payload arrives.
 *
 * On 2026-08-04 that took down the whole internal-LLM substrate on one machine:
 * a ~40 KB prompt blew the ceiling, LlmCircuitBreaker classified the opaque
 * send error as `provider rate-limited`, and the breaker tripped every 15
 * minutes (14 consecutive) while ten LLM-backed components — MessagingToneGate
 * and completion-claim-verify among them — sat at 76-100% error rate.
 *
 * The fix converted every call site to `buildLiteralSendArgs()` from
 * `src/core/tmuxLiteralSend.ts`, which chunks below the ceiling. THIS lint is
 * what stops the class coming back: without it, the next call site someone adds
 * reintroduces a defect that is invisible until production payload hits it.
 *
 * Structure > Willpower — a comment asking authors to remember is a wish; this
 * is the guarantee.
 *
 * SCOPE CORRECTED 2026-08-15. The previous header said only that "a wrapper that
 * builds the argv array dynamically could still evade it". That understated the
 * gap: the check was LINE-oriented and required `send-keys` and `'-l'` on the
 * SAME line, so four PLAIN literal forms — none of them dynamic, none of them a
 * wrapper — walked straight past it. Measured against the shipped check, with the
 * one-line form as a positive control firing in the same run:
 *
 *   ["send-keys", "-l", p]                        CONTROL  exit 1 (caught)
 *   [\n  "send-keys",\n  "-l",\n  p,\n]        exit 0 — EVADES
 *   const F = "-l";      ["send-keys", F, p]      exit 0 — EVADES
 *   const C = "send-keys"; [C, "-l", p]           exit 0 — EVADES
 *   ["send-keys","-l",p]  // buildLiteralSendArgs exit 0 — EVADES
 *
 * The first is the one that matters: a multi-line argv array is simply how any
 * formatter writes an array over the print width. The guard could be defeated by
 * running prettier. The last is worse in kind — merely NAMING the funnel in a
 * COMMENT on that line suppressed the check, so `// TODO: use buildLiteralSendArgs`
 * beside a raw send silenced the guard that the TODO was admitting was needed.
 *
 * Now: comments are stripped quote-aware first, string constants are resolved
 * per file, and the unit of matching is the ARRAY LITERAL (bracket-matched,
 * bounded) rather than the line — which is what the original rule always meant.
 *
 * STILL not proof, and this is the honest remainder: an argv array assembled at
 * RUNTIME (push(), concat(), spread of a computed list, a helper that returns the
 * array) is invisible here. That is the gap the original header named, and it is
 * the only one left. Closing it needs dataflow, not more patterns.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const SRC = path.join(REPO, 'src');

/** The funnel itself must contain the only raw literal-send argv in src/. */
const EXEMPT = new Set([path.join('src', 'core', 'tmuxLiteralSend.ts')]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/**
 * Strip // and block comments WITHOUT touching string contents, replacing each
 * removed character with a space so every byte offset — and therefore every
 * reported line number — is preserved exactly.
 */
export function stripComments(src) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') { out += n ?? ''; i += 2; continue; }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i += 1; continue; }
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i += 1; }
      continue;
    }
    if (c === '/' && n === '*') {
      out += '  '; i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      out += '  '; i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * Identifiers bound to a plain string literal in THIS file. An identifier bound
 * more than once to DIFFERENT values is UNRESOLVABLE and dropped, so an ambiguous
 * name can never be substituted into a match — ambiguity fails toward NOT flagging,
 * because a guess that fails someone's build is the expensive direction.
 */
export function collectStringConsts(code) {
  const seen = new Map();
  const conflicting = new Set();
  const DECL = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(['"`])([^'"`\n]*)\2/g;
  let m;
  while ((m = DECL.exec(code)) !== null) {
    const [, name, , value] = m;
    if (seen.has(name) && seen.get(name) !== value) conflicting.add(name);
    else seen.set(name, value);
  }
  for (const name of conflicting) seen.delete(name);
  return seen;
}

/**
 * Every bracket-matched array literal in the source, as {text, line}. Bounded:
 * an array longer than MAX_ARRAY_CHARS is truncated rather than scanned whole, so
 * a pathological file cannot make this quadratic. Unbalanced brackets simply
 * yield no region — the check fails toward NOT flagging.
 */
const MAX_ARRAY_CHARS = 4000;
export function arrayRegions(code) {
  const regions = [];
  for (let i = 0; i < code.length; i++) {
    if (code[i] !== '[') continue;
    let depth = 0;
    let quote = null;
    let j = i;
    for (; j < code.length && j - i < MAX_ARRAY_CHARS; j++) {
      const c = code[j];
      if (quote) {
        if (c === '\\') { j += 1; continue; }
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
      if (c === '[') depth += 1;
      else if (c === ']') { depth -= 1; if (depth === 0) break; }
    }
    if (depth !== 0) continue;
    const text = code.slice(i, j + 1);
    const line = code.slice(0, i).split('\n').length;
    regions.push({ text, line });
  }
  return regions;
}

/** True when the resolved region is a raw literal `send-keys -l` argv. */
export function regionViolates(regionText, consts) {
  let t = regionText;
  for (const [name, value] of consts) {
    t = t.replace(new RegExp(`\\b${name}\\b`, 'g'), `'${value}'`);
  }
  if (!/['"`]send-keys['"`]/.test(t)) return false;
  if (!/['"`]-l['"`]/.test(t)) return false;
  // Already funnelled — checked on COMMENT-STRIPPED code, so merely naming the
  // funnel in a comment can no longer silence the guard.
  if (t.includes('buildLiteralSendArgs')) return false;
  return true;
}

export function scanSource(code) {
  const stripped = stripComments(code);
  const consts = collectStringConsts(stripped);
  const hits = [];
  for (const region of arrayRegions(stripped)) {
    if (regionViolates(region.text, consts)) {
      hits.push({ line: region.line, text: region.text.replace(/\s+/g, ' ').trim() });
    }
  }
  return hits;
}

// DIRECT-INVOCATION GUARD. Without it, importing this module to unit-test the
// helpers above runs the whole src/ scan and calls process.exit(1) the moment the
// repo has a real violation — killing the importing process. Four other lints hit
// exactly that this week; the guard is the same fix.
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) runLint();

function runLint() {
const violations = [];

for (const file of walk(SRC)) {
  const rel = path.relative(REPO, file);
  if (EXEMPT.has(rel)) continue;
  for (const hit of scanSource(fs.readFileSync(file, 'utf-8'))) {
    violations.push({ rel, line: hit.line, text: hit.text });
  }
}

if (violations.length > 0) {
  console.error('\n✖ lint-no-unfunneled-tmux-literal-send: raw `send-keys -l` found.\n');
  console.error('  A literal send must go through buildLiteralSendArgs() +');
  console.error('  chunkLiteralForTmux() from src/core/tmuxLiteralSend.ts, or it will');
  console.error('  fail with `command too long` once the payload exceeds ~16 KB.\n');
  for (const v of violations) {
    console.error(`    ${v.rel}:${v.line}`);
    console.error(`      ${v.text.slice(0, 120)}`);
  }
  console.error('');
  process.exit(1);
}

console.log(`✓ tmux literal sends funnelled (scanned ${walk(SRC).length} files, 0 unfunneled)`);
}
