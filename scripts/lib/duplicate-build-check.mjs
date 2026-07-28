// safe-git-allow: duplicate-build-guard check library — READ-ONLY git only
//   (rev-parse / log / grep / ls-tree / branch / fetch), every call an
//   execFileSync ARGV ARRAY (never a shell string), untrusted values
//   type-validated + passed after `--` per docs/specs/duplicate-build-guard.md
//   §3.2a. Never a destructive git verb.

/**
 * duplicate-build-check.mjs — the duplicate-build guard's deterministic,
 * fail-open, security-hardened check library.
 *
 * Spec: docs/specs/duplicate-build-guard.md (converged + approved, ACT-592).
 * Principle: docs/signal-vs-authority.md — this module only ever produces
 * SIGNALS (a verdict + evidence). The proceed/abandon authority is the human
 * author's recorded disposition; the only blocking surfaces are the
 * build-start PreToolUse gate (which enforces that a disposition EXISTS) and
 * the precommit presence-only backstop.
 *
 * The check asks three "is anyone else on this right now?" questions (§3.2):
 *   1. Local sibling in-flight ledger  (<agent-home>/state/dup-build-inflight.jsonl)
 *   2. Open PRs                        (bounded two-stage `gh` scan; CI-skipped)
 *   3. Recently-merged lookback        (git log origin/main --since=…)
 * plus a WEAK `main`-state corroborator (git grep — never a block source) and
 * a WEAK changed-file overlap (reusing scripts/lib/pre-push-scope.mjs).
 *
 * TOTAL verdict ladder (§3.3, FD4):
 *   likely-duplicate ⇔ a STRONG-exact target matches a CONCURRENCY source.
 *   verify           ⇔ fuzzy-only hit (cause `fuzzy`) OR strong target only on
 *                      main-state (cause `main-only`) OR a degraded scan on a
 *                      substrate-introducing spec (cause `degraded`).
 *   clear            ⇔ no overlap + all concurrency sources scanned; a degraded
 *                      NON-substrate scan is `clear` with a degraded audit flag.
 *   WEAK-only overlap → silent `clear` + a quiet note (never `verify`).
 * Real-overlap causes (`fuzzy`, `main-only`) OUTRANK the environmental
 * `degraded` tag; `causes[]` carries the full set for the audit trail.
 *
 * FAIL-OPEN TOTALITY (§3.3, FD5): any internal error → a non-blocking
 * `check-errored` verdict; the CLI ALWAYS exits 0. Per-subprocess timeouts
 * git ≤3s / gh ≤5s, total budget ≤8s.
 *
 * Off-switch: INSTAR_DUP_BUILD_CHECK=off (or instarDev.duplicateBuildGuard
 * disabled in a reachable .instar/config.json) → total no-op (`skipped`).
 *
 * CLI:
 *   node scripts/lib/duplicate-build-check.mjs <specPath> [--json] [--root <p>]
 *     [--phase build-start|pre-push] [--agent-home <p>]
 *   node scripts/lib/duplicate-build-check.mjs --record-disposition \
 *     --decision proceed|abandon --reason "…" [--ack EV-1,EV-2] [--root <p>]
 *   node scripts/lib/duplicate-build-check.mjs --remove-marker [--root <p>] [--agent-home <p>]
 *
 * State files (worktree-local, gitignored):
 *   .instar/dup-build-check.json        — the verdict stub + recorded disposition
 *   .instar/dup-build-cache.json        — the (specSlug, mainSha, prListHash) cache
 *   logs/dup-build-check.jsonl          — the append-only audit trail (metadata only)
 * Agent-home state:
 *   <agent-home>/state/dup-build-inflight.jsonl — the sibling in-flight ledger (0600)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolvePrePushBase, changedFilesSince } from './pre-push-scope.mjs';

const __filename = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = path.resolve(path.dirname(__filename), '..', '..');

// ── Tunables (spec §3.1/§3.3 — bounds enforced BEFORE similarity math) ──────

/**
 * FD6 — the token-set-Jaccard fuzzy floor. A frontloaded CONSERVATIVE constant
 * tuned toward recall (a fuzzy-only hit only ever yields `verify`, the cheap
 * verdict). CALIBRATED against the committed corpus at
 * tests/fixtures/dup-build-calibration.json (tests/unit/duplicate-build-check.test.ts
 * asserts recall on the known-duplicate pairs and a precision floor on the
 * known-non-duplicate pairs at exactly this constant). An evidence-set
 * constant, not a guess. Measured corpus scores at calibration time:
 * duplicates 0.263–0.667 (min: the rename+rewrite pair), non-duplicates
 * 0.000–0.111 (max: secret-sync vs secret-drop) — 0.22 sits below every
 * known dup with a ~2x margin over the worst known non-dup.
 */
export const JACCARD_THRESHOLD = 0.22;

export const MAX_TARGETS = 20;
export const PR_BODY_CAP_BYTES = 8 * 1024; // §3.1: each PR body ≤8KB BEFORE similarity
export const SPEC_SECTION_CAP_BYTES = 4 * 1024; // §3.1: each spec section ≤4KB
export const GIT_TIMEOUT_MS = 3_000; // §3.3 per-subprocess: git ≤3s
export const GH_TIMEOUT_MS = 5_000; // §3.3 per-subprocess: gh ≤5s
export const TOTAL_BUDGET_MS = 8_000; // §3.3 total budget
export const OPEN_PR_LIMIT = 100; // §3.2: gh pr list --limit
export const PR_DIFF_STAGE2_MAX = 5; // §3.2: gh pr diff on ≤5 matched PRs only
export const PR_DIFF_CAP_BYTES = 512 * 1024; // §3.2: per-PR diff-size cap
export const MERGE_LOOKBACK_MAX_COMMITS = 500; // §3.2: -n 500
export const MERGE_LOOKBACK_FLOOR_DAYS = 30; // §3.2: 30d floor
export const GREP_MAX_MATCHES = 50; // §3.2a: git grep max-match cap
export const LINE_CLAMP_CHARS = 300; // §3.2a: per-match / evidence line clamp
export const LEDGER_COMPACT_BYTES = 256 * 1024; // §3.2: read-time compaction threshold
export const CENSUS_FILE = 'src/data/provenanceCoverage.ts'; // pinned census artifact path (§4)

export const STUB_REL_PATH = path.join('.instar', 'dup-build-check.json');
export const MARKER_REL_PATH = path.join('.instar', 'dup-build-gate.marker.json');
export const CACHE_REL_PATH = path.join('.instar', 'dup-build-cache.json');
export const AUDIT_REL_PATH = path.join('logs', 'dup-build-check.jsonl');
export const LEDGER_REL_PATH = path.join('state', 'dup-build-inflight.jsonl');

// ── Rollout flag (§5) ────────────────────────────────────────────────────────

/** INSTAR_DUP_BUILD_CHECK=off|0|false → the whole guard no-ops. */
export function isGuardOff(env = process.env, root = DEFAULT_ROOT) {
  const v = String(env.INSTAR_DUP_BUILD_CHECK ?? '').toLowerCase();
  if (v === 'off' || v === '0' || v === 'false') return true;
  // Best-effort config read (instarDev.duplicateBuildGuard) — the gates run
  // pre-compile so this is a plain JSON probe, fail-open on any error.
  try {
    const cfgPath = path.join(root, '.instar', 'config.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      const g = cfg && cfg.instarDev && cfg.instarDev.duplicateBuildGuard;
      if (g === false) return true;
      if (g && typeof g === 'object' && g.enabled === false) return true;
    }
  } catch {
    /* unreadable config → default-on per §5 */
  }
  return false;
}

/** The precommit backstop only REFUSES when the guard is explicitly live. */
export function isGuardExplicitlyOn(env = process.env) {
  const v = String(env.INSTAR_DUP_BUILD_CHECK ?? '').toLowerCase();
  return v === 'on' || v === '1' || v === 'true';
}

