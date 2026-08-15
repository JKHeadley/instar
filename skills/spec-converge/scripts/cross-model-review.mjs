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
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

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
    config: null,
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
    else if (a === '--config') out.config = args[++i];
    else fail(`Unknown arg: ${a}`);
  }
  if (!out.detectOnly && !out.spec) {
    fail(
      'Usage: cross-model-review.mjs --spec PATH [--context PATH ...] ' +
        '[--detect-only] [--hash-only] [--family ID] [--state-dir DIR] ' +
        '[--timeout-ms N] [--config PATH]',
    );
  }
  return out;
}

/**
 * MODULE resolution ladder (grok-build spec §8 round-9 — the SIXTH load-path-gap
 * instance, and the first on the MODULE load rather than the config read).
 *
 * The old single ROOT-relative import (`<ROOT>/dist/core/crossModelReviewer.js`)
 * is correct in a checkout/published package, where ROOT is the instar package
 * root. It is UNREACHABLE at the migrator's own delivery target: the installed
 * copy lives at `<agent home>/.claude/skills/spec-converge/scripts/`, so ROOT is
 * `<agent home>/.claude` — and `dist/` is structurally never installed there
 * (`.claude/` carries `skills/`, `scripts/`, `src/` only). Every installed copy
 * therefore exited 1 BEFORE any config resolution ran, which made the §11
 * migration-parity claim false at its delivery point.
 *
 * The fix mirrors §8's config ladder rather than shipping a duplicate build
 * artifact: resolve the module by first-hit-wins across the real execution
 * contexts, and surface the winner (`resolvedModulePath`) so a future dead
 * source is observable instead of silent.
 */
function moduleCandidates() {
  const rel = path.join('dist', 'core', 'crossModelReviewer.js');
  const out = [];
  const push = (p) => {
    if (p && !out.includes(p)) out.push(p);
  };
  // (1) checkout / published package: the skill ships inside the instar package,
  //     so the package's own dist sits beside `skills/` at ROOT.
  push(path.join(ROOT, rel));
  // (2) installed-into-`.claude` copy: ROOT is `<agent home>/.claude`, which has
  //     no dist — resolve the agent's REAL instar install one level up.
  const home = path.resolve(ROOT, '..');
  push(path.join(home, '.instar', 'shadow-install', 'node_modules', 'instar', rel));
  push(path.join(home, 'node_modules', 'instar', rel));
  // (3) ordinary node resolution from this script upward (covers a global or
  //     hoisted install neither of the above named).
  try {
    push(createRequire(import.meta.url).resolve('instar/dist/core/crossModelReviewer.js'));
  } catch {
    /* not resolvable from here — the explicit candidates above still apply */
  }
  return out;
}

async function loadModule() {
  const tried = moduleCandidates();
  const hit = tried.find((p) => fs.existsSync(p));
  if (!hit) {
    fail(
      'crossModelReviewer module not found. In an instar checkout run `pnpm build` ' +
        '(or `npm run build`) first; in an installed agent home the module comes from ' +
        'the instar package. Tried:\n  ' +
        tried.join('\n  '),
    );
  }
  const mod = await import(pathToFileURL(hit).href);
  return { mod, resolvedModulePath: hit };
}

/**
 * Resolve a `--spec` / `--context` path — CWD-FIRST, ROOT as fallback
 * (round-10 integration: the SEVENTH load-path-gap instance, and the same
 * class as the module load one layer over).
 *
 * `path.resolve(ROOT, rel)` alone is correct only in a checkout. For the
 * INSTALLED copy, ROOT is `<agent home>/.claude`, a tree that structurally has
 * no `docs/` — so the documented relative invocation
 * (`--spec docs/specs/foo.md`, run from the repo) exited 1 with "File not
 * found" at the migrator's own delivery target, defeating BOTH consumers the
 * wrapper exists for: the `--hash-only` delta-gate and the review run itself.
 * An absolute path masked it, which is why round 9's live check missed this.
 *
 * CWD first is the right precedence: the caller names a path relative to the
 * repo they are reviewing, which is the process's cwd — never relative to
 * wherever the script happens to be installed.
 */
