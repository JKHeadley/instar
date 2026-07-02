#!/usr/bin/env node
/**
 * lint-scrape-fixture-realness.js — enforces that every REGISTERED scrape/parser
 * has a test that FEEDS it a structurally-real captured fixture and asserts on
 * the result (not a hand-authored clean string).
 *
 * Implements piece 3 of docs/specs/scrape-fixture-realness.md (the "code=t"
 * lesson, structurally enforced). A parser of untrusted real-world text is only
 * as good as the realness of its test input. The check is precise by
 * construction — a CURATED registry (SCRAPE_PARSERS), not a heuristic over all
 * tests — so false-positives are near-zero (same posture as
 * lint-no-direct-llm-http / lint-dev-agent-dark-gate). Adding/removing a registry
 * entry requires a spec change.
 *
 * For each registered parser the lint verifies (spec §3):
 *   (a) tests/fixtures/captured/<slug>/ has >=1 `.txt`, each with a valid matching
 *       `.meta.json` (required fields present + capturedAt parses as ISO date).
 *   (b) testFile contains a test whose name === testName, and within that test's
 *       body ALL of: a loadCapturedFixture('<slug>', ...) call, the parserSymbol
 *       called with the loaded var as an argument (member-expression accepted),
 *       and an expect( call.
 *
 * It ALSO scans src/ for exported parse-prefixed / scrape-prefixed symbols not covered by the
 * registry and prints a non-blocking WARNING ("register-or-justify") — a
 * Close-the-Loop signal, never a block (Signal vs. Authority).
 *
 * Exit codes:
 *   0 — every registered entry conforms (warnings do NOT affect exit code).
 *   1 — at least one registered entry fails a sub-check.
 *
 * Usage:
 *   node scripts/lint-scrape-fixture-realness.js                # full check
 *   node scripts/lint-scrape-fixture-realness.js --staged       # staged files (still runs full registry check)
 *   node scripts/lint-scrape-fixture-realness.js path1 path2    # explicit paths (still runs full registry check)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

/**
 * The curated registry of parsers whose realness is enforced. Each entry:
 *   { parserSymbol, fixtureSlug, testFile, testName }
 *
 * Adding/removing an entry requires a spec change (FD1/FD3). The seed is the one
 * parser we KNOW consumes untrusted terminal text and bit us (the code=t bug).
 */
export const SCRAPE_PARSERS = [
  {
    parserSymbol: 'FrameworkLoginDriver.parseArtifact',
    fixtureSlug: 'claude-url-code-paste',
    testFile: 'tests/unit/framework-login-driver.test.ts',
    testName: 'parses the REAL wrapped Mac Mini login pane',
  },
  // U4.3 (u4-3-breaker-recovery-probe §6): the recovery probe's typed-contract
  // success classifier consumes untrusted wire bytes (a captive portal or wrong
  // server can answer anything) — registered with captured byte-for-byte
  // fixtures of real /mesh/rpc responses + real wrong-server/captive bodies.
  {
    parserSymbol: 'parseProbeResponse',
    fixtureSlug: 'mesh-rpc-probe-responses',
    testFile: 'tests/unit/ropeProbeContract.test.ts',
    testName: 'classifies the REAL captured /mesh/rpc probe responses byte-for-byte',
  },
  // U4.5 (u4-5-rope-health-alerts §6): the key-expiry tier's parser consumes
  // untrusted CLI stdout (`tailscale status --json` — carries IPs, emails,
  // tailnet names that must NEVER leave the parser) — registered with captured
  // byte-for-byte fixtures of the real command output (same-length redactions).
  {
    parserSymbol: 'parseTailscaleStatus',
    fixtureSlug: 'tailscale-status',
    testFile: 'tests/unit/tailscaleStatusParser.test.ts',
    testName: 'parses the REAL captured tailscale status --json byte-for-byte',
  },
];

const REQUIRED_META_FIELDS = ['source', 'command', 'capturedAt', 'machine', 'redactions', 'note'];

/**
 * (a) — verify the captured-fixture directory + sidecars for a slug.
 * @returns {string[]} list of failure messages (empty = ok)
 */
