#!/usr/bin/env node
/**
 * write-trace.mjs — emit an instar-dev trace file.
 *
 * Called by the /instar-dev skill at Phase 6 (commit-time) after the
 * side-effects artifact is complete. The pre-commit hook reads the trace
 * to verify the commit came through the skill.
 *
 * Usage:
 *   node skills/instar-dev/scripts/write-trace.mjs \
 *     --artifact upgrades/side-effects/<slug>.md \
 *     --files "src/a.ts,src/b.ts,tests/x.test.ts" \
 *     [--spec docs/specs/<slug>.md] \
 *     [--tier 1|2|3] \
 *     [--tier-reasoning "<one or two sentences>"] \
 *     [--eli16-path docs/specs/<slug>.eli16.md] \
 *     [--side-effects-path upgrades/side-effects/<slug>.md] \
 *     [--second-pass true|false|not-required] \
 *     [--reviewer-concurred true|false]
 *
 * The --spec argument records which spec (converged + approved) drove the
 * change. The pre-commit hook verifies the referenced spec has both
 * review-convergence and approved tags before allowing the commit.
 * Bootstrap commits (installing /instar-dev itself or /spec-converge itself)
 * may omit --spec; all other commits REQUIRE it.
 *
 * Tier declaration (Step A of the Tiered Development Process,
 * docs/specs/tier-classifier-and-tier1-path-spec.md): the agent DECLARES the
 * change's tier so the gate can enforce the chosen tier's requirement set.
 *   - --tier 1 → a Tier-1 (small / low-risk) change. The trace carries
 *     `tier: 1` + `eli16Path` + `sideEffectsPath` and NO `specPath` — a Tier-1
 *     commit needs an ELI16 + side-effects artifact + green tests/lint, but no
 *     pre-approved converged spec. `--spec` is therefore OPTIONAL when --tier 1.
 *   - --tier 2|3 (or omitted) → the existing full requirement set; `--spec`
 *     (a converged + approved spec) is required exactly as before.
 * No tier declaration → the gate defaults to Tier 2 (back-compatible).
 *
 * The trace is written to .instar/instar-dev-traces/<timestamp>-<slug>.json.
 * Trace files are gitignored (runtime state, not source).
 *
 * Exit codes:
 *   0 — trace written, prints its path to stdout
 *   1 — usage error or artifact missing
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    artifact: null, files: [], spec: null, secondPass: 'not-required', reviewerConcurred: null,
    // Tier declaration (Step A — Tiered Development Process). All OPTIONAL; when
    // omitted the gate defaults to Tier 2 (back-compatible). For --tier 1 the
    // trace carries tier + eli16Path + sideEffectsPath and no specPath.
    tier: null, tierReasoning: null, eli16Path: null, sideEffectsPath: null,
    // v3 toolchain enrichment (Failure-Learning Loop §4.1) — all OPTIONAL, caller-passed
    // literals (O(1), no discovery/git/parse at commit time). Omitted fields → omitted
    // from the toolchain block; a gather failure → omit, never block the commit.
    buildSkill: null, reviewSkills: null, convergenceReport: null, convergenceIterations: null,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--artifact') out.artifact = args[++i];
    else if (a === '--files') out.files = args[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--spec') out.spec = args[++i];
    else if (a === '--tier') out.tier = parseInt(args[++i], 10);
    else if (a === '--tier-reasoning') out.tierReasoning = args[++i];
    else if (a === '--eli16-path') out.eli16Path = args[++i];
    else if (a === '--side-effects-path') out.sideEffectsPath = args[++i];
    else if (a === '--second-pass') out.secondPass = args[++i];
    else if (a === '--reviewer-concurred') out.reviewerConcurred = args[++i] === 'true';
    else if (a === '--build-skill') out.buildSkill = args[++i];
    else if (a === '--review-skills') out.reviewSkills = args[++i]; // "name:outcome[:iterations],..."
    else if (a === '--convergence-report') out.convergenceReport = args[++i];
    else if (a === '--convergence-iterations') out.convergenceIterations = parseInt(args[++i], 10);
    else {
      console.error(`Unknown arg: ${a}`);
      process.exit(1);
    }
  }
  if (!out.artifact) {
    console.error('Missing --artifact');
    process.exit(1);
  }
  if (out.files.length === 0) {
    console.error('Missing --files');
    process.exit(1);
  }
  if (out.tier != null && ![1, 2, 3].includes(out.tier)) {
    console.error(`Invalid --tier ${out.tier}: must be 1, 2, or 3`);
    process.exit(1);
  }
  // A Tier-1 trace must carry its own ELI16 + side-effects path (no converged
  // spec). The side-effects path defaults to the --artifact (the sha is computed
  // from that same file), but the ELI16 path is required and has no default.
  if (out.tier === 1) {
    if (!out.sideEffectsPath) out.sideEffectsPath = out.artifact;
    if (!out.eli16Path) {
      console.error('A Tier-1 trace requires --eli16-path (the request ELI16 overview).');
      process.exit(1);
    }
  }
  return out;
}

const {
  artifact, files, spec, tier, tierReasoning, eli16Path, sideEffectsPath,
  secondPass, reviewerConcurred, buildSkill, reviewSkills, convergenceReport, convergenceIterations,
} = parseArgs();

/**
 * Build the v3 `toolchain` block (Failure-Learning Loop §4.1). Toolchain fields
 * are CLAIMS until cheaply corroborated:
 *  - buildSkill.version is pinned to a content hash of the named skill's SKILL.md
 *    (server-derived, not caller-asserted) → verified:true. If the skill dir
 *    isn't found, the caller's name is recorded as claimed (verified:false).
 *  - convergence.verified is true only if the referenced report file exists.
 * Returns undefined when no toolchain inputs were supplied (→ `unknown` bucket).
 * Wrapped fail-open: any error → undefined, never blocks the commit.
 */