function resolveRepoFile(rel) {
  if (path.isAbsolute(rel)) return fs.existsSync(rel) ? rel : null;
  for (const base of [process.cwd(), ROOT]) {
    const abs = path.resolve(base, rel);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

function readRepoFile(rel) {
  const abs = resolveRepoFile(rel);
  if (!abs) {
    fail(
      `File not found: ${rel} (tried cwd ${process.cwd()} then script root ${ROOT})`,
    );
  }
  return fs.readFileSync(abs, 'utf-8');
}

/**
 * Read the minimal reviewer config the module needs (REVIEWER-DOOR-REWIRING
 * §1.5): the developmentAgent gate flag + the `specConverge.reviewers` block, so
 * the Anthropic clean-door family resolves live-on-dev / dark-fleet. Best-effort:
 * a missing/unparseable `.instar/config.json` ⇒ `{}` ⇒ fleet-dark (byte-identical
 * `[codex, gemini]`). `.instar/config.json` is machine-local (no config
 * replication in instar) — enabling the family is a per-machine edit.
 */
/**
 * Resolve the agent's REAL `.instar/config.json` (grok-build spec §8 round-8 —
 * the FIFTH load-path-gap instance: the old ROOT-relative read pointed at a
 * location that exists in NO real execution context — worktrees carry no
 * config.json, the dev checkout carries none, and the installed `.claude`
 * skill copy's ROOT resolves to `<root>/.claude` where `.instar/` structurally
 * never exists; the agent's real config lives at the AGENT HOME, above all of
 * those). Resolution order, first hit wins:
 *   1. explicit `--config <path>` flag
 *   2. `INSTAR_CONFIG_PATH` env
 *   3. cwd walk-up: nearest `<dir>/.instar/config.json` from cwd to fs root
 *      (a worktree/dev checkout under the agent home lands on the agent's
 *      real config; a checkout carrying its own config.json wins closer-first)
 *   4. legacy ROOT-relative (kept last for any caller that relied on it)
 * Returns { path: string|null } — null means none-found (fleet-dark, {}).
 */
/**
 * AUTHORSHIP GUARD (round-9 security): a candidate `.instar/config.json`
 * that is GIT-TRACKED by its surrounding checkout is repo-authored bytes —
 * a branch under review could commit one and open the reviewer door (and
 * the developmentAgent gate) with content, not an operator act. Such a
 * candidate is SKIPPED with one loud line and the walk-up continues. An
 * UNTRACKED/ignored config inside a git repo is operator/agent-authored
 * local state and stays valid (an agent HOME can itself be a git repo —
 * a blanket skip-checkouts rule would over-block it). If the trackedness
 * check itself fails (no git binary, git error), the candidate is skipped
 * — the safe direction is dark, and the explicit `--config` /
 * `INSTAR_CONFIG_PATH` rungs (same-principal) bypass this guard entirely.
 */
function isRepoAuthoredConfig(candidate) {
  const repoDir = path.dirname(path.dirname(candidate)); // <dir>/.instar/config.json → <dir>
  // Cheap pre-check: outside any checkout (`.git` file or dir absent up the
  // tree from the candidate's dir) there is nothing to guard. `git -C`
  // handles worktrees (where .git is a file) natively below.
  let probe = repoDir;
  let inRepo = false;
  for (;;) {
    if (fs.existsSync(path.join(probe, '.git'))) { inRepo = true; break; }
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  if (!inRepo) return false;
  try {
    const out = execFileSync(
      'git',
      ['-C', repoDir, 'ls-files', '--', '.instar/config.json'],
      { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return out.trim().length > 0; // tracked ⇒ repo-authored ⇒ refuse
  } catch {
    return true; // unverifiable authorship ⇒ refuse the candidate (dark-safe)
  }
}

function acceptCandidate(candidate) {
  if (!isRepoAuthoredConfig(candidate)) return true;
  console.error(
    `[cross-model-review] checkout-local config ignored (git-tracked = repo-authored, ` +
      `not an operator act): ${candidate} — operator config must live outside the ` +
      `checkout; use --config/INSTAR_CONFIG_PATH to point into one deliberately`,
  );
  return false;
}

function resolveReviewerConfigPath(explicitPath) {
  if (explicitPath) return { path: explicitPath };
  if (process.env.INSTAR_CONFIG_PATH) return { path: process.env.INSTAR_CONFIG_PATH };
  let dir = process.cwd();
  for (;;) {
    const candidate = path.join(dir, '.instar', 'config.json');
    if (fs.existsSync(candidate) && acceptCandidate(candidate)) return { path: candidate };
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const legacy = path.join(ROOT, '.instar', 'config.json');
  if (fs.existsSync(legacy) && acceptCandidate(legacy)) return { path: legacy };
  return { path: null };
}

function loadReviewerConfig(explicitPath) {
  const resolved = resolveReviewerConfigPath(explicitPath);
  try {
    if (!resolved.path || !fs.existsSync(resolved.path)) {
      return { config: {}, resolvedConfigPath: null };
    }
    const cfg = JSON.parse(fs.readFileSync(resolved.path, 'utf-8'));
    const out = {};
    if (typeof cfg.developmentAgent === 'boolean') out.developmentAgent = cfg.developmentAgent;
    if (cfg.specConverge && typeof cfg.specConverge === 'object') out.specConverge = cfg.specConverge;
    // grok-build reviewer dark-ship gate (grok-build spec §8 round-7): the
    // enabledFrameworks opt-in must reach detection through THIS loader —
    // without it the gate is a dead switch that refuses forever.
    if (Array.isArray(cfg.enabledFrameworks)) out.enabledFrameworks = cfg.enabledFrameworks;
    // §2.1 rung 2 must reach the LIVE lane too (round-12): the persisted
    // `sessions.frameworkBinaryPaths['grok-build']` relocates every other lane,
    // and the reviewer used to resolve independently — so a configured install
    // plus a stale conventional one meant the reviewer spawned a different
    // binary than the rest of instar.
    const configuredGrok = cfg?.sessions?.frameworkBinaryPaths?.['grok-build'];
    if (typeof configuredGrok === 'string' && configuredGrok) out.grokConfiguredPath = configuredGrok;
    return { config: out, resolvedConfigPath: resolved.path };
  } catch {
    return { config: {}, resolvedConfigPath: resolved.path };
  }
}

async function main() {
  const { spec, context, detectOnly, hashOnly, family, stateDir, timeoutMs, config } = parseArgs();
  const { mod, resolvedModulePath } = await loadModule();
  // Config-gate the Anthropic clean-door family (§1.5). Absent config ⇒ fleet-dark.
  const { config: reviewerConfig, resolvedConfigPath } = loadReviewerConfig(config);

  // ── --hash-only: the delta-gating hash of the spec's reviewable body ──
  if (hashOnly) {
    if (!spec) fail('--hash-only requires --spec PATH');
    const specMarkdown = readRepoFile(spec);
    process.stdout.write(JSON.stringify({ hash: mod.hashSpecReviewableBody(specMarkdown) }) + '\n');
    process.exit(0);
  }

  // ── --detect-only: report ALL available families (Piece 3) ──
  if (detectOnly) {
    const detectInputs = {
      ...(Array.isArray(reviewerConfig.enabledFrameworks)
        ? { enabledFrameworks: reviewerConfig.enabledFrameworks }
        : {}),
      ...(reviewerConfig.grokConfiguredPath
        ? { grokConfiguredPath: reviewerConfig.grokConfiguredPath }
        : {}),
    };
    const all = mod.detectAllCrossModelReviewers(detectInputs, reviewerConfig);
    // Back-compat: keep the old single-framework fields (first-match shape).
    const first = mod.detectCrossModelReviewer(detectInputs, reviewerConfig);
    // Per-family REFUSAL reasons (round-8): 'grok-not-enabled' vs
    // 'grok-binary-missing' is the difference between "config never reached
    // detection" (the dead-switch signature) and an honest availability gap.
    const inactive = [];
    for (const entry of mod.resolveActiveReviewerFrameworks(reviewerConfig)) {
      const d = entry.detect(detectInputs);
      if (!d.available) inactive.push({ framework: entry.id, reason: d.reason ?? 'unknown' });
    }
    const report = {
      available: all.length > 0,
      frameworks: all,
      inactive,
      // Surface WHERE config came from (round-8: a mis-resolution must be
      // visible instead of silently reading {} — the dead-switch signature).
      resolvedConfigPath: resolvedConfigPath ?? 'none-found',
      // Same reason, for the MODULE carrier (round-9): which of the ladder's
      // candidates actually served the built reviewer module.
      resolvedModulePath,
      ...(first.framework ? { framework: first.framework } : {}),
      ...(first.model ? { model: first.model } : {}),
      ...(first.reason ? { reason: first.reason } : {}),
    };
    // Record the activation observation into the durable standing-framework
    // baseline when a state dir was provided. A record failure is surfaced in
    // the JSON (fail-loud), never silently swallowed — a missing baseline
    // would quietly weaken the externals-mandatory check. Iterate the ACTIVE
    // set so a config-disabled claude family is not recorded as present.
    if (stateDir) {
      const frameworks = {};
      for (const entry of mod.resolveActiveReviewerFrameworks(reviewerConfig)) {
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
    // Config gate (§1.5): a trusted-but-disabled family (the claude clean-door
    // family on the fleet) is refused here — trusted-egress ≠ enabled.
    const active = mod.resolveActiveReviewerFrameworks(reviewerConfig);
    familyEntry = active.find((f) => f.id === family) ?? null;
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

  const familyDetectInputs = {
    ...(Array.isArray(reviewerConfig.enabledFrameworks)
      ? { enabledFrameworks: reviewerConfig.enabledFrameworks }
      : {}),
    ...(reviewerConfig.grokConfiguredPath
      ? { grokConfiguredPath: reviewerConfig.grokConfiguredPath }
      : {}),
  };
  const detection = familyEntry
    ? familyEntry.detect(familyDetectInputs)
    : mod.detectCrossModelReviewer(familyDetectInputs, reviewerConfig);

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
        // Per-family timeout (REVIEWER-DOOR-REWIRING §3.2 / D6): an explicit
        // `--timeout-ms` wins; otherwise resolve this family's budget from the
        // `specConverge.reviewers.timeoutMs` knob (absent ⇒ today's 120s).
        timeoutMs: Number.isFinite(timeoutMs)
          ? timeoutMs
          : mod.resolveReviewerTimeoutMs(reviewerConfig, familyEntry.id),
        detectionOverride: detection,
        reviewerConfig,
      })
    : await mod.runCrossModelReview({
        assembled,
        config: reviewerConfig,
        // Third detect flow (security round-8): the back-compat default path
        // must carry the same inputs as detect-all and per-family.
        ...(Array.isArray(reviewerConfig.enabledFrameworks)
          ? { detectInputs: { enabledFrameworks: reviewerConfig.enabledFrameworks } }
          : {}),
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
