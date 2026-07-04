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
import { checkEli16Overview, MIN_ELI16_CHARS } from './eli16-overview-check.mjs';
import { verifyProposalDerivedRunbooks } from '../skills/instar-dev/scripts/verify-proposal-derived-runbook.mjs';
import { classifyTier, decideRequirementSet } from './lib/classify-tier.mjs';
import { recognizeConvergence } from './lib/convergence-recognition.mjs';
import { isOperatorSurfaceFile, artifactAddressesOperatorSurfaceQuality, isAuthorizationSurfaceFile, artifactAddressesAgentProposesApproves, operatorSurfaceRequiresRawInput } from './lib/operator-surface.mjs';
import { selfActionDeclarationVerdict } from './lib/self-action-detect.mjs';

// Report-Backed Converging Audit (docs/specs/CONVERGING-AUDIT-DEFAULT.md, Part B).
// The precommit reads NO config file and runs pre-compile, so it cannot import
// the TS config loader. The flag specReview.requireConvergenceReport is threaded
// in as an ENV VAR by the .husky/pre-commit hook, mirroring the existing in-file
// INSTAR_DEV_ALLOW_ORPHAN_DEFERRALS pattern. When unset, the new report-backing
// branch never runs → byte-identical to today's precommit behavior.
const REQUIRE_CONVERGENCE_REPORT = process.env.INSTAR_DEV_REQUIRE_CONVERGENCE_REPORT === '1';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const TRACES_DIR = path.join(ROOT, '.instar', 'instar-dev-traces');
// Legacy single-file audit log (frozen 2026-06-05 — read-only history).
// Every gated commit used to APPEND one line here; because the line rides the
// commit (the task-#62 fix), any two PRs in flight both modified this file's
// tail and conflicted at the merge point — a structural conflict generator at
// parallel-PR cadence (live hit: PR #824 went CI-green then failed merge on
// exactly this file). New entries are one-file-per-decision under
// DECISIONS_DIR instead: distinct filenames can never conflict.
// (The frozen legacy file remains at .instar/instar-dev-decisions.jsonl.)
const DECISIONS_DIR = path.join(ROOT, '.instar', 'instar-dev-decisions');

// Set by writeDecisionAudit; consumed by the process 'exit' handler that
// finalizes the entry's verdict. BOTH the declaration AND the handler
// registration live here, above the top-level audit call site — placed
// after it, the declaration TDZ-throws inside writeDecisionAudit's
// try/catch, and the handler registration is never even reached when
// blockCommit exits first (top-level statements run in source order).
let pendingAuditEntry = null;
process.on('exit', (code) => {
  if (!pendingAuditEntry) return;
  try {
    const { entryPath, entryData } = pendingAuditEntry;
    entryData.verdict = code === 0 ? 'pass' : 'blocked';
    fs.writeFileSync(entryPath, JSON.stringify(entryData, null, 2) + '\n');
    execSync(`git add ${JSON.stringify(path.relative(ROOT, entryPath))}`, { cwd: ROOT });
  } catch { /* best-effort — 'pending' is still more truthful than no verdict */ }
});
const WINDOW_MS = 60 * 60 * 1000; // 60 minutes
const MIN_ARTIFACT_CHARS = 200;

