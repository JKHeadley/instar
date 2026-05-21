#!/usr/bin/env node
// safe-git-allow: pre-push critical path — must stay lightweight, no SafeGitExecutor audit-log writes from the hook.
/**
 * Pre-push guard: reject test-fixture commits before they ship.
 *
 * Git invokes pre-push hooks with GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE
 * set in the env. When the hook runs `npm run test:smoke`, the test
 * suite inherits those overrides, and any test that spawns `git init`
 * + `git commit` in a tmpdir without sanitizing env ends up committing
 * into the real repo on whichever branch is currently checked out.
 *
 * That's how PRs #130 and #277 picked up "Initial commit" / "seed" /
 * "Worktree commit N" stowaways that overwrote README.md on main.
 *
 * Layer 1 (vitest-setup.ts strip) closes the root cause. This guard is
 * the second line of defense: even if a future test reintroduces a raw
 * git call without sanitizing env, the resulting commit can never reach
 * the remote because this hook refuses to push it.
 *
 * Behavior:
 *   - Scans commits on HEAD that aren't yet on origin/main.
 *   - Fails the push if any of them match the fixture-pollution signature
 *     (author email test@instar.local / t@t.com / t@e.com, or commit
 *     messages "Initial commit" / "seed" / "Worktree commit <N>").
 *   - Prints what it found so the author can `git reset` past the bad
 *     commits and re-push.
 *
 * Escape hatch (for legitimate fixture commits in test-only branches
 * that will never merge): INSTAR_PRE_PUSH_FIXTURE_GUARD_SKIP=1
 *
 * Exit codes: 0 = clean (or skipped), 1 = pollution detected.
 */

import { execFileSync } from 'node:child_process';

const SKIP = process.env.INSTAR_PRE_PUSH_FIXTURE_GUARD_SKIP === '1';
if (SKIP) {
  console.log('⏭️  INSTAR_PRE_PUSH_FIXTURE_GUARD_SKIP=1 — fixture guard bypassed.');
  process.exit(0);
}

// Strip the same env overrides we accuse of causing the bug. Otherwise
// our own `git log` here would be subject to the same redirection.
const env = { ...process.env };
delete env.GIT_DIR;
delete env.GIT_WORK_TREE;
delete env.GIT_INDEX_FILE;
delete env.GIT_OBJECT_DIRECTORY;
delete env.GIT_COMMON_DIR;

function git(args) {
  return execFileSync('git', args, { encoding: 'utf-8', env, stdio: ['ignore', 'pipe', 'pipe'] });
}

let baseRef;
try {
  // Prefer upstream tracking branch if one is configured.
  baseRef = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']).trim();
} catch {
  // No upstream — fall back to whichever remote main we can resolve.
  for (const candidate of ['upstream/main', 'origin/main']) {
    try {
      git(['rev-parse', '--verify', '--quiet', candidate]);
      baseRef = candidate;
      break;
    } catch { /* try next */ }
  }
}

if (!baseRef) {
  // No remote main to compare against — likely a fresh repo. Skip silently.
  process.exit(0);
}

// `<base>..HEAD` lists commits on HEAD that aren't on base. NUL-separated
// records of "<sha>\t<author_email>\t<author_name>\t<subject>" — using \0
// between records lets us survive commit messages that contain newlines.
let log;
try {
  log = git([
    'log',
    `${baseRef}..HEAD`,
    '--pretty=format:%H%x09%ae%x09%an%x09%s%x00',
  ]);
} catch (err) {
  // Couldn't compute the range. Don't block the push — a real failure
  // would surface elsewhere; we'd rather miss a guard than wedge pushes
  // on every fresh repo / unborn branch.
  process.exit(0);
}

const records = log.split('\0').map((r) => r.trim()).filter(Boolean);

const BAD_EMAILS = new Set([
  'test@instar.local',
  't@t.com',
  't@e.com',
  'test@test.com',
]);

const BAD_SUBJECT_PATTERNS = [
  /^Initial commit$/,
  /^seed$/,
  /^Worktree commit \d+$/,
  /^init$/,
];

const violations = [];
for (const record of records) {
  const [sha, email, name, subject] = record.split('\t');
  const reasons = [];
  if (BAD_EMAILS.has(email)) {
    reasons.push(`fixture-identity author <${email}>`);
  }
  for (const pattern of BAD_SUBJECT_PATTERNS) {
    if (pattern.test(subject)) {
      reasons.push(`fixture commit message "${subject}"`);
      break;
    }
  }
  if (reasons.length > 0) {
    violations.push({ sha: sha.slice(0, 10), name, email, subject, reasons });
  }
}

if (violations.length === 0) {
  process.exit(0);
}

const lines = [];
lines.push('');
lines.push('🚫 pre-push-fixture-guard: refusing to push test-fixture commits.');
lines.push('');
lines.push('These commits look like test-fixture pollution (test wrote into');
lines.push('the real repo because GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE');
lines.push('leaked from this pre-push hook into a child test process):');
lines.push('');
for (const v of violations) {
  lines.push(`  ${v.sha}  ${v.name} <${v.email}>  "${v.subject}"`);
  for (const r of v.reasons) {
    lines.push(`            → ${r}`);
  }
}
lines.push('');
lines.push('How to recover:');
lines.push(`  1. Inspect the commits:  git log ${baseRef}..HEAD`);
lines.push(`  2. Drop them:            git reset --hard <last good sha>`);
lines.push('  3. Force-push the cleaned branch.');
lines.push('');
lines.push('If this is intentional (e.g. a test-only branch you do not plan');
lines.push('to merge), bypass with INSTAR_PRE_PUSH_FIXTURE_GUARD_SKIP=1.');
lines.push('');

process.stderr.write(lines.join('\n'));
process.exit(1);
