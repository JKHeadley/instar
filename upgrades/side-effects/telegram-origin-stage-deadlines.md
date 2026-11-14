# Side-Effects Review — Telegram origin recording stage budgets become settable

**Version / slug:** `telegram-origin-stage-deadlines`
**Date:** `2026-11-13`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 1. Stacked on PR 3149 (test-only), which it shares two test files with.

Production, one file: `src/messaging/telegram-origin/TelegramOriginService.ts`. The five literals passed to `within(...)` in `#recordEvidence` (250, 500, 1250 ms) and in the admission path (1000, 1000 ms) are replaced by `this.#stageDeadline(stage)`, which returns the caller's `options.stageDeadlines[stage]` when it is a safe integer from 1 to `ORIGIN_STAGE_DEADLINE_MAX_MS` (60,000) and otherwise the default from the new frozen `ORIGIN_STAGE_DEADLINES_MS` (the same five numbers). New exported type `OriginStageDeadlines`. No caller in `src` sets the option.

Tests: new `tests/unit/telegram-origin/origin-stage-deadlines.test.ts`; new helper `allowSlowOriginRecording(service)` (20 s a stage) in `tests/helpers/telegramOriginStore.ts`, called from the harnesses of six e2e files, one integration file and one unit file, and from the two shared late-capacity harness helpers, which serve three more test files (unit, integration and e2e late-capacity). Eleven test files change timing in all.

## Decision-point inventory

- `TelegramOriginService.#recordEvidence` and the admission block — modify — these decide whether an outbound Telegram send is HELD (`all-durable-recording-sinks-unavailable`, `execution-admission-unavailable`). The decision logic is unchanged; the time each stage is given before it counts as failed becomes a parameter with the old values as defaults.

---

## 1. Over-block

None added. With defaults the hold conditions are identical. A caller that sets a SHORTER budget would hold more; the option accepts values down to 1 ms. No caller does.

## 2. Under-block

- **Two layers of time limit, and which fixtures lift which.** The service budgets (this change's seam) sit on top of each `OriginStore` request's own deadline (`requestTimeoutMs ?? 2000`, `OriginStore.ts:139`); in a runtime or boot fixture both the store and the spool are `OriginStore` instances opened from the same storage options. Lifting only the service budgets therefore leaves each stage bounded near 2 s, and commits slower than 2 s do happen on the Studio today: during review the new unit file failed once that way ("the maximum itself is accepted", 3,988 ms). So the fixtures that pass their own storage options also set `requestTimeoutMs` to the store's maximum, 30 s (`SLOW_DISK_STORE_REQUEST_TIMEOUT_MS`): the new unit file, `transport-deadlines`, the shared late-capacity harness, `telegram-origin-runtime-lifecycle` and `telegram-origin-browser-outbox`. The fixtures built through `bootTelegramOrigin` (`notice-policy`, `deterministic-notice-origin`, `dashboard-edit-rejection`, `enrollment`, `lease-renew-unreachable-peer-sends`, the HTTP late-capacity harness) cannot set storage options and keep the 2 s request deadline: for them this change widens 250 / 500 ms to about 2 s (8x and 4x) and a commit slower than 2 s can still fail them. A pass-through on `bootTelegramOrigin` would close that; it is a second production seam and is left out of this change. <!-- tracked: fb-de7ee113-bc8 -->
- **A longer budget delays a hold.** A hung store or spool is cut off by its request deadline (2 s, or 30 s in the fixtures that raise it; no test in those fixtures uses a hung store or spool, they use rejecting mocks and closed stores). Two cases have no such inner bound: a peer sink (no harness wires one), and a store whose worker is respawning, where a call first awaits readiness (bounded only by the 30 s startup limit). There the service budget is the only bound: 250 ms before, 20 s with the helper. The one test that can reach this is the corrupt-store restart in `telegram-origin-runtime-lifecycle.test.ts`; its outcome is unchanged (rejection, then spool, then `execution-admission-unavailable`), only its duration can grow, to at most the time the worker takes to fail startup.
- **Production keeps the defaults**, so the production symptom stays: on a loaded host a send is held and the operator is alerted when a commit was only slow. Not changed here; filed as fb-de7ee113-bc8. <!-- tracked: fb-de7ee113-bc8 -->
- **37 other test files** open a real origin service with production budgets. None has failed with this signature on record. A process-wide test default was considered and not done: it would change the timing of tests that deliberately exercise slow or hung sinks, and finding those needs full-suite runs that the test line cannot spare today. <!-- tracked: fb-de7ee113-bc8 -->

## 3. Level-of-abstraction fit

The budgets belong to the service that applies them; making them an option of that service is the smallest seam. The alternative of raising the production defaults is a product decision about how long a real send may wait on a slow disk, and is left to the owner.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] The hold is an existing authority with deterministic inputs (did each durable sink confirm in time). This change adds no new authority and no new brittle check; it parameterises "in time", default unchanged.

