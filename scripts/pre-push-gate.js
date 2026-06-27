#!/usr/bin/env node
/**
 * Fast pre-push gate — runs BEFORE the test suite to catch common issues early.
 *
 * Checks:
 *   1. NEXT.md exists and has required sections (saves ~4min if missing)
 *   2. package.json version was incremented from the latest published guide
 *
 * This is intentionally lightweight — no imports from src/, no TypeScript,
 * no test framework. Just reads files and exits.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateGuideContent } from './upgrade-guide-validator.mjs';
import { assembleNextMd, gatherFragmentInputs, hasInternalOnlyMarker } from './assemble-next-md.mjs';
import { isReleaseRelevant } from './release-relevant-paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const upgradesDir = path.join(ROOT, 'upgrades');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
const version = pkg.version;

// Section list kept here only for the "no upgrade guide found" error
// message. The full per-section validation now flows through
// validateGuideContent (which has its own canonical REQUIRED_SECTIONS).
const REQUIRED_SECTIONS = [
  '## What Changed',
  '## What to Tell Your User',
  '## Summary of New Capabilities',
];

let errors = [];
let warnings = [];

// ── 1. Release-note validation (fragment-aware) ───────────────────────
//
// Release notes are authored as per-PR FRAGMENTS in upgrades/next/<slug>.md
// (so concurrent PRs never collide on a single shared NEXT.md). The pre-push
// gate validates the ASSEMBLED result — fragments folded together with any
// legacy upgrades/NEXT.md — so a PR that ships only a fragment passes the same
// section/content checks the publish gate enforces. We assemble in-memory and
// NEVER write NEXT.md to disk here: the PR keeps its fragment, not a generated
// guide. publish.yml runs the real assemble step before publishing.

const versionedGuidePath = path.join(upgradesDir, `${version}.md`);
const versionedGuideExists = fs.existsSync(versionedGuidePath);

// Assemble fragments + legacy NEXT.md in-memory.
let assembledContent = null;
let assembleError = null;
{
  const { inputs } = gatherFragmentInputs(upgradesDir);
  if (inputs.length > 0) {
    try {
      assembledContent = assembleNextMd(inputs);
    } catch (err) {
      assembleError = err instanceof Error ? err.message : String(err);
    }
  }
}

// The active guide for validation: the assembled fragments/NEXT.md (in-flight
// release notes) win when present; otherwise fall back to the versioned guide
// (post-release-cut state, when NEXT.md has been renamed and no new fragment is
// staged yet).
const activeGuideLabel = assembledContent !== null
  ? 'assembled release notes (upgrades/next/*.md + NEXT.md)'
  : (versionedGuideExists ? `${version}.md` : null);

if (assembleError) {
  // A malformed fragment must fail the push loudly — the same loud failure the
  // publish workflow would hit.
  errors.push(`Release-note fragments are malformed: ${assembleError}`);
} else if (assembledContent !== null) {
  // Run the shared validator (same checks as check-upgrade-guide.js at publish
  // time). This catches the publish-blocker bugs that previously slipped past
  // pre-push: inline code / fenced blocks / camelCase config keys in "What to
  // Tell Your User", and missing "## Evidence" when "What Changed" claims a fix.
  // Before this gate, those defects only surfaced as silently-dropped publish
  // runs on main — agents never received the merged code.
  const validatorIssues = validateGuideContent(assembledContent);
  for (const issue of validatorIssues) {
    errors.push(`${activeGuideLabel}: ${issue}`);
  }
} else if (versionedGuideExists) {
  const content = fs.readFileSync(versionedGuidePath, 'utf-8');
  const validatorIssues = validateGuideContent(content);
  for (const issue of validatorIssues) {
    errors.push(`${version}.md: ${issue}`);
  }
} else {
  errors.push(
    `No upgrade guide found. Create a release-note fragment ` +
    `upgrades/next/<slug>.md (or legacy upgrades/NEXT.md) with sections: ${REQUIRED_SECTIONS.join(', ')}`
  );
}

// ── 2. Version increment check ────────────────────────────────────────

// Find the latest published version from existing upgrade guides
const publishedVersions = fs.existsSync(upgradesDir)
  ? fs.readdirSync(upgradesDir)
      .map(f => /^(\d+)\.(\d+)\.(\d+)\.md$/.exec(f))
      .filter(Boolean)
      .map(m => ({
        str: `${m[1]}.${m[2]}.${m[3]}`,
        parts: [+m[1], +m[2], +m[3]],
      }))
      .sort((a, b) => {
        for (let i = 0; i < 3; i++) {
          if (a.parts[i] !== b.parts[i]) return a.parts[i] - b.parts[i];
        }
        return 0;
      })
  : [];

const latestPublished = publishedVersions.length > 0
  ? publishedVersions[publishedVersions.length - 1]
  : null;

if (latestPublished) {
  const [curMaj, curMin, curPatch] = version.split('.').map(Number);
  const [pubMaj, pubMin, pubPatch] = latestPublished.parts;

  if (curMaj === pubMaj && curMin === pubMin && curPatch === pubPatch) {
    warnings.push(
      `package.json version (${version}) matches the latest published guide (${latestPublished.str}). ` +
      `Did you forget to bump the version? Run: npm version patch|minor|major`
    );
  } else if (
    curMaj < pubMaj ||
    (curMaj === pubMaj && curMin < pubMin) ||
    (curMaj === pubMaj && curMin === pubMin && curPatch < pubPatch)
  ) {
    errors.push(
      `package.json version (${version}) is LOWER than the latest published guide (${latestPublished.str}). ` +
      `Version must be incremented, not decremented.`
    );
  }
}

// ── 3. Test file change check ─────────────────────────────────────────
// If source files changed, at least one test file should also change.
// This prevents shipping code changes without regression tests.

try {
  const { execSync } = await import('node:child_process');
  // Compute "what this PR changes" against its MERGE TARGET (main), not the
  // branch's own upstream (@{u}). Using @{u} breaks when a PR is updated by
  // MERGING main in (the no-force-push path): `@{u}...HEAD` then includes all of
  // main's already-shipped changes, producing false "src changed without a
  // release-note fragment" errors (which forced INSTAR_PRE_PUSH_SKIP=1 on merge-
  // updated PRs). A three-dot diff against main is the PR's TRUE diff in both the
  // normal-incremental and merge-from-main cases, and never UNDER-reports the
  // PR's own changes (merge-base of main and HEAD is the branch point).
  const pickRef = (cands) => {
    for (const r of cands) {
      try { execSync(`git rev-parse --verify --quiet ${r}`, { stdio: 'pipe', encoding: 'utf-8' }); return r; }
      catch { /* ref not present in this clone */ }
    }
    return null;
  };
  const remoteBranch = pickRef(['JKHeadley/main', 'origin/main', 'upstream/main', 'main'])
    || execSync('git rev-parse --abbrev-ref @{u} 2>/dev/null || echo origin/main', { encoding: 'utf-8' }).trim();
  const changedFiles = execSync(`git diff --name-only ${remoteBranch}...HEAD 2>/dev/null || git diff --name-only HEAD~1 2>/dev/null`, { encoding: 'utf-8' })
    .trim()
    .split('\n')
    .filter(Boolean);

  const srcChanges = changedFiles.filter(f => f.startsWith('src/') && f.endsWith('.ts'));
  const testChanges = changedFiles.filter(f => f.includes('tests/') && f.endsWith('.test.ts'));

  if (srcChanges.length > 0 && testChanges.length === 0) {
    warnings.push(
      `${srcChanges.length} source file(s) changed but no test files were added or modified. ` +
      `Every code change should include regression tests. Files changed:\n` +
      srcChanges.slice(0, 5).map(f => `      • ${f}`).join('\n') +
      (srcChanges.length > 5 ? `\n      • ...and ${srcChanges.length - 5} more` : '')
    );
  }

  // ── 3b. Release-fragment gate (#23: src change without a release note) ─
  // A shippable src/ change MUST carry a release-note fragment. publish.yml
  // SILENTLY skips the release when there is no upgrades/next/<slug>.md fragment
  // (and no upgrades/NEXT.md) — so the fix merges but never ships, with no
  // signal. Mirror of the src→tests check above. The "chore: release" cut commit
  // touches upgrades/ but not src/, so it never trips this. Bypass genuine WIP
  // with INSTAR_PRE_PUSH_SKIP=1.
  const fragmentChanges = changedFiles.filter(f =>
    f.startsWith('upgrades/next/') || f === 'upgrades/NEXT.md'
  );
  // Release-relevance is now the SHARED predicate (scripts/release-relevant-paths.mjs),
  // the same one the server-side Layer-1 PR gate uses — so "needs a release note?"
  // has one answer in both places. This BROADENS the old src/**.ts-only check to
  // also catch scripts/, .github/workflows/, package.json, and skill code/templates
  // (all of which ship behavior but previously slipped this local gate).
  const releaseRelevantChanges = changedFiles.filter(isReleaseRelevant);
  if (releaseRelevantChanges.length > 0 && fragmentChanges.length === 0) {
    errors.push(
      `${releaseRelevantChanges.length} release-relevant file(s) changed but no release-note fragment was added. ` +
      `Without upgrades/next/<slug>.md (or upgrades/NEXT.md), publish.yml SILENTLY SKIPS the ` +
      `release — your change would merge but never ship. Add a fragment describing the change:\n` +
      releaseRelevantChanges.slice(0, 5).map(f => `      • ${f}`).join('\n') +
      (releaseRelevantChanges.length > 5 ? `\n      • ...and ${releaseRelevantChanges.length - 5} more` : '')
    );
  }

  // ── 3c. Internal-only lane verification (objective gate) ──────────────
  // A release fragment marked <!-- internal-only --> may omit the user-facing
  // sections — the assembler auto-fills "None — internal" for an all-internal
  // release. That is ONLY valid for changes with no shipped runtime surface.
  // Verify against the diff: if any staged internal-only fragment accompanies a
  // runtime src/ change, REJECT — a user-facing change must not skip
  // "What to Tell Your User" / "Summary of New Capabilities". This is the
  // objective gate that keeps the marker from being misused (the agent sets it,
  // the diff verifies it). tests/docs/scripts-only changes are fine.
  const internalOnlyFragments = fragmentChanges.filter(f => {
    try { return hasInternalOnlyMarker(fs.readFileSync(path.join(ROOT, f), 'utf-8')); }
    catch { return false; }
  });
  if (internalOnlyFragments.length > 0 && srcChanges.length > 0) {
    errors.push(
      `Internal-only release fragment(s) accompany ${srcChanges.length} runtime src/ change(s):\n` +
      internalOnlyFragments.slice(0, 5).map(f => `      • ${f} (marked <!-- internal-only -->)`).join('\n') + '\n' +
      `      The internal-only lane (which auto-fills the user-facing release sections) is ONLY for changes ` +
      `with no shipped runtime surface (tests / docs / scripts). Either remove the marker and write the ` +
      `"What to Tell Your User" + "Summary of New Capabilities" sections, or split the src/ change into its own PR.`
    );
  }

  // ── 4. Adapter contract test gate ─────────────────────────────────────
  // If messaging adapter source files changed, require contract test evidence.
  // This prevents shipping integration code verified only by mocked unit tests.
  // The evidence file is created by `npm run test:contract` when tests pass.

  const ADAPTER_PATHS = [
    'src/messaging/slack/',
    'src/messaging/telegram/',
    'src/messaging/whatsapp/',
    'src/messaging/imessage/',
  ];

  const adapterChanges = srcChanges.filter(f =>
    ADAPTER_PATHS.some(prefix => f.startsWith(prefix))
  );

  if (adapterChanges.length > 0) {
    const evidencePath = path.join(ROOT, '.contract-test-evidence.json');
    let evidenceValid = false;

    // Marker escape (mirrors check-e2e-pairing.cjs's 'E2E-PAIRING: EXEMPT'):
    // a changed adapter file may carry "CONTRACT-EVIDENCE: EXEMPT — <reason>"
    // when the diff touches NO API-contract surface (type-only changes,
    // attribution metadata on internal LLM calls, comments). The marker is
    // in-diff and reviewable — a reviewer sees both the exemption and its
    // reason next to the change it covers. Real API changes must still run
    // `npm run test:contract` against the live API.
    const exemptFiles = adapterChanges.filter((f) => {
      try {
        const content = fs.readFileSync(path.join(ROOT, f), 'utf-8');
        return /CONTRACT-EVIDENCE:\s*EXEMPT\s*(—|--|-)/.test(content);
      } catch {
        return false;
      }
    });
    if (exemptFiles.length === adapterChanges.length) {
      evidenceValid = true;
      console.log(
        `  ⚠️  Contract-evidence gate: ALL ${adapterChanges.length} changed adapter file(s) carry ` +
        `a CONTRACT-EVIDENCE: EXEMPT marker — accepting without live-API evidence. ` +
        `(Remove the marker when the file's API surface next changes.)`
      );
    }

    if (fs.existsSync(evidencePath)) {
      try {
        const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf-8'));
        const ageMs = Date.now() - (evidence.timestamp || 0);
        const maxAgeMs = 4 * 60 * 60 * 1000; // 4 hours

        if (ageMs < maxAgeMs && evidence.passed === true) {
          evidenceValid = true;
          const ageMin = Math.round(ageMs / 60000);
          console.log(`  ✅ Contract tests passed ${ageMin}m ago (${evidence.suite})`);
        } else if (ageMs >= maxAgeMs) {
          console.log(`  ⏰ Contract test evidence is stale (${Math.round(ageMs / 3600000)}h old)`);
        } else if (!evidence.passed) {
          console.log(`  ❌ Contract test evidence shows FAILURE`);
        }
      } catch {
        // Corrupt evidence file
      }
    }

    if (!evidenceValid) {
      errors.push(
        `Adapter source files changed but no recent contract test evidence found.\n` +
        `      Adapter files modified:\n` +
        adapterChanges.slice(0, 5).map(f => `        • ${f}`).join('\n') +
        (adapterChanges.length > 5 ? `\n        • ...and ${adapterChanges.length - 5} more` : '') +
        `\n\n      Run contract tests against the REAL API before pushing:\n` +
        `        SLACK_CONTRACT_BOT_TOKEN=xoxb-... npm run test:contract\n\n` +
        `      This ensures your changes work against the actual API, not just mocked responses.\n` +
        `      Contract test evidence expires after 4 hours.`
      );
    }
  }
} catch {
  // Git commands may fail in CI or detached HEAD — skip gracefully
}

