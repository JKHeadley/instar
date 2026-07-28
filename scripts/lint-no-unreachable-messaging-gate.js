#!/usr/bin/env node
/**
 * lint-no-unreachable-messaging-gate.js — ban a DEFAULT-OFF config gate read at a
 * `messaging.<child>.*` dot-path.
 *
 * The 2026-07-04 incident (PR #1379): the Action-Claim / Slack-followthrough
 * sentinel gated on `messaging.actionClaim.enabled`, read as
 * `liveConfig.get('messaging.actionClaim.enabled', false)`. On every real install
 * `messaging` is a JSON ARRAY of adapter configs, so `getNestedValue` walks the
 * array, `array['actionClaim']` is undefined, and it returns the `false` default.
 * Because the feature defaults OFF, the master switch could never be set true — the
 * feature was structurally UN-ENABLABLE in production. CI missed it because every
 * test used an OBJECT-shaped `messaging`, which no real install uses.
 *
 * The sibling default-ON `messaging.*` sentinels (toneGate, outboundAdvisory) share
 * the same unreachability but are masked — unreachable just means they stay ON. Only
 * a DEFAULT-OFF gate is un-enablable. So this lint flags exactly the un-enablable
 * shape: a `.get('messaging.<...>', false)` (a dot-path under the array-valued
 * `messaging`, with a `false` default). The fix is to read the config from a
 * reachable TOP-LEVEL key (e.g. `actionClaim`), as #1379 did.
 *
 * Conservative by design: it flags only the concrete `.get('messaging.*', false)`
 * shape (the primary LiveConfig gate-read), not every messaging.* access. A
 * genuinely-intended exception can be suppressed inline with
 *   // lint-allow-messaging-gate: <reason>
 * on the same or the immediately-preceding line.
 *
 * Exit 0 = clean. Exit 1 = at least one offending site (printed).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `.get('messaging.<child>...', false)` — optionally with a `<T>` generic and any
 * whitespace. The `false` default is what makes it un-enablable (an unreachable
 * default-true gate merely stays on). Matches both quote styles.
 */
export const UNREACHABLE_OFF_GATE =
  /\.get\s*(?:<[^>]*>)?\s*\(\s*['"`]messaging\.[^'"`]+['"`]\s*,\s*false\b/;

const SUPPRESS = /lint-allow-messaging-gate\s*:/;

/** Scan raw source text; return 1-indexed line numbers of un-suppressed offenders. */
export function scanText(text) {
  const lines = text.split('\n');
  const hits = [];
  lines.forEach((line, i) => {
    if (!UNREACHABLE_OFF_GATE.test(line)) return;
    if (SUPPRESS.test(line)) return;
    if (i > 0 && SUPPRESS.test(lines[i - 1])) return;
    hits.push(i + 1);
  });
  return hits;
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'templates') continue;
      walk(full, out);
    } else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

function main() {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const SRC = path.join(ROOT, 'src');
  const offenders = [];
  for (const file of walk(SRC)) {
    const rel = path.relative(ROOT, file);
    const text = fs.readFileSync(file, 'utf-8');
    for (const line of scanText(text)) {
      offenders.push({ rel, line, text: text.split('\n')[line - 1].trim() });
    }
  }

  if (offenders.length > 0) {
    console.error(
      'lint-no-unreachable-messaging-gate: default-OFF config gate at an unreachable messaging.<child>.* dot-path.\n' +
        "On a real install `messaging` is a JSON ARRAY, so `messaging.<child>.*` resolves undefined → the `false`\n" +
        'default → the feature is structurally UN-ENABLABLE (the PR #1379 bug). Read it from a reachable TOP-LEVEL\n' +
        'key instead (e.g. `actionClaim.enabled`), or suppress with `// lint-allow-messaging-gate: <reason>`.\n',
    );
    for (const o of offenders) console.error(`  ${o.rel}:${o.line}  ${o.text}`);
    process.exit(1);
  }
  console.log('lint-no-unreachable-messaging-gate: clean');
  process.exit(0);
}

// Run the CLI scan only when executed directly (not when imported by a test).
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
