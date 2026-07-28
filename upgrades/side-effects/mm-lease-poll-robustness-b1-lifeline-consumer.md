# Side-Effects Review — B1 lifeline consumer (multimachine-lease-poll-robustness, Decisions 4/5/6)

**Change:** The lifeline now reconciles its Telegram poll to the fenced-lease intent the server publishes — `reconcilePolling()` runs on the existing 15s loop (+ once at boot): reads the poll-intent file (freshness/dead-writer gated via `effectivePollIntent`), gathers the operator override + the local 409 signal + a start-debounce, calls `decidePollAction`, and writes `lifeline-poll-active.json` (the B5 truth source). **Ships DRY-RUN by default even on a dev agent** (`pollFollowsLease.dryRun:true`): it LOGS the would-start/would-stop and writes the truth file, but does NOT start/stop the real poll. The live flip (`dryRun:false`) is gated on the Phase-4 two-host proof + B2/B5 live (Decision 12).

**Files:** `src/lifeline/TelegramLifeline.ts` (reconcilePolling + wiring), `src/core/pollIntent.ts` (poll-active helpers + `pidAlive`), `src/core/types.ts` + `src/config/ConfigDefaults.ts` (`pollFollowsLease`/`pollOverride`), `tests/unit/pollIntent.test.ts`.

## THE LOAD-BEARING SAFETY CLAIM
This touches live Telegram ingress, and Phase-0's manual pins are keeping the live agent healthy RIGHT NOW. The guarantee: **in dry-run (the default, including on this dev agent) `reconcilePolling()` NEVER sets `this.polling` and NEVER calls `this.poll()`/stop** — it only reads, logs, and writes the advisory `lifeline-poll-active.json`. The two `this.polling` mutations + `this.poll()` call live exclusively inside the `if (!dryRun)` branch. So enabling the dev gate cannot change which machine polls; only a deliberate `dryRun:false` does. The static `shouldOwnTelegramPoll` boot decision is completely untouched and still controls real polling.

## Phase 1 — Principle check (signal vs authority)
When live, this IS authority (start/stop ingress), so the principle governs. It fails toward HOLD on every uncertainty: a stale/dead-writer/missing intent → `effectivePollIntent` null → `decidePollAction` returns hold; STOP is immediate on a real lease loss (losing the slot is the safe harm); START never spawns a 2nd poller (409/peer gate) and rides a debounce. In dry-run it holds NO authority (changes nothing).

## 1. Over-block / 2. Under-block
Decision logic is the unit-tested `decidePollAction` (12 tests) + the freshness gate (11 tests). Over-block (silence): guarded by STOP-only-on-real-loss + hold-on-stale. Under-block (dual-poll): guarded by the no-2nd-poller gate (local 409 = partition-immune; peer-pollingActive cross-check is the B5-surface follow-up) + debounce.

## 3. Level-of-abstraction fit
Right layer — the reconcile lives in the lifeline (which owns the socket), consuming the server's intent. Pure decision (`decidePollAction`) + pure freshness (`effectivePollIntent`) are isolated and tested; the lifeline just gathers inputs + applies.

## 4. Signal vs authority compliance
In dry-run: pure signal (logs). When live: authority over only THIS machine's own poll, fail-safe toward hold. (Ref `docs/signal-vs-authority.md`.)

## 5. Interactions
- **Static boot decision (`shouldOwnTelegramPoll`):** untouched; in dry-run it still drives real polling, reconcile only observes. When live, the live branch overrides it.
- **409 backoff:** `consecutive409s` is reused read-only as the recentLocal409 signal; reconcile never resets it.
- **replayInterval (15s):** reconcile is appended; pure/guarded, cannot wedge replay.
- **Phase-0 telegramPolling pin:** mapped to `force-mute` (Decision 7), so a Phase-0-pinned standby stays muted; `true`/absent defers to the lease (NOT force-poll) so two pinned machines don't become a permanent dual-poll.

## 6. External surfaces
A new advisory file `state/lifeline-poll-active.json` (local same-uid IPC). Dry-run log lines on a would-transition (infrequent). No route, no message. Live ingress unchanged in dry-run.

## 7. Multi-machine posture (Cross-Machine Coherence)
Per-machine: each lifeline reconciles its own poll from its own server's intent (machine-local IPC). The poll-active file is the per-machine truth B5 reads pool-wide. Single-machine / gate-off: `enabled` false (non-dev) → reconcile returns immediately; with no peer the lease drives a clean single poller when eventually live.

## 8. Rollback cost
Trivial — `pollFollowsLease.enabled:false` → reconcile no-ops (exact static behavior). Even enabled, `dryRun:true` (default) changes no ingress. The live flip is a deliberate, reversible config change. No state/migration.

## Verification
- `npx tsc --noEmit` clean.
- `tests/unit/pollIntent.test.ts` 11/11 (incl. poll-active round-trip + pidAlive) + `pollDecision.test.ts` 12/12.
- Dry-run safety is structural: the only `this.polling`/`this.poll()` writes are inside `if (!dryRun)`.

## Phase 5 — Second-pass review (INGRESS-CRITICAL)
Independent reviewer verdict: **Concur with the review.** The load-bearing dry-run-safety claim was verified BOTH structurally (every `this.polling=`/`this.poll()` is strictly inside `if (!dryRun)`; hold/dry-run return before any mutation) AND against the LIVE agent's real config (`/Users/justin/.instar/agents/echo/.instar/config.json`: `pollFollowsLease` absent → inherits `{dryRun:true}` → dry-run on this agent; `telegramPolling:true` does NOT map to force-mute). So the change CANNOT change which machine polls on the live agent — only a deliberate `dryRun:false` does. 409 backoff untouched (read-only), writePollActive atomic + unconsumed, pidAlive correct (EPERM=alive/ESRCH=dead). NON-BLOCKING note for the EVENTUAL live flip (out of scope now): re-verify boot static-decision vs first-reconcile ORDERING against the B2 intent producer — the "static decision overridden when live" is convergence-eventual, not boot-synchronous; the 409 gate is the dual-poll backstop regardless. Recorded for the live increment.
