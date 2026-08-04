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
 * Guardrail, not proof: a wrapper that builds the argv array dynamically could
 * still evade it. The declared duty stays "literal sends go through the
 * funnel"; this catches the direct pattern.
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

const violations = [];

for (const file of walk(SRC)) {
  const rel = path.relative(REPO, file);
  if (EXEMPT.has(rel)) continue;
  const lines = fs.readFileSync(file, 'utf-8').split('\n');
  lines.forEach((line, i) => {
    // Match an argv array literal carrying both 'send-keys' and a '-l' flag.
    if (!line.includes('send-keys')) return;
    if (!/['"]-l['"]/.test(line)) return;
    // Already funnelled.
    if (line.includes('buildLiteralSendArgs')) return;
    violations.push({ rel, line: i + 1, text: line.trim() });
  });
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
