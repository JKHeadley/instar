# Side-effects: Slack replies inside private memory

Tier 1, SMALL: a reversible serialization correction plus migration hash and regression tests. Independent review concurred; a second targeted review covers the verification fixture repair. Commit/gate attempts are recorded in the build summary. Live owner recovery uncovered this after PRs #2744 and #2752: Bash 3.2's here-string cannot create its temporary file under the existing privacy sandbox, so the agent computes an answer but cannot relay it.

## Decision-point inventory
No judgment or blocking authority added or changed. Slack's session binding, authorization, privacy boundary, outbound review, delivery id and retry outcomes pass through unchanged.

## 1. Over-block
No new block/allow surface. Replace the here-string with a printf pipe; Bash no longer needs a regular file to encode the message.

## 2. Under-block
No privacy permissions broadened. Existing handling of failed Python, network failures, and unknown delivery outcomes remains intact.

## 3. Level-of-abstraction fit
The failure belongs to the shell transport template, not the sandbox policy. Keep the deny rules; remove unnecessary filesystem use in JSON encoding.

## 4. Signal vs authority compliance
No block/allow surface. This is serialization mechanics, compliant with docs/signal-vs-authority.md; the same request reaches the existing authorities.

## 4b. Judgment-point check
No new static heuristic at a competing-signals decision point.

## 5. Interactions
printf uses a fixed format and adds the same newline as the former here-string. No destination, credential, retry, or idempotency change. SlackReplyRelayInstaller recognizes the exact previous shipped SHA and upgrades canonical and compatibility copies, retaining backups. Customized scripts remain preserved by the existing hash policy. No new timer, race, or feedback loop.

## 6. External surfaces
Owners in opted-in multi-person agents can receive ordinary Slack replies after repairing private memory. No new API or operator action; the existing phone-usable owner repair page is unchanged. No durable data schema change.

## 6b. Operator-surface quality
No renderer or operator form change. The existing repair page was exercised in real Chrome at 390x844: GET did not mutate; POST repaired once; replay and refresh returned 410.

## 7. Multi-machine posture
Replicated through the normal package update and PostUpdateMigrator script reconciliation on each machine. No shared runtime state, new status answer, generated URL, or additional user notice. Existing session binding selects the destination. Existing tunnel generation and one-voice delivery remain unchanged.

## 8. Rollback cost
Revert template and added hash, ship a patch. No data migration. Rolling back restores the sandboxed relay failure; known-shipped history must retain any subsequently released hash when making that rollback.

## Class-Closure Declaration
No agent-authored prompt/config/skill defect: ordinary shell serialization defect. No self-triggered controller added or changed.

## Evidence
Real macOS sandbox regression: both channel and bound replies fail on the old script with 'cannot create temp file for here document'; both pass with the pipeline, with regular file writes denied (only /dev/null allowed). Transport shim asserts multiline/quoted text, exact JSON, delivery id, auth, agent identity, route, and session binding. Integration test migrates the exact previous shipped fixture through PostUpdateMigrator. Real Slack acceptance is recorded in topic 10000001598 and PR comments.

## Second-pass review
Reviewer relay_review independently read the final diff, exact historical fixture/hash, migration wiring, tests, and this artifact: concur. No blocking correctness, privacy, or rollout concerns. Real Slack and full remote verification remain acceptance gates.


## Full-verification fixture repair
The first official full run executed 59,193 unit tests and found one failure in lint-blocking-decisions-declared.test.ts. Its mutation probe wrote zz-undeclared-test.py into the real source tree, then SourceTreeGuard refused to remove it; isolation retry saw the dirty file and failed its initial clean assertion. This blocks a reliable full verdict. The test now checks the actual tree read-only, then copies the real lint, manifest and template population to a temporary fixture for the adversarial probe. SafeFsExecutor removes that fixture; no guard permission changes or source-tree cleanup exception is added. This also removes the parallel-test race in which another lint could observe the injected file. The Slack runtime bytes and completed live acceptance are unchanged.

Independent reviewer relay_review concurs with the fixture repair: the copied lint uses its own fixture root, the exact real manifest/population are copied, no source marker or git metadata is copied, and the positive/negative lint contract remains intact. Full verification must restart from a clean checkout.
