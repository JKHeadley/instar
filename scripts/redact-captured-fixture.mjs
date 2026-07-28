#!/usr/bin/env node
/**
 * redact-captured-fixture.mjs — same-SHAPE, grammar-valid secret redaction for
 * captured parser fixtures.
 *
 * Captured fixtures (tests/fixtures/captured/<slug>/) preserve every STRUCTURAL
 * byte that matters to parsing (wrapping/ANSI/spacing/line-breaks) — those are
 * the realness and are NEVER tidied. But a real capture carries secrets (OAuth
 * client_id/state, tokens, usernames, paths). Committing them raw is a leak, so
 * each secret VALUE is replaced with a same-SHAPE placeholder:
 *
 *   - SAME LENGTH (so line positions + wrapping stay byte-identical),
 *   - SAME CHARACTER CLASS (hex stays hex, base64url stays base64url, …),
 *   - delimiters preserved AT THEIR POSITIONS (a UUID keeps its `-` offsets),
 *   - GRAMMAR-VALID (a redacted URL still parses; encoding form intact).
 *
 * A redaction that would change length is REJECTED — a length change shifts the
 * wrapping and silently produces a passing-but-fake fixture.
 *
 * See docs/specs/scrape-fixture-realness.md (FD2) and
 * tests/fixtures/captured/README.md.
 *
 * Usage (CLI):
 *   node scripts/redact-captured-fixture.mjs <raw.txt> \
 *     --redact '<find>:<class>' [--redact '<find>:<class>' ...] [-o out.txt]
 *
 *   <class> ∈ hex | uuid | base64url | alnum | token
 *
 * Programmatic:
 *   import { redactCapture } from './redact-captured-fixture.mjs';
 *   const { redacted, redactions } = redactCapture(raw, [{ find, class }]);
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The supported redaction classes. Adding a class requires a spec change
// (it widens the same-shape contract).
export const REDACTION_CLASSES = new Set(['hex', 'uuid', 'base64url', 'alnum', 'token']);

// Per-class placeholder fill characters. The fill is a single canonical char of
// the class so the result is obviously inert (not a plausible real secret),
// while staying in the class so the parser's grammar is preserved.
const CLASS_FILL = {
  hex: 'a', // [0-9a-f]
  uuid: 'a', // hex within UUID segments; hyphens are preserved positionally
  base64url: 'z', // [A-Za-z0-9_-]
  alnum: 'x', // [A-Za-z0-9]
  token: 'x', // generic opaque token — treated like alnum for the fill
};

// Characters that are DELIMITERS within a value of a given class — preserved at
// their exact positions so the value's internal structure (and thus length +
// grammar) is unchanged. Everything else is replaced with the class fill char.
const CLASS_DELIMITERS = {
  hex: new Set([]),
  uuid: new Set(['-']),
  base64url: new Set(['-', '_']),
  alnum: new Set([]),
  token: new Set(['-', '_', '.']),
};

/**
 * Build a same-length, same-class, grammar-valid placeholder for a secret value.
 * Delimiter characters for the class are preserved at their positions.
 */
function placeholderFor(value, cls) {
  const fill = CLASS_FILL[cls];
  const delims = CLASS_DELIMITERS[cls];
  let out = '';
  for (const ch of value) {
    out += delims.has(ch) ? ch : fill;
  }
  return out;
}

/**
 * Redact secrets from a raw capture, producing a same-shape result.
 *
 * @param {string} raw    the raw captured text (structural bytes preserved)
 * @param {Array<{find:string, class:string}>} specs  secrets to redact
 * @returns {{ redacted: string, redactions: Array<{what:string,strategy:string,length:number,class:string}> }}
 * @throws if a class is unknown, a `find` is missing from `raw`, or a
 *         placeholder would change length (it never should — this is a guard).
 */
export function redactCapture(raw, specs) {
  if (typeof raw !== 'string') throw new Error('redactCapture: raw must be a string');
  if (!Array.isArray(specs)) throw new Error('redactCapture: specs must be an array');

  let redacted = raw;
  const redactions = [];

  for (const spec of specs) {
    const { find } = spec;
    const cls = spec.class;
    if (typeof find !== 'string' || find.length === 0) {
      throw new Error('redactCapture: each spec needs a non-empty `find` string');
    }
    if (!REDACTION_CLASSES.has(cls)) {
      throw new Error(
        `redactCapture: unknown class "${cls}" for find "${find}" — must be one of ${[...REDACTION_CLASSES].join(', ')}`,
      );
    }
    if (!redacted.includes(find)) {
      throw new Error(`redactCapture: secret to redact not found in capture: "${find}"`);
    }

    const placeholder = placeholderFor(find, cls);
    // Length-preservation guard: the whole point is byte-identical wrapping.
    if (placeholder.length !== find.length) {
      throw new Error(
        `redactCapture: placeholder length ${placeholder.length} != original length ${find.length} ` +
          `for class "${cls}" — a length-changing redaction shifts wrapping and is rejected.`,
      );
    }

    redacted = redacted.split(find).join(placeholder);
    redactions.push({
      what: find,
      strategy: `same-length ${find.length} ${cls}-class placeholder, delimiters preserved at positions`,
      length: find.length,
      class: cls,
    });
  }

  return { redacted, redactions };
}

// ── thin CLI wrapper ──────────────────────────────────────────────────
function parseArgs(argv) {
  const specs = [];
  let input = null;
  let out = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--redact') {
      const v = argv[++i];
      const idx = v.lastIndexOf(':');
      if (idx < 0) throw new Error(`--redact expects '<find>:<class>', got "${v}"`);
      specs.push({ find: v.slice(0, idx), class: v.slice(idx + 1) });
    } else if (a === '-o' || a === '--out') {
      out = argv[++i];
    } else if (!input) {
      input = a;
    }
  }
  return { input, out, specs };
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    console.log(
      'Usage: node scripts/redact-captured-fixture.mjs <raw.txt> --redact \'<find>:<class>\' [...] [-o out.txt]\n' +
        `  <class> ∈ ${[...REDACTION_CLASSES].join(' | ')}`,
    );
    process.exit(argv.length === 0 ? 1 : 0);
  }
  const { input, out, specs } = parseArgs(argv);
  const raw = fs.readFileSync(input, 'utf-8');
  const { redacted, redactions } = redactCapture(raw, specs);
  if (out) {
    fs.writeFileSync(out, redacted);
    console.error(`Wrote redacted capture to ${out}`);
  } else {
    process.stdout.write(redacted);
  }
  console.error(`Redactions (${redactions.length}):`);
  for (const r of redactions) {
    console.error(`  - ${r.class} (len ${r.length}): ${r.strategy}`);
  }
}

const isDirectRun = (() => {
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (isDirectRun) main();
