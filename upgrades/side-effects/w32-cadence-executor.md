# Side-Effects Review — W32 cadence executor and lifecycle proof

**Version / slug:** `w32-cadence-executor`
**Date:** `2026-09-05`
**Author:** `Codey, W32 Lane B`
**Second-pass reviewer:** `Peirce (/root/w32_continuation/lane_b_side_effects_review)`

## Summary of the change

This change adds a durable Echo-only cadence executor for Window 32. It starts only after the authoritative liveness record is `active` with an `activatedAt`, records distinct advancing-work results every 30 minutes, checkpoints the exact first unreceipted autonomous task, delivers a high-level Telegram synthesis every three hours, preserves cadence across verified executor rebind, and closes on terminal liveness. The lifecycle ledger remains its sole evidence writer: it binds cadence delivery to the exact W32 run and re-reads the adapter's machine-local durable outbound history before satisfying report and close duties. This is deliberately not described as a Telegram-server deletion oracle. Configuration defaults, migration parity, capability discovery, and agent awareness are included. The worktree was intentionally based on W32 integration commit `84dff081e` rather than the later `origin/main`, as required by the lane charter; remote is `JKHeadley/instar`, package version is `1.3.1223`.

## Decision-point inventory

- `WindowRunCadenceExecutor.tick` — add — decides when activation-authoritative receipt/checkpoint/report work is due.
- `WindowRunCadenceExecutor.materializeDueIntervals` — add — applies the enumerable invariant that one newer server-minted work receipt satisfies one 30-minute interval; otherwise the interval fails after bounded grace.
- `WindowRunCadenceExecutor.materializeDueReports` — add — re-queries ambiguous delivery, then permits at most three durable exponentially spaced attempts before terminal failure.
- `routes.ts materializeMachineEvidence/evidenceAuthority` — modify — exclusively mints and re-verifies cadence-report lifecycle evidence from the exact cadence binding, Ed25519 producer signature, and the adapter's current machine-local durable outbound row.
- `routes.ts deterministicPayload` — modify — derives the enumerated W32 continuous/close predicates from liveness audit/exit proof, cadence receipts, and live-coupled report evidence.
- `AgentServer` production composition — modify — orders liveness evaluation before cadence consumption and wires checkpoint/session and report/Telegram effects.
- `DARK_GATE_EXCLUSIONS` — modify — keeps this action-bearing controller explicitly off until an operator enables it; dry-run remains the default.

## 1. Over-block

The cadence will fail a run whose substantive artifact advance arrives after the five-minute interval grace, even when useful work happened elsewhere. That is intentional: only a server-minted artifact receipt can prove the chartered durable-work predicate. The lifecycle report binder accepts activation-vs-compilation deadline skew only within the duty's declared grace; a longer preparation gap requires lifecycle cadence materialization to be aligned before activation rather than silently claiming delivery against the wrong duty. Malformed/missing autonomous task frontmatter blocks checkpoint/recovery task resolution because choosing a task without the run binding would be less truthful.

## 2. Under-block

A Telegram transport can accept a report and then lose both the return value and its local outbound-history row. The next bounded retry may duplicate that one report because no locally authoritative message id is available; the stable receipt marker makes this recoverable whenever the adapter row is present, and the three-attempt ceiling bounds the ambiguity. The adapter history is a local JSONL/cache authority: it can detect local row removal or corruption, but cannot prove that a user did or did not delete a message on Telegram's servers. Liveness and cadence use separate atomic files, so lifecycle evidence can temporarily underclaim between their commits/ticks. It cannot overclaim from an arbitrary local row because the report binding and immutable body hash must verify against Echo's Ed25519 identity key. A machine loss before the local cadence file is replicated strands that machine-local proof; this state intentionally represents the locally bound executor and must be consumed on its owning machine.

## 3. Level-of-abstraction fit

The cadence store is a lower-level durable scheduler/receipt primitive. It consumes the existing `WindowRunLivenessAuthority`; it does not create a second definition of active. The lifecycle ledger is the higher-level closure authority and remains the single writer of lifecycle evidence. Telegram delivery uses the existing adapter, including its tokenless-standby relay path, rather than direct HTTP. Exact-task resolution is shared with liveness recovery so checkpoint and recovery cannot select different continuation tasks.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — the new blockers are hard-invariant/policy evaluation over an enumerable state machine, not brittle semantic judgment.

No regex or text classifier decides whether work is substantive. Work authority is an existing server-minted receipt tied to verified artifact bytes and the first unreceipted task. Report text checks do not block arbitrary user messaging; they verify the narrow machine-authored evidence contract before lifecycle closure. Missing or stale evidence fails toward `unknown`/not-closed.

## 4b. Judgment-point check

No new static heuristic resolves competing signals. The five-predicate liveness authority remains canonical. Interval sequence, timestamps, exact immutable binding, retry count, message identity, provenance, and duty grace are mechanical invariants. High-level report structure is a receipt-verification floor, not an interpretation of operator intent.

## 5. Interactions

