#!/usr/bin/env node
/**
 * cross-model-review.mjs — the thin script /spec-converge calls to run the
 * external (non-Claude) cross-model reviewer through the agent's own installed
 * codex CLI (Step B of the tiered development process,
 * docs/specs/codex-crossreview-stepB-spec.md).
 *
 * This is the REAL mechanism that replaces the never-built "/crossreview"
 * placeholder the skill prose referred to. It is a thin wrapper: all the
 * detection, prompt-assembly, provider invocation, and result parsing live in
 * the unit-tested `src/core/crossModelReviewer.ts` module (built to
 * `dist/core/crossModelReviewer.js`). This script only does the file I/O —
 * read the spec + referenced context docs from the repo and hand them to the
 * module — because codex runs read-only in an empty scratch dir with no repo
 * access, so context must be inlined before the spawn.
 *
 * Modes:
 *   --detect-only            Print detection JSON and exit (no spawn).
 *                            { available, frameworks: [...all available...],
 *                              framework?, model?, reason? } — the `frameworks`
 *                            array is the Piece-3 family-diverse collection;
 *                            the single-framework fields stay for back-compat.
 *                            With --state-dir <dir>, also records the
 *                            activation observation to the durable
 *                            framework-activation history (the standing-
 *                            framework baseline for the mandatory check).
 *   --hash-only              Print { hash } — sha256 of the spec's reviewable
 *                            body (frontmatter-stripped, CRLF-normalized) for
 *                            the skill's delta-gating. Requires --spec.
 *   (default)                Detect; if available, assemble the prompt + run
 *                            the review; print the ReviewerResult JSON. With
 *                            --family <id>, run through THAT framework
 *                            specifically (must be on the trusted first-party
 *                            allowlist — spec text is never sent to a custom/
 *                            base-URL endpoint; pi-cli is excluded by design).
 *
 * Usage:
 *   node skills/spec-converge/scripts/cross-model-review.mjs \
 *     --spec docs/specs/<slug>.md \
 *     [--context docs/foo.md --context docs/bar.md ...] \
 *     [--detect-only] [--state-dir .instar] \
 *     [--hash-only] \
 *     [--family codex-cli|gemini-cli] \
 *     [--timeout-ms 120000]
 *
 * Output: a single JSON object on stdout (machine-readable for the skill).
 *   On detect-only: the detection JSON above.
 *   On hash-only:   { hash }.
 *   On full run:    the ReviewerResult ({ status, framework?, model?, verdict?,
 *                   findings?, reason?, flag }).
 *
 * Exit codes:
 *   0 — ran successfully (INCLUDING the unavailable/degraded outcomes —
 *       those are valid disclosed states, never a failure of this script).
 *   1 — usage error or the spec/template/context file could not be read.
 *
 * NEVER blocks convergence: an unavailable or degraded result is printed and
 * exit 0. The skill reads `status` + `flag` to decide what to record.
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('../../..', import.meta.url).pathname);
const REVIEWER_TEMPLATE_PATH = path.join(
  ROOT,
  'skills',
  'spec-converge',
  'templates',
  'reviewer-cross-model.md',
);

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    spec: null,
    context: [],
    detectOnly: false,
    hashOnly: false,
    family: null,
    stateDir: null,
    timeoutMs: null,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--spec') out.spec = args[++i];
    else if (a === '--context') out.context.push(args[++i]);
    else if (a === '--detect-only') out.detectOnly = true;
    else if (a === '--hash-only') out.hashOnly = true;
    else if (a === '--family') out.family = args[++i];
    else if (a === '--state-dir') out.stateDir = args[++i];
    else if (a === '--timeout-ms') out.timeoutMs = parseInt(args[++i], 10);
    else fail(`Unknown arg: ${a}`);
  }
  if (!out.detectOnly && !out.spec) {
    fail(
      'Usage: cross-model-review.mjs --spec PATH [--context PATH ...] ' +
        '[--detect-only] [--hash-only] [--family ID] [--state-dir DIR] [--timeout-ms N]',
    );
  }
  return out;
}

async function loadModule() {
  // Import the built module. The dev tooling runs in the instar repo where
  // `pnpm build` has produced dist/. (If dist is stale, rebuild first.)
  const modUrl = new URL('../../../dist/core/crossModelReviewer.js', import.meta.url);
  if (!fs.existsSync(modUrl)) {
    fail(
      'dist/core/crossModelReviewer.js not found. Run `pnpm build` (or `npm run build`) ' +
        'before invoking the cross-model reviewer.',
    );
  }
  return import(modUrl.href);
}

function readRepoFile(rel) {
  const abs = path.resolve(ROOT, rel);
  if (!fs.existsSync(abs)) fail(`File not found: ${rel}`);
  return fs.readFileSync(abs, 'utf-8');
}

async function main() {
  const { spec, context, detectOnly, hashOnly, family, stateDir, timeoutMs } = parseArgs();
  const mod = await loadModule();

  // ── --hash-only: the delta-gating hash of the spec's reviewable body ──
  if (hashOnly) {
    if (!spec) fail('--hash-only requires --spec PATH');
    const specMarkdown = readRepoFile(spec);
    process.stdout.write(JSON.stringify({ hash: mod.hashSpecReviewableBody(specMarkdown) }) + '\n');
    process.exit(0);
  }

  // ── --detect-only: report ALL available families (Piece 3) ──
  if (detectOnly) {
    const all = mod.detectAllCrossModelReviewers();
    // Back-compat: keep the old single-framework fields (first-match shape).
    const first = mod.detectCrossModelReviewer();
    const report = {
      available: all.length > 0,
      frameworks: all,
      ...(first.framework ? { framework: first.framework } : {}),
      ...(first.model ? { model: first.model } : {}),
      ...(first.reason ? { reason: first.reason } : {}),
    };
    // Record the activation observation into the durable standing-framework
    // baseline when a state dir was provided. A record failure is surfaced in
    // the JSON (fail-loud), never silently swallowed — a missing baseline
    // would quietly weaken the externals-mandatory check.
    if (stateDir) {
      const frameworks = {};
      for (const entry of mod.SUPPORTED_REVIEWER_FRAMEWORKS) {
        frameworks[entry.id] = all.some((d) => d.framework === entry.id);
      }
      try {
        mod.recordFrameworkActivationObservation(stateDir, { frameworks });
        report.activationRecorded = true;
      } catch (err) {
        report.activationRecorded = false;
        report.activationRecordError =
          err instanceof Error ? err.message.slice(0, 200) : String(err);
      }
    }
    process.stdout.write(JSON.stringify(report) + '\n');
    process.exit(0);
  }

  // ── full run ──
  // --family: run through ONE specific framework. Allowlist-gated — the full
  // spec text is never sent to a custom/base-URL endpoint (pi-cli excluded).
  let familyEntry = null;
  if (family) {
    if (!mod.isTrustedReviewerFramework(family)) {
      process.stdout.write(
        JSON.stringify({
          status: 'unavailable',
          reason: 'untrusted-framework',
          flag: 'cross-model-review: unavailable',
        }) + '\n',
      );
      process.exit(0);
    }
    familyEntry = mod.SUPPORTED_REVIEWER_FRAMEWORKS.find((f) => f.id === family) ?? null;
    if (!familyEntry) {
      process.stdout.write(
        JSON.stringify({
          status: 'unavailable',
          reason: 'no-supported-framework',
          flag: 'cross-model-review: unavailable',
        }) + '\n',
      );
      process.exit(0);
    }
  }

  const detection = familyEntry ? familyEntry.detect() : mod.detectCrossModelReviewer();

  // Unavailable → print the unavailable flag, exit 0. Never block.
  if (!detection.available) {
    const flag = mod.buildCrossModelFlag('unavailable', detection.reason);
    process.stdout.write(
      JSON.stringify({ status: 'unavailable', reason: detection.reason, flag: flag.flag }) + '\n',
    );
    process.exit(0);
  }

  // Available → assemble the prompt from disk + run the review.
  const reviewerTemplate = fs.readFileSync(REVIEWER_TEMPLATE_PATH, 'utf-8');
  const specMarkdown = readRepoFile(spec);
  const contextDocs = context.map((rel) => ({ path: rel, content: readRepoFile(rel) }));

  const assembled = mod.assembleReviewerPrompt({
    reviewerTemplate,
    specMarkdown,
    specPath: spec,
    context: contextDocs,
  });

  const result = familyEntry
    ? await familyEntry.review({
        promptText: assembled.promptText,
        timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : mod.REVIEW_TIMEOUT_MS,
        detectionOverride: detection,
      })
    : await mod.runCrossModelReview({
        assembled,
        ...(Number.isFinite(timeoutMs) ? { timeoutMs } : {}),
      });

  // Surface truncation in the emitted result so the skill/report can note it.
  process.stdout.write(JSON.stringify({ ...result, promptTruncated: assembled.truncated }) + '\n');
  process.exit(0);
}

main().catch((err) => {
  // Even an unexpected crash must not block convergence: emit a degraded
  // result and exit 0 so the skill folds in internal-only + records degraded.
  const reason = err instanceof Error ? err.message.slice(0, 200) : String(err);
  process.stdout.write(
    JSON.stringify({
      status: 'degraded',
      reason: `driver-error: ${reason}`,
      flag: `cross-model-review: codex-cli (degraded: driver-error)`,
    }) + '\n',
  );
  process.exit(0);
});
