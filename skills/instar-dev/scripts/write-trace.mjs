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
 *     [--second-pass true|false|not-required] \
 *     [--reviewer-concurred true|false]
 *
 * The --spec argument records which spec (converged + approved) drove the
 * change. The pre-commit hook verifies the referenced spec has both
 * review-convergence and approved tags before allowing the commit.
 * Bootstrap commits (installing /instar-dev itself or /spec-converge itself)
 * may omit --spec; all other commits REQUIRE it.
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
  return out;
}

const { artifact, files, spec, secondPass, reviewerConcurred, buildSkill, reviewSkills, convergenceReport, convergenceIterations } = parseArgs();

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
const trace = {
  version: toolchain ? 3 : 2, // v3 only when enriched; readers ignore unknown fields either way
  sessionId: process.env.INSTAR_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID || 'unknown',
  timestamp,
  artifactPath: artifact,
  artifactSha256: crypto.createHash('sha256').update(artifactContent).digest('hex'),
  specPath: spec,
  coveredFiles: files.sort(),
  phase: 'complete',
  secondPass,
  reviewerConcurred,
  ...(toolchain ? { toolchain } : {}),
};

fs.writeFileSync(traceFile, JSON.stringify(trace, null, 2) + '\n');

console.log(path.relative(ROOT, traceFile));