// ── 5. Side-effects review artifact ───────────────────────────────────
// If the upgrade notes claim a fix or feature (anything that would require
// an Evidence section), a matching side-effects review artifact must exist
// in upgrades/side-effects/. This enforces the /instar-dev process at push
// time — the pre-commit hook catches it earlier per-commit, this is the
// release-level re-check.
//
// Skipped in CI: contributor branches may be based on a commit predating the
// artifact being added to main. The enforcement point is the local pre-push
// hook; CI can't retroactively add artifacts.
if (!process.env.CI) {
  const FIX_PATTERNS = [
    /\bfix(es|ed|ing)?\b/i,
    /\bbug(fix)?\b/i,
    /\bregression\b/i,
    /\bresolves?\b/i,
    /\bresolved\b/i,
    /\bcrashes?\b/i,
    /\bcrashed\b/i,
    /\bcrashing\b/i,
    /\bbroken\b/i,
    /\bstall(s|ed|ing)?\b/i,
    /\bfeature\b/i,
    /\badd(s|ed|ing)?\b/i,
    /\bnew\b/i,
  ];

  // The in-flight release notes (assembled fragments + legacy NEXT.md) represent
  // the *next* shipment being prepared in this push — prefer them over the
  // (frozen) versioned guide, which describes the already-released version and
  // isn't what this PR is changing. Falls back to the versioned guide when no
  // fragment / NEXT.md is staged (post-release-cut state).
  const inFlight = assembledContent !== null;
  const guideContent = inFlight
    ? assembledContent
    : (versionedGuideExists ? fs.readFileSync(versionedGuidePath, 'utf-8') : null);
  if (guideContent !== null) {
    // Extract "## What Changed" section
    const whatChangedMatch = guideContent.match(/## What Changed\s*([\s\S]*?)(?=\n##\s|$)/);
    const whatChanged = whatChangedMatch ? whatChangedMatch[1] : '';

    const qualifies = FIX_PATTERNS.some((p) => p.test(whatChanged));

    if (qualifies) {
      const sideEffectsDir = path.join(ROOT, 'upgrades', 'side-effects');
      // When in-flight notes (fragments/NEXT.md) drive the push, any fresh
      // artifact (last 24h) counts — the versioned-filename requirement only
      // applies when a versioned guide is being validated without in-flight notes.
      const artifactName = (!inFlight && versionedGuideExists) ? `${version}.md` : null;
      let artifactFound = false;

      if (fs.existsSync(sideEffectsDir)) {
        const files = fs.readdirSync(sideEffectsDir).filter((f) => f.endsWith('.md'));
        if (artifactName) {
          artifactFound = files.includes(artifactName);
        } else {
          // For in-flight notes (fragments/NEXT.md), any fresh artifact from the
          // last 24h counts. The expectation is that during release cut, the
          // fragment/NEXT.md -> <version>.md rename pairs with an artifact rename.
          const recent = files.filter((f) => {
            const stat = fs.statSync(path.join(sideEffectsDir, f));
            return Date.now() - stat.mtimeMs < 24 * 60 * 60 * 1000;
          });
          artifactFound = recent.length > 0;
        }
      }

      if (!artifactFound) {
        errors.push(
          `Upgrade notes claim a fix/feature but no matching side-effects review artifact found in upgrades/side-effects/. ` +
          `Every change qualifying for review must ship with an artifact produced via the /instar-dev skill. ` +
          `See skills/instar-dev/SKILL.md and docs/signal-vs-authority.md.`
        );
      }
    }
  }
}

// ── Destructive-tool containment lint (full repo) ─────────────────────
//
// Runs the lint-no-direct-destructive AST scanner across the whole repo on
// every push. Pre-commit only runs it over staged files; pre-push catches
// commits that landed before the rule existed (or before the marker scheme
// expired). Fails the push on any violation.
//
// Wired here rather than in .husky/pre-push because the husky hook files
// are managed by a sandboxed flow that this gate can extend.

try {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(
    process.execPath,
    [path.join(ROOT, 'scripts/lint-no-direct-destructive.js')],
    { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] },
  );
  if (result.status !== 0) {
    errors.push('lint-no-direct-destructive: violations detected (see output above)');
  }
} catch (err) {
  warnings.push(`lint-no-direct-destructive failed to run: ${err.message}`);
}