// ── §3.2a type validators (option-injection defense) ────────────────────────
// Validation is BY TYPE for the value's argument position — NOT a blanket
// leading-`-` reject (which would wrongly refuse valid slugs/paths). A value
// that fails its type check is DROPPED from the scan, never shelled. Every
// untrusted value is additionally passed after a `--` end-of-options separator
// where the git/gh grammar allows one.

const TOKEN_RE = /^[A-Za-z0-9_.:/-]{2,128}$/;

export function isValidToken(v) {
  return typeof v === 'string' && TOKEN_RE.test(v) && !v.startsWith('-');
}

export function isValidRepoRelPath(p) {
  if (typeof p !== 'string' || p.length < 2 || p.length > 256) return false;
  if (path.isAbsolute(p)) return false;
  if (p.includes('\\') || p.includes('\0')) return false;
  const parts = p.split('/');
  if (parts.some((seg) => seg === '' || seg === '.' || seg === '..')) return false;
  return /^[A-Za-z0-9_.@/-]+$/.test(p);
}

export function isValidPrNumber(n) {
  return Number.isInteger(n) && n > 0 && n < 10_000_000;
}

export function isValidRef(r) {
  if (typeof r !== 'string' || r.length < 1 || r.length > 200) return false;
  if (r.startsWith('-') || r.startsWith('.') || r.endsWith('.') || r.endsWith('/')) return false;
  if (r.includes('..') || r.includes('@{') || r.includes('//')) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(r);
}

/** Strip control/escape chars + clamp length — every untrusted string passes
 * through here before entering evidence, a log line, or the agent surface. */
export function clampUntrusted(s, max = LINE_CLAMP_CHARS) {
  return String(s ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/\n/g, ' ')
    .slice(0, max);
}

/** Byte-cap a string (enforced BEFORE any similarity math — §3.1/FD6). */
export function capBytes(s, capBytesN) {
  const str = String(s ?? '');
  const buf = Buffer.from(str, 'utf8');
  if (buf.length <= capBytesN) return str;
  return buf.subarray(0, capBytesN).toString('utf8');
}

// ── FD6 fuzzy floor: normalization + token-set Jaccard ──────────────────────

const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'into', 'onto', 'over',
  'under', 'are', 'was', 'were', 'will', 'must', 'can', 'may', 'has', 'have',
  'had', 'its', 'not', 'but', 'when', 'then', 'than', 'per', 'via', 'each',
  'only', 'never', 'ever', 'also', 'out', 'all', 'any', 'one', 'two', 'you',
  'your', 'our', 'their', 'they', 'them', 'his', 'her', 'she', 'him', 'who',
  'what', 'which', 'where', 'how', 'why', 'does', 'did', 'been', 'being',
  'would', 'could', 'should', 'here', 'there', 'these', 'those', 'such',
  'more', 'most', 'less', 'least', 'very', 'just', 'both', 'same', 'other',
  'about', 'before', 'after', 'because', 'between', 'against', 'without',
  'within', 'itself', 'every', 'spec', 'specs',
]);

function stem(t) {
  if (t.length > 6 && t.endsWith('ing')) return t.slice(0, -3);
  if (t.length > 5 && t.endsWith('ed')) return t.slice(0, -2);
  if (t.length > 4 && t.endsWith('es')) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1);
  return t;
}

