#!/usr/bin/env node
/**
 * lint-no-unfunneled-credential-write.js — refuses a raw write to the Claude Code
 * credential store outside the serialization funnel (Step 4b of live credential
 * re-pointing, spec §2.2).
 *
 * Why this exists: every in-process write to a config home's `Claude Code-credentials`
 * keychain entry MUST go through `CredentialWriteFunnel.withSlotLock(slot, …)` (via
 * `refreshClaudeToken`, `writeCredentialsSerialized`, or the Step-5 swap executor) so a
 * refresh write can never interleave with a swap on the SAME slot and strand a rotated
 * token. A callsite that writes the credential store directly — `defaultCredentialStore.write`,
 * `provider.writeCredentials(...)`, or a hand-rolled `security add-generic-password` to the
 * `Claude Code-credentials` service — bypasses that lock and re-opens the clobber race.
 * This mirrors the SafeGitExecutor / SafeFsExecutor single-funnel precedent.
 *
 * Rule: outside the closed allowlist below, no source file may contain:
 *   - a `defaultCredentialStore.write(` call,
 *   - a qualified `.writeCredentials(` call (i.e. `someProvider.writeCredentials(...)` —
 *     the bare method DEFINITION `writeCredentials(creds…)` has no leading dot and is fine),
 *   - a raw `add-generic-password` invocation in a file that targets the
 *     `Claude Code-credentials` service (scoped by the literal service string so the OTHER
 *     keychain vaults — WorktreeKeyVault / SecretStore / GlobalSecretStore / RemediationKeyVault,
 *     each a DISTINCT service — never false-positive).
 *
 * Comment-only mentions are NOT a bypass and are ignored.
 *
 * Exit codes: 0 — clean; 1 — at least one violation.
 *
 * Usage:
 *   node scripts/lint-no-unfunneled-credential-write.js            # full repo
 *   node scripts/lint-no-unfunneled-credential-write.js --staged   # staged files
 *   node scripts/lint-no-unfunneled-credential-write.js <file…>    # explicit files (tests)
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

// ── Allowlist (closed). Each entry is a file that OWNS a credential-write primitive
//    and routes it through the funnel internally (or the lint itself). Adding an entry
//    requires review of WHY the callsite cannot route through `withSlotLock`. ──────
const ALLOWLIST = new Set([
  // THE funnel — the per-slot lock lives here.
  'src/core/CredentialWriteFunnel.ts',
  // Owns `defaultCredentialStore.write` + the raw keychain write; `refreshClaudeToken`
  // wraps it in `funnel.withSlotLock(configHome, …)`.
  'src/core/OAuthRefresher.ts',
  // Owns `KeychainCredentialProvider.writeCredentials` (the raw `security -i` write) +
  // the sanctioned `writeCredentialsSerialized` funnel chokepoint that wraps it.
  'src/monitoring/CredentialProvider.ts',
  // Step 5 (spec section 2.3). Owns the async execFile add-generic-password keychain write
  // primitive (defaultKeychainExec) used for slot + staging writes. Every credential write the
  // executor performs runs INSIDE funnel.withSingleMover then funnel.withSlotLocks([A,B], ...) —
  // the staged exchange takes the single-mover mutex AND both slot locks before any write, so a
  // swap write can never interleave with a refresh/switch on the same slot. Funnel-routing is at
  // the call layer (the primitive must NOT self-lock under the slot locks). Sanctioned route.
  'src/core/CredentialSwapExecutor.ts',
  // This lint file names the patterns it greps for.
  'scripts/lint-no-unfunneled-credential-write.js',
]);

const SCAN_DIRS = ['src', 'scripts', 'templates'];
const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.sh']);

// The keychain service the funnel guards. Scopes the raw `add-generic-password` rule so the
// other (distinct-service) keychain vaults never trip it.
const GUARDED_SERVICE = 'Claude Code-credentials';

const PATTERNS = [
  {
    re: /defaultCredentialStore\.write\s*\(/,
    msg: 'direct defaultCredentialStore.write — route through CredentialWriteFunnel.withSlotLock (see refreshClaudeToken)',
  },
  {
    re: /\.writeCredentials\s*\(/,
    msg: 'direct provider.writeCredentials(...) — route through writeCredentialsSerialized (CredentialProvider.ts)',
  },
];

// A raw keychain write is flagged ONLY in a file that also references the guarded service —
// so WorktreeKeyVault / SecretStore / GlobalSecretStore / RemediationKeyVault (distinct
// services) are never false-positived.
const RAW_KEYCHAIN_WRITE = /add-generic-password/;

// ── Evasion-resistant detection (2026-08-14) ─────────────────────────────
// A peer-agent audit classified this check DEFEATABLE by ordinary renaming,
// and three bypasses were then reproduced against it:
//
//   const SVC = 'Claude Code' + '-credentials';         // concatenated service
//   execFileSync('security', ['add-generic-password', '-s', SVC]);
//   const store = defaultCredentialStore; store.write(p);  // re-bound receiver
//   provider['writeCredentials'](p);                       // computed access
//
// The first is the sharpest: the raw-keychain rule is GATED on the literal
// service string appearing in the file, so splitting it across a concatenation
// switches the whole rule off. That gate exists to avoid false-positiving the
// other, distinct-service vaults, so it is narrowed rather than removed.

/** Collapse simple adjacent string concatenation so `'A' + 'B'` reads as `AB`. */
export function collapseConcatenation(content) {
  // `'A' + 'B'` / "A" + "B" / mixed quotes → `AB`. Repeated to fold chains.
  let out = content;
  for (let i = 0; i < 5; i++) {
    const next = out.replace(/(['"])\s*\+\s*(['"])/g, '');
    if (next === out) break;
    out = next;
  }
  return out;
}

/** Local names bound to `defaultCredentialStore`, resolved to a fixpoint. */
export function credentialStoreBindings(content) {
  const names = new Set(['defaultCredentialStore']);
  for (let pass = 0; pass < 10; pass++) {
    const before = names.size;
    for (const known of [...names]) {
      const re = new RegExp(`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${known}\\s*[;,\\n]`, 'g');
      for (const m of content.matchAll(re)) names.add(m[1]);
    }
    if (names.size === before) break;
  }
  return [...names];
}

/**
 * Violations in `content`, as { line, msg }. Exported so the rules can be
 * driven with fixtures rather than only end-to-end over the tree.
 */
export function findCredentialWriteViolations(content) {
  const hits = [];
  // Concatenation-tolerant: a split service literal no longer disarms the rule.
  const targetsGuardedService = collapseConcatenation(content).includes(GUARDED_SERVICE);
  const storeNames = credentialStoreBindings(content);
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isCommentLine(line)) continue;
    // Re-bound receiver + computed access on the store write.
    for (const n of storeNames) {
      if (new RegExp(`\\b${n}\\s*\\.\\s*write\\s*\\(`).test(line)
        || new RegExp(`\\b${n}\\s*\\[\\s*['"\`]write['"\`]\\s*\\]\\s*\\(`).test(line)) {
        hits.push({ line: i + 1, msg: PATTERNS[0].msg });
        break;
      }
    }
    // `.writeCredentials(` and its computed form.
    if (/\.writeCredentials\s*\(/.test(line)
      || /\[\s*['"`]writeCredentials['"`]\s*\]\s*\(/.test(line)) {
      hits.push({ line: i + 1, msg: PATTERNS[1].msg });
    }
    if (targetsGuardedService && RAW_KEYCHAIN_WRITE.test(line)) {
      hits.push({
        line: i + 1,
        msg: `raw 'add-generic-password' to the ${GUARDED_SERVICE} service outside the funnel. `
          + `Route the write through CredentialWriteFunnel.withSlotLock, or add an allowlist entry here with a justification.`,
      });
    }
  }
  return hits;
}

function isCommentLine(line) {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('#');
}

function listFiles() {
  if (process.argv.includes('--staged')) {
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
// Guarded so the exported detector can be imported by tests WITHOUT running the
// scan: this module calls process.exit(1) on a violation, so an unguarded
// import would kill any test run the moment the repo had one. Same pattern as
// scripts/eli16-pr-description-check.mjs and lint-no-unbounded-llm-spawn.js.
const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;

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
  for (const hit of findCredentialWriteViolations(content)) {
    console.error(`${normalized}:${hit.line} — ${hit.msg}`);
    violations++;
  }
}

if (violations > 0) {
  console.error(
    `\nlint-no-unfunneled-credential-write: ${violations} violation(s). Every Claude credential write ` +
    `must go through CredentialWriteFunnel.withSlotLock (spec §2.2).`,
  );
  process.exit(1);
}
console.log('lint-no-unfunneled-credential-write: clean');
}