// ── Direct-LLM-HTTP containment lint (full repo) ──────────────────────
//
// Phase 1 of docs/specs/token-burn-detection-and-self-heal.md: every LLM
// HTTP call must go through src/core/{Anthropic,ClaudeCli}IntelligenceProvider
// so the burn-detection system can attribute spend. New raw-HTTP-to-LLM
// references outside that chokepoint fail the push.

try {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(
    process.execPath,
    [path.join(ROOT, 'scripts/lint-no-direct-llm-http.js')],
    { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] },
  );
  if (result.status !== 0) {
    errors.push('lint-no-direct-llm-http: violations detected (see output above)');
  }
} catch (err) {
  warnings.push(`lint-no-direct-llm-http failed to run: ${err.message}`);
}

// (The scrape-fixture-realness lint is enforced via the `npm run lint` chain in
// package.json, which CI runs — not duplicated here. A direct gate invocation
// would run against this gate's resolved ROOT, which is a scratch dir under the
// gate's own unit tests, where the registered fixtures don't exist; the chain in
// `npm run lint` runs in the real repo and is the authoritative enforcement.)

// ── 6. URL.pathname filesystem guard ──────────────────────────────────
// new URL(..., import.meta.url).pathname preserves %20-encoded spaces,
// breaking filesystem operations. Use __dirname (via fileURLToPath) instead.

