#!/usr/bin/env node
/**
 * lint-state-registry.js — every direct durable-write site that targets a
 * state dir / `.instar/` must be declared in the State-Coherence Registry.
 *
 * Part of the multi-machine-coherence P0 enforcement, landing with its first
 * consumer (the Coherence Journal, COHERENCE-JOURNAL-SPEC §3.6). The census
 * (docs/specs/STATE-COHERENCE-REGISTRY.md) classifies ~100 durable state
 * categories; its machine form is src/data/state-coherence-registry.json. The
 * principle: "Unclassified state = accidentally machine-local = the EXO
 * failure." New state must declare its coherence class at birth.
 *
 * HONEST FRAMING (per §3.6): this lint is a GUARDRAIL, not complete
 * enforcement. Durable writes can hide behind wrappers, libraries, and dynamic
 * paths the lint cannot statically resolve; the declared duty remains "a new
 * store registers itself," and this lint catches the COMMON DIRECT patterns —
 * a `writeFileSync`/`appendFileSync`/`createWriteStream`/sqlite-open whose line
 * statically names BOTH a state-dir indicator (`stateDir` / `state/` /
 * `.instar/`) AND a store-path literal. That paired requirement is the
 * deliberate false-positive floor: a write to a bare variable path (assigned
 * elsewhere) is invisible to a static line scan, and flagging it would be noise
 * a reviewer cannot action at the write site.
 *
 * A flagged site is SATISFIED when either:
 *   (a) its store-path literal matches the `paths` of some registry entry, OR
 *   (b) an inline `/* state-registry: <category> *​/` annotation appears within
 *       3 lines and names an existing registry entry — the greppable,
 *       reviewable escape for a registered store reached via a dynamic path.
 *
 * Exit codes: 0 — clean; 1 — at least one undeclared store, or a malformed
 * registry / dangling annotation.
 *
 * Usage:
 *   node scripts/lint-state-registry.js                 # full src/ tree
 *   node scripts/lint-state-registry.js --root <dir>    # alternate scan root
 *                                                       #   (tests point this
 *                                                       #    at a fixture tree)
 *   node scripts/lint-state-registry.js <file> [<file>] # explicit files
 *
 * No deps; plain node stdlib.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');

// ── Args ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
let scanRoot = path.join(REPO_ROOT, 'src');
const explicitFiles = [];
let registryPathArg = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--root') {
    scanRoot = path.resolve(argv[++i]);
  } else if (a === '--registry') {
    registryPathArg = path.resolve(argv[++i]);
  } else if (!a.startsWith('--')) {
    explicitFiles.push(path.resolve(a));
  }
}

const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);

// ── Load the registry ─────────────────────────────────────────────────────
const REGISTRY_PATH =
  registryPathArg || path.join(REPO_ROOT, 'src', 'data', 'state-coherence-registry.json');

function loadRegistry() {
  let raw;
  try {
    raw = fs.readFileSync(REGISTRY_PATH, 'utf-8');
  } catch {
    console.error(
      `lint-state-registry: registry JSON not found at ${path.relative(REPO_ROOT, REGISTRY_PATH)}. ` +
        `The registry and this lint ship in the same PR (COHERENCE-JOURNAL-SPEC §3.6).`,
    );
    process.exit(1);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error(`lint-state-registry: registry JSON is not valid JSON — ${(e && e.message) || e}`);
    process.exit(1);
  }
  const entries = parsed && Array.isArray(parsed.entries) ? parsed.entries : null;
  if (!entries) {
    console.error('lint-state-registry: registry JSON has no `entries` array.');
    process.exit(1);
  }
  const VALID_SCOPE = new Set([
    'machine-local',
    'must-be-coherent',
    'derived-cache',
    'coherent-on-demand',
  ]);
  const byCategory = new Map();
  for (const e of entries) {
    if (!e || typeof e.category !== 'string' || !e.category) {
      console.error('lint-state-registry: registry entry missing a string `category`.');
      process.exit(1);
    }
    if (!VALID_SCOPE.has(e.scope)) {
      console.error(`lint-state-registry: entry "${e.category}" has invalid scope "${e.scope}".`);
      process.exit(1);
    }
    if (!Array.isArray(e.paths)) {
      console.error(`lint-state-registry: entry "${e.category}" has no `+'`paths` array.');
      process.exit(1);
    }
    if (byCategory.has(e.category)) {
      console.error(`lint-state-registry: duplicate category "${e.category}".`);
      process.exit(1);
    }
    byCategory.set(e.category, e);
  }
  return { entries, byCategory };
}

const { entries: REGISTRY, byCategory: REGISTRY_BY_CATEGORY } = loadRegistry();

// ── Path-glob matching (glob-ish hints → literal) ─────────────────────────
// Registry `paths` are glob-ish hints. A write-site literal matches an entry
// when the literal's basename or a trailing path segment is named by one of
// the entry's path hints. We compare on normalized POSIX-ish strings and
// support `*` wildcards and trailing-`/` directory prefixes.
function normalize(p) {
  return String(p).replace(/\\/g, '/');
}

function globToRegExp(glob) {
  const g = normalize(glob);
  // Escape regex specials except `*`, then translate `*` → `[^/]*`.
  const escaped = g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(escaped);
}

/**
 * Does write-site `literal` (a quoted path fragment from source) fall under
 * registry path-hint `hint`?
 *
 * Matching is suffix/segment oriented because write sites compose paths
 * (`path.join(stateDir, 'state', 'foo.json')`) so the literal is usually only
 * the tail. A hint matches when:
 *   - hint ends with `/` (a directory prefix) and the literal contains that
 *     directory segment, OR
 *   - the hint's basename (last segment) equals/glob-matches the literal's
 *     basename, OR
 *   - the literal (or its tail) glob-matches the whole hint.
 */