function buildToolchain() {
  try {
    if (!buildSkill && !reviewSkills && !convergenceReport) return undefined;
    const tc = {};
    if (buildSkill) {
      const skillMd = path.join(ROOT, 'skills', buildSkill, 'SKILL.md');
      if (fs.existsSync(skillMd)) {
        const ver = crypto.createHash('sha256').update(fs.readFileSync(skillMd)).digest('hex').slice(0, 12);
        tc.buildSkill = { name: buildSkill, version: ver, verified: true };
      } else {
        tc.buildSkill = { name: buildSkill, version: null, verified: false };
      }
    }
    if (reviewSkills) {
      tc.reviewSkills = reviewSkills.split(',').map((s) => s.trim()).filter(Boolean).map((entry) => {
        const [name, outcome, iterations] = entry.split(':');
        const r = { name, outcome: outcome || null, verified: false };
        if (iterations != null && iterations !== '') r.iterations = parseInt(iterations, 10);
        return r;
      });
    }
    if (convergenceReport) {
      const exists = fs.existsSync(path.resolve(ROOT, convergenceReport));
      tc.convergence = {
        reportPath: convergenceReport,
        iterations: Number.isFinite(convergenceIterations) ? convergenceIterations : null,
        verified: exists, // true only if the report artifact actually exists
      };
    }
    return tc;
  } catch {
    return undefined; // fail-open: never block a commit on enrichment
  }
}

const artifactPath = path.resolve(ROOT, artifact);
if (!fs.existsSync(artifactPath)) {
  console.error(`Artifact not found: ${artifact}`);
  process.exit(1);
}
const artifactContent = fs.readFileSync(artifactPath, 'utf8');
if (artifactContent.trim().length < 200) {
  console.error(`Artifact appears empty or stub (${artifactContent.trim().length} chars): ${artifact}`);
  process.exit(1);
}

const slug = path.basename(artifact, path.extname(artifact));
const timestamp = new Date().toISOString();
const traceId = crypto.randomBytes(4).toString('hex');
const traceDir = path.join(ROOT, '.instar', 'instar-dev-traces');
fs.mkdirSync(traceDir, { recursive: true });

const traceFile = path.join(traceDir, `${timestamp.replace(/[:.]/g, '-')}-${slug}-${traceId}.json`);
const toolchain = buildToolchain();
const isTier1 = tier === 1;

/**
 * Duplicate-build guard (docs/specs/duplicate-build-guard.md §3.4): fold the
 * build-start check's recorded verdict + disposition (the worktree stub at
 * .instar/dup-build-check.json, written by scripts/lib/duplicate-build-check.mjs
 * and/or the build-start PreToolUse gate) into the trace as the
 * `duplicateBuildCheck` field the precommit PRESENCE backstop looks for.
 * Fail-open: a missing/unreadable stub simply omits the field — the backstop
 * (not this writer) decides what that means for the commit.
 */
function readDuplicateBuildCheck() {
  try {
    const stubPath = path.join(ROOT, '.instar', 'dup-build-check.json');
    if (!fs.existsSync(stubPath)) return undefined;
    const stub = JSON.parse(fs.readFileSync(stubPath, 'utf8'));
    if (!stub || typeof stub.verdict !== 'string') return undefined;
    const d = stub.disposition && typeof stub.disposition === 'object' ? stub.disposition : {};
    return {
      verdict: stub.verdict,
      cause: stub.cause ?? null,
      ...(Array.isArray(stub.causes) ? { causes: stub.causes } : {}),
      decision: d.decision ?? null,
      reason: d.reason ?? null,
      acknowledgedEvidenceIds: Array.isArray(d.acknowledgedEvidenceIds) ? d.acknowledgedEvidenceIds : [],
      ...(stub.checkedAt ? { checkedAt: stub.checkedAt } : {}),
      ...(stub.specSlug ? { specSlug: stub.specSlug } : {}),
    };
  } catch {
    return undefined; // fail-open: never block trace-writing on the guard
  }
}
const duplicateBuildCheck = readDuplicateBuildCheck();

const trace = {
  version: toolchain ? 3 : 2, // v3 only when enriched; readers ignore unknown fields either way
  sessionId: process.env.INSTAR_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID || 'unknown',
  timestamp,
  artifactPath: artifact,
  artifactSha256: crypto.createHash('sha256').update(artifactContent).digest('hex'),
  // A Tier-1 trace carries NO specPath (it ships an ELI16 + side-effects instead
  // of a converged + approved spec). Tier 2+/no-tier keep the existing specPath.
  ...(isTier1 ? {} : { specPath: spec }),
  coveredFiles: files.sort(),
  phase: 'complete',
  // Tier declaration (Step A). Emitted only when the agent declared a tier so an
  // undeclared trace round-trips byte-identically to the pre-Step-A shape.
  ...(tier != null ? { tier } : {}),
  ...(tierReasoning != null ? { tierReasoning } : {}),
  ...(isTier1 ? { eli16Path, sideEffectsPath } : {}),
  secondPass,
  reviewerConcurred,
  ...(toolchain ? { toolchain } : {}),
  // Duplicate-build guard §3.4 — omitted when no stub exists so pre-guard
  // traces round-trip byte-identically.
  ...(duplicateBuildCheck ? { duplicateBuildCheck } : {}),
};

fs.writeFileSync(traceFile, JSON.stringify(trace, null, 2) + '\n');

console.log(path.relative(ROOT, traceFile));