try {
  const srcDir = path.join(ROOT, 'src');
  const { execSync } = await import('node:child_process');
  const matches = execSync(
    `grep -rn "new URL(.*import\\.meta\\.url.*)\\.pathname" "${srcDir}" 2>/dev/null || true`,
    { encoding: 'utf-8' }
  ).trim();

  if (matches) {
    const lines = matches.split('\n').filter(Boolean);
    errors.push(
      `${lines.length} instance(s) of URL.pathname for filesystem paths found in src/.\n` +
      `      This breaks when the project directory contains spaces (%20 encoding).\n` +
      `      Use path.resolve(__dirname, '...') instead.\n` +
      lines.slice(0, 5).map(l => `        • ${l.replace(srcDir + '/', 'src/')}`).join('\n') +
      (lines.length > 5 ? `\n        • ...and ${lines.length - 5} more` : '')
    );
  }
} catch {
  // grep not available — skip gracefully
}

// ── Report ────────────────────────────────────────────────────────────

if (errors.length > 0 || warnings.length > 0) {
  console.log('\n  Pre-Push Gate');
  console.log(`  ${'─'.repeat(40)}`);
}

if (errors.length > 0) {
  console.log('');
  for (const e of errors) {
    console.log(`  ❌ ${e}`);
  }
  console.log('\n  Fix these before pushing. This saves ~4 minutes vs. discovering them in the test suite.\n');
  process.exit(1);
}

if (warnings.length > 0) {
  console.log('');
  for (const w of warnings) {
    console.log(`  ⚠️  ${w}`);
  }
  console.log('');
}

// If we get here, gate passed — print nothing (let the test suite output take over)