/** Lowercase → split on non-alphanumerics → drop short/stopword tokens → light stem. */
export function normalizeTokens(text) {
  const out = new Set();
  for (const raw of String(text ?? '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3) continue;
    if (STOPWORDS.has(raw)) continue;
    out.add(stem(raw));
  }
  return out;
}

/** Deterministic token-set Jaccard (FD6 — no embeddings, linear in capped tokens). */
export function tokenSetJaccard(a, b) {
  if (!a || !b || a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (large.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

// ── §3.1 target extraction ───────────────────────────────────────────────────

function extractSection(content, headingRe) {
  const lines = String(content ?? '').split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headingRe.test(lines[i])) { start = i + 1; break; }
  }
  if (start < 0) return null;
  const out = [];
  for (let i = start; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join('\n');
}

const SUBSTRATE_FILE_RE = /`((?:src|scripts|skills|dashboard|packages|tests)\/[A-Za-z0-9_./-]{2,200}\.(?:ts|tsx|js|mjs|cjs|json))`/g;
// Census/decision-point ids are COMPOUND (kebab/snake: `messaging-tone-gate`,
// `DP_EXTERNAL_HOG_KILL_LEAVE`) — requiring at least one separator kills the
// generic backticked prose words (`invariant`, `verify`) that would otherwise
// become false STRONG targets (precision over recall — §3.3: the author must
// never be trained to skim).
const CENSUS_ID_RE = /`([a-z0-9]+(?:[-_][a-z0-9]+){1,10}|DP_[A-Z0-9_]{2,64})`/g;
const SYMBOL_RE = /`([A-Z][A-Za-z0-9]{5,64})`/g;
// Generic platform nouns that appear in nearly every instar spec — never a
// duplicate signal, so never a target (as substring-matched STRONG targets
// they would drag unrelated commits/PR diffs into false likely-duplicates).
const SYMBOL_DENYLIST = new Set([
  'PreToolUse', 'PostToolUse', 'SessionStart', 'SessionEnd', 'UserPromptSubmit',
  'SubagentStart', 'SubagentStop', 'PreCompact', 'MultiEdit', 'NotebookEdit',
  'WorktreeCreate', 'WorktreeRemove', 'TaskCompleted', 'PermissionRequest',
  'AskUserQuestion', 'GitHub', 'JavaScript', 'TypeScript', 'MERGE_HEAD',
]);

/**
 * Derive the TARGET SET (§3.1) from a spec's content:
 *  - census/decision-point ids (STRONG-exact) — backticked kebab/snake ids (or
 *    `DP_*` constants) inside the `## Decision points touched` section;
 *  - substrate files (STRONG-exact) — backticked repo-relative code paths;
 *  - exported symbols (STRONG-exact) — backticked PascalCase identifiers;
 *  - a feature-description FINGERPRINT (FUZZY floor) from title + problem
 *    statement + scope sections, byte-capped BEFORE tokenization — survives a
 *    missing `## Decision points touched` section entirely.
 * Values failing their §3.2a type validation are DROPPED (never shelled) and
 * counted in `dropped`.
 */
export function extractTargets(specContent) {
  const content = String(specContent ?? '');
  const targets = [];
  const seen = new Set();
  let dropped = 0;
  const push = (kind, value, valid) => {
    if (!valid) { dropped++; return; }
    const key = `${kind}:${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    targets.push({ kind, value });
  };

  const dpSection = extractSection(content, /^##\s+Decision points touched\s*$/im);
  if (dpSection) {
    for (const m of dpSection.matchAll(CENSUS_ID_RE)) {
      push('census-id', m[1], isValidToken(m[1]));
    }
  }
  for (const m of content.matchAll(SUBSTRATE_FILE_RE)) {
    push('file', m[1], isValidRepoRelPath(m[1]));
  }
  for (const m of content.matchAll(SYMBOL_RE)) {
    if (SYMBOL_DENYLIST.has(m[1])) continue; // generic platform noun — not a drop, just not a target
    push('symbol', m[1], isValidToken(m[1]));
  }

  // Priority order (census-id, file, symbol) then cap at MAX_TARGETS.
  const order = { 'census-id': 0, file: 1, symbol: 2 };
  targets.sort((a, b) => order[a.kind] - order[b.kind]);
  const capped = targets.slice(0, MAX_TARGETS);

  const titleMatch = content.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1] : '';
  const problem =
    extractSection(content, /^##\s+(?:\d+\.\s*)?Problem statement\b/im) ??
    extractSection(content, /^##\s+(?:\d+\.\s*)?Problem\b/im) ?? '';
  const scope = extractSection(content, /^##\s+(?:\d+\.\s*)?Scope\b/im) ?? '';
  // §3.1/FD6: byte caps enforced BEFORE similarity math.
  const fpText = [
    capBytes(title, SPEC_SECTION_CAP_BYTES),
    capBytes(problem, SPEC_SECTION_CAP_BYTES),
    capBytes(scope, SPEC_SECTION_CAP_BYTES),
  ].join(' ');

  return {
    targets: capped,
    dropped,
    fingerprint: normalizeTokens(fpText),
    titleTokens: normalizeTokens(capBytes(title, SPEC_SECTION_CAP_BYTES)),
    specTitle: clampUntrusted(title, 200),
    // §3.3: "substrate-introducing" — the spec names concrete new substrate
    // (files / census ids / symbols). Degradation on such a spec → `verify`.
    substrateIntroducing: capped.length > 0,
  };
}

export function specSlugFromPath(specPath) {
  const base = path.basename(String(specPath ?? ''), '.md');
  const slug = base.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'unknown-spec';
}

// ── Safe subprocess wrappers (§3.2a) ─────────────────────────────────────────

function remainingMs(deadline, cap) {
  const rem = deadline - Date.now();
  return Math.max(1, Math.min(cap, rem));
}

/** READ-ONLY git via argv array. Throws on failure (callers degrade loudly). */
function gitRead(args, { cwd, deadline }) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: remainingMs(deadline, GIT_TIMEOUT_MS),
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function tryGitRead(args, opts) {
  try { return gitRead(args, opts); } catch { return null; }
}

function ghEnv(env) {
  return {
    ...env,
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    GH_PAGER: 'cat',
    NO_COLOR: '1',
    CLICOLOR: '0',
  };
}

// ── §3.2(1) the local sibling in-flight ledger ───────────────────────────────

export function ledgerPathFor(agentHome) {
  // §3.2a path-jail: realpath-resolve the agent home (a symlinked home cannot
  // redirect the ledger outside its trust domain); fall back to the literal
  // path when the home doesn't exist yet (first write creates it).
  let home = agentHome;
  try {
    home = fs.realpathSync(agentHome);
  } catch { /* not yet created — literal path is fine */ }
  return path.join(home, LEDGER_REL_PATH);
}

/**
 * Resolve the agent home from the worktree convention
 * (`<home>/.instar/agents/<agent>/.worktrees/<slug>` — the sandbox-safe root
 * worktrees are already jailed to) or INSTAR_AGENT_HOME. null → ledger source
 * degrades loudly.
 */
export function resolveAgentHome(worktreeRoot, env = process.env) {
  if (env.INSTAR_AGENT_HOME && typeof env.INSTAR_AGENT_HOME === 'string') {
    try {
      if (fs.existsSync(env.INSTAR_AGENT_HOME)) return path.resolve(env.INSTAR_AGENT_HOME);
    } catch { /* fall through */ }
  }
  const m = String(worktreeRoot ?? '').match(/^(.*\/\.instar\/agents\/[^/]+)\/\.worktrees(\/|$)/);
  if (m) return m[1];
  return null;
}

/** Allowed roots a sibling `worktreePath` must realpath-resolve under (§3.2a). */
export function allowedWorktreeRoots(agentHome, root = DEFAULT_ROOT) {
  const roots = [];
  if (agentHome) roots.push(path.join(agentHome, '.worktrees'));
  try {
    const cfgPath = path.join(root, '.instar', 'config.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      const extra = cfg && cfg.worktree && cfg.worktree.allowedRoots;
      if (Array.isArray(extra)) {
        for (const r of extra) if (typeof r === 'string' && path.isAbsolute(r)) roots.push(r);
      }
    }
  } catch { /* config unreadable → default roots only */ }
  return roots;
}

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

/** Process start-time stamp — the pid-reuse defense half of the liveness conjunction. */
export function getProcStartToken(pid) {
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const tok = out.trim();
    return tok || null;
  } catch {
    return null;
  }
}

/**
 * §3.2(1) liveness is a CONJUNCTION: pid alive ∧ procStartToken matches ∧
 * worktreePath still exists (and realpath-resolves under an allowed root, no
 * symlink — the planted-marker defense). Only a PROVABLY dead marker is
 * ignored; age alone never marks live work stale.
 */
export function isEntryLive(entry, { allowedRoots = [], livenessProbe = null } = {}) {
  if (livenessProbe) return !!livenessProbe(entry);
  if (!entry || !Number.isInteger(entry.pid) || entry.pid <= 0) return false;
  if (typeof entry.worktreePath !== 'string' || !path.isAbsolute(entry.worktreePath)) return false;
  if (!pidAlive(entry.pid)) return false;
  const tok = getProcStartToken(entry.pid);
  if (!tok || typeof entry.procStartToken !== 'string' || tok !== entry.procStartToken) return false;
  let lst;
  try {
    lst = fs.lstatSync(entry.worktreePath);
  } catch {
    return false; // ENOENT mid-scan → skipped, not fatal (§3.2)
  }
  if (lst.isSymbolicLink()) return false;
  let real;
  try {
    real = fs.realpathSync(entry.worktreePath);
  } catch {
    return false;
  }
  const jailed = allowedRoots.some((r) => {
    try {
      const rr = fs.realpathSync(r);
      return real === rr || real.startsWith(rr + path.sep);
    } catch {
      return false;
    }
  });
  return jailed;
}

/**
 * Line-by-line, torn-line-tolerant ledger parse (§3.2 concurrent-read
 * integrity): an unparseable line is SKIPPED (never fails the scan to
 * `clear`); a torn LAST line is reported so a substrate-introducing spec can
 * raise `verify`.
 */
export function parseLedgerLines(raw) {
  const entries = [];
  let skipped = 0;
  let tornLast = false;
  const lines = String(raw ?? '').split('\n');
  let lastNonEmpty = -1;
  for (let i = 0; i < lines.length; i++) if (lines[i].trim() !== '') lastNonEmpty = i;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) entries.push(obj);
      else skipped++;
    } catch {
      skipped++;
      if (i === lastNonEmpty) tornLast = true;
    }
  }
  return { entries, skipped, tornLast };
}

/** Write-FIRST-then-scan (§3.2 TOCTOU fix): append my marker before reading. */
export function appendLedgerMarker(agentHome, entry) {
  const lp = ledgerPathFor(agentHome);
  fs.mkdirSync(path.dirname(lp), { recursive: true });
  const line = JSON.stringify(entry) + '\n';
  fs.appendFileSync(lp, line, { mode: 0o600 });
  return entry.id;
}

/** Terminal lifecycle (§3.2): remove the marker at commit-success / abandon. */
export function removeLedgerMarker(agentHome, markerId) {
  const lp = ledgerPathFor(agentHome);
  let raw;
  try {
    raw = fs.readFileSync(lp, 'utf8');
  } catch {
    return false;
  }
  const lines = String(raw).split('\n');
  const kept = [];
  let removed = false;
  for (const line of lines) {
    if (line.trim() === '') continue;
    try {
      const obj = JSON.parse(line);
      if (obj && obj.id === markerId) { removed = true; continue; }
    } catch { /* torn/foreign line — preserved verbatim */ }
    kept.push(line);
  }
  fs.writeFileSync(lp, kept.length ? kept.join('\n') + '\n' : '', { mode: 0o600 });
  return removed;
}

/**
 * Read-time / boot compaction (§3.2 unbounded-growth fix): rewrite keeping
 * only live entries. A torn (unparseable) LAST line is preserved verbatim —
 * it may be a sibling's mid-flight append.
 */
export function compactLedger(agentHome, opts = {}) {
  const lp = ledgerPathFor(agentHome);
  let raw;
  try {
    raw = fs.readFileSync(lp, 'utf8');
  } catch {
    return { compacted: false };
  }
  const lines = String(raw).split('\n').filter((l) => l.trim() !== '');
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    let obj = null;
    try { obj = JSON.parse(lines[i]); } catch { obj = null; }
    if (obj === null) {
      if (i === lines.length - 1) kept.push(lines[i]); // torn last line preserved
      continue;
    }
    if (isEntryLive(obj, opts)) kept.push(lines[i]);
  }
  fs.writeFileSync(lp, kept.length ? kept.join('\n') + '\n' : '', { mode: 0o600 });
  return { compacted: true, kept: kept.length, before: lines.length };
}

function targetValues(targets) {
  return new Set((targets || []).map((t) => (typeof t === 'string' ? t : t && t.value)).filter(Boolean));
}

/**
 * Scan the ledger for OTHER live overlapping entries (the caller has already
 * appended `self` — write-first-then-scan). Race semantics (§3.2): an
 * earlier-startedAt live overlap means I LOSE; equal startedAt ties break
 * lexicographically by (pid, branch) so exactly one of two simultaneous
 * builders yields.
 */
export function scanLedgerForOverlap(agentHome, self, opts = {}) {
  const lp = ledgerPathFor(agentHome);
  let raw = '';
  try {
    raw = fs.readFileSync(lp, 'utf8');
  } catch {
    return { scanned: true, losses: [], liveOverlaps: [], tornLast: false, skipped: 0 };
  }
  if (Buffer.byteLength(raw, 'utf8') > (opts.compactBytes ?? LEDGER_COMPACT_BYTES)) {
    try {
      compactLedger(agentHome, opts);
      raw = fs.readFileSync(lp, 'utf8');
    } catch { /* compaction is best-effort */ }
  }
  const { entries, skipped, tornLast } = parseLedgerLines(raw);
  const myTargets = targetValues(self.targets);
  const liveOverlaps = [];
  const losses = [];
  for (const other of entries) {
    if (!other || other.id === self.id) continue;
    // Entries from THIS worktree are this build's own markers (an earlier
    // hook/CLI run of the same build) — never a sibling.
    if (typeof other.worktreePath === 'string' && other.worktreePath === self.worktreePath) continue;
    const otherTargets = targetValues(other.targets);
    const shared = [...myTargets].filter((v) => otherTargets.has(v));
    const sameSlug = typeof other.specSlug === 'string' && other.specSlug === self.specSlug;
    if (shared.length === 0 && !sameSlug) continue;
    if (!isEntryLive(other, opts)) continue;
    const overlap = { entry: other, shared, sameSlug };
    liveOverlaps.push(overlap);
    const otherStart = String(other.startedAt ?? '');
    const myStart = String(self.startedAt ?? '');
    if (otherStart < myStart) {
      losses.push(overlap);
    } else if (otherStart === myStart) {
      const otherKey = `${String(other.pid).padStart(12, '0')}|${String(other.branch ?? '')}`;
      const myKey = `${String(self.pid).padStart(12, '0')}|${String(self.branch ?? '')}`;
      if (otherKey < myKey) losses.push(overlap); // lexicographic tiebreak — exactly one yields
    }
  }
  return { scanned: true, losses, liveOverlaps, tornLast, skipped };
}

// ── §3.2(2) open-PR source (bounded, non-interactive, timed, two-stage) ──────

/**
 * ONE `gh pr list` call. Returns sanitized PRs (every field clamped/validated —
 * gh output is untrusted §3.2a) or {ok:false} with a GENERIC note (stderr is
 * never echoed).
 */
export function fetchOpenPrs({ cwd, env, deadline }) {
  const res = spawnSync(
    'gh',
    ['pr', 'list', '--state', 'open', '--limit', String(OPEN_PR_LIMIT), '--json', 'number,title,headRefName,files,body'],
    {
      cwd,
      encoding: 'utf8',
      timeout: remainingMs(deadline, GH_TIMEOUT_MS),
      env: ghEnv(env),
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (res.error || res.status !== 0 || typeof res.stdout !== 'string') return { ok: false };
  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    return { ok: false };
  }
  if (!Array.isArray(parsed)) return { ok: false };
  const prs = [];
  for (const raw of parsed.slice(0, OPEN_PR_LIMIT)) {
    if (!raw || !isValidPrNumber(raw.number)) continue; // fails its type check → dropped, never shelled
    const files = [];
    if (Array.isArray(raw.files)) {
      for (const f of raw.files.slice(0, 400)) {
        const p = f && typeof f.path === 'string' ? f.path : null;
        if (p && isValidRepoRelPath(p)) files.push(p);
      }
    }
    prs.push({
      number: raw.number,
      title: clampUntrusted(raw.title, 300),
      headRefName: isValidRef(String(raw.headRefName ?? '')) ? String(raw.headRefName) : null,
      // §3.1/FD6: body byte-capped BEFORE similarity; control chars stripped.
      body: capBytes(clampUntrusted(raw.body, PR_BODY_CAP_BYTES), PR_BODY_CAP_BYTES),
      files,
    });
  }
  return { ok: true, prs, rawHash: crypto.createHash('sha256').update(res.stdout).digest('hex') };
}

/** Stage 2: `gh pr diff <n>` — added lines only, size-capped. */
export function fetchPrDiff({ number, cwd, env, deadline }) {
  if (!isValidPrNumber(number)) return { ok: false };
  const res = spawnSync('gh', ['pr', 'diff', String(number), '--patch'], {
    cwd,
    encoding: 'utf8',
    timeout: remainingMs(deadline, GH_TIMEOUT_MS),
    env: ghEnv(env),
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: PR_DIFF_CAP_BYTES, // cap-exceed → res.error → degrade for THIS PR
  });
  if (res.error || res.status !== 0 || typeof res.stdout !== 'string') return { ok: false };
  const added = res.stdout
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1))
    .join('\n');
  return { ok: true, addedText: capBytes(added, PR_DIFF_CAP_BYTES) };
}

// ── §3.2(3) merged-commit lookback + main-state corroborator ─────────────────

export function resolveMainRef(cwd, deadline, preferred = null) {
  const candidates = preferred
    ? [preferred]
    : ['JKHeadley/main', 'origin/main', 'upstream/main', 'main'];
  for (const ref of candidates) {
    if (!isValidRef(ref)) continue;
    const out = tryGitRead(['rev-parse', '--verify', '--quiet', ref], { cwd, deadline });
    if (out && out.trim()) return { ref, sha: out.trim() };
  }
  return null;
}

/**
 * ONE bounded `git log <mainRef> --since=… -n 500 --name-only` call; strong
 * targets are matched against the merged commits' changed FILE PATHS and
 * SUBJECTS (deterministic, argv-safe, single call — the incident signal is a
 * merged PR ADDING the substrate file).
 */
export function scanMergedLookback({ cwd, mainRef, sinceIso, targets, titleTokens, deadline }) {
  let out;
  try {
    out = gitRead(
      ['log', mainRef, `--since=${sinceIso}`, '-n', String(MERGE_LOOKBACK_MAX_COMMITS), '--name-only', '--format=%x1e%H%x1f%s'],
      { cwd, deadline },
    );
  } catch {
    return { ok: false };
  }
  const strong = [];
  const fuzzy = [];
  const fileTargets = new Set(targets.filter((t) => t.kind === 'file').map((t) => t.value));
  const idTargets = targets.filter((t) => t.kind !== 'file').map((t) => t.value);
  for (const record of out.split('\u001e')) {
    if (!record.trim()) continue;
    const [head, ...rest] = record.split('\n');
    const [sha, subjectRaw] = head.split('\u001f');
    const subject = clampUntrusted(subjectRaw, LINE_CLAMP_CHARS);
    const files = rest.map((l) => l.trim()).filter(Boolean);
    const hitFiles = files.filter((f) => fileTargets.has(f));
    const hitIds = idTargets.filter((t) => subject.toLowerCase().includes(t.toLowerCase()));
    if (hitFiles.length || hitIds.length) {
      strong.push({ sha: String(sha ?? '').slice(0, 12), subject, hitFiles: hitFiles.slice(0, 5), hitIds: hitIds.slice(0, 5) });
      if (strong.length >= 10) break;
    } else if (titleTokens && titleTokens.size > 0) {
      const j = tokenSetJaccard(titleTokens, normalizeTokens(subject));
      if (j >= JACCARD_THRESHOLD) {
        fuzzy.push({ sha: String(sha ?? '').slice(0, 12), subject, jaccard: Number(j.toFixed(3)) });
        if (fuzzy.length >= 10) break;
      }
    }
  }
  return { ok: true, strong, fuzzy };
}

/**
 * The WEAK `main`-state corroborator (§3.2 tail): a single combined
 * `git grep --fixed-strings -e … -e …` over ≤MAX_TARGETS capped targets,
 * pathspec-scoped to the census file + src/** with a match cap and per-match
 * line clamp. NEVER a block source — a hit yields cause `main-only` (verify).
 */
export function scanMainState({ cwd, mainRef, targets, deadline }) {
  const grepTargets = targets
    .filter((t) => t.kind !== 'file')
    .map((t) => t.value)
    .filter(isValidToken)
    .slice(0, MAX_TARGETS);
  const fileTargets = targets
    .filter((t) => t.kind === 'file')
    .map((t) => t.value)
    .filter(isValidRepoRelPath)
    .slice(0, MAX_TARGETS);
  const matches = [];
  if (grepTargets.length > 0) {
    const args = ['grep', '-I', '-n', '--fixed-strings'];
    for (const t of grepTargets) args.push('-e', t);
    args.push(mainRef, '--', CENSUS_FILE, 'src/');
    let out = null;
    try {
      out = gitRead(args, { cwd, deadline });
    } catch (err) {
      // git grep exits 1 on "no match" — that's a clean scan, not a failure.
      const status = err && typeof err.status === 'number' ? err.status : null;
      if (status !== 1) return { ok: false };
      out = '';
    }
    for (const line of String(out).split('\n')) {
      if (!line.trim()) continue;
      // format: <ref>:<path>:<lineno>:<content>
      const parts = line.split(':');
      if (parts.length < 4) continue;
      const p = parts[1];
      if (!isValidRepoRelPath(p)) continue;
      matches.push({ path: p, line: clampUntrusted(parts.slice(3).join(':'), LINE_CLAMP_CHARS) });
      if (matches.length >= GREP_MAX_MATCHES) break;
    }
  }
  if (fileTargets.length > 0 && matches.length < GREP_MAX_MATCHES) {
    const args = ['ls-tree', '--name-only', '-r', mainRef, '--', ...fileTargets];
    const out = tryGitRead(args, { cwd, deadline });
    if (out === null) return { ok: false, matches };
    for (const line of out.split('\n')) {
      const p = line.trim();
      if (p && fileTargets.includes(p)) matches.push({ path: p, line: '(file exists on main)' });
    }
  }
  return { ok: true, matches };
}

// ── Cache (§3.3) ─────────────────────────────────────────────────────────────

export function computeCacheKey({ specSlug, mainSha, prListHash }) {
  return `${specSlug}:${mainSha || 'no-main'}:${prListHash || 'no-pr-list'}`;
}

function loadCache(root) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(root, CACHE_REL_PATH), 'utf8'));
    return c && typeof c === 'object' ? c : null;
  } catch {
    return null;
  }
}

function storeCache(root, key, record) {
  try {
    fs.mkdirSync(path.join(root, '.instar'), { recursive: true });
    fs.writeFileSync(path.join(root, CACHE_REL_PATH), JSON.stringify({ key, record, at: new Date().toISOString() }, null, 2) + '\n');
  } catch { /* cache is best-effort */ }
}

// ── Audit trail (§3.5 — metadata only, never untrusted PR body text) ────────

export function appendAudit(root, record) {
  try {
    const p = path.join(root, AUDIT_REL_PATH);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const entry = {
      ts: new Date().toISOString(),
      phase: record.phase ?? null,
      specSlug: record.specSlug ?? null,
      verdict: record.verdict,
      cause: record.cause ?? null,
      causes: record.causes ?? [],
      degraded: !!record.degraded,
      degradedSources: record.degradedSources ?? [],
      cached: !!record.cached,
      durationMs: record.durationMs ?? null,
      evidence: (record.evidence ?? []).map((e) => ({
        id: e.id,
        source: e.source,
        strength: e.strength,
        ...(e.prNumber != null ? { prNumber: e.prNumber } : {}),
        ...(e.path ? { path: e.path } : {}),
        ...(e.sha ? { sha: e.sha } : {}),
      })),
      ...(record.disposition ? { disposition: {
        decision: record.disposition.decision ?? null,
        reason: clampUntrusted(record.disposition.reason, LINE_CLAMP_CHARS),
        acknowledgedEvidenceIds: Array.isArray(record.disposition.acknowledgedEvidenceIds)
          ? record.disposition.acknowledgedEvidenceIds.slice(0, 20)
          : [],
      } } : {}),
    };
    fs.appendFileSync(p, JSON.stringify(entry) + '\n');
  } catch { /* audit is best-effort — never fails the check */ }
}

// ── Verdict stub (the build-start record the gate + write-trace consume) ─────

export function stubPathFor(root) {
  return path.join(root, STUB_REL_PATH);
}

export function readStub(root) {
  try {
    const s = JSON.parse(fs.readFileSync(stubPathFor(root), 'utf8'));
    return s && typeof s === 'object' ? s : null;
  } catch {
    return null;
  }
}

export function writeStub(root, stub) {
  fs.mkdirSync(path.join(root, '.instar'), { recursive: true });
  fs.writeFileSync(stubPathFor(root), JSON.stringify(stub, null, 2) + '\n');
}

/** The §3.4 fail-open auto-stub — written on a hard check error, never blocks. */
export function checkErroredAutoStub(extra = {}) {
  return {
    verdict: 'check-errored',
    cause: 'check-error',
    causes: ['check-error'],
    degraded: true,
    evidence: [],
    notes: ['duplicate-build check errored (fail-open)'],
    checkedAt: new Date().toISOString(),
    disposition: {
      decision: 'proceed',
      reason: 'auto: check errored (fail-open)',
      acknowledgedEvidenceIds: [],
      recordedAt: new Date().toISOString(),
      auto: true,
    },
    ...extra,
  };
}

/**
 * Record the author's disposition into the stub (§3.4 schema):
 * { decision: "proceed"|"abandon", reason, acknowledgedEvidenceIds[] }.
 * A `likely-duplicate` proceed REQUIRES a non-empty reason AND ≥1
 * acknowledgedEvidenceId naming a real evidence entry.
 */
export function recordDisposition(root, { decision, reason, acknowledgedEvidenceIds = [] }) {
  const stub = readStub(root);
  if (!stub) return { ok: false, error: 'no check stub found — run the check first' };
  if (decision !== 'proceed' && decision !== 'abandon') {
    return { ok: false, error: 'decision must be "proceed" or "abandon"' };
  }
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    return { ok: false, error: 'a non-empty reason is required' };
  }
  const acks = (Array.isArray(acknowledgedEvidenceIds) ? acknowledgedEvidenceIds : [])
    .map((s) => String(s).trim())
    .filter(Boolean);
  if (stub.verdict === 'likely-duplicate' && decision === 'proceed') {
    const evidenceIds = new Set((stub.evidence ?? []).map((e) => e.id));
    const named = acks.filter((a) => evidenceIds.size === 0 || evidenceIds.has(a));
    if (named.length < 1) {
      return {
        ok: false,
        error: 'a likely-duplicate proceed requires at least one acknowledgedEvidenceId naming a concrete evidence entry (e.g. EV-1)',
      };
    }
  }
  stub.disposition = {
    decision,
    reason: clampUntrusted(reason, 1000),
    acknowledgedEvidenceIds: acks.slice(0, 20),
    recordedAt: new Date().toISOString(),
  };
  writeStub(root, stub);
  appendAudit(root, { ...stub, phase: 'disposition' });
  // §3.2 terminal lifecycle: abandon IS a terminal transition — remove the
  // in-flight ledger marker so the abandoned build stops reading as live.
  // Fail-open: cleanup failure never fails the disposition.
  if (decision === 'abandon' && stub.agentHome && stub.ledgerMarkerId) {
    try { removeLedgerMarker(stub.agentHome, stub.ledgerMarkerId); } catch { /* fail-open */ }
  }
  return { ok: true, stub };
}

// ── The check itself ─────────────────────────────────────────────────────────

/**
 * §3.3 fail-open TOTALITY: this wrapper guarantees a non-throwing, non-blocking
 * result for EVERY input. Any internal error → `check-errored` (generic note —
 * no stderr / stack echoed into evidence).
 */
export function runDuplicateBuildCheck(opts = {}) {
  try {
    return runInner(opts);
  } catch {
    return {
      verdict: 'check-errored',
      cause: 'check-error',
      causes: ['check-error'],
      degraded: true,
      degradedSources: ['internal-error'],
      evidence: [],
      notes: ['duplicate-build check errored (fail-open); details withheld (generic-error policy §3.2a)'],
      specSlug: opts && opts.specPath ? specSlugFromPath(opts.specPath) : 'unknown-spec',
      checkedAt: new Date().toISOString(),
    };
  }
}

function runInner(opts) {
  const env = opts.env || process.env;
  const root = path.resolve(opts.root || DEFAULT_ROOT);
  const phase = opts.phase || 'build-start';
  const startedMs = Date.now();
  const deadline = startedMs + (opts.totalBudgetMs ?? TOTAL_BUDGET_MS);

  if (isGuardOff(env, root)) {
    return {
      verdict: 'skipped', cause: 'disabled', causes: ['disabled'], degraded: false,
      degradedSources: [], evidence: [], notes: ['INSTAR_DUP_BUILD_CHECK=off / config-disabled — guard no-op'],
      specSlug: opts.specPath ? specSlugFromPath(opts.specPath) : 'unknown-spec',
      checkedAt: new Date().toISOString(),
    };
  }

  // ── Read + parse the spec (a bad spec is a HARD error → check-errored) ──
  const specPath = opts.specPath;
  const specContent = fs.readFileSync(specPath, 'utf8'); // throws → fail-open wrapper
  if (!specContent || specContent.trim().length === 0) throw new Error('empty spec');
  const specSlug = specSlugFromPath(specPath);
  const extraction = extractTargets(specContent);
  const { targets, fingerprint, titleTokens, substrateIntroducing } = extraction;
  const strongValues = targets.map((t) => t.value);

  const notes = [];
  const evidence = [];
  const degradedSources = [];
  let evSeq = 0;
  const addEvidence = (e) => {
    evSeq += 1;
    const id = `EV-${evSeq}`;
    evidence.push({ id, ...e });
    return id;
  };
  if (extraction.dropped > 0) {
    notes.push(`${extraction.dropped} extracted value(s) failed type validation and were dropped from the scan (§3.2a)`);
  }

  // ── main ref (+ pre-push re-fetch so the lookback actually runs at push) ──
  if (phase === 'pre-push' && !opts.skipFetch) {
    const probe = resolveMainRef(root, deadline, opts.mainRef ?? null);
    if (probe && probe.ref.includes('/')) {
      const [remote] = probe.ref.split('/');
      if (isValidRef(remote)) {
        try {
          gitRead(['fetch', '--quiet', remote, 'main'], { cwd: root, deadline });
        } catch {
          notes.push('origin/main re-fetch failed — lookback runs against the last-known main (degraded freshness)');
        }
      }
    }
  }
  const main = resolveMainRef(root, deadline, opts.mainRef ?? null);
  const mainSha = main ? main.sha : null;

  // ── 1. Local sibling in-flight ledger (write-FIRST-then-scan) ──────────────
  const agentHome = opts.agentHome !== undefined ? opts.agentHome : resolveAgentHome(root, env);
  const allowedRoots = opts.allowedRoots ?? allowedWorktreeRoots(agentHome ?? '', root);
  const ledgerOpts = { allowedRoots, livenessProbe: opts.livenessProbe ?? null };
  let ledgerResult = null;
  let markerId = null;
  if (agentHome) {
    try {
      const buildPid = Number.isInteger(opts.pid) ? opts.pid
        : (env.INSTAR_BUILD_PID && Number.isInteger(parseInt(env.INSTAR_BUILD_PID, 10)))
          ? parseInt(env.INSTAR_BUILD_PID, 10)
          : (process.ppid || process.pid);
      const self = {
        id: opts.markerId ?? crypto.randomBytes(6).toString('hex'),
        agent: path.basename(agentHome),
        host: os.hostname(),
        branch: clampUntrusted(tryGitRead(['branch', '--show-current'], { cwd: root, deadline }) ?? '', 100).trim(),
        specSlug,
        targets: strongValues.slice(0, MAX_TARGETS),
        startedAt: opts.startedAt ?? new Date().toISOString(),
        pid: buildPid,
        procStartToken: opts.procStartToken ?? getProcStartToken(buildPid),
        worktreePath: root,
      };
      if (phase !== 'pre-push') {
        // Build-start: write FIRST, then scan (TOCTOU fix). Pre-push scans only
        // (this build's marker was written at build-start; a second marker from
        // an ephemeral push process would just be swept as dead).
        markerId = appendLedgerMarker(agentHome, self);
      }
      ledgerResult = scanLedgerForOverlap(agentHome, self, ledgerOpts);
      if (ledgerResult.tornLast) {
        degradedSources.push('ledger-torn-line');
        notes.push('ledger has a torn/mid-write last line — a sibling may be appending right now');
      }
      for (const loss of ledgerResult.losses) {
        const e = loss.entry;
        addEvidence({
          source: 'local-sibling',
          strength: 'strong',
          detail: clampUntrusted(
            `live sibling build on this machine (branch ${e.branch || '?'}, started ${e.startedAt || '?'}) ` +
            (loss.sameSlug ? `is on the SAME spec (${self.specSlug})` : `shares target(s): ${loss.shared.slice(0, 5).join(', ')}`),
          ),
        });
      }
    } catch {
      degradedSources.push('ledger');
      notes.push('sibling ledger unavailable (scan degraded)');
    }
  } else {
    degradedSources.push('ledger-unresolvable');
    notes.push('agent home not resolvable — sibling ledger not scanned');
  }

  // ── 2. Open PRs (bounded two-stage; CI-skipped by design §3.3/§5) ──────────
  let prListHash = null;
  const prStrong = [];
  const prFuzzy = [];
  const prWeak = [];
  if (env.CI) {
    degradedSources.push('open-prs-skipped-ci');
    notes.push('open-PR scan skipped under CI (by design §5)');
  } else if (Date.now() >= deadline) {
    degradedSources.push('open-prs-budget');
    notes.push('open-PR scan skipped — total budget exhausted');
  } else {
    const source = opts.openPrSource
      ? opts.openPrSource({ cwd: root, env, deadline })
      : fetchOpenPrs({ cwd: root, env, deadline });
    if (!source || !source.ok) {
      degradedSources.push('open-prs');
      notes.push('open-PR scan unavailable (gh missing/failed/timed out) — degraded to local-only');
    } else {
      prListHash = source.rawHash ?? null;
      const fileTargets = new Set(targets.filter((t) => t.kind === 'file').map((t) => t.value));
      const idTargets = targets.filter((t) => t.kind !== 'file').map((t) => t.value);
      const weakFiles = new Set(opts.weakChangedFiles ?? computeWeakChangedFiles(root, deadline, notes));
      const stage2Candidates = [];
      for (const pr of source.prs) {
        const strongFileHits = pr.files.filter((f) => fileTargets.has(f));
        if (strongFileHits.length > 0) {
          prStrong.push({ pr, hits: strongFileHits, via: 'file' });
          stage2Candidates.push(pr);
          continue;
        }
        const titleHit = idTargets.some((t) => pr.title.toLowerCase().includes(t.toLowerCase()));
        // §3.1/FD6: the body byte-cap is enforced HERE, at the similarity site
        // (defense in depth — fetchOpenPrs caps too, but an injected/fixture
        // source must be capped identically before ANY similarity math).
        const j = tokenSetJaccard(fingerprint, normalizeTokens(`${pr.title} ${capBytes(pr.body, PR_BODY_CAP_BYTES)}`));
        if (titleHit) stage2Candidates.push(pr);
        if (j >= JACCARD_THRESHOLD) {
          prFuzzy.push({ pr, jaccard: Number(j.toFixed(3)) });
          if (!titleHit) stage2Candidates.push(pr);
        }
        const weakHits = pr.files.filter((f) => weakFiles.has(f));
        if (weakHits.length > 0 && strongFileHits.length === 0) prWeak.push({ pr, hits: weakHits.slice(0, 5) });
      }
      // Stage 2: census/symbol identities a PR ADDS are only visible in its
      // diff — run `gh pr diff` on ≤5 already-matched PRs, diff-size-capped.
      const idTargetsForDiff = idTargets.filter(isValidToken);
      if (idTargetsForDiff.length > 0) {
        const seen = new Set();
        const candidates = stage2Candidates.filter((pr) => {
          if (seen.has(pr.number)) return false;
          seen.add(pr.number);
          return true;
        }).slice(0, PR_DIFF_STAGE2_MAX);
        for (const pr of candidates) {
          if (Date.now() >= deadline) {
            degradedSources.push(`pr-diff-${pr.number}-budget`);
            notes.push(`PR #${pr.number} diff skipped (budget) — matched at stage 1 only`);
            continue;
          }
          const diff = opts.prDiffSource
            ? opts.prDiffSource({ number: pr.number, cwd: root, env, deadline })
            : fetchPrDiff({ number: pr.number, cwd: root, env, deadline });
          if (!diff || !diff.ok) {
            // Cap-exceed / timeout → fall back to file-overlap-only for this PR;
            // a verify-worthy signal is never silently dropped (§3.2).
            degradedSources.push(`pr-diff-${pr.number}`);
            notes.push(`PR #${pr.number} diff unavailable/over-cap — falling back to file-overlap-only for it`);
            continue;
          }
          const addedHits = idTargetsForDiff.filter((t) => diff.addedText.includes(t));
          if (addedHits.length > 0) prStrong.push({ pr, hits: addedHits, via: 'diff' });
        }
      }
      for (const s of prStrong) {
        addEvidence({
          source: 'open-pr',
          strength: 'strong',
          prNumber: s.pr.number,
          detail: clampUntrusted(
            s.via === 'file'
              ? `open PR #${s.pr.number} touches substrate file(s) this spec introduces: ${s.hits.slice(0, 5).join(', ')}`
              : `open PR #${s.pr.number} is ADDING identity target(s) this spec names: ${s.hits.slice(0, 5).join(', ')}`,
          ),
          ...(s.via === 'file' ? { path: s.hits[0] } : {}),
        });
      }
      for (const f of prFuzzy) {
        addEvidence({
          source: 'open-pr',
          strength: 'fuzzy',
          prNumber: f.pr.number,
          detail: `open PR #${f.pr.number} title/body fingerprint similarity ${f.jaccard} ≥ ${JACCARD_THRESHOLD}`,
        });
      }
      if (prWeak.length > 0) {
        notes.push(
          `quiet note: ${prWeak.length} open PR(s) overlap only on WEAK touched files (` +
          prWeak.slice(0, 3).map((w) => `#${w.pr.number}`).join(', ') + ') — not escalated (§3.3)',
        );
      }
    }
  }

  // ── 3. Recently-merged lookback ─────────────────────────────────────────────
  let mergedStrongCount = 0;
  let mergedFuzzyCount = 0;
  if (!main) {
    degradedSources.push('merged-lookback-no-main');
    notes.push('no main ref resolvable — merged-commit lookback not scanned');
  } else if (Date.now() >= deadline) {
    degradedSources.push('merged-lookback-budget');
  } else {
    const floorMs = MERGE_LOOKBACK_FLOOR_DAYS * 24 * 60 * 60 * 1000;
    const buildStartMs = opts.buildStartedAt ? Date.parse(opts.buildStartedAt) : NaN;
    const sinceMs = Math.min(
      Number.isFinite(buildStartMs) ? buildStartMs : Date.now(),
      Date.now() - floorMs,
    );
    const sinceIso = new Date(sinceMs).toISOString();
    const merged = scanMergedLookback({ cwd: root, mainRef: main.ref, sinceIso, targets, titleTokens, deadline });
    if (!merged.ok) {
      degradedSources.push('merged-lookback');
      notes.push('merged-commit lookback failed (git error/timeout) — degraded');
    } else {
      mergedStrongCount = merged.strong.length;
      mergedFuzzyCount = merged.fuzzy.length;
      for (const s of merged.strong) {
        addEvidence({
          source: 'merged-commit',
          strength: 'strong',
          sha: s.sha,
          detail: clampUntrusted(
            `merged commit ${s.sha} (“${s.subject}”) ` +
            (s.hitFiles.length ? `touches target file(s): ${s.hitFiles.join(', ')}` : `names target id(s): ${s.hitIds.join(', ')}`),
          ),
          ...(s.hitFiles.length ? { path: s.hitFiles[0] } : {}),
        });
      }
      for (const f of merged.fuzzy) {
        addEvidence({
          source: 'merged-commit',
          strength: 'fuzzy',
          sha: f.sha,
          detail: `merged commit ${f.sha} subject similarity ${f.jaccard} ≥ ${JACCARD_THRESHOLD}`,
        });
      }
    }
  }

  // ── Cache (after the pr-list fetch so the key includes its hash) ───────────
  const cacheKey = computeCacheKey({ specSlug, mainSha, prListHash });
  if (!opts.noCache) {
    const cached = loadCache(root);
    if (cached && cached.key === cacheKey && cached.record && cached.record.verdict) {
      // Identical inputs → the previous computation stands (build-start +
      // pre-push share ONE computation; a HEAD move / new PR re-keys).
      const rec = { ...cached.record, cached: true, phase };
      appendAudit(root, rec);
      return rec;
    }
  }

  // ── 4. main-state WEAK corroborator (never a block source) ─────────────────
  let mainOnlyMatches = [];
  if (main && Date.now() < deadline && targets.length > 0) {
    const ms = scanMainState({ cwd: root, mainRef: main.ref, targets, deadline });
    if (!ms.ok) {
      notes.push('main-state corroborator unavailable (weak signal only — not counted as degradation)');
    }
    mainOnlyMatches = ms.matches ?? [];
    for (const m of mainOnlyMatches.slice(0, 5)) {
      addEvidence({
        source: 'main-state',
        strength: 'weak',
        path: m.path,
        detail: clampUntrusted(`target already present on ${main.ref}: ${m.path} — ${m.line}`),
      });
    }
  }

  // ── §3.3 TOTAL verdict ladder (FD4) ─────────────────────────────────────────
  const strongConcurrency = evidence.filter((e) => e.strength === 'strong' &&
    (e.source === 'local-sibling' || e.source === 'open-pr' || e.source === 'merged-commit'));
  const fuzzyHits = evidence.filter((e) => e.strength === 'fuzzy');
  const degraded = degradedSources.length > 0;

  let verdict;
  const causes = [];
  if (strongConcurrency.length > 0) {
    verdict = 'likely-duplicate';
    causes.push('concurrency');
    if (fuzzyHits.length > 0) causes.push('fuzzy');
    if (degraded) causes.push('degraded');
  } else {
    if (fuzzyHits.length > 0) causes.push('fuzzy');
    if (mainOnlyMatches.length > 0) causes.push('main-only');
    if (degraded && substrateIntroducing) causes.push('degraded');
    if (causes.length > 0) {
      verdict = 'verify';
    } else {
      verdict = 'clear';
      if (degraded) notes.push('degraded NON-substrate scan → clear with a degraded audit flag (§3.3)');
    }
  }
  // Real-overlap causes OUTRANK the environmental `degraded` tag (§3.3).
  const causePriority = ['concurrency', 'fuzzy', 'main-only', 'degraded'];
  const cause = causePriority.find((c) => causes.includes(c)) ?? null;

  const record = {
    verdict,
    cause,
    causes,
    degraded,
    degradedSources,
    substrateIntroducing,
    evidence,
    notes,
    specSlug,
    specPath: path.relative(root, path.resolve(specPath)) || String(specPath),
    specTitle: extraction.specTitle,
    targets: targets.slice(0, MAX_TARGETS),
    mainRef: main ? main.ref : null,
    mainSha,
    phase,
    cached: false,
    checkedAt: new Date().toISOString(),
    durationMs: Date.now() - startedMs,
    ...(markerId ? { ledgerMarkerId: markerId, agentHome } : {}),
    ...(mergedStrongCount + mergedFuzzyCount > 0 ? { mergedHits: { strong: mergedStrongCount, fuzzy: mergedFuzzyCount } } : {}),
  };

  if (!opts.noCache) storeCache(root, cacheKey, record);
  appendAudit(root, record);
  return record;
}

