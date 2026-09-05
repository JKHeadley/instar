# MR1 — model-registry review application

Append-only working record. Newest entry is last.

## 2026-08-18 05:07:57 PDT — scope, base, and reviewed evidence

Base:

```text
$ git rev-parse HEAD
248ed7177f5bf416aa7bdad9763741478195e1fc
$ git merge-base HEAD upstream/main
248ed7177f5bf416aa7bdad9763741478195e1fc
```

Authorized edits only:

- `scripts/model-registry-freshness.manifest.json`: reviewed frontier membership, roles, and per-entry `verifiedAt` values named by the MR1 brief. `lastReviewedAt` was already `2026-08-18` on upstream main and was not changed.
- `src/providers/adapters/anthropic-headless/models.ts`: capable `claude-opus-4-8` -> `claude-opus-5`.
- `src/providers/adapters/openai-codex/models.ts`: capable `gpt-5.5` -> `gpt-5.6-sol`.
- `src/core/ModelTierEscalation.ts`: Claude default `claude-opus-4-8` -> `claude-opus-5`; escalated remains `claude-fable-5`.

Review evidence supplied by Pathway:

- Anthropic doors: Claude Code v2.1.234's local model selector offered Opus 5 (default), Fable 5, Sonnet 5, and Haiku 4.5. Opus 4.8 and Sonnet 4.6 were no longer offered. Reviewed ids: `claude-opus-5`, `claude-fable-5`, `claude-sonnet-5`, `claude-haiku-4-5`.
- Codex door: Codex v0.145.0's local selector labelled `gpt-5.6-sol` “Latest frontier agentic coding model” and made it the default; `gpt-5.6-terra` was “Balanced”, `gpt-5.6-luna` was “Fast and affordable”, and `gpt-5.5` was the superseded previous generation.
- Gemini door: `gemini-3.1-pro-preview` was verified from public vendor documentation, not by a local probe. The local Gemini CLI could not authenticate because the account requires a cloud project id. No Gemini id changed.
- pi door: no pin and an empty set; unchanged.

Finding: today's earlier registry refresh added the new Anthropic ids but left the superseded ids marked `frontier:true` and did not update the Codex door or the three source pins. Because it also moved `lastReviewedAt` to `2026-08-18`, those stale pins would have remained green for another 45 days: the date moved without the pins moving.

## 2026-08-18 05:07:57 PDT — verification step 1: freshness check PASS

Command: `npm run lint:model-freshness`

Exit: `0`

```text
> instar@1.3.1180 lint:model-freshness
> node scripts/lint-model-registry-freshness.mjs

[lint-model-registry-freshness] enforcement=strict
  ok   Staleness OK: reviewed 2026-08-18 (0d ago, window 45d).
  ok   Drift OK: gemini-cli 'gemini-capable-tier' -> 'gemini-3.1-pro-preview' (in derived frontier set).
  ok   Drift OK: codex-cli 'codex-capable-tier' -> 'gpt-5.6-sol' (in derived frontier set).
  ok   Drift OK: anthropic-headless 'anthropic-headless-capable-tier' -> 'claude-opus-5' (in derived frontier set).
  ok   Drift OK: claude-code 'claude-tier-escalation-default-escalated' -> 'claude-opus-5' (in derived frontier set).
  ok   Drift OK: claude-code 'claude-tier-escalation-default-escalated' -> 'claude-fable-5' (in derived frontier set).
  ok   Drift OK: claude-code 'claude-clean-door-reviewer-default' -> 'claude-fable-5' (in derived frontier set).
PASS — model registry pins fresh and in-allowlist.
```

## 2026-08-18 05:07:57 PDT — verification step 2: targeted tests FAIL

Command:

```text
npx vitest run tests/unit/model-registry-freshness.test.ts tests/unit/model-registry-freshness-reviewer-pin.test.ts tests/unit/doorway-registry-reader.test.ts tests/unit/codex-model-tier-resolution.test.ts tests/unit/PostUpdateMigrator-modelTierEscalation.test.ts tests/unit/modelTierEscalation-resolver.test.ts tests/unit/crossModelReviewer-clean-door.test.ts tests/unit/providers/adapters/anthropic-interactive-pool/pool-model-flag.test.ts
```

Exit: `1`

Totals:

```text
Test Files  3 failed | 5 passed (8)
Tests       3 failed | 120 passed (123)
```

Deciding failure output:

```text
FAIL tests/unit/PostUpdateMigrator-modelTierEscalation.test.ts
AssertionError: expected { default: 'claude-opus-5', …(1) } to deeply equal { default: 'claude-opus-4-8', …(1) }

FAIL tests/unit/codex-model-tier-resolution.test.ts
AssertionError: expected 'gpt-5.6-sol' to be 'gpt-5.5'

FAIL tests/unit/modelTierEscalation-resolver.test.ts
AssertionError: expected null to be 'claude-opus-4-8'
```