function literalMatchesHint(literal, hint) {
  const lit = normalize(literal).replace(/^\.?\//, '');
  const h = normalize(hint).replace(/^\.?\//, '');

  // Directory-prefix hint: literal lives under it.
  if (h.endsWith('/')) {
    const dir = h.slice(0, -1);
    const dirRe = new RegExp('(^|/)' + globToRegExp(dir).source + '(/|$)');
    return dirRe.test(lit) || dirRe.test(lit + '/');
  }

  // Bare-filename hint (no path separator): match by basename glob. This is
  // the common write-site case (hint 'security.jsonl' vs literal
  // 'security.jsonl', or hint '*.local.md' vs 'topic.local.md'). A bare
  // wildcard hint like '*.json' would be dangerously broad, so it is rejected
  // — a wildcard basename is only honored when the hint also pins a directory
  // (handled by the suffix match below).
  if (!h.includes('/')) {
    if (h.includes('*')) return false;
    const litBase = lit.split('/').pop();
    const baseRe = new RegExp('^' + globToRegExp(h).source + '$');
    return baseRe.test(litBase);
  }

  // Path-qualified hint: require the WHOLE hint to suffix-match the literal
  // tail, so a wildcard basename ('relationships/*.json') only matches when
  // its directory segment ('relationships/') is present in the literal too.
  const wholeRe = new RegExp('(^|/)' + globToRegExp(h).source + '$');
  return wholeRe.test(lit);
}

function literalIsRegistered(literal) {
  for (const e of REGISTRY) {
    for (const hint of e.paths) {
      if (literalMatchesHint(literal, hint)) return e.category;
    }
  }
  return null;
}

// ── Write-site detection ──────────────────────────────────────────────────
// A line is a durable-write site when it calls one of these sinks…
const WRITE_SINK = /\b(?:writeFileSync|appendFileSync|createWriteStream|writeFile|appendFile)\s*\(/;
// …or opens a sqlite database.
const SQLITE_OPEN =
  /\b(?:new\s+(?:Database|BetterSqlite3|DatabaseSync)|sqlite3?\.Database|openDatabase)\s*\(/;

// A state-dir indicator must be present on the line for it to be IN SCOPE
// (the deliberate false-positive floor — see header).
const STATE_DIR_INDICATOR = /\bstateDir\b|\.instar\/|(?:^|[^A-Za-z0-9])state\//;

// Store-path literal: a quoted string that ends in a durable-state extension,
// OR a known bare control-file name (no extension).
const STORE_LITERAL_RE =
  /['"`]([^'"`]*?(?:\.(?:json|jsonl|db|sqlite3?|enc|pem|md|cache)|autonomous-emergency-stop|boot-id))['"`]/g;

const ANNOTATION_RE = /\/\*\s*state-registry:\s*([a-z0-9-]+)\s*\*\//;

function listFiles() {
  if (explicitFiles.length) {
    return explicitFiles.filter((f) => EXTENSIONS.has(path.extname(f)));
  }
  const files = [];
  const walk = (dir) => {
    let dirents;
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      if (d.name === 'node_modules' || d.name === '.git' || d.name === 'dist') continue;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) walk(full);
      else if (EXTENSIONS.has(path.extname(d.name))) files.push(full);
    }
  };
  walk(scanRoot);
  return files;
}

// Returns the annotated category if a `/* state-registry: cat */` annotation
// is present within `radius` lines of `idx` (inclusive both directions).
function annotationNear(lines, idx, radius) {
  for (let j = Math.max(0, idx - radius); j <= Math.min(lines.length - 1, idx + radius); j++) {
    const m = ANNOTATION_RE.exec(lines[j]);
    if (m) return m[1];
  }
  return null;
}

let violations = 0;
let danglingAnnotations = 0;

for (const file of listFiles()) {
  let content;
  try {
    content = fs.readFileSync(file, 'utf-8');
  } catch {
    continue;
  }
  const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/');
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // First, validate any annotation actually names a real category — a
    // dangling annotation is a silent-failure shape we refuse (Distrust
    // Temporary Success).
    const annHere = ANNOTATION_RE.exec(line);
    if (annHere && !REGISTRY_BY_CATEGORY.has(annHere[1])) {
      console.error(
        `${rel}:${i + 1} — state-registry annotation names unknown category "${annHere[1]}". ` +
          `Add it to src/data/state-coherence-registry.json or fix the name.`,
      );
      danglingAnnotations++;
    }

    const isWriteSite = WRITE_SINK.test(line) || SQLITE_OPEN.test(line);
    if (!isWriteSite) continue;
    if (!STATE_DIR_INDICATOR.test(line)) continue;

    // Collect store-path literals on this line.
    STORE_LITERAL_RE.lastIndex = 0;
    const literals = [];
    let m;
    while ((m = STORE_LITERAL_RE.exec(line)) !== null) literals.push(m[1]);
    if (literals.length === 0) continue; // sink + state-dir but no resolvable literal → out of scope

    // Annotation escape (within 3 lines) satisfies the whole site.
    const ann = annotationNear(lines, i, 3);
    if (ann && REGISTRY_BY_CATEGORY.has(ann)) continue;

    // Each literal must be registered.
    const unregistered = literals.filter((lit) => !literalIsRegistered(lit));
    if (unregistered.length > 0) {
      for (const lit of unregistered) {
        console.error(
          `${rel}:${i + 1} — durable write to "${lit}" has no State-Coherence Registry entry. ` +
            `Declare it in src/data/state-coherence-registry.json (pick a coherence scope), ` +
            `or add an inline /* state-registry: <category> */ annotation if the store is already registered.`,
        );
        violations++;
      }
    }
  }
}

const total = violations + danglingAnnotations;
if (total > 0) {
  console.error(
    `\nlint-state-registry: ${total} issue(s) ` +
      `(${violations} undeclared store(s), ${danglingAnnotations} dangling annotation(s)). ` +
      `See docs/specs/STATE-COHERENCE-REGISTRY.md and COHERENCE-JOURNAL-SPEC §3.6.`,
  );
  process.exit(1);
}
console.log(`lint-state-registry: clean (${REGISTRY.length} registry categories)`);
