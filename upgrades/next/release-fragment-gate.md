<!-- bump: patch -->

## What Changed

Added the **release-fragment-gate** so a release-affecting PR can no longer merge and
then SILENTLY skip the release (the 2026-06-27 incident: PRs #1295-#1297 merged with
no `upgrades/next/` fragment, the publish ran green and cut no version, fixes stranded
~7h).

The fragment requirement already existed as a HARD local pre-push gate
(`pre-push-gate.js §3b`) — but husky runs only on a local `git push`, so the
server-side squash/bot/auto-merge path bypassed it. This change moves the same
requirement to the merge boundary, server-side, where it can't be routed around:

- **Layer 1 — `release-fragment-gate` CI check** (`.github/workflows/release-fragment-gate.yml`
  + `scripts/check-release-fragment.mjs`): on every PR to `main`, a release-relevant
  change with no fragment is flagged. Ships **warn-only** (reports the verdict, never
  blocks) until the spec's D3 criterion is met and it's registered as a required check.
  Security-hardened: `on: pull_request` (never `pull_request_target`), read-only token,
  the gate code loads from the BASE ref (never PR-head), and the bot exemption keys on
  authenticated identity, not a spoofable title. Fail-closed.
- **Shared predicate** (`scripts/release-relevant-paths.mjs`): one "is this
  release-relevant?" answer, consumed by both the PR gate and the local pre-push gate
  (`§3b` is broadened from `src/**.ts` to also catch `scripts/`, `.github/workflows/`,
  `package.json`, skill code, and shipped `.claude/hooks` + `.claude/skills`).
- **Layer 2 — loud-skip backstop**: the publish pipeline now emits a loud warning +
  step summary when it would skip with unreleased release-relevant work
  (`scripts/release-skip-annotate.mjs`, signal-only, never fails the run), and the
  `ReleaseReadinessSentinel` gains a **fast-trigger** so a missing-fragment merge
  surfaces immediately instead of waiting out the multi-day age floor.

## What to Tell Your User

If a release ever stops cutting versions, the cause is almost always a merged change
with no "what changed" note — and now you'll be told loudly instead of finding a
green-but-empty release run hours later. Maintainer agents get an immediate heads-up
when finished work is sitting unreleased for that reason. Nothing changes for everyday
users; this is release-pipeline safety for the people who ship instar.

## Summary of New Capabilities

- A server-side PR check that catches a release-affecting change shipped without a
  release note, before it merges (starts in warn-only mode).
- One shared rule for "does this change need a release note?", used by both the
  server check and the local pre-push check.
- A loud alarm (instead of a silent green run) when the publish pipeline skips a
  release that still has unreleased work, plus an immediate maintainer heads-up.

## Evidence

57 new unit tests (the shared predicate incl. adversarial path-evasion + an anti-drift
ownership guard, the Layer-1 decision table incl. the bot-spoof evasion case, and the
Layer-2 classifier) + the extended ReleaseReadinessSentinel suite (fast-trigger fires
for the missing-fragment case, does NOT fire for a coverage-gap block, honors its
off-switch). tsc clean. Driven by the converged + approved
RELEASE-FRAGMENT-GATE-SPEC (3-round spec-converge, 6 internal + codex/gemini external
reviewers) and an independent second-pass review that caught + fixed a `.claude`
shipped-path exemption hole before commit.