The first two failures are assertions pinned to the prior reviewed values. The third is a behavioral blocker: `KNOWN_CLAUDE_MODEL_IDS` does not contain `claude-opus-5`, so `resolveTierModel('claude-code', 'default', DEFAULT_TIER_ESCALATION_CONFIG)` fails closed to `null`. MR1 authorizes only the manifest and three source pins, so the allowlist and test files were not edited.

Direct adapter smoke (the repository has no direct test file for `anthropic-headless/models.ts`):

```text
$ npx tsx -e <assert both changed capable resolvers>
{"anthropicHeadlessCapable":"claude-opus-5","codexCapable":"gpt-5.6-sol"}
exit 0
```

## 2026-08-18 05:07:57 PDT — verification step 3: type-check PASS

The package has no `typecheck` script:

```text
$ npm run typecheck
npm error Missing script: "typecheck"
exit 1
```

The repository/CI type-check command passed:

```text
$ npx tsc --noEmit
exit 0
```

## 2026-08-18 05:07:57 PDT — verification step 4: drift tooth must-fail control PASS

Temporary mutation: changed only `src/providers/adapters/openai-codex/models.ts` capable pin from `gpt-5.6-sol` to the now non-frontier `gpt-5.5`, ran the live gate, then reverted the mutation exactly.

Command: `npm run lint:model-freshness`

Exit: `1` (required)

```text
[lint-model-registry-freshness] enforcement=strict
  ok   Staleness OK: reviewed 2026-08-18 (0d ago, window 45d).
  ok   Drift OK: gemini-cli 'gemini-capable-tier' -> 'gemini-3.1-pro-preview' (in derived frontier set).
  ok   Drift OK: anthropic-headless 'anthropic-headless-capable-tier' -> 'claude-opus-5' (in derived frontier set).
  ok   Drift OK: claude-code 'claude-tier-escalation-default-escalated' -> 'claude-opus-5' (in derived frontier set).
  ok   Drift OK: claude-code 'claude-tier-escalation-default-escalated' -> 'claude-fable-5' (in derived frontier set).
  ok   Drift OK: claude-code 'claude-clean-door-reviewer-default' -> 'claude-fable-5' (in derived frontier set).
  FIND DRIFT: pin 'codex-capable-tier' (codex-cli) pins 'gpt-5.5' in src/providers/adapters/openai-codex/models.ts, which is NOT in the derived frontier set for 'codex-cli' (doors['codex-cli'].topModels[frontier=true]) = [gpt-5.6-sol]. Either the pin is stale or the frontier set wasn't updated — reconcile the two (operator-confirm the frontier id).
FAIL — 1 finding(s) under strict enforcement.
```

Post-revert freshness rerun: exit `0`; every drift line green.

Final verification state: step 1 PASS; step 2 FAIL (3 tests, including one real closed-allowlist routing blocker); step 3 PASS using the repository's actual `tsc --noEmit` command; step 4 PASS. No merge performed.

## 2026-08-18 05:09 PDT — repository lint PASS

Command: `npm run lint` after staging exactly the four authorized code files and this report.

Exit: `0`

Deciding output:

```text
[lint-model-registry-freshness] enforcement=strict
  ok   Staleness OK: reviewed 2026-08-18 (0d ago, window 45d).
  ok   Drift OK: codex-cli 'codex-capable-tier' -> 'gpt-5.6-sol' (in derived frontier set).
  ok   Drift OK: anthropic-headless 'anthropic-headless-capable-tier' -> 'claude-opus-5' (in derived frontier set).
  ok   Drift OK: claude-code 'claude-tier-escalation-default-escalated' -> 'claude-opus-5' (in derived frontier set).
PASS — model registry pins fresh and in-allowlist.
[framework-list] OK — every annotated list covers its own declared type.
```

The full lint suite passed. Its existing report-only findings remained non-gating and were unrelated to MR1.

## 2026-08-18 05:14 PDT — independent side-effects review concern recorded

Reviewer `testing_integrity_review` agreed that the signal-versus-authority treatment and closed-enum blocker were accurate, then identified a second merge blocker: unchanged manifest prose contradicts the reviewed values.

Exact contradictory fields preserved because MR1 did not authorize editing them:

- `doors['codex-cli'].note` says `gpt-5.6-sol` is deliberately not frontier and the capable pin stays `gpt-5.5`.
- `$flaggedStaleNote` repeats that `gpt-5.6-sol` is not promoted and the capable pin stays `gpt-5.5`.
- `$lastReviewNote` says no pin changed and `claude-opus-4-8` remained frontier.

The freshness lint ignores these note fields, so it remains green. The side-effects artifact now identifies the contradictory prose as a second reason this branch must not merge.

Re-review verdict: `Concur with the revised review`.

