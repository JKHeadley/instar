#!/usr/bin/env node
/**
 * instar-dev-precommit.js — pre-commit gate enforcing /instar-dev skill usage.
 *
 * Runs in the instar repo's .husky/pre-commit. For any commit that touches
 * behavior (src/, scripts/, .husky/, or skills/), this gate requires:
 *
 *   1. A fresh trace file exists in .instar/instar-dev-traces/ (< 60 min old).
 *   2. The trace's coveredFiles is a superset of the staged files in scope.
 *   3. The trace references an artifact file that exists.
 *   4. The artifact's content sha256 matches what the trace recorded.
 *   5. The artifact is longer than a stub (> 200 chars of real content).
 *
 * If the commit touches nothing in scope (pure docs, release notes,
 * gitignore tweaks, etc.), the gate passes through.
 *
 * Bypass is structurally discouraged. The standard `--no-verify` still
 * works (git itself owns that flag), but any such commit is visible in
 * git history and flagged by the post-push release analyzer.
 *
 * Exit codes:
 *   0 — pass
 *   1 — block
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const TRACES_DIR = path.join(ROOT, '.instar', 'instar-dev-traces');
const WINDOW_MS = 60 * 60 * 1000; // 60 minutes
const MIN_ARTIFACT_CHARS = 200;

// ─── Step 0: skip gate for merge commits ─────────────────────────────────
// Merge commits integrate already-reviewed code from another branch/machine.
// The side-effects review was done when those commits were originally authored.
if (fs.existsSync(path.join(ROOT, '.git', 'MERGE_HEAD'))) {
  process.exit(0);
}

// ─── Step 1: inspect staged files ────────────────────────────────────────

let stagedOutput;
try {
  stagedOutput = execSync('git diff --cached --name-only --diff-filter=ACMR', {
    cwd: ROOT,
    encoding: 'utf8',
  });
} catch (err) {
  // git not available or not in a git repo — can't verify; fail-open.
  console.error('[instar-dev-precommit] git not available — skipping gate');
  process.exit(0);
}

const staged = stagedOutput
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean);

if (staged.length === 0) {
  // No staged files — nothing to check.
  process.exit(0);
}

// ─── Step 2: classify staged files ───────────────────────────────────────

function inScope(file) {
  // Files that require review: anything that ships behavior.
  if (file.startsWith('src/')) return true;
  if (file.startsWith('scripts/')) return true;
  if (file.startsWith('.husky/')) return true;
  if (file.startsWith('skills/') && file.endsWith('SKILL.md')) return true;
  if (file.startsWith('skills/') && (file.endsWith('.sh') || file.endsWith('.mjs') || file.endsWith('.js'))) return true;
  return false;
}

const inScopeFiles = staged.filter(inScope);

if (inScopeFiles.length === 0) {
  // Pure docs / release notes / config — pass through.
  process.exit(0);
}

// ─── Step 3: bootstrap exception ─────────────────────────────────────────
// If this commit itself is introducing the gate (i.e., scripts/instar-dev-precommit.js
// is staged as "A"), the gate isn't "in effect" yet — its own first-ship can't
// reference itself. We detect this and pass, documenting the bypass.

let addedOutput = '';
try {
  addedOutput = execSync('git diff --cached --name-only --diff-filter=A', {
    cwd: ROOT,
    encoding: 'utf8',
  });
} catch {
  // ignore
}
const addedFiles = addedOutput.split('\n').map((s) => s.trim()).filter(Boolean);
if (addedFiles.includes('scripts/instar-dev-precommit.js')) {
  console.error(
    '[instar-dev-precommit] bootstrap commit detected (this script is itself being added) — passing. All future commits will be gated.',
  );
  process.exit(0);
}

// ─── Step 4: find a fresh trace ──────────────────────────────────────────

if (!fs.existsSync(TRACES_DIR)) {
  blockCommit(inScopeFiles, 'No trace directory found. Run the /instar-dev skill to produce a trace before committing.');
}

const traceEntries = fs
  .readdirSync(TRACES_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => ({
    file: path.join(TRACES_DIR, f),
    mtime: fs.statSync(path.join(TRACES_DIR, f)).mtimeMs,
  }))
  .filter((e) => Date.now() - e.mtime < WINDOW_MS)
  .sort((a, b) => b.mtime - a.mtime);

if (traceEntries.length === 0) {
  blockCommit(
    inScopeFiles,
    'No fresh trace found (< 60 min old) in .instar/instar-dev-traces/. Run the /instar-dev skill to produce one.',
  );
}

// ─── Step 5: validate most recent trace against staged files ─────────────

let validTrace = null;
const attempts = [];

for (const entry of traceEntries) {
  let trace;
  try {
    trace = JSON.parse(fs.readFileSync(entry.file, 'utf8'));
  } catch (err) {
    attempts.push(`${path.basename(entry.file)}: malformed JSON`);
    continue;
  }

  if (trace.phase !== 'complete') {
    attempts.push(`${path.basename(entry.file)}: trace phase is "${trace.phase}", expected "complete"`);
    continue;
  }

  const covered = new Set(trace.coveredFiles || []);
  const missing = inScopeFiles.filter((f) => !covered.has(f));
  if (missing.length > 0) {
    attempts.push(
      `${path.basename(entry.file)}: trace's coveredFiles does not include: ${missing.join(', ')}`,
    );
    continue;
  }

  const artifactPath = path.resolve(ROOT, trace.artifactPath);
  if (!fs.existsSync(artifactPath)) {
    attempts.push(`${path.basename(entry.file)}: artifact ${trace.artifactPath} does not exist`);
    continue;
  }

  const artifactContent = fs.readFileSync(artifactPath, 'utf8');
  if (artifactContent.trim().length < MIN_ARTIFACT_CHARS) {
    attempts.push(
      `${path.basename(entry.file)}: artifact is too short (${artifactContent.trim().length} chars, need ${MIN_ARTIFACT_CHARS})`,
    );
    continue;
  }

  const sha = crypto.createHash('sha256').update(artifactContent).digest('hex');
  if (trace.artifactSha256 && trace.artifactSha256 !== sha) {
    attempts.push(
      `${path.basename(entry.file)}: artifact content has changed since the trace was written (sha mismatch)`,
    );
    continue;
  }

  // Also verify the artifact is staged — it must ship alongside the code.
  if (!staged.includes(trace.artifactPath)) {
    attempts.push(
      `${path.basename(entry.file)}: artifact ${trace.artifactPath} is not staged for commit — it must ship alongside the change`,
    );
    continue;
  }

  validTrace = { entry, trace };
  break;
}

if (!validTrace) {
  blockCommit(
    inScopeFiles,
    [
      'No valid trace matched the staged changes. Attempts:',
      ...attempts.map((a) => `  • ${a}`),
      '',
      'Run the /instar-dev skill, produce the side-effects artifact, stage the artifact, and write a fresh trace before committing.',
    ].join('\n'),
  );
}

// ─── Pass ────────────────────────────────────────────────────────────────

console.error(
  `[instar-dev-precommit] OK — trace ${path.basename(validTrace.entry.file)} covers ${inScopeFiles.length} in-scope file(s), artifact ${validTrace.trace.artifactPath} verified.`,
);
process.exit(0);

function blockCommit(files, reason) {
  console.error('');
  console.error('╔════════════════════════════════════════════════════════════════════╗');
  console.error('║  /instar-dev gate — commit BLOCKED                                 ║');
  console.error('╚════════════════════════════════════════════════════════════════════╝');
  console.error('');
  console.error('In-scope staged files requiring side-effects review:');
  for (const f of files) console.error(`  • ${f}`);
  console.error('');
  console.error('Reason:');
  reason.split('\n').forEach((line) => console.error(`  ${line}`));
  console.error('');
  console.error('See docs/signal-vs-authority.md and skills/instar-dev/SKILL.md for details.');
  console.error('');
  process.exit(1);
}
