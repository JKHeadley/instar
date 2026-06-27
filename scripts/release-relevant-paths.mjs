#!/usr/bin/env node
/**
 * release-relevant-paths — the SINGLE SOURCE OF TRUTH for "does this changed
 * file ship behavior that must carry a release-note fragment?"
 *
 * ── Why this exists ───────────────────────────────────────────────────
 * The release-note fragment requirement was enforced by THREE independent
 * predicates that could drift: `pre-push-gate.js §3b` (`src/**.ts` only — too
 * narrow, missed scripts/workflows), and the publish-side skip is path-blind.
 * On 2026-06-27 PRs #1295-#1297 merged with no fragment and the publish ran
 * green and silently skipped (v1.3.685 stuck ~7h). This module is the one
 * predicate the PR-time gate (Layer 1) AND the local pre-push gate share, so
 * "is this release-relevant?" has exactly one answer everywhere.
 *
 * It answers ONE question: "needs a release note?". It is deliberately NOT
 * `instar-dev-precommit.js`'s `inScope()` — that answers a DIFFERENT question
 * ("needs instar-dev review?") and is intentionally narrower; merging them
 * would silently change which changes require review. (See the spec's D6 +
 * the side-effects artifact for the reconciliation.)
 *
 * ── The predicate (spec D6) ───────────────────────────────────────────
 *   RELEASE-RELEVANT (positive): src/, scripts/, .husky/, skills/** code +
 *     SKILL.md + templates/, package.json, package-lock.json,
 *     .github/workflows/**.
 *   EXEMPT (never release-relevant, even under a positive root):
 *     any *.test.ts, the tests/ tree, the docs/ tree, a bare *.md (notes/readme)
 *     that is NOT a SKILL.md or under a skill templates/ dir, the upgrades/ tree
 *     (the fragment dir itself), the .instar/ tree (agent-local), and repo
 *     dotfiles like .gitignore.
 *
 * Paths are canonicalized (POSIX separators, no leading ./, `..` REJECTED as
 * relevant — the safe direction) and compared case-insensitively on the
 * segment, so `Src/Foo.TS`, `src/../src/x.ts`, and `src/x.ts/` cannot evade.
 *
 * Pure + exported for unit testing; the CLI wrapper classifies a newline/comma
 * list of paths.
 */

/** Canonicalize a changed-file path to a comparable POSIX form. Returns null if it escapes the tree. */
export function canonicalizePath(raw) {
  if (typeof raw !== 'string') return null;
  let p = raw.trim();
  if (!p) return null;
  // Normalize separators + strip a leading ./, collapse duplicate slashes.
  p = p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!p) return null;
  // Reject any traversal segment — a `..` path is treated as release-relevant
  // by the caller (fail toward "in scope"), never silently exempt.
  const segments = p.split('/');
  if (segments.some((s) => s === '..')) return { escaped: true, path: p };
  return { escaped: false, path: p };
}

/** Lowercase form for case-insensitive matching (covers macOS/Windows case-fold FS). */
function lc(p) {
  return p.toLowerCase();
}

/**
 * Is this changed file release-relevant (needs a release-note fragment)?
 * @param {string} rawPath a repo-relative changed-file path
 * @returns {boolean}
 */