## 2026-08-18 05:22 PDT — pre-push base corrected; release fragment required

First push attempt failed before tests because the pre-push gate selected stale local ref `JKHeadley/main` at `4318a1e150e9a8304e6c2e7ad381bf66d03998e5` instead of fetched `upstream/main` at `248ed7177f5bf416aa7bdad9763741478195e1fc`, producing 29 unrelated release-relevant files. No push occurred.

The tracking ref was refreshed from the upstream repository:

```text
$ git fetch upstream main:refs/remotes/JKHeadley/main
4318a1e15..248ed7177 main -> JKHeadley/main
$ git rev-parse JKHeadley/main upstream/main
248ed7177f5bf416aa7bdad9763741478195e1fc
248ed7177f5bf416aa7bdad9763741478195e1fc
```

Second push attempt compared the correct four runtime files and failed because a release-note fragment was absent:

```text
4 release-relevant file(s) changed but no release-note fragment was added.
• scripts/model-registry-freshness.manifest.json
• src/core/ModelTierEscalation.ts
• src/providers/adapters/anthropic-headless/models.ts
• src/providers/adapters/openai-codex/models.ts
husky - pre-push script failed (code 1)
```

Added `upgrades/next/mr1-model-registry-review.md` as the required shipping artifact. It states the routing change, documentation-only Gemini evidence, targeted-test totals, and both merge blockers. No hook bypass and no merge.

## 2026-08-18 05:29:46 PDT — pull request open; node complete as blocked draft

Upstream branch push: exit `0`; all hooks active. The bounded smoke selector waited for the host lane, then timed out its affected-test listing and explicitly deferred to CI; the path-scoped E2E gate passed.

Pull request verification:

```json
{
  "number": 1928,
  "url": "https://github.com/JKHeadley/instar/pull/1928",
  "state": "OPEN",
  "isDraft": true,
  "baseRefName": "main",
  "headRefName": "phaseb/mr1-model-registry-review",
  "headRefOid": "7ac4002cce1dc5e5001f3f106d3d9080e458853c",
  "autoMergeRequest": null
}
```

Final state: PR open and unmerged. Freshness PASS, drift negative control PASS, type-check PASS, full lint PASS, targeted suite FAIL (3 of 123) with the closed-enum runtime mismatch and two stale expectations. Independent side-effects review concurs with both merge blockers recorded. MR1 is not merge-ready and claims no unblock.

## 2026-08-18 05:43 PDT — MR1-B authorized closure built and hand-proven

Authorized additions applied:

- Added only `claude-opus-5` and `claude-sonnet-5` to `KNOWN_CLAUDE_MODEL_IDS`.
- Updated prior-value expectations without weakening assertions. The Claude default resolver assertion remains exact and now expects `claude-opus-5` after the closed enum accepts it.
- Corrected only `doors['codex-cli'].note`, `$flaggedStaleNote`, and `$lastReviewNote`; no behavioral manifest fields changed.
- Added `tests/unit/model-registry-runtime-resolution.test.ts`, which refuses unhandled manifest pins and requires every extracted pin value to equal a non-empty result from its owning resolver.

Expanded targeted suite before sabotage:

```text
Test Files  9 passed (9)
Tests       129 passed (129)
exit 0
```

Required must-fail control: temporarily removed `claude-opus-5` from `KNOWN_CLAUDE_MODEL_IDS` and ran only the new check.

```text
FAIL tests/unit/model-registry-runtime-resolution.test.ts
Error: RUNTIME-RESOLUTION: pin 'claude-tier-escalation-default-escalated' expected [claude-opus-5, claude-fable-5] but its real resolver returned [<empty>, claude-fable-5]

Test Files  1 failed (1)
Tests       1 failed | 5 passed (6)
exit 1
```

The failure was behavioral: the suite compiled, all six tests executed, five passed, and the assertion named the exact pin plus the empty resolver output.

After restoring `claude-opus-5`:

```text
Test Files  1 passed (1)
Tests       6 passed (6)
exit 0
```

Post-restoration verification:

- `npm run lint:model-freshness`: PASS, exit 0; all drift lines green.
- `npx tsc --noEmit`: PASS, exit 0.
- `npm run lint`: PASS, exit 0.
- `lastReviewedAt`, staleness window, enforcement mode, pin definitions, and freshness gate script: unchanged.

Finding closed: a manifest pin can no longer be fresh and drift-green while silently resolving empty through a registered runtime path without making CI red. This remains a routing change for operator approval. Gemini was verified from vendor documentation rather than a successful local probe. PR #1928 remains open, draft, unmerged, and without auto-merge.

Independent MR1-B second-pass verdict: `Concur with MR1-B review`. The reviewer confirmed exhaustive manifest-pin coverage, production-resolver invocation, exact non-empty results, the behavioral Claude control, and the distinction between three live routing changes and Gemini's documentation-only verification.