/** WEAK touched-file computation — REUSES pre-push-scope (§3.1), never a re-implemented diff. */
function computeWeakChangedFiles(root, deadline, notes) {
  try {
    const base = resolvePrePushBase({ cwd: root });
    return changedFilesSince(base.ref, { cwd: root });
  } catch {
    notes.push('weak changed-file computation unavailable (quiet signal only)');
    return [];
  }
}

/**
 * Resolve which spec drives an advisory/gate run when none was passed:
 * the stub's recorded specPath first, else the branch's own added/modified
 * spec under docs/specs/ (untracked or diverged from main), else null.
 */
export function resolveSpecForAdvisory(root, { deadline = Date.now() + GIT_TIMEOUT_MS } = {}) {
  try {
    const stub = readStub(root);
    if (stub && typeof stub.specPath === 'string') {
      const p = path.resolve(root, stub.specPath);
      if (fs.existsSync(p)) return p;
    }
    const main = resolveMainRef(root, deadline);
    const candidates = new Set();
    if (main) {
      const diff = tryGitRead(['diff', '--name-only', `${main.ref}...HEAD`, '--', 'docs/specs'], { cwd: root, deadline });
      if (diff) for (const l of diff.split('\n')) { const f = l.trim(); if (f) candidates.add(f); }
    }
    // --untracked-files=all: porcelain otherwise collapses a fully-untracked
    // directory to `?? docs/specs/`, hiding the spec file inside it.
    const status = tryGitRead(['status', '--porcelain', '--untracked-files=all', '--', 'docs/specs'], { cwd: root, deadline });
    if (status) {
      for (const l of status.split('\n')) {
        const f = l.slice(3).trim();
        if (f) candidates.add(f);
      }
    }
    const specs = [...candidates].filter((f) =>
      /^docs\/specs\/[^/]+\.md$/.test(f) && !f.endsWith('.eli16.md') && !f.includes('/reports/'));
    let best = null;
    let bestM = -1;
    for (const f of specs) {
      const p = path.join(root, f);
      try {
        const m = fs.statSync(p).mtimeMs;
        if (m > bestM) { bestM = m; best = p; }
      } catch { /* deleted */ }
    }
    return best;
  } catch {
    return null;
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────
// FAIL-OPEN TOTALITY: the CLI ALWAYS exits 0 (FD5) — the verdict is the
// signal; blocking authority lives with the gate + the author's disposition.

function cliMain(argv) {
  const args = argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? (args[i + 1] ?? null) : null;
  };
  const has = (name) => args.includes(name);
  const root = path.resolve(flag('--root') ?? DEFAULT_ROOT);
  const asJson = has('--json');
  const print = (obj, human) => {
    if (asJson) console.log(JSON.stringify(obj, null, 2));
    else console.log(human);
  };

  try {
    if (has('--record-disposition')) {
      const decision = flag('--decision');
      const reason = flag('--reason');
      const ack = (flag('--ack') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      const res = recordDisposition(root, { decision, reason, acknowledgedEvidenceIds: ack });
      if (!res.ok) {
        print({ ok: false, error: res.error }, `disposition NOT recorded: ${res.error}`);
      } else {
        print({ ok: true, disposition: res.stub.disposition },
          `disposition recorded: ${decision} (${res.stub.verdict}) — the build-start gate will now allow implementation writes`);
      }
      return 0;
    }
    if (has('--remove-marker')) {
      const stub = readStub(root);
      const agentHome = flag('--agent-home') ?? (stub && stub.agentHome) ?? resolveAgentHome(root, process.env);
      const id = flag('--marker-id') ?? (stub && stub.ledgerMarkerId);
      if (!agentHome || !id) {
        print({ ok: false, error: 'no marker recorded' }, 'no ledger marker to remove');
        return 0;
      }
      const removed = removeLedgerMarker(agentHome, id);
      print({ ok: true, removed }, removed ? 'ledger marker removed (terminal transition)' : 'marker already gone');
      return 0;
    }

    const specPath = args.find((a) => !a.startsWith('--') && a !== flag('--root') && a !== flag('--phase') && a !== flag('--agent-home'));
    if (!specPath) {
      print({ ok: false, error: 'usage: duplicate-build-check.mjs <specPath> [--json] [--root <p>] [--phase build-start|pre-push]' },
        'usage: node scripts/lib/duplicate-build-check.mjs <specPath> [--json]');
      return 0; // even usage errors are non-blocking (FD5)
    }
    const record = runDuplicateBuildCheck({
      specPath: path.resolve(root, specPath),
      root,
      phase: flag('--phase') ?? 'build-start',
      agentHome: flag('--agent-home') ?? undefined,
      env: process.env,
    });
    // Persist the stub (the build-start record the gate + write-trace consume).
    try {
      const existing = readStub(root);
      const stub = { ...record };
      if (existing && existing.disposition && existing.specSlug === record.specSlug) {
        stub.disposition = existing.disposition; // keep an already-recorded disposition
      } else if (record.verdict === 'clear' || record.verdict === 'skipped') {
        stub.disposition = {
          decision: 'proceed',
          reason: `auto: verdict ${record.verdict}`,
          acknowledgedEvidenceIds: [],
          recordedAt: new Date().toISOString(),
          auto: true,
        };
      } else if (record.verdict === 'check-errored') {
        stub.disposition = checkErroredAutoStub().disposition;
      }
      writeStub(root, stub);
    } catch { /* stub write is best-effort */ }
    print(record,
      `duplicate-build check: ${record.verdict}` +
      (record.cause ? ` (cause: ${record.cause})` : '') +
      (record.evidence.length ? '\n' + record.evidence.map((e) => `  ${e.id} [${e.source}] ${e.detail}`).join('\n') : '') +
      (record.notes.length ? '\n' + record.notes.map((n) => `  note: ${n}`).join('\n') : ''));
    return 0;
  } catch {
    // §3.3 fail-open totality — even a CLI-layer crash exits 0.
    try {
      print({ verdict: 'check-errored', cause: 'check-error' }, 'duplicate-build check errored (fail-open) — proceeding is allowed; the errored run is visible in the audit');
    } catch { /* ignore */ }
    return 0;
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (invokedDirectly) {
  process.exit(cliMain(process.argv));
}