export function checkFixtures(root, fixtureSlug) {
  const failures = [];
  const dir = path.join(root, 'tests', 'fixtures', 'captured', fixtureSlug);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    failures.push(`fixture dir missing: tests/fixtures/captured/${fixtureSlug}/`);
    return failures;
  }
  const entries = fs.readdirSync(dir);
  const txts = entries.filter((f) => f.endsWith('.txt'));
  if (txts.length === 0) {
    failures.push(`no .txt captures in tests/fixtures/captured/${fixtureSlug}/`);
    return failures;
  }
  for (const txt of txts) {
    const base = txt.slice(0, -'.txt'.length);
    const sidecar = `${base}.meta.json`;
    const sidecarPath = path.join(dir, sidecar);
    if (!fs.existsSync(sidecarPath)) {
      failures.push(`missing sidecar ${fixtureSlug}/${sidecar} for capture ${fixtureSlug}/${txt}`);
      continue;
    }
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(sidecarPath, 'utf-8'));
    } catch (err) {
      failures.push(`sidecar ${fixtureSlug}/${sidecar} is not valid JSON: ${err.message}`);
      continue;
    }
    for (const field of REQUIRED_META_FIELDS) {
      if (!(field in meta)) {
        failures.push(`sidecar ${fixtureSlug}/${sidecar} missing required field "${field}"`);
      }
    }
    if (meta.capturedAt !== undefined) {
      const t = Date.parse(meta.capturedAt);
      if (Number.isNaN(t)) {
        failures.push(`sidecar ${fixtureSlug}/${sidecar} capturedAt "${meta.capturedAt}" is not a parseable ISO-8601 date`);
      }
    }
  }
  return failures;
}

/**
 * Extract the body text of an `it('<name>', ...)` / `test('<name>', ...)` block
 * by matching the opening and walking braces to the matching close. Returns null
 * if no test with that exact name is found.
 */
export function extractTestBody(source, testName) {
  // Find an it/test call whose first string-literal arg === testName.
  // Match the literal (single, double, or backtick quotes) followed by a comma.
  const escaped = testName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const opener = new RegExp(`\\b(?:it|test)\\s*\\(\\s*(['"\`])${escaped}\\1\\s*,`, 'g');
  const m = opener.exec(source);
  if (!m) return null;
  // Walk forward from the end of the matched opener to find the body's braces.
  // The test body is the arrow/function passed as the 2nd arg; find its first
  // `{` after the opener and brace-match to its close.
  let i = opener.lastIndex;
  // Skip ahead to the first `{` that starts the callback body.
  const braceStart = source.indexOf('{', i);
  if (braceStart < 0) return null;
  let depth = 0;
  for (let j = braceStart; j < source.length; j++) {
    const ch = source[j];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return source.slice(braceStart + 1, j);
      }
    }
  }
  return null;
}

/**
 * (b) — verify the registered test exists and feeds-and-asserts.
 * @returns {string[]} list of failure messages (empty = ok)
 */
export function checkTest(root, entry) {
  const failures = [];
  const testPath = path.join(root, entry.testFile);
  if (!fs.existsSync(testPath)) {
    failures.push(`testFile missing: ${entry.testFile}`);
    return failures;
  }
  const source = fs.readFileSync(testPath, 'utf-8');
  const body = extractTestBody(source, entry.testName);
  if (body === null) {
    failures.push(`no test named "${entry.testName}" found in ${entry.testFile}`);
    return failures;
  }

  // The loader call, capturing the variable it assigns to.
  // const <v> = loadCapturedFixture('<slug>', ...)
  const slugEsc = entry.fixtureSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const loaderRe = new RegExp(
    `(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*loadCapturedFixture\\s*\\(\\s*['"\`]${slugEsc}['"\`]`,
  );
  const loaderMatch = body.match(loaderRe);
  if (!loaderMatch) {
    failures.push(
      `test "${entry.testName}" must call loadCapturedFixture('${entry.fixtureSlug}', …) and assign the result to a variable`,
    );
  }
  const loadedVar = loaderMatch ? loaderMatch[1] : null;

  // The parser call, fed the loaded variable as an argument.
  // Accept member-expression (Cls.method) or bare/aliased call.
  // parserSymbol may be "Cls.method" — escape dots literally.
  const parserEsc = entry.parserSymbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let parserFed = false;
  if (loadedVar) {
    const varEsc = loadedVar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // <parserSymbol>( ... <loadedVar> ... ) — loadedVar appears as an arg.
    const parserRe = new RegExp(`${parserEsc}\\s*\\(\\s*${varEsc}\\b`);
    parserFed = parserRe.test(body);
  }
  if (!parserFed) {
    failures.push(
      `test "${entry.testName}" must pass the loaded fixture variable as the first argument to ${entry.parserSymbol}(…)`,
    );
  }

  // At least one expect( on the result.
  if (!/\bexpect\s*\(/.test(body)) {
    failures.push(`test "${entry.testName}" must assert on the parse result with expect(…)`);
  }

  return failures;
}

/** Recursively collect `.ts` files under a dir. */
function walkTs(dir, out, skip) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (skip.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkTs(full, out, skip);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(full);
  }
}