// ─── Step 0: skip gate for merge commits ─────────────────────────────────
// Merge commits integrate already-reviewed code from another branch/machine.
// The side-effects review was done when those commits were originally authored.
//
// `.git` is a directory in a normal checkout but a gitlink-FILE in a worktree
// (containing `gitdir: /absolute/path/to/the/real/git/dir`). The real
// MERGE_HEAD lives in that real git dir, e.g.
// `.git/worktrees/<worktree-name>/MERGE_HEAD`. Asking git for the resolved
// git dir works in both layouts; hard-coding `path.join(ROOT, '.git', ...)`
// fails to detect a merge in a worktree, which made the gate fire on every
// worktree merge commit. We use `git rev-parse --git-dir` to dodge both.
{
  let gitDir = path.join(ROOT, '.git');
  try {
    const resolved = execSync('git rev-parse --git-dir', { cwd: ROOT, encoding: 'utf8' }).trim();
    if (resolved) {
      gitDir = path.isAbsolute(resolved) ? resolved : path.join(ROOT, resolved);
    }
  } catch {
    // Fall back to the literal `.git` join — at worst we miss the merge
    // detection and the gate fires; we never falsely SKIP.
  }
  if (fs.existsSync(path.join(gitDir, 'MERGE_HEAD'))) {
    process.exit(0);
  }
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
const BOOTSTRAP_TRIGGERS = [
  'scripts/instar-dev-precommit.js',
  'skills/spec-converge/SKILL.md',
];
const bootstrapTrigger = addedFiles.find((f) => BOOTSTRAP_TRIGGERS.includes(f));
if (bootstrapTrigger) {
  console.error(
    `[instar-dev-precommit] bootstrap commit detected (${bootstrapTrigger} is being added) — passing. All future commits will be gated by the full spec-tag chain.`,
  );
  process.exit(0);
}

// ─── Step 3.5: compute + surface the tier signal ─────────────────────────
// Pure classifier (scripts/lib/classify-tier.mjs). SIGNAL ONLY — the gate
// SURFACES the suggestion; the agent DECLARES the real tier in its trace. The
// classifier never decides for the agent and never blocks. (The Body and the
// Mind: the body informs, the mind decides, the decision is audited.)

let tierSignal = { suggestedTier: 2, sizeTier: 2, riskFloor: 1, reasons: [] };
let totalChangedLoc = 0;
// Hoisted to module scope (docs/specs/self-action-convergence.md → E3 impl
// note): addedDiffText is computed in the Step-3.5 block but consumed later by
// assertSelfActionDeclared at BOTH the enforceTier1 and Tier-2 pass-through call
// sites. It must outlive the block.
let addedDiffText = '';
{
  let addedLines = 0;
  let deletedLines = 0;
  try {
    const numstat = execSync(
      `git diff --cached --numstat -- ${inScopeFiles.map((f) => JSON.stringify(f)).join(' ')}`,
      { cwd: ROOT, encoding: 'utf8' },
    );
    for (const line of numstat.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [a, d] = trimmed.split('\t');
      // Binary files show "-\t-"; treat as 0 LOC.
      addedLines += a === '-' ? 0 : parseInt(a, 10) || 0;
      deletedLines += d === '-' ? 0 : parseInt(d, 10) || 0;
    }
  } catch {
    // If numstat fails, leave LOC at 0 — sizeTier becomes 1, riskFloor still
    // governs. We never crash the gate over a diff-stat hiccup.
  }
  try {
    // Added-line-only diff text feeds the new-capability heuristic. We pull the
    // full staged diff and keep only the added (`+`) lines, stripping the `+`.
    const fullDiff = execSync(
      `git diff --cached -- ${inScopeFiles.map((f) => JSON.stringify(f)).join(' ')}`,
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    );
    addedDiffText = fullDiff
      .split('\n')
      .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
      .map((l) => l.slice(1))
      .join('\n');
  } catch {
    // No added-diff text → classifier SKIPS the new-capability check (per spec).
    addedDiffText = '';
  }

  totalChangedLoc = addedLines + deletedLines;

  tierSignal = classifyTier({
    inScopeFiles,
    addedLines,
    deletedLines,
    addedDiffText: addedDiffText || undefined,
  });

  console.error(
    `[instar-dev-precommit] tier signal: suggestedTier=${tierSignal.suggestedTier} ` +
      `(size=${tierSignal.sizeTier}, riskFloor=${tierSignal.riskFloor}, ` +
      `${addedLines + deletedLines} LOC across ${inScopeFiles.length} file(s))`,
  );
  if (tierSignal.reasons.length > 0) {
    console.error('[instar-dev-precommit] risk-floor reasons:');
    for (const r of tierSignal.reasons) console.error(`  • ${r}`);
  }
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

// ─── Step 4.5: read the agent's DECLARED tier + branch ───────────────────
// The agent records its tier in the trace JSON. We peek the freshest fresh
// trace to read `trace.tier` (1|2|3). decideRequirementSet() factors the pure
// enforcement decision:
//   - tier 1            → 'tier1-lite'  (ELI16 + side-effects staged; no spec)
//   - tier 2 / 3        → 'tier2-full'  (the EXISTING full validation, unchanged)
//   - missing / no tier → 'tier2-full'  (back-compat default — behaves as today)

let declaredTier = null;
let tierReasoning = '';
let freshestTrace = null;
try {
  freshestTrace = JSON.parse(fs.readFileSync(traceEntries[0].file, 'utf8'));
  if (freshestTrace && (freshestTrace.tier === 1 || freshestTrace.tier === 2 || freshestTrace.tier === 3)) {
    declaredTier = freshestTrace.tier;
  }
  if (freshestTrace && typeof freshestTrace.tierReasoning === 'string') {
    tierReasoning = freshestTrace.tierReasoning;
  }
} catch {
  // Malformed freshest trace → declaredTier stays null → Tier-2 back-compat
  // path (the existing Step 5 loop will surface the malformed-JSON attempt).
}

const slug = (freshestTrace && (freshestTrace.slug || freshestTrace.name)) || 'unknown';
const decision = decideRequirementSet(declaredTier);

// ─── Step 4.55: causal autopsy (directive 2026-06-05) ───────────────────
// Low-ceremony lanes (Tier-1) ship without an independent reviewer, so the
// compensating control is a durable causal record per issue: every fix-class
// commit SHOULD declare what caused the issue it fixes — a prior PR, an
// environment shift that invalidated old assumptions, plain new code, a
// latent bug, or honestly unknown. The field rides the decision audit so
// meta-analysis ("are we converging or playing whack-a-mole?") is a query
// over .instar/instar-dev-decisions/, not archaeology. ADVISORY in this
// slice: absence warns on fix-class signals, never blocks. A PRESENT but
// malformed autopsy blocks — a corrupt record is worse than none.
const AUTOPSY_ORIGINS = ['prior-pr', 'environment-shift', 'new-code', 'latent', 'unknown'];
let causalAutopsy = null;
let autopsyError = null;
if (freshestTrace && freshestTrace.causalAutopsy !== undefined) {
  const ca = freshestTrace.causalAutopsy;
  const validPrs = (a) => Array.isArray(a) && a.length > 0 && a.every((n) => Number.isInteger(n) && n > 0);
  if (!ca || typeof ca !== 'object' || Array.isArray(ca)) {
    autopsyError = 'causalAutopsy must be an object: { origin, relatedPrs?, notes? }';
  } else if (!AUTOPSY_ORIGINS.includes(ca.origin)) {
    autopsyError = `causalAutopsy.origin must be one of ${AUTOPSY_ORIGINS.join(' | ')} (got ${JSON.stringify(ca.origin)})`;
  } else if (ca.origin === 'prior-pr' && !validPrs(ca.relatedPrs)) {
    autopsyError = 'causalAutopsy.origin "prior-pr" requires relatedPrs: a non-empty array of positive PR numbers';
  } else if (ca.relatedPrs !== undefined && !validPrs(ca.relatedPrs)) {
    autopsyError = 'causalAutopsy.relatedPrs must be a non-empty array of positive integers when present';
  } else if (ca.notes !== undefined && typeof ca.notes !== 'string') {
    autopsyError = 'causalAutopsy.notes must be a string when present';
  } else {
    causalAutopsy = {
      origin: ca.origin,
      ...(ca.relatedPrs !== undefined ? { relatedPrs: ca.relatedPrs } : {}),
      ...(ca.notes !== undefined ? { notes: ca.notes } : {}),
    };
  }
}

// AUDIT (all in-scope cases): one JSON line, written regardless of branch.
// belowFloor = the agent declared UNDER the risk-signaled floor. We never
// block on it (the mind holds authority) — the record is the backstop.
const belowFloor = declaredTier != null && declaredTier < tierSignal.riskFloor;
const decisionEntryPath = writeDecisionAudit({
  slug,
  suggestedTier: tierSignal.suggestedTier,
  declaredTier,
  riskFloor: tierSignal.riskFloor,
  riskFloorReasons: tierSignal.reasons,
  belowFloor,
  files: inScopeFiles.length,
  loc: totalChangedLoc,
  causalAutopsy,
  classClosure: (freshestTrace && typeof freshestTrace.classClosure === 'object' && freshestTrace.classClosure) || null,
});
// Malformed autopsy blocks AFTER the audit write — the blocked attempt is
// recorded (verdict 'blocked' via the exit handler), same as every gate
// refusal. Validated-when-present: absence never reaches this.
if (autopsyError) {
  blockCommit(
    inScopeFiles,
    `Invalid causalAutopsy in trace: ${autopsyError}\n` +
    `  Shape: { "origin": "prior-pr|environment-shift|new-code|latent|unknown", "relatedPrs": [123], "notes": "..." }\n` +
    `  (origin "prior-pr" requires relatedPrs; the field is otherwise optional-but-validated.)`,
  );
}
// Advisory (never blocks): a fix-class commit with NO autopsy gets a loud
// nudge. Fix-class signal = branch name says fix, or a staged release-note
// fragment declares change_type: fix.
if (!causalAutopsy) {
  let fixClassSignal = false;
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();
    if (/(^|[\/-])fix([\/-]|$)/i.test(branch)) fixClassSignal = true;
  } catch { /* detached HEAD / no commits — stay quiet, advisory only */ }
  if (!fixClassSignal) {
    try {
      const staged = execSync('git diff --cached --name-only', { cwd: ROOT, encoding: 'utf8' })
        .split('\n').map((s) => s.trim()).filter(Boolean);
      for (const f of staged) {
        if (!/^upgrades\/next\/.+\.md$/.test(f)) continue;
        const fp = path.join(ROOT, f);
        if (fs.existsSync(fp) && /change_type:\s*fix/.test(fs.readFileSync(fp, 'utf8'))) {
          fixClassSignal = true;
          break;
        }
      }
    } catch { /* advisory only */ }
  }
  if (fixClassSignal) {
    console.error('');
    console.error('┌──────────────────────────────────────────────────────────────────┐');
    console.error('│  ⚠ ADVISORY — fix-class commit with no causalAutopsy in trace.    │');
    console.error('│    What caused the issue this fixes? Add to your trace JSON:      │');
    console.error('│    "causalAutopsy": { "origin": "prior-pr|environment-shift|      │');
    console.error('│      new-code|latent|unknown", "relatedPrs": [N], "notes": "…" }  │');
    console.error('│    NOT blocked — but the meta-analysis record stays blind here.   │');
    console.error('└──────────────────────────────────────────────────────────────────┘');
    console.error('');
  }
}
if (belowFloor) {
  console.error('');
  console.error('┌──────────────────────────────────────────────────────────────────┐');
  console.error('│  ⚠ BELOW RISK FLOOR — declared tier is under the risk-signaled    │');
  console.error('│    floor. NOT blocked (you hold authority), but recorded.         │');
  console.error('└──────────────────────────────────────────────────────────────────┘');
  console.error(`  declared Tier ${declaredTier} < risk floor ${tierSignal.riskFloor}. Risk signals:`);
  for (const r of tierSignal.reasons) console.error(`    • ${r}`);
  if (tierReasoning) console.error(`  Your tierReasoning: ${tierReasoning}`);
  console.error(`  Recorded to ${path.relative(ROOT, decisionEntryPath ?? DECISIONS_DIR)} (belowFloor:true).`);
  console.error('');
}

// ─── Step 4.6: Tier-1 lite path ──────────────────────────────────────────
// When the agent declared Tier 1, the requirement set is intentionally lighter:
// a staged ELI16 (the "request" ELI16) + a staged side-effects artifact
// (sha-matched if the trace records a sha) — and NO converged/approved spec.
// (The tests/lint requirement from the spec lives in the pre-PUSH gate, not
// here: this pre-COMMIT hook checks ARTIFACTS only.)
if (decision.requirementSet === 'tier1-lite') {
  enforceTier1(freshestTrace, traceEntries[0].file);
  // enforceTier1 either passes through (process.exit(0)) or blockCommit()s.
}

// ── Otherwise: Tier-2 / Tier-3 / no-tier → the EXISTING full validation ──
// Everything below (Steps 5–8) is unchanged. A Tier-3 project step is just a
// Tier-2 spec; nothing new is enforced for "Tier 3" at the gate.

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
    // Self-service fix: tell the author the EXACT sha to write, plus the
    // freeze-recipe. Without this, an agent (especially codex, which often
    // regenerates artifacts) chases the hash forever — regenerate → a volatile
    // field (e.g. a `Date:` line) changes → new sha → repeat. Printing the
    // computed sha turns a ~2h grind into a copy-paste fix.
    attempts.push(
      `${path.basename(entry.file)}: artifact ${trace.artifactPath} sha mismatch — ` +
        `trace records ${String(trace.artifactSha256).slice(0, 12)}… but the staged bytes hash to ${sha.slice(0, 12)}…. ` +
        `If the current artifact is correct, set "artifactSha256": "${sha}" in the trace, ` +
        `re-stage BOTH the artifact and the trace, and commit fresh (do NOT amend). ` +
        `Common cause: a volatile field (e.g. a Date line) was regenerated — freeze the bytes, hash once, do not regenerate the artifact again.`,
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

// ─── Step 6: spec-tag verification ───────────────────────────────────────
// Every in-scope change must reference a spec that has (a) been through
// /spec-converge to convergence, and (b) been explicitly approved by the
// user. The trace's `specPath` field points at the spec file. We parse its
// YAML frontmatter and verify both tags are present.

const spec = validTrace.trace.specPath;
if (!spec) {
  blockCommit(
    inScopeFiles,
    [
      'Trace does not reference a spec (trace.specPath is missing).',
      '',
      'Every in-scope change must be driven by a spec that has passed /spec-converge',
      'and been approved by the user. Write the trace with --spec <path>.',
    ].join('\n'),
  );
}

const specPath = path.resolve(ROOT, spec);
if (!fs.existsSync(specPath)) {
  blockCommit(
    inScopeFiles,
    `Spec file ${spec} (referenced by trace) does not exist.`,
  );
}

const specContent = fs.readFileSync(specPath, 'utf8');
const specFmMatch = specContent.match(/^---\n([\s\S]*?)\n---\n/);
if (!specFmMatch) {
  blockCommit(
    inScopeFiles,
    `Spec ${spec} has no YAML frontmatter. It cannot carry the required review-convergence and approved tags.`,
  );
}
const specFm = specFmMatch[1];

// Convergence / approval / report recognition is factored into a pure,
// dependency-free module (scripts/lib/convergence-recognition.mjs) that a unit
// test cross-checks against the TS validator's `isConvergenceTagPresent` —
// keeping the two gates in agreement (CONVERGING-AUDIT-DEFAULT.md, Part C). The
// report-existence input depends on the spec's slug + the env flag, computed
// just below; the recognizer does no I/O of its own.

// Slug → report path, matching StageTransitionValidator's derivation exactly.
const specSlugMatch = specFm.match(/^\s*slug\s*:\s*["']?([a-z0-9][a-z0-9-]{0,63})["']?\s*$/m);
const specSlug = specSlugMatch ? specSlugMatch[1] : '';
const convergenceReportRel = specSlug
  ? path.join('docs/specs/reports', `${specSlug}-convergence.md`)
  : '';
// Only probe the filesystem when the report requirement is actually on. With
// the flag unset, reportExists stays false but is never consulted (the
// recognizer's reportBacked is vacuously true), so this branch is byte-inert.
const convergenceReportExists =
  REQUIRE_CONVERGENCE_REPORT && convergenceReportRel
    ? fs.existsSync(path.resolve(ROOT, convergenceReportRel))
    : false;

const recognition = recognizeConvergence(specFm, {
  requireReport: REQUIRE_CONVERGENCE_REPORT,
  reportExists: convergenceReportExists,
});

if (!recognition.converged) {
  blockCommit(
    inScopeFiles,
    [
      `Spec ${spec} is not tagged review-convergence.`,
      'Run /spec-converge on this spec before committing the change.',
    ].join('\n'),
  );
}

if (!recognition.approved) {
  blockCommit(
    inScopeFiles,
    [
      `Spec ${spec} has review-convergence but no approved: true tag.`,
      'The user must review the convergence report and apply the approved tag',
      'before /instar-dev can ship this change.',
    ].join('\n'),
  );
}

// ── Report-backing (Part B — dark, env-gated) ──
// When INSTAR_DEV_REQUIRE_CONVERGENCE_REPORT=1, a converged + approved spec must
// ALSO have its converging-audit report on disk (proving the audit RAN, not just
// that a tag was added). This brings the precommit UP to the formal validator's
// strictness (which requires the report unconditionally). With the env unset,
// recognition.reportBacked is always true and this branch never blocks.
if (!recognition.reportBacked) {
  blockCommit(
    inScopeFiles,
    [
      `Spec ${spec} is tagged review-convergence + approved, but its converging-audit`,
      `report is missing: ${convergenceReportRel || '(spec has no valid slug to locate a report)'}`,
      '',
      'INSTAR_DEV_REQUIRE_CONVERGENCE_REPORT is on (specReview.requireConvergenceReport:',
      'true) — a convergence tag without its report can fake convergence. The report is',
      'the audit\'s proof-of-work; run /spec-converge to produce it (Phase 5 writes',
      `docs/specs/reports/<slug>-convergence.md), then commit. To turn this requirement`,
      'off, set specReview.requireConvergenceReport: false in your instar config.',
    ].join('\n'),
  );
}

// ── Part D: surface cross-model-review depth (observe-only, never blocks) ──
// The converging audit records how much external (cross-model) review actually
// ran. Surfacing it here makes the audit's depth visible to the operator/agent
// reading the gate output, without ever gating on it (Signal vs. Authority).
const crossModelMatch = specFm.match(/^\s*cross-model-review\s*:\s*["']?([^"'\n]+)/m);
const crossModelReview = crossModelMatch ? crossModelMatch[1].trim() : 'not-recorded';

// ─── Step 7: ELI16 overview verification ─────────────────────────────────
// Every approved spec must ship with a plain-English ELI16 overview. The
// overview is the entry point for any reader who has to make a real decision
// against the spec — the dense technical spec is for reviewers, not deciders.

const eli16Result = checkEli16Overview(specPath, specFm);
if (!eli16Result.ok) {
  if (eli16Result.reason === 'missing') {
    blockCommit(
      inScopeFiles,
      [
        `Spec ${spec} has no ELI16 overview.`,
        'Every approved spec must ship with a plain-English overview at:',
        `  • Sibling path: ${path.relative(ROOT, eli16Result.siblingPath)}`,
        '  • OR declared via spec frontmatter: eli16-overview: <relative-path>',
        '',
        'An ELI16 overview is a ~16-year-old-reading-level companion to the',
        "technical spec — it leads with what the change actually is in plain",
        "English, what already exists, what's new, and what the reader needs",
        'to decide. The technical spec is the appendix, not the entry point.',
        '',
        'See skills/instar-dev/templates/eli16-overview.md for a template.',
      ].join('\n'),
    );
  } else if (eli16Result.reason === 'declared-not-found') {
    blockCommit(
      inScopeFiles,
      [
        `Spec ${spec} declares an ELI16 overview at ${path.relative(ROOT, eli16Result.declaredPath)} (frontmatter eli16-overview),`,
        'but that file does not exist. Create it before committing.',
      ].join('\n'),
    );
  } else if (eli16Result.reason === 'too-short') {
    blockCommit(
      inScopeFiles,
      [
        `Spec ${spec}'s ELI16 overview at ${path.relative(ROOT, eli16Result.declaredPath)} is too short`,
        `(${eli16Result.charCount} chars, need ${eli16Result.minChars}).`,
        '',
        "A stub isn't an overview — write a real one.",
        'See skills/instar-dev/templates/eli16-overview.md for the expected shape.',
      ].join('\n'),
    );
  }
}

// If the spec itself is staged, the ELI16 overview must ship with it.
const eli16Rel = path.relative(ROOT, eli16Result.eli16Path).replace(/\\/g, '/');
if (staged.includes(spec) && !staged.includes(eli16Rel)) {
  blockCommit(
    inScopeFiles,
    [
      `Spec ${spec} is staged but its ELI16 overview ${eli16Rel} is not.`,
      'The overview must ship alongside the spec it accompanies.',
    ].join('\n'),
  );
}

// ─── Step 7.6: Constitutional Traceability (No Unconstitutional Work) ──────
// Every spec must trace to a real constitutional standard with an indisputable
// fit. This commit-time gate enforces the STRUCTURAL half (always-on, server-free):
// the spec's parent-principle frontmatter must be PRESENT and RESOLVE to a real
// article heading in docs/STANDARDS-REGISTRY.md. The QUALITATIVE "indisputable fit"
// judgment (fit/weak/none) is the review-time reviewer's job — POST
// /spec/conformance-check now returns report.fit — so a weak/none fit is caught and
// resolved before approval, not at commit (where a 150s LLM call would hang every
// commit). A non-resolving parent is the signal to amend the constitution (propose a
// new standard) or recognize the work as unconstitutional. Fail-OPEN if the registry
// is unreadable — never block work because the constitution can't be read.
{
  const parentMatch = specFm.match(/^\s*parent-principle\s*:\s*(.+)$/m);
  const parent = parentMatch ? parentMatch[1].trim().replace(/^["']|["']$/g, '') : '';
  if (!parent) {
    blockCommit(
      inScopeFiles,
      [
        `Spec ${spec} names no parent-principle (Constitutional Traceability).`,
        'Every spec MUST name the constitutional standard it serves, with an indisputable fit.',
        'Add a frontmatter line, e.g.:',
        '  parent-principle: "<exact article name from docs/STANDARDS-REGISTRY.md>"',
        '',
        'If no current standard covers this work, that is the signal to either amend the',
        'constitution (propose a new standard, get it ratified) or recognize the work as',
        'unconstitutional — do not ship it unanchored.',
      ].join('\n'),
    );
  }
  let registryNames = [];
  try {
    const reg = fs.readFileSync(path.join(ROOT, 'docs', 'STANDARDS-REGISTRY.md'), 'utf8');
    registryNames = (reg.match(/^###\s+(.+)$/gm) || []).map((h) => h.replace(/^###\s+/, '').trim());
  } catch {
    // Registry unreadable → cannot resolve; fail-open (skip the resolution check).
    registryNames = [];
  }
  if (parent && registryNames.length) {
    const pl = parent.toLowerCase();
    const resolves = registryNames.some((n) => {
      const nl = n.toLowerCase();
      return pl.includes(nl) || nl.includes(pl);
    });
    if (!resolves) {
      blockCommit(
        inScopeFiles,
        [
          `Spec ${spec}'s parent-principle does not resolve to a real constitutional standard.`,
          `  parent-principle: ${parent}`,
          '',
          'It must name (or contain) an exact article heading from docs/STANDARDS-REGISTRY.md.',
          'A hand-wave parent fails the same as none — name the standard this work is plainly an',
          'instance of, or amend the constitution to cover it (then the work is constitutional).',
        ].join('\n'),
      );
    }
  }
}

// ─── Step 7.5: orphan deferrals must be tracked ───────────────────────────
// Why: on 2026-05-20 PR #284 shipped four of five fixes for a version-skew
// failure class and explicitly deferred the fifth ("lifeline auto-restart on
// server upgrade — out of scope today"). Two days later that exact deferral
// produced the same outage. Per user feedback 2026-05-22: "WE NEED TO CHANGE
// THIS. Our development work should focus on COMPLETE features/fixes with NO
// deferrals." This check makes the rule structural: any spec that contains
// "deferred / out of scope today / follow-up / preemptive fix / NOT in this
// PR" language must explicitly track each instance (HTML comment marker
// `<!-- tracked: <id> -->` within 200 chars, or a frontmatter
// `deferrals-tracked` field). Override via INSTAR_DEV_ALLOW_ORPHAN_DEFERRALS=1
// (logged for visibility).
//
// Detector patterns intentionally conservative — false-positives are cheaper
// than false-negatives here. The author can either link a tracker or rephrase
// the sentence to not promise a deferral.
// Patterns: { regex, requireUnnegated } — when requireUnnegated is true,
// we skip the match if the immediately-preceding chars contain "no ", "non-",
// "non ", "non", or "un" (so "no deferrals" / "non-deferred" / "undeferred"
// don't false-alarm).
//
// Reviewer feedback 2026-05-22: the prior implementation honored a
// `deferrals-tracked:` frontmatter wave-through that short-circuited the
// entire body scan. That was a loophole — a future author could write
// `deferrals-tracked: see below` and ship orphan deferrals with no
// validation. Closed: every body hit must have its own inline tracker
// marker within 200 chars. The §"Deferrals tracked" section in the spec is
// still useful as a human-readable catalog, but no longer a bypass.
const DEFERRAL_PATTERNS = [
  { regex: /\bdeferred?\b/gi, requireUnnegated: true },
  { regex: /\bdeferrals?\b/gi, requireUnnegated: true },
  { regex: /\bout of scope today\b/gi, requireUnnegated: false },
  { regex: /\bout of scope for now\b/gi, requireUnnegated: false },
  { regex: /\bnot in this pr\b/gi, requireUnnegated: false },
  { regex: /\bpreemptive fix\b/gi, requireUnnegated: false },
  // Match standalone "follow-up" / "follow-ups" / "followups" mentions.
  // Reviewer broadened from the prior narrow "(?!\s+(?:are\s+)?tracked)"
  // exclusion — that only handled "follow-ups tracked" / "follow-ups are
  // tracked" and false-positived on natural variants. We now require the
  // 200-char tracker-marker check to do the work uniformly.
  { regex: /\bfollow[- ]?ups?\b/gi, requireUnnegated: false },
];
const TRACKED_NEAR_HIT_CHARS = 200;
const TRACKED_MARKER = /<!--\s*tracked:\s*[A-Za-z0-9._/-]+\s*-->/;
const NEGATION_BEFORE = /(?:\b(?:no|non-?|un)[- ]?)$/i;

function findOrphanDeferrals(content) {
  const orphans = [];
  for (const { regex, requireUnnegated } of DEFERRAL_PATTERNS) {
    regex.lastIndex = 0;
    let m;
    while ((m = regex.exec(content)) !== null) {
      const start = m.index;
      if (requireUnnegated) {
        // Look at up to 8 chars immediately before the match. Treat
        // matches preceded by "no ", "non-", "non ", "un" as legitimate
        // negations (false-positive guard for "no deferrals", "non-
        // deferred", "undeferred").
        const before = content.slice(Math.max(0, start - 8), start);
        if (NEGATION_BEFORE.test(before)) continue;
      }
      const end = Math.min(content.length, start + m[0].length + TRACKED_NEAR_HIT_CHARS);
      const slice = content.slice(start, end);
      if (TRACKED_MARKER.test(slice)) continue;
      // Compute line number for the operator's diagnostic.
      const beforeAll = content.slice(0, start);
      const lineNo = (beforeAll.match(/\n/g) || []).length + 1;
      orphans.push({ pattern: regex.source, match: m[0], lineNo });
      if (orphans.length >= 16) return orphans; // cap noise (was 8; widened patterns may trip more)
    }
  }
  return orphans;
}

const orphans = findOrphanDeferrals(specContent);
if (orphans.length > 0) {
  const override = process.env.INSTAR_DEV_ALLOW_ORPHAN_DEFERRALS === '1';
  if (override) {
    // Log the override for visibility — every use is audited.
    try {
      const logPath = path.join(TRACES_DIR, 'orphan-deferral-overrides.jsonl');
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(
        logPath,
        JSON.stringify({
          at: new Date().toISOString(),
          spec,
          orphans,
          stagedFiles: inScopeFiles,
        }) + '\n',
      );
      console.warn(
        `[instar-dev-precommit] WARN: INSTAR_DEV_ALLOW_ORPHAN_DEFERRALS=1 — ` +
        `${orphans.length} orphan deferral(s) in ${spec} bypassed and logged to ${path.relative(ROOT, logPath)}`,
      );
    } catch { /* logging is best-effort */ }
  } else {
    blockCommit(
      inScopeFiles,
      [
        `Spec ${spec} contains ${orphans.length} orphan deferral mention(s) — each must be tracked.`,
        '',
        ...orphans.map(o => `  • line ${o.lineNo}: "${o.match}"`),
        '',
        'Why this rule exists:',
        '  On 2026-05-20 a PR shipped 4 of 5 fixes for a failure class and',
        '  explicitly deferred the 5th. Two days later that exact deferral',
        '  produced the same outage. Deferrals are how regressions happen.',
        '',
        'How to resolve each one:',
        '  (a) Move the work into this PR (preferred — eliminates the deferral).',
        '  (b) Add a tracked marker within 200 chars of the mention:',
        '      `<!-- tracked: <id> -->` where <id> is an issue, topic, or',
        '      commitment-action ID that owns the follow-up.',
        '  (c) Rephrase the sentence so it no longer promises a deferral',
        '      (e.g. quote the historical phrase verbatim with surrounding',
        '      context that makes the non-prescriptive intent obvious).',
        '',
        'Emergency override (logged + audited):',
        '  INSTAR_DEV_ALLOW_ORPHAN_DEFERRALS=1 git commit ...',
        '  Use only when the deferral language is in a non-prescriptive context',
        '  (e.g. quoting an old spec). Every use lands in',
        '  .instar/instar-dev-traces/orphan-deferral-overrides.jsonl for review.',
      ].join('\n'),
    );
  }
}

// ─── Step 8: proposal-derived runbook gate (S-3) ─────────────────────────
// Per SELF-HEALING-REMEDIATOR-V2-SPEC §A11/§A22/§A32, runbook source files
// emitted by the SystemReviewer proposal pipeline must:
//   1. Reference a proposal that actually exists in
//      .instar/remediation/proposals-*/<id>.json on this checkout, AND
//   2. Carry a __producingAgentId const matching the proposal's
//      producingAgentId field.
// The CI gate (C-1) re-verifies at PR-merge time with full fleet visibility.
// This commit-time gate catches author mistakes before the PR is pushed.

const promotionGateResult = verifyProposalDerivedRunbooks({
  repoRoot: ROOT,
  files: staged,
});
if (!promotionGateResult.ok) {
  blockCommit(
    inScopeFiles,
    [
      'Proposal-derived runbook gate refused this commit:',
      `  ${promotionGateResult.reason}`,
      '',
      'See SELF-HEALING-REMEDIATOR-V2-SPEC.md §A11, §A22, §A32 for the rationale.',
      'The proposal pipeline (Tier-3 S-1) must emit __proposalDerivedFrom +',
      '__producingAgentId together, and the matching proposal JSON must be',
      'present at .instar/remediation/proposals-<machineId>/<id>.json.',
    ].join('\n'),
  );
}

// ─── Pass ────────────────────────────────────────────────────────────────

assertFrameworkGenerality(inScopeFiles, validTrace.trace);
assertOperatorSurfaceQuality(staged, validTrace.trace);
assertSelfActionDeclared(addedDiffText, inScopeFiles, validTrace.trace);

console.error(
  `[instar-dev-precommit] OK — trace ${path.basename(validTrace.entry.file)} covers ${inScopeFiles.length} in-scope file(s), artifact ${validTrace.trace.artifactPath} verified, spec ${spec} is converged + approved` +
    `${REQUIRE_CONVERGENCE_REPORT ? ` + report-backed (${convergenceReportRel})` : ''}` +
    ` [cross-model: ${crossModelReview}], ELI16 overview ${eli16Rel} present (${eli16Result.charCount} chars), promotion-gate: ${promotionGateResult.reason}.`,
);
process.exit(0);

// Framework-generality review gate. Changes to the session launch/inject
// ABSTRACTION surface must explicitly state whether they work for ALL agentic
// frameworks (claude-code / codex-cli / gemini-cli / future), not just Claude.
// The CI test tests/unit/framework-agnosticism.test.ts catches the concrete
// "a framework lacks injection coverage" regression; THIS gate makes the review
// state the framework-generality reasoning in the side-effects artifact so the
// subtler Claude-specific assumptions get caught too. Scoped tight (these files
// change rarely) so normal commits pay nothing.
function assertFrameworkGenerality(inScopeFiles, trace) {
  const SURFACE = /(^|\/)(frameworkSessionLaunch|frameworkInjectionProcesses)\.ts$|(^|\/)messaging\/MessageDelivery\.ts$/;
  const touched = inScopeFiles.filter((f) => SURFACE.test(f));
  if (touched.length === 0) return;
  const artifactRel = trace.sideEffectsPath || trace.artifactPath;
  if (!artifactRel) return; // a missing artifact is already blocked upstream
  const artifactAbs = path.resolve(ROOT, artifactRel);
  if (!fs.existsSync(artifactAbs)) return;
  const content = fs.readFileSync(artifactAbs, 'utf8');
  const ADDRESSED =
    /framework[- ]?(general|agnostic)|all (current and future )?frameworks|every framework|per-framework|codex[- ]?cli|gemini[- ]?cli/i;
  if (!ADDRESSED.test(content)) {
    blockCommit(
      touched,
      [
        'Framework-generality review gate:',
        `  ${touched.join(', ')} change the session launch/inject ABSTRACTION,`,
        '  but the side-effects artifact never addresses whether this works for ALL',
        '  agentic frameworks (claude-code / codex-cli / gemini-cli / future) — not',
        '  just Claude.',
        '',
        '  Add a "## Framework generality" section: does this route through the',
        '  framework abstraction? Is it correct for codex-cli and gemini-cli, or is',
        '  it a Claude-specific assumption? (Standard: docs/STANDARDS-REGISTRY.md →',
        '  "Framework-Agnostic — and Framework-Optimizing".)',
      ].join('\n'),
    );
  }
}

// Operator-Surface Quality review gate (docs/STANDARDS-REGISTRY.md →
// "Operator-Surface Quality", CMT-1434). A change touching an operator surface
// (dashboard renderers/markup, approval pages, grant/secret forms) must answer
// the operator-surface-quality question in the side-effects artifact IN WRITING:
// does the surface lead with its primary action, expose zero raw internals,
// de-emphasize destructive actions, and work at phone width? A "reachable but
// bad" surface passes Mobile-Complete and still fails the operator (the
// 2026-06-12 "abysmal" Mandates-grant-form lesson) — this makes the quality
// question unskippable. Operator-surface files are NOT in the gate's inScope set
// (they live under dashboard/), so we scan the full STAGED set, not inScopeFiles.
// Scoped tight so a non-surface commit pays nothing. Companion to
// assertFrameworkGenerality.
function assertOperatorSurfaceQuality(stagedFiles, trace) {
  const touched = (stagedFiles || []).filter(isOperatorSurfaceFile);
  if (touched.length === 0) return;
  const artifactRel = trace.sideEffectsPath || trace.artifactPath;
  if (!artifactRel) return; // a missing artifact is already blocked upstream
  const artifactAbs = path.resolve(ROOT, artifactRel);
  if (!fs.existsSync(artifactAbs)) return;
  const content = fs.readFileSync(artifactAbs, 'utf8');
  // The artifact must engage the operator-surface-quality question (the §6b
  // section seeded by skills/instar-dev/templates/side-effects-artifact.md).
  if (!artifactAddressesOperatorSurfaceQuality(content)) {
    blockCommit(
      touched,
      [
        'Operator-Surface Quality review gate:',
        `  ${touched.join(', ')} change an OPERATOR SURFACE,`,
        '  but the side-effects artifact never answers the operator-surface-quality',
        '  question — a surface can be phone-reachable (Mobile-Complete) and still be',
        '  unusable (the 2026-06-12 "abysmal" Mandates grant-form lesson, CMT-1434).',
        '',
        '  Add the "## 6b. Operator-surface quality" section and answer in writing:',
        '  does the surface (1) lead with its primary action, (2) expose zero raw',
        '  internals as primary content, (3) de-emphasize destructive actions, and',
        '  (4) read in plain language at phone width? (Standard:',
        '  docs/STANDARDS-REGISTRY.md → "Operator-Surface Quality". Template:',
        '  skills/instar-dev/templates/side-effects-artifact.md §6b.)',
      ].join('\n'),
    );
  }
  // "Agent Proposes, Operator Approves" — the authorization-surface subset additionally
  // requires the artifact to confirm the operator is APPROVING (not authoring) and that
  // the authority text is SERVER-authored (not agent free-text — the display-integrity
  // corollary). Same structural-presence strength.
  const authTouched = (stagedFiles || []).filter(isAuthorizationSurfaceFile);
  if (authTouched.length > 0 && !artifactAddressesAgentProposesApproves(content)) {
    blockCommit(
      authTouched,
      [
        'Agent-Proposes-Operator-Approves review gate:',
        `  ${authTouched.join(', ')} change an AUTHORIZATION/APPROVAL surface,`,
        '  but the side-effects artifact never answers the agent-proposes/operator-approves',
        '  question. The operator must be APPROVING a server-authored request, never',
        '  AUTHORING authority from raw fields (the 2026-06-13 raw-JSON mandate-form lesson),',
        '  and the authority text they approve must be server-authored, never agent free-text.',
        '',
        '  Confirm in writing in the side-effects artifact: does the operator (1) approve a',
        '  pre-filled request rather than construct one, and (2) read an authority statement',
        '  authored by the SERVER from structured data, not agent-supplied free-text?',
        '  (Standard: docs/STANDARDS-REGISTRY.md → "Agent Proposes, Operator Approves".)',
      ].join('\n'),
    );
  }
  // "Operators Act in Taps, Not Text" clause (ws52-operator-tap-not-text, Part C arm 1).
  // MECHANICAL upgrade of §6b from prose-attestation to a real inspection of the
  // SURFACE FILE: an operator surface must never require the operator to paste raw
  // technical text (a JSON template in a textarea, an input labelled for a
  // fingerprint/token/base64/curl, or instructions to paste/author such text). The
  // 2026-06-13 raw-JSON mandate-form passed the prose gate; it must not pass this one.
  // Opt out ONLY with the explicit, co-located power-user marker (and that surface
  // must provably never be the default operator path — verified in review).
  for (const surface of touched) {
    const abs = path.resolve(ROOT, surface);
    if (!fs.existsSync(abs)) continue;
    const surfaceContent = fs.readFileSync(abs, 'utf8');
    const verdict = operatorSurfaceRequiresRawInput(surfaceContent);
    if (verdict.requiresRawInput && !verdict.hasPowerUserMarker) {
      blockCommit(
        [surface],
        [
          'Operators-Act-in-Taps-Not-Text gate:',
          `  ${surface} is an operator surface that REQUIRES the operator to paste/enter`,
          '  raw or technical text — a developer action, not an operator action:',
          ...verdict.reasons.map((r) => `    • ${r}`),
          '',
          '  Operators act in taps and plain-language choices; the UI must assemble any',
          '  structured data (JSON, fingerprints, IDs) from those taps. A flow needing raw',
          '  technical input is finished for an engineer, not its user (operator feedback,',
          '  2026-06-17; the 2026-06-13 raw-JSON mandate-form regression).',
          '',
          '  Fix: build the one-tap/selection surface so the operator never sees raw text.',
          '  If this is GENUINELY a power-user surface that is never the default operator',
          '  path, mark it explicitly and co-located:',
          '    /* operator-surface-power-user: <why this is never the default path> */',
          '  (Standard: docs/STANDARDS-REGISTRY.md → "Operator-Surface Quality" →',
          '  "Operators Act in Taps, Not Text" clause.)',
        ].join('\n'),
      );
    }
  }
}

// Self-Action Convergence gate (docs/specs/self-action-convergence.md → E3).
// The light (Tier-1) path is where #1035 (swap-thrash) slipped through with no
// adversarial reviewer. When an ADDED diff introduces/modifies a self-action
// emit (restart|swap|respawn|spawn|notify|retry|re-drive|kill) AND a src/ file
// is touched, the change must declare the `unbounded-self-action` class in the
// TRACE — either a real classClosure declaration (guard|gap) OR an explicit
// negative declaration (closure:'n/a' + reason) — the trace-level analog of the
// D4 lint's allowlist. A genuine one-shot user-driven call costs one attested
// line, never an unescapable block.
//
// FAIL-OPEN on tooling failure (the safe asymmetry): empty addedDiffText, no
// src/ file, or an unreadable artifact does NOT fire — a false-negative here is
// backstopped by the E2 CI lint; a false-positive that blocked all commits
// would sever the developer's ability to ship. Called at BOTH pass-through
// points (enforceTier1 + the Tier-2 fall-through) — the both-call-sites detail
// is load-bearing (the light path is where #1035 escaped).
function assertSelfActionDeclared(addedDiffText, inScopeFilesArg, trace) {
  const verdict = selfActionDeclarationVerdict({
    addedDiffText,
    inScopeFiles: inScopeFilesArg,
    classClosure: trace && trace.classClosure,
  });
  if (!verdict.required) return; // fail-open / not a self-action change

  if (!verdict.satisfied) {
    blockCommit(
      inScopeFilesArg,
      [
        'Self-Action Convergence gate:',
        '  This change ADDS or modifies a self-triggered action in src/ (a',
        '  restart / swap / respawn / spawn / notify / retry / re-drive / kill),',
        '  but the trace carries no `unbounded-self-action` class declaration.',
        '',
        '  A self-triggered action must be proven to CONVERGE under sustained',
        '  pressure (not just be individually correct). Declare it in your trace:',
        '',
        '  • If it is a self-triggered controller — register it in',
        '    src/testing/selfActionRegistry.ts (so tests/unit/self-action-convergence.test.ts',
        '    proves it settles) and declare closure:"guard" citing that ratchet:',
        '      node scripts/class-closure-declare.mjs --to-trace \\',
        '        --class unbounded-self-action --closure guard \\',
        '        --citation tests/unit/self-action-convergence.test.ts \\',
        '        --enforcement ratchet --how-caught "<convergence argument: steady-state bound + settling brake>"',
        '',
        '  • If the guard is out of THIS change\'s scope — closure:"gap" with a',
        '    tracked evolution-action id (--closure gap --gap-item <id>).',
        '',
        '  • If it is genuinely a ONE-SHOT / user-driven action (not a',
        '    self-triggered loop) — an explicit negative declaration:',
        '      { "defectClass": "unbounded-self-action", "closure": "n/a",',
        '        "reason": "one-shot user-driven action, not a self-triggered loop" }',
        '',
        '  (Standard: docs/STANDARDS-REGISTRY.md → "Capacity Safety — No Unbounded',
        '  Self-Action". Spec: docs/specs/self-action-convergence.md → Part E3.)',
      ].join('\n'),
    );
  }

  // Mirror check (the display-only human mirror — the two hosts #1347 uses).
  // Fail-OPEN if the artifact is unreadable.
  const artifactRel = trace && (trace.sideEffectsPath || trace.artifactPath);
  if (artifactRel) {
    const abs = path.resolve(ROOT, artifactRel);
    if (fs.existsSync(abs)) {
      const content = fs.readFileSync(abs, 'utf8');
      if (!/unbounded-self-action/.test(content)) {
        blockCommit(
          inScopeFilesArg,
          [
            'Self-Action Convergence gate (mirror):',
            '  The trace declares the unbounded-self-action class, but the staged',
            `  side-effects artifact (${artifactRel}) never mentions it — the`,
            '  display-only human mirror must AGREE with the machine-readable trace',
            '  declaration (the two hosts #1347 uses).',
            '',
            '  Add the class-closure declaration to the side-effects artifact\'s',
            '  "## Class-Closure Declaration" section.',
          ].join('\n'),
        );
      }
    }
  }
}

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

// ─── Audit writer ─────────────────────────────────────────────────────────
// Append exactly one JSON line to .instar/instar-dev-decisions.jsonl for every
// in-scope commit (regardless of tier branch). Best-effort: a logging failure
// must never crash the gate.
//
// The line is then STAGED so it rides the very commit it describes. Without
// this, a pre-commit-hook append always lands AFTER staging, leaving the line
// uncommitted in the building worktree's tracked decisions file — one-PR
// worktrees never commit it, worktree reclaim deletes it, and the audit trail
// silently leaks (the task-#62 "decision-audit didn't fire" mystery: it DID
// fire, the line just evaporated with the worktree). If the commit is later
// blocked by the gate, the staged line simply rides the retry commit — both
// lines describe real gate evaluations.
function writeDecisionAudit({ slug, suggestedTier, declaredTier, riskFloor, riskFloorReasons, belowFloor, files, loc, causalAutopsy = null, classClosure = null }) {
  try {
    fs.mkdirSync(DECISIONS_DIR, { recursive: true });
    const ts = new Date().toISOString();
    // Filename: sortable timestamp + sanitized slug → chronological `ls`,
    // and a DISTINCT file per decision so parallel PRs can never conflict
    // on the audit trail (each adds its own file; git merges additions of
    // different paths trivially, including GitHub's server-side merge).
    const safeSlug = String(slug).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
    let entryPath = path.join(DECISIONS_DIR, `${ts.replace(/[:.]/g, '-')}-${safeSlug}.json`);
    let n = 1;
    while (fs.existsSync(entryPath)) {
      entryPath = path.join(DECISIONS_DIR, `${ts.replace(/[:.]/g, '-')}-${safeSlug}-${n++}.json`);
    }
    const entryData = {
      ts,
      slug,
      suggestedTier,
      declaredTier,
      // riskFloor (the number) keeps the entry self-contained for later review
      // without re-running the classifier — not just the derived belowFloor.
      riskFloor,
      riskFloorReasons,
      belowFloor,
      files,
      loc,
      // Causal autopsy (directive 2026-06-05): what caused the issue this
      // commit fixes — prior-pr / environment-shift / new-code / latent /
      // unknown, with linked PRs. null = not declared (advisory in slice 1).
      // This is THE meta-analysis substrate: convergence vs whack-a-mole is
      // a query over these entries, not archaeology.
      causalAutopsy,
      // Class-closure declaration (docs/specs/class-closure-gate.md +
      // self-action-convergence.md → E3): persisted from the instar-dev TRACE
      // into the machine-readable decision-audit host the CI class-closure lint
      // reads — closing the chicken-and-egg (the trace is authored before the
      // commit; the entry is written by this hook). null = not declared.
      classClosure,
      // Finalized by the process exit handler below: 'pass' when the gate
      // allowed the commit, 'blocked' otherwise. The riding-the-retry design
      // (a blocked evaluation's entry rides the next successful commit, see
      // header comment) is deliberate — but without a verdict, a rode-along
      // entry written under a stale/unresolved trace slug READS as a real
      // shipped decision for that slug. Live recurrence (2026-06-05): both
      // echo (#836) and codey (#842) shipped mislabeled "unknown"/foreign-slug
      // entries in one day. The verdict makes every entry self-describing.
      verdict: 'pending',
    };
    fs.writeFileSync(entryPath, JSON.stringify(entryData, null, 2) + '\n');
    execSync(`git add ${JSON.stringify(path.relative(ROOT, entryPath))}`, { cwd: ROOT });
    pendingAuditEntry = { entryPath, entryData };
    return entryPath;
  } catch {
    // best-effort — never block on audit I/O
    return null;
  }
}

// ── Verdict finalization ──────────────────────────────────────────────────
// The process 'exit' handler that finalizes each entry's verdict is
// registered next to the pendingAuditEntry declaration near the top of this
// file (it must be registered BEFORE the top-level gate flow can exit). One
// hook covers every exit path: enforceTier1's process.exit(0), the Tier-2
// fall-through, and every blockCommit.

// ─── Tier-1 lite enforcement ──────────────────────────────────────────────
// Tier-1 requirement set: a staged ELI16 (trace.eli16Path) passing the length
// check + a staged side-effects artifact (trace.sideEffectsPath, sha-matched if
// trace.artifactSha256 is present). NO specPath / review-convergence / approved.
// On success this PASSES the whole gate (process.exit(0)); on any failure it
// blockCommit()s with a Tier-1-specific message.
function enforceTier1(trace, traceFile) {
  const traceName = path.basename(traceFile);

  // ── ELI16 (request overview) ──
  const eli16Rel = trace.eli16Path;
  if (!eli16Rel) {
    blockCommit(
      inScopeFiles,
      [
        `Tier-1 trace ${traceName} does not declare an ELI16 overview (trace.eli16Path is missing).`,
        '',
        'A Tier-1 commit still requires a plain-English ELI16 overview of the',
        'change. Write it, stage it, and set "eli16Path": "<relative-path>" in the trace.',
      ].join('\n'),
    );
  }
  const eli16Abs = path.resolve(ROOT, eli16Rel);
  if (!fs.existsSync(eli16Abs)) {
    blockCommit(
      inScopeFiles,
      `Tier-1 ELI16 overview ${eli16Rel} (trace.eli16Path) does not exist.`,
    );
  }
  if (!staged.includes(eli16Rel)) {
    blockCommit(
      inScopeFiles,
      [
        `Tier-1 ELI16 overview ${eli16Rel} is not staged for commit.`,
        'It must ship alongside the change.',
      ].join('\n'),
    );
  }
  const eli16Content = fs.readFileSync(eli16Abs, 'utf8');
  if (eli16Content.trim().length < MIN_ELI16_CHARS) {
    blockCommit(
      inScopeFiles,
      [
        `Tier-1 ELI16 overview ${eli16Rel} is too short`,
        `(${eli16Content.trim().length} chars, need ${MIN_ELI16_CHARS}).`,
        '',
        "A stub isn't an overview — write a real one.",
        'See skills/instar-dev/templates/eli16-overview.md for the expected shape.',
      ].join('\n'),
    );
  }

  // ── Side-effects artifact ──
  const sideEffectsRel = trace.sideEffectsPath;
  if (!sideEffectsRel) {
    blockCommit(
      inScopeFiles,
      [
        `Tier-1 trace ${traceName} does not declare a side-effects artifact (trace.sideEffectsPath is missing).`,
        '',
        'A Tier-1 commit still requires a side-effects review artifact. Write it,',
        'stage it, and set "sideEffectsPath": "<relative-path>" in the trace.',
      ].join('\n'),
    );
  }
  const sideEffectsAbs = path.resolve(ROOT, sideEffectsRel);
  if (!fs.existsSync(sideEffectsAbs)) {
    blockCommit(
      inScopeFiles,
      `Tier-1 side-effects artifact ${sideEffectsRel} (trace.sideEffectsPath) does not exist.`,
    );
  }
  if (!staged.includes(sideEffectsRel)) {
    blockCommit(
      inScopeFiles,
      [
        `Tier-1 side-effects artifact ${sideEffectsRel} is not staged for commit.`,
        'It must ship alongside the change.',
      ].join('\n'),
    );
  }
  const sideEffectsContent = fs.readFileSync(sideEffectsAbs, 'utf8');
  if (sideEffectsContent.trim().length < MIN_ARTIFACT_CHARS) {
    blockCommit(
      inScopeFiles,
      `Tier-1 side-effects artifact ${sideEffectsRel} is too short ` +
        `(${sideEffectsContent.trim().length} chars, need ${MIN_ARTIFACT_CHARS}).`,
    );
  }
  // sha-match exactly as the existing artifact logic, when a sha is recorded.
  if (trace.artifactSha256) {
    const sha = crypto.createHash('sha256').update(sideEffectsContent).digest('hex');
    if (trace.artifactSha256 !== sha) {
      blockCommit(
        inScopeFiles,
        [
          `Tier-1 side-effects artifact ${sideEffectsRel} sha mismatch —`,
          `trace records ${String(trace.artifactSha256).slice(0, 12)}… but the staged bytes hash to ${sha.slice(0, 12)}….`,
          `If the current artifact is correct, set "artifactSha256": "${sha}" in the trace,`,
          're-stage BOTH the artifact and the trace, and commit fresh (do NOT amend).',
        ].join('\n'),
      );
    }
  }

  assertFrameworkGenerality(inScopeFiles, trace);
  assertOperatorSurfaceQuality(staged, trace);
  assertSelfActionDeclared(addedDiffText, inScopeFiles, trace);

  console.error(
    `[instar-dev-precommit] OK (Tier 1) — trace ${traceName} covers ${inScopeFiles.length} in-scope file(s), ` +
      `ELI16 ${eli16Rel} (${eli16Content.trim().length} chars) + side-effects ${sideEffectsRel} staged & verified. ` +
      `No converged spec required for Tier 1.`,
  );
  process.exit(0);
}