export function isReleaseRelevant(rawPath) {
  const c = canonicalizePath(rawPath);
  if (c === null) return false;
  // A traversal path is ambiguous → bias toward release-relevant (the safe
  // direction: a false "needs a note" is escapable with a one-line fragment; a
  // false exempt silently re-opens the 2026-06-27 silent-skip).
  if (c.escaped) return true;
  const p = lc(c.path);

  // ── EXEMPT (checked first — exemptions override positive roots) ──────
  // Test files anywhere.
  if (p.endsWith('.test.ts') || p.endsWith('.test.js') || p.endsWith('.test.mjs')) return false;
  if (p === 'tests' || p.startsWith('tests/')) return false;
  // Docs + the release-notes machinery itself.
  if (p === 'docs' || p.startsWith('docs/')) return false;
  if (p === 'upgrades' || p.startsWith('upgrades/')) return false;
  // Agent-local + repo dotfiles that ship no runtime behavior.
  if (p.startsWith('.instar/')) return false;
  if (p.startsWith('.github/') && !p.startsWith('.github/workflows/')) return false; // ISSUE_TEMPLATE etc.

  // ── POSITIVE (release-relevant) ─────────────────────────────────────
  if (p === 'package.json' || p === 'package-lock.json') return true;
  if (p.startsWith('.github/workflows/')) return true;
  if (p.startsWith('src/')) return true;
  if (p.startsWith('scripts/')) return true;
  if (p.startsWith('.husky/')) return true;
  // Built-in skills under skills/ ship behavior.
  if (p.startsWith('skills/')) return isSkillPathRelevant(p);
  // SHIPPED .claude paths (package.json `files`): .claude/hooks/** and the
  // built-in .claude/skills/<name>/ dirs are hand-maintained behavior that
  // reaches the fleet via npm — NOT exempt (the second-pass-review fix). Other
  // .claude/** is agent-local and not shipped → exempt.
  if (p.startsWith('.claude/hooks/')) return true;
  if (p.startsWith('.claude/skills/') && SHIPPED_CLAUDE_SKILLS.some((n) => p.startsWith(`.claude/skills/${n}/`))) {
    return isSkillPathRelevant(p);
  }

  // ── Everything else: a bare *.md, assets, examples, site, etc. → exempt.
  return false;
}

/** Built-in .claude/skills/<name> dirs shipped via package.json `files`. */
const SHIPPED_CLAUDE_SKILLS = ['setup-wizard', 'secret-setup', 'autonomous', 'build'];

/**
 * Within a skill dir, classify a path. FAIL TOWARD RELEVANT: a SKILL.md, a
 * templates/ file, or ANY code/data file is relevant; only a bare doc *.md that
 * is NOT a SKILL.md and NOT under templates/ is exempt. (Broadened from a fixed
 * extension allowlist so .cjs/.py/.json and future code types are not silently
 * exempted — the second-pass-review fix.)
 */
function isSkillPathRelevant(p) {
  if (p.endsWith('/skill.md')) return true;
  if (p.includes('/templates/')) return true;
  if (p.endsWith('.md')) return false; // a non-SKILL.md skill doc
  return true; // any other file under a skill ships behavior/data
}

/**
 * Classify a list of changed-file paths.
 * @param {string[]} paths
 * @returns {{ relevant: string[], exempt: string[] }}
 */
export function classifyPaths(paths) {
  const relevant = [];
  const exempt = [];
  for (const raw of paths) {
    const c = canonicalizePath(raw);
    const display = c && !c.escaped ? c.path : (typeof raw === 'string' ? raw.trim() : String(raw));
    if (isReleaseRelevant(raw)) relevant.push(display);
    else if (display) exempt.push(display);
  }
  return { relevant, exempt };
}

/**
 * The current top-level shipped/runtime roots, derived from package.json `files`.
 * Used by the anti-drift guard test: a NEW top-level root the predicate does not
 * explicitly classify must fail the test, so a future release-bearing directory
 * cannot silently fall through as a false-negative (spec D6 anti-drift rule).
 * @param {string[]} filesWhitelist package.json `files`
 * @returns {string[]} distinct top-level segments
 */
export function shippedTopLevelRoots(filesWhitelist) {
  const roots = new Set();
  for (const entry of filesWhitelist || []) {
    const c = canonicalizePath(entry);
    if (!c || c.escaped) continue;
    const top = c.path.split('/')[0];
    if (top) roots.add(top);
  }
  return [...roots].sort();
}

// ── CLI: classify a newline/comma-separated list of paths from argv/stdin ──
const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  const arg = process.argv.slice(2).join(' ').trim();
  let input = arg;
  if (!input) {
    try { input = require('node:fs').readFileSync(0, 'utf8'); } catch { input = ''; }
  }
  const paths = input.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  const { relevant, exempt } = classifyPaths(paths);
  process.stdout.write(JSON.stringify({ relevant, exempt, releaseRelevant: relevant.length > 0 }, null, 2) + '\n');
}