/**
 * Close-the-Loop signal: scan src/ for exported parse-prefixed / scrape-prefixed symbols not in
 * the registry. Non-blocking — returns a warning list only.
 * @returns {Array<{symbol:string,file:string}>}
 */
export function findUnregisteredParsers(root) {
  const skip = new Set(['node_modules', 'dist', 'build', '.instar', '.git', '.next', 'coverage']);
  const files = [];
  const srcDir = path.join(root, 'src');
  if (fs.existsSync(srcDir)) walkTs(srcDir, files, skip);

  // The bare method names already covered by the registry (e.g. "parseArtifact").
  const registeredMethodNames = new Set(
    SCRAPE_PARSERS.map((e) => {
      const parts = e.parserSymbol.split('.');
      return parts[parts.length - 1];
    }),
  );

  const re = /export\s+(?:async\s+)?function\s+((?:parse|scrape)[A-Z]\w*)|export\s+const\s+((?:parse|scrape)[A-Z]\w*)/g;
  const found = [];
  const seen = new Set();
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      const symbol = m[1] || m[2];
      if (!symbol) continue;
      if (registeredMethodNames.has(symbol)) continue;
      const rel = path.relative(root, file).split(path.sep).join('/');
      const key = `${rel}:${symbol}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ symbol, file: rel });
    }
  }
  return found;
}

/**
 * Run the full lint over the registry. Pure-ish (reads fs, returns a result).
 * @returns {{ exitCode:number, errors:string[], warnings:string[], passed:Array }}
 */
export function runLint(root = ROOT) {
  const errors = [];
  const passed = [];
  for (const entry of SCRAPE_PARSERS) {
    const failures = [...checkFixtures(root, entry.fixtureSlug), ...checkTest(root, entry)];
    if (failures.length > 0) {
      errors.push(
        `Registered parser "${entry.parserSymbol}" (${entry.testFile}) failed realness check:\n` +
          failures.map((f) => `      - ${f}`).join('\n'),
      );
    } else {
      passed.push(entry);
    }
  }

  const unregistered = findUnregisteredParsers(root);
  const warnings = [];
  if (unregistered.length > 0) {
    warnings.push(
      `register-or-justify: ${unregistered.length} exported parse*/scrape* symbol(s) in src/ are not in SCRAPE_PARSERS.\n` +
        `      If they consume untrusted real-world text, register them (spec change) or justify out-of-scope in the PR:\n` +
        unregistered.slice(0, 20).map((u) => `        • ${u.symbol} (${u.file})`).join('\n') +
        (unregistered.length > 20 ? `\n        • ...and ${unregistered.length - 20} more` : ''),
    );
  }

  return { exitCode: errors.length > 0 ? 1 : 0, errors, warnings, passed };
}

function main() {
  // --staged / explicit paths are accepted for parity with sibling lints, but
  // the realness check is over the curated registry, so it always runs the full
  // registry check regardless of which files changed.
  const { exitCode, errors, warnings, passed } = runLint(ROOT);

  if (errors.length > 0) {
    console.error('lint-scrape-fixture-realness: registered parser(s) failed realness enforcement.\n');
    console.error('A registered scrape/parser must have a test that FEEDS it a structurally-real captured');
    console.error('fixture and asserts on the result. See docs/specs/scrape-fixture-realness.md.\n');
    for (const e of errors) console.error(`  ❌ ${e}`);
    console.error('');
  } else {
    for (const e of passed) {
      console.log(`  ✅ ${e.parserSymbol} — realness fixture + feeds-and-asserts test OK (${e.testName})`);
    }
  }

  if (warnings.length > 0) {
    for (const w of warnings) console.warn(`  ⚠️  ${w}`);
    console.warn('');
  }

  process.exit(exitCode);
}

const isDirectRun = (() => {
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === __filename;
  } catch {
    return false;
  }
})();
if (isDirectRun) main();