## 4b. Judgment-point check (Judgment Within Floors standard)

No judgment point. A numeric budget with a hard validity range.

## 4c. Self-action class (`unbounded-self-action`)

Not applicable: no spawn, restart, retry, notify or kill is added. The hold-notice path that follows a hold is unchanged.

## 5. Interactions

- **`options` is read at call time.** `service.options` is a public object that production already mutates after boot (`peerEvidence` in `src/commands/server.ts`, `sendPolicy` and `store` in `TelegramOriginRuntime.ts`). A value set after construction takes effect on the next send; pinned by a test.
- **Validation is per call, per stage.** A partly valid object uses its valid fields and defaults for the rest. An invalid value never throws (a send must not fail because of a bad test option) and never widens a budget.
- **Runtime wiring:** `TelegramOriginRuntime` constructs the service and does not forward a `stageDeadlines` of its own; tests reach the service through `runtime.service.options`. Boot (`bootTelegramOrigin`) is unchanged.
- **Admission deadline arithmetic** (`#limits.deadlineMs`, six hours) is separate and unaffected: a 20 s stage budget cannot outlive an operation's deadline in any realistic test.
- **Tests that assert a hold from a failed sink** use rejecting mocks or a closed store; those fail at once regardless of the budget. No test in the changed harness files uses a never-resolving recording stage; the one fake-timer use (`lease-renew-unreachable-peer-sends`) fakes `setInterval` only, so the budget timer stays real. The four affected unit files pass (115 tests) with both the helper and the raised request deadline. Three of the e2e files passed (58 tests) with the helper, before the request deadline was raised in two of them; they have not been re-run since.
- **Overlap with PR 3149:** this branch contains 3149's commit. After 3149 merges, main is merged in; the two touch different lines of the two shared test files.

## 6. External surfaces

- Install base: the service runs on every agent with Telegram; behaviour is unchanged with no option set.
- Public API: one new optional field on `OriginServiceOptions`, one new exported constant pair and type.
- Persistent state, operator surface: none.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN**: a per-process option of a per-machine service. No replicated state, notices or URLs change.

## 8. Rollback cost

Revert and release. No state or migration. Reverting restores the literals; the tests would then flake as before.

---

## Conclusion

A seam with unchanged defaults, used only by tests, for a failure class with 29 recorded occurrences in a week. It does not decide the production question it exposes.

---

## Second-pass review

**Reviewer:** independent reviewer subagent (Claude), given the code and not the author's conclusions; ran the affected unit files itself
**Independent read of the artifact: concur, after three reads; no blocker; boot-built fixtures keep a 2 s window (stated in section 2)**

**First read: CONCERN, "nothing blocks the production change".** Confirmed: the production edit is behaviour-preserving (same five budgets, order and hold reasons; no other stage literal missed); the validation cannot return NaN, undefined, zero or a wider value; no production code path or config file can set the option; no test in the changed fixtures relies on a short budget; the helper is applied before the first send and after every reopen. Three should-fix items: the new unit tests left unmeasured stages on production budgets; "20 s" was really about 2 s because of the store's own request deadline; several misstatements in this document.

**Second read, after those were applied: CONCERN.** The new unit file failed 1 of 18 on the reviewer's run: a real commit took over 2 s and the store's request deadline rejected it under a 60 s stage budget. And the reason this document gave for not raising `requestTimeoutMs` in the fixtures was wrong (four fixtures pass a storage literal; no hung-store test exists in them).

**What was done:** `requestTimeoutMs` is raised to the store's 30 s maximum in the new unit file and in the four fixtures that pass storage options; section 2 now states the two layers, which fixtures lift which, and that the boot-built fixtures keep a 2 s window.

**Third read: CONCUR.** The unit-file exposure is closed: the store in the new unit file and in the four fixtures that pass storage options now has a 30 s request deadline, and the reviewer's re-run of origin-stage-deadlines and transport-deadlines passed 43 of 43 on a loaded machine. By reading, no test in those fixtures can hang on the longer deadline (closed stores and failed workers reject at once, reopens reuse the same storage options, none relies on the 2 s deadline); the reviewer ran no e2e or integration file, so runtime-lifecycle and browser-outbox with the 30 s deadline are unverified by execution.

---

## Evidence pointers

- `.instar/logs/local-verify.jsonl` on the Studio, `run-detail` records 2026-11-07 to 11-13: 29 failed or flaky-retried entries with a held-send signature, in nine distinct test files (the files on record; eleven files change timing because two shared harness helpers serve three), in the runs of 17 PRs.
- Latest: PR 3141, 2026-11-13 17:49:19Z, `tests/unit/telegram-origin/transport-deadlines.test.ts`.
- Server log, same machine, same morning: `[telegram-origin] config snapshot unavailable: origin-config-reader-timeout` (a 10 s budget exceeded).