- **Shadowing:** liveness ticks first; cadence consumes only its committed result. Preparation produces no cadence state or actions. Existing cadence continues through `at-risk`, but terminal liveness closes it.
- **Double-fire:** checkpoints are deduplicated by due time and persist each attempt before session injection. Reports and failure notices use deterministic ids, persist attempts before send, and re-read local durable history before every retry. The lifecycle timer alone materializes report evidence; the async Telegram callback never writes the lifecycle store.
- **Races:** each cadence mutation holds a `proper-lockfile` lock and writes by fsync-plus-rename. Liveness/cadence/lifecycle are separate authorities, so cross-store updates are deliberately monotonic and may lag one tick rather than use a partial multi-file transaction. A lifecycle re-query removes locally vanished/corrupt delivery evidence and dependent close proof. It does not claim to observe Telegram-server deletion.
- **Feedback loops:** checkpoint injection can lead to a later work receipt, but the injection itself never counts. Checkpoint attempts stop at two; report delivery and the terminal failure notice each stop at three with durable exponential backoff. Restart preserves every counter, and an accepted notification with a lost acknowledgement is reconciled by its stable local-history marker.
- **Route ordering:** static `/cadence` and `/cadence/tick` routes precede the registration/work routes and do not collide with parameter routes. A manual cadence tick cannot initialize before authoritative activation.

## 6. External surfaces

The change adds authenticated `GET /window-run-liveness/cadence` and `POST /window-run-liveness/cadence/tick`, a new `.instar/window-run-cadence/state.json` ledger, session checkpoint prompts, and operator-facing Telegram synthesis/failure messages. Every test caller sends both Bearer authentication and `X-Instar-AgentId`. The executor is explicitly `enabled:false`, `dryRun:true` by default and classified action-bearing. Migration is add-missing-only and preserves operator overrides. The agent-awareness template and existing-agent CLAUDE migration describe both endpoints and the evidence boundary.

No new operator approval/grant action is introduced; enablement remains the existing configuration surface, so there is no new API-only phone action to complete. No dashboard renderer or form is changed.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

**Machine-local BY DESIGN.** The cadence document records facts about one locally bound executor, its local autonomous task ledger, local artifact receipts, and local liveness authority. Those truths must not be merged across machines. Actuation is admitted only when the distributed `SessionOwnershipRegistry` says this exact bound topic/conversation is `active` on this machine; liveness separately binds the executor. A configured multi-machine coordinator without topic ownership authority fails closed. The tokenless Telegram relay remains transport only and is not treated as ownership authority. Durable cadence state can strand if the entire owning machine is lost; it is not silently reconstructed on a peer because doing so could reset intervals or duplicate recovery. A verified executor rebind on the same authority updates only `executorId` and retains history. The feature generates no URLs.

## 8. Rollback cost

Disable `monitoring.windowRunLiveness.cadenceExecutor.enabled` immediately to stop new actions, then revert and ship a patch. The additive state file can remain inert; no existing schema is mutated and no cleanup is required. Existing lifecycle evidence re-query will underclaim if the executor is absent rather than retaining false closure. Agent awareness text can be removed by a later migration if desired, but leaving it while disabled accurately yields a 503/dark response.

## Conclusion

The review changed the implementation materially: report delivery originally retried once per server tick under permanent Telegram failure. It now persists bounded checkpoint/report/failure-notice attempts before each external action, applies exponential backoff, signs each immutable report/run binding with Echo's Ed25519 identity, admits actions only on the authoritative session owner, and is enrolled in the standing self-action convergence ratchet with a total 2+3+3 bound. Direct adapter outbound rows explicitly record `forwarded:false`; inbound operator semantics remain unchanged. The remaining transport ambiguity is bounded and named. The design preserves liveness as the only active authority, lifecycle as the only closure-evidence writer, and fails toward temporary underclaim across separate stores.

## Second-pass review

**Reviewer:** Peirce (`/root/w32_continuation/lane_b_side_effects_review`)
**Independent read of the artifact:** **CONCUR.** The reviewer independently verified all six blocking corrections: compatible outbound provenance, authoritative topic ownership, bounded crash-safe failure notification, honest adapter-local history naming, Ed25519-bound report recovery/evidence, and persist-before-send checkpoint redrive. The final reread also verified fresh-signature self-validation against the configured public key, durable terminalization on missing/mismatched keys, W32-only exclusion of manual cadence evidence, activation-only cadence origin, preserved executor-rebind history, and the production 2+3+3 convergence ceiling. The reviewer made no edits.

## Evidence pointers

- Expanded focused unit/integration/E2E selection covering cadence, liveness, migration, awareness, discovery, dark-gate, lifecycle proof, and production wiring — 430/430.
- Final signer/ownership/lifecycle focused selection after configured-key self-verification — 20/20.
- `corepack pnpm vitest run tests/e2e/window-lifecycle-production-wiring.test.ts --reporter=dot` — 1/1 on the final frozen tree, 326.15s (323.47s test time); the two preceding frozen production-path runs also passed in 317.57s and 316.45s.
- `corepack pnpm exec tsc --noEmit` — pass.
- `git diff --check` — pass before staging; repeated before commit.

## Class-Closure Declaration (display-only mirror)

`defectClass: unbounded-self-action`, `closure: guard`, `guardEvidence: { enforcementType: ratchet, citation: tests/unit/self-action-convergence.test.ts, howCaught: the registered window-run-cadence-delivery-redrive model drives permanent checkpoint, report, and failure-notice rejection across normal ticks and process reconstruction; its durable per-target attempt counts stop at 2, 3, and 3 independent of the horizon, while production unit tests pin persistence-before-action, exponential due-time spacing, local-history reconciliation, and terminal settling }`.
