---
title: "Codex session lifecycle reliability — attributed interrupts and verified delivery"
slug: "codex-session-lifecycle-reliability"
author: "echo"
created: "2026-08-27"
status: "draft"
approved: true
parent-principle: "Verify the State, Not Its Symbol"
eli16-overview: "codex-session-lifecycle-reliability.eli16.md"
lessons-engaged: "P1,P2,P3,P4,P5,P7,P10,P14,P17,P18,P19,P20,P21,P22,P23,P24,L5,L6,L7,L8,L9,L10,L14"
review-convergence: "2026-08-28T16:39:52.621Z"
review-iterations: 12
review-completed-at: "2026-08-28T16:39:52.621Z"
review-report: ".instar/tmp/codex-session-reliability/docs/specs/reports/codex-session-lifecycle-reliability-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 12
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Codex session lifecycle reliability

## Problem statement

Codex sessions on Echo regularly appear to stall, ignore an inbound message, or terminate without an operator action. Live evidence shows that this is not one failure mode:

1. `SessionWatchdog` interrupted two legitimate `safe-merge` waits with `Ctrl+C` and `SIGTERM`. That class was fixed in v1.3.1205 by protecting bounded external waiters and attributing watchdog interventions.
2. After that fix, `SessionWatchdog` interrupted two long-lived `codex-code-mode-host` processes. One session recovered and one died. The host is framework infrastructure, not a user command, so it must never enter the stuck-command judge.
3. For topic 59199, `stuck-input-events.jsonl` contains repeated four-step keypress ladders whose outcome is only `fired`. The marker remained at the prompt after every attempt. A successful tmux send is not proof that Codex accepted the message.
4. A completed Codex turn is idle, not wedged. A nudge cannot resume completed work unless an explicit continuation obligation exists; existing bounded continuation and autonomous-turn revival own that state.

The system currently exposes these distinct states through similar user-visible symptoms and sometimes records attempted actions as successful outcomes. That makes diagnosis unreliable and recovery either destructive or ineffective.

## Goals

1. Framework-owned Codex infrastructure can never be killed by the stuck-command watchdog.
2. Every watchdog intervention names its principal and lifecycle reason, and operator cancellation remains distinguishable from supervisor action.
3. Inbound injection has an explicit lifecycle: `prepared`, `dispatched`, `composer-cleared`, `turn-consumed`, `responded`, `unknown`, `exhausted`, `superseded`, `continuity-lost`, or `dispatch-failed`.
4. An unchanged prompt after the bounded keypress ladder produces a typed exhausted event and routes through the existing recovery authority; it is never reported as recovered merely because a key was sent.
5. Completed-turn idleness, active tool execution, stranded drafts, and dead sessions remain separate states with separate owners.
6. The change is covered at unit, integration, and E2E lifecycle tiers and updates installed-agent awareness/migrations where required.

## Non-goals

- Detecting whether every arbitrary shell command is semantically making progress.
- Restarting a healthy Codex session on terminal silence alone.
- Creating a second continuation engine parallel to `CodexTaskContinuationStore`, `AutonomousLivenessReconciler`, or `ResumeQueueDrainer`.
- Treating an unchanged tmux frame as proof of a stall.

## Proposed design

### Glossary and staged scope

- **session incarnation**: one concrete tmux/Codex process lifetime; respawn creates a new incarnation.
- **owner epoch**: monotonic conversation-ownership generation used to fence stale machines.
- **rollout**: Codex's append-only JSONL transcript for one session, pinned by `TopicResumeMap`.
- **pending inject**: the durable queue entry that causes one message envelope to be delivered to a session.
- **session refresh**: `SessionRefresh.refreshSession()`, the existing scoped effect owner that respawns one Codex session while preserving its topic/resume mapping; `AutonomousLivenessReconciler.recoverIdle` is an existing caller/wiring precedent.
- **dark / observe-only**: constructed but inactive / recording decisions while suppressing newly introduced effects.
- **Tier-1 supervisor**: the project-required LLM validator around a critical programmatic pipeline; it can veto uncertain evidence but cannot bypass deterministic safety floors.
- **authorization capability**: a short-lived, single-use token bound to one effect and the epochs observed when it was approved.

The implementation is staged in one release. Stage A ships live fleet-wide immediately. Stage B is production-wired dark, then enforced on Echo/dev for a pre-release canary of at least two hours and 50 deliveries (including identical, multiline, active-turn, resize, outage, and transfer cases) with zero false unknown/exhaustion, duplicate key ownership, lost inbound, or stale-owner action; only after that gate does the release/migration enable Stage B fleet-wide. Failure keeps Stage B dark and blocks the release rather than shipping a user-facing fix disabled. Stage C scoped refresh/replay remains independently dark/dry-run until post-merge maturation. Stage-B transfer compatibility ships because its live rows can move between owners.

| Stage | Required components | Release authority |
|---|---|---|
| A | process provenance/cache, descendant traversal, watchdog attribution | fleet-live independently |
| B | delivery store, pending-inject/funnel, composer+rollout adapters, observer, attempt ownership, safety latch/effect lock, status/migration, transfer of live rows | candidate artifact must pass Echo gate; then fleet-live |
| C | recovery episodes/capabilities, supervisor, scoped refresh/replay, breaker | ships dark; separate post-merge canary |

Stage B cannot simply refuse ownership transfer while rows are live: observed rows can remain open for the 24-hour diagnostic window, while operator-requested topic/session moves must preserve exactly-one ownership and reachability. Blocking transfer would turn normal session replacement into a day-long outage; dropping rows/fresh-starting would lose FIFO/dedup evidence. Therefore transfer compatibility is part of B, while C actuation remains optional.

Convergence applies the 80/20 rule fractally. Each subsystem is complete when its small load-bearing core has: one named authority, explicit state/evidence, bounded work/storage, crash/partition posture, and tests across both sides of its main decision boundary. Findings that change those properties are DESIGN and reopen only the affected subsystem plus its direct dependents. Precision/readability findings are still recorded but do not recursively reopen clean branches. The final delta review is therefore scoped to tracked-send/keypress effect journaling and its direct FIFO, lock, migration, and crash-test dependencies; unrelated clean transfer/crypto/rollout branches remain closed unless the delta invalidates an invariant.

### 1. Protect framework infrastructure before judgment

Add `classifyFrameworkInfrastructureProcess(process, sessionIncarnation)` as a safety floor in `SessionWatchdog`. A basename match is only a detector. Confirmed protection additionally requires the recorded Codex framework, the expected resolved executable identity/path, and a parent-role edge bound to the current session incarnation. A confirmed host node is excluded before elapsed-time selection and the LLM judge. A suspected match with missing or conflicting provenance returns `ownership-unknown`: audit and preserve on that poll.

Trusted identity is deterministic: resolve the configured Codex launcher realpath, derive the bundled platform package's `vendor/*/codex-code-mode-host` realpath, and snapshot the host executable's device/inode at spawn. On macOS, runtime identity comes from `proc_pidpath` plus `lsof -Fn -p PID`'s executable (`txt`) vnode; both must agree with the snapshot and the process start time must be newer than the recorded session incarnation. The result is cached by `(session incarnation, pid, process-start-time, executable-snapshot)` after spawn/first observation, invalidated on any key change, and unknown results retry with persisted 10s/30s/90s backoff. Probes have a two-second timeout, a global concurrency cap of two, and never run per descendant. Cache rows are deleted on incarnation end/process death; stale retry metadata has a 24-hour TTL. Unavailable/conflicting/timeout measurement yields `ownership-unknown`. Symlink updates are re-derived only at the next session spawn; an in-flight session keeps its spawn snapshot. A daily/upgrade-triggered live canary re-derives first, then emits one deduplicated alerts-topic escalation only after three bounded failures; it never kills on drift. No basename-only process is ever called confirmed.

This is a safety guard on a destructive action: an over-match leaves a process running for later session-level health handling; an under-match can destroy a healthy session. It therefore intentionally fails toward no interruption. The classifier is narrow and token/basename based, not a substring such as `codex`.

Process discovery walks the descendant tree once from the framework PID, retaining parent edges and start-time identity to prevent PID-reuse mistakes. Protecting the host node does not hide actionable user-command descendants below it; those remain eligible for the existing judge. No new per-child `ps` or registry I/O is added. The bounded-wait classifier remains a separate safety floor because it describes command purpose, not process ownership.

### 2. Record delivery state, not keypress intent

Add a bounded `InboundDeliveryStore`, keyed by `(conversationId, deliveryId)`, with a bounded ordered set of live records plus the newest 20 terminal records per conversation and a 24-hour terminal TTL. Live rows are never evicted: their count and encrypted-byte ceiling equal the configured inbound queue maximum; preparation refuses with typed backpressure when either bound is reached. The 20-row/24-hour policy applies only after terminalization. It uses SQLite transactions/CAS (the project already depends on SQLite) and is the sole actuation-state store; JSONL remains audit-only and rotated. The record includes schema version, random delivery ID, session incarnation, framework, owner machine/epoch, transcript byte offset/event sequence baseline, deadlines, attempts, and state. It stores no message prefix: durable transcript correlation uses an agent-secret keyed HMAC of the normalized full envelope plus length/version; files retain mode `0600`.

Normally, backpressure never injects into an epistemically unknown composer. Every live row has a persisted observation deadline; expiry terminalizes its ledger state `unknown` but does not assert the physical composer is empty. At most one tracked delivery may be in `dispatched` or `composer-cleared` without transcript consumption per conversation/session; later prepared ordinals remain in the existing durable inbound queue behind it. Identical tracked messages therefore cannot overlap at the rollout boundary.

The operator channel nevertheless fails toward delivery without concatenating unknown drafts. If the lifecycle store is unavailable or saturated, `PendingInjectStore` retains each stable upstream message ID. Fallback uses a monotonic effect record, never a pre-send “delivered” tombstone: `queued -> armed -> effect-started -> sent-unverified | send-failed | effect-unknown -> reconciled-consumed | continuity-lost`. `armed` durably commits the safety fence and preserves body/ID; synchronous failure returns `send-failed` to queued. Immediately before tmux mutation, `effect-started` is fsynced. Successful return records `sent-unverified`, not delivered. Crash while `effect-started` becomes `effect-unknown`; it never dedups away the pending body or claims delivery. Only authenticated transcript/new-incarnation ordered-boundary evidence resolves consumed; otherwise the bounded operator-visible continuity-loss policy applies.

Fallback injection additionally requires the positive empty-composer contract while holding the effect lock: two stable observations across ≥250 ms, fence/effect-armed commit, then **two new stable empty observations** across another render interval, followed by latch/epoch re-read immediately before send. Any repaint/resize/modal/change refuses. If no fence/effect journal can commit or emptiness is unproven, inbound remains queued/redeliverable and owning-platform durable status reports that honestly. Tests cover crash before send, during send, synchronous failure, and composer change between every sample.

`PendingInjectStore` owns preparation retry with persisted 10s/30s/90s/270s backoff, 15-minute delivery deadline, stable platform message-ID dedup, per-conversation FIFO, and round-robin fairness; platform receipt is acknowledged only after durable queue commit. One outage episode gets one aggregated alerts-topic notice; queue caps/overflow are explicit. The composite authority consults both stores and refuses while either fence is unreconciled. Status exposes blocking rows/store/latch faults; authenticated reconciliation cannot delete live evidence or force an actionable state. Tests cover crash-after-send-before-projection, reboot with SQLite healthy, older authorized episodes, sustained outage, queue bursts, ACK/dedup, and overflow.

The existing per-session injection mutex allocates and persists `prepared` plus encrypted/pending replay identity **before** tmux dispatch. Every normal tracked send then uses the same-store monotonic effect phases `prepared -> dispatch-armed -> dispatch-started -> dispatched | dispatch-failed | effect-unknown`: arm commits in SQLite; started commits immediately before the first bracketed-paste/submit mutation; synchronous pre-effect failure may retry; crash or ambiguity after started raises the physical-uncertainty latch, preserves pending body/ID, and never blindly resends until authenticated transcript or fresh-incarnation ordered reconciliation. Runtime timeout/partial paste/paste-success-submit-timeout/success-before-final-CAS invokes the same reconciler before releasing the effect lock; it is not boot-only.

Sentinel keypresses persist one unique row per `(deliveryId, attemptIndex)`: `attempt-armed -> attempt-started -> attempted | effect-unknown`. Arming reserves one of exactly four rungs. A later holder under a necessarily newer lock epoch may classify old `attempt-armed` as proven pre-effect and re-arm the **same index** only when journal phase, delivery/incarnation, and unchanged complete-composer HMAC agree; equality with the obsolete acquisition epoch is not required. Started without terminal outcome permanently consumes the rung and becomes `effect-unknown`; it is never resent. Under a newer epoch, fresh composer evidence decides whether the next distinct rung may proceed. `attempted` means only tmux returned success. Exhaustion requires four attempted-or-possibly-applied distinct rungs plus positive marker persistence.

Correlation does not alter user-visible text. The source is the incarnation-pinned Codex rollout JSONL at `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-…-<rolloutId>.jsonl`, resolved through `TopicResumeMap`, never “newest rollout.” The reader accepts only complete newline-terminated events after the persisted byte offset, validates rollout/session identity and monotonic offset/time, and treats compaction/rotation as a typed boundary requiring a successor link. At dispatch, normalize the exact injected envelope (Unicode NFC, LF line endings, trim only the transport-added final newline), store its keyed HMAC/byte length, offset, and delivery ordinal. The narrow fresh-incarnation exception is the first bootstrap that creates Codex's rollout: exact full-envelope custody plus a durable `freshPreRolloutBootstrap: true` flag in `PendingInjectStore` may authorize the journaled physical effect while rollout identity is absent. That flag is written only for a genuinely fresh Codex spawn, never resume/recovery/legacy records. Codex's installed `.codex/hooks.json` `UserPromptSubmit` group includes the event reporter, which binds that same local, already-dispatched, null-rollout/-1-offset row to the incarnation-pinned generation at offset zero. Refusal retains pending custody and propagates as recovery failure; non-bootstrap, imported, pre-bound, nonlocal, resumed, or unflagged rows cannot enter this path. A live Codex incarnation still lacking a generation after a two-minute startup grace is stale: conversational ingress retains its source message, clears any prior resume UUID, replaces the incarnation fresh, and carries bounded history plus the current inbound in the new bootstrap. The unverifiable preflight occurs before ledger preparation, so a refused stale-incarnation attempt cannot manufacture a terminal `dispatch-failed` row. `turn-consumed` is the first complete matching post-baseline user response item at the expected ordinal. For the pinned Codex schema, the enclosing `task_started`/`task_complete.turn_id` is the generation authority. When a response item includes `internal_chat_message_metadata_passthrough.turn_id`, that field must be a non-empty string equal to the enclosing turn; current Codex versions may omit the redundant per-item field, but a present malformed or conflicting field yields `unknown`. `responded` is a completed assistant item inside that same task interval under the same rule. Unknown event shapes, partial items, missing required task IDs, unlinked rotation, or truncation yield `unknown`. Captured fixtures pin the supported schema and a drift fixture proves fail-closed behavior. Telegram/bootstrap prefixes are part of the envelope; identical repeated messages remain distinct by ordinal and offset.

Composer correlation is deliberately narrower than transcript correlation. A versioned `CodexComposerAdapter` extracts exactly one input-box region from the complete visible pane using a pinned tmux screen mode plus prompt/status/cursor structure; it excludes scrollback/transcript rows and reconstructs complete UTF-8 across wrapped lines. Live Codex 0.2xx evidence reports `#{alternate_on}=0`, so adapter `codex-0.2xx-primary-v1` requires primary-screen mode and treats an alternate-screen transition as schema drift until a separately pinned adapter ships. A positively empty ready composer requires the pinned empty-input prompt/status structure, cursor at the input origin, no approval/onboarding/modal, placeholder/ghost text matching the pinned ANSI/dim presentation semantics, full viewport boundaries, and two identical observations separated by at least one render interval (250 ms). Automatic keypress recovery is allowed only when both boundaries and cursor are unambiguous, the full region fits the configured byte bound, and its normalized full-envelope HMAC matches. Multiple prompts, clipped top/bottom, pane resize uncertainty, cursor outside the region, screen-mode uncertainty, scrollback loss, invalid UTF-8, or oversized input yields `unknown`; no absence or partial-text test may authorize a keypress. Only actionable `dispatched` rows are probed. Pane captures are asynchronous with concurrency four, 750 ms per-capture timeout, and per-sweep budgets of 20 captures/25 ms scheduling time; sweeps never await serial batches past cadence and overlapping sweeps coalesce/refuse. Nearest deadline wins and ties round-robin. Missing a row's deadline terminalizes it `unknown`, raises physical uncertainty, and reports backlog/lag/exhaustion. Fixtures/live canary cover empty/ghost placeholders, wrapped multiline, identical scrollback text, resize, and truncation.

FIFO is invariant: once any newer ordinal has been dispatched, every older exhausted delivery becomes terminal `superseded`, is permanently ineligible for replay, retains its immutable loss evidence, and produces one deduplicated operator-visible notice. Recovery also cannot act while newer input occupies or may occupy the composer; replay preserves the original delivery ordinal.

The canonical stored tuple is `(transportState, composerState, transcriptState, eligibilityState)`: transport=`prepared|dispatch-armed|dispatch-started|dispatched|dispatch-failed|effect-unknown`; composer=`unobserved|present|cleared|unknown`; transcript=`unseen|consumed|responded|unknown`; eligibility=`open|keypress-exhausted|superseded|continuity-lost|unknown`. Projection order is deterministic: responded, consumed, administrative eligibility terminal, composer-cleared, then transport state. Impossible tuples (responded without consumed, composer-present after continuity loss, actionable unknown) quarantine. Fields never overwrite independent evidence.

State projections are monotonic:

```
prepared -> dispatch-armed -> dispatch-started -> dispatched -> composer-cleared -> turn-consumed -> responded
   |              |                |                    |              |
   +-> dispatch-failed             +-> effect-unknown   +-> exhausted  +-> unknown
                                                            |              |
                                                            +-> unknown    +-> superseded / continuity-lost
```

| From | To | Writer | Required evidence/CAS | Terminal |
|---|---|---|---|---|
| none | prepared | injection funnel | next conversation ordinal + encrypted replay envelope committed | no |
| prepared | dispatch-armed | injection funnel | same-store effect intent + lock/file epoch committed | no |
| dispatch-armed | dispatch-started | injection funnel | committed immediately before first tmux mutation | no |
| dispatch-started | dispatched | injection funnel | tmux paste+submit returned success for same incarnation | no |
| prepared/dispatch-armed | dispatch-failed | injection funnel | synchronous evidence proves no physical mutation | yes |
| dispatch-started | effect-unknown | boot/effect reconciler | crash/ambiguous result; physical uncertainty latch committed | yes; body/ID preserved, no blind resend |
| dispatched | composer-cleared | observer | complete bounded composer buffer no longer matches after stable idle observation | no |
| dispatched | exhausted | sentinel | complete bounded composer-buffer HMAC still matches through bounded ladder/deadline | yes for keypress; recovery-request eligible |
| exhausted | superseded | injection funnel | a newer conversation ordinal was dispatched | yes; permanent replay refusal + bounded notice |
| exhausted | continuity-lost | refresh reconciler | old incarnation gone and resume/successor continuity positively failed | yes; permanent replay refusal + bounded loss notice |
| prepared | unknown | observer/store | pre-dispatch correlation/schema/key unavailable; pane untouched | yes; never actionable; physical FIFO unaffected |
| dispatched | unknown | observer/store | composer evidence unavailable after pane mutation | yes; atomically raises physical-uncertainty latch; later input remains queued |
| composer-cleared | unknown | transcript observer | transcript evidence unavailable after positive composer clearance | yes; never actionable; physical FIFO may advance |
| composer-cleared | turn-consumed | transcript observer | first matching post-baseline user item + ordinal | no |
| turn-consumed | responded | transcript observer | later assistant item bound to the consumed turn | yes |

Every other delivery transition is forbidden. `exhausted` is closed for keypress/ordinary advancement and permits only the listed administrative terminalizations: `superseded` when newer inbound wins, or `continuity-lost` after failed scoped refresh. Later evidence does not repair `unknown`. Recovery is tracked separately:

| From | To | Writer/evidence | Terminal | Failure budget / retry |
|---|---|---|---|---|
| none | requested | recovery consumer CAS on exhausted delivery | no | none; only one episode per delivery |
| requested | denied | composite authority floor/supervisor refusal | yes | not acted; no retry |
| requested | dry-run-complete | dry-run records would-authorize, no capability | yes | not acted; no retry |
| requested | authorized | authority atomically inserts unconsumed opaque capability + sequencing lease | no | acted episode begins |
| authorized | effect-armed | one SQLite transaction consumes capability + inserts recovery effect-journal row before mutation | no | capability can never be reused |
| effect-armed | effect-started | fsynced immediately before kill/send | no | boot must reconcile physical evidence |
| effect-started | effect-observed | old/new PID+start+tmux incarnation proves scoped effect occurred | no | continue readiness/replay observation |
| effect-armed/effect-started | failed/effect-unknown | pre-effect evidence or ambiguity | yes | deny replay; run bounded continuity compensation |
| effect-observed | refresh-complete | new incarnation ready with positively empty composer | no | failure transitions `failed` |
| refresh-complete | replay-claimed | same lease + owner epoch + delivery dedup CAS | no | no second claim |
| replay-claimed | replayed | canonical funnel dispatch in new incarnation | no | failure transitions `failed` |
| replayed | consumed/responded | pinned transcript evidence | yes | positive recovery closes breaker |
| requested/authorized/refresh-complete/replay-claimed | failed:superseded | newer inbound wins sequencing CAS before replay dispatch | yes | counts only if refresh effect already occurred |
| authorized/refresh-complete/replay-claimed/replayed | failed | capability expiry, refresh/replay failure, deadline, or session death | yes | acted failure counts |

The delivery's original exhaustion evidence is immutable. Normal inbound may win only before refresh effect arming or after `refresh-complete` but before replay claim; once replay wins, inbound queues until terminal evidence. Replay deadline is five minutes. Recovery effect journals live in the same SQLite store/transaction as capabilities; the independent `PendingInjectStore`/file journal is used only for SQLite-outage fallback, so no recovery transition claims cross-store atomicity. Stable operation IDs link audit projections but never choose “newer copy.”

Boot reconciliation dispatches by effect type. Refresh: armed + unchanged old incarnation => failed-before-effect; started + old absent/new distinct => observed; started + old unchanged => failed-before-effect; old absent/no trustworthy new => unknown/continuity compensation. Replay: armed before send => failed-before-effect; started without authenticated matching transcript evidence => effect-unknown and never resend; matching transcript => observed/consumed. Reconciler proposes these typed transitions through the store worker but cannot mint capabilities or repeat ambiguous effects.

- `dispatched`: bracketed paste and submit key were sent successfully.
- `composer-cleared`: HMAC-correlated text left the composer; this claims only presentation change, not consumption.
- `turn-consumed`: transcript growth after the persisted dispatch offset contains the generation-bound inbound turn.
- `responded`: a later assistant item causally follows that inbound turn.
- `unknown`: evidence is missing, corrupt, raced, or cannot be safely correlated. Terminal for automatic keypress/refresh/replay. On a healthy DB, post-dispatch unknown and latch epoch commit in one transaction; outage paths fsync the independent journal/latch first and project later. It cannot release later inbound until fresh-incarnation/empty-composer reconciliation; pre-dispatch and post-clear unknown do not claim unresolved pane text.
- `exhausted`: positive correlation proves the same draft remains after the bounded recovery ladder. Only this state may request deeper recovery.
- `superseded`: a newer ordinal was dispatched after exhaustion; the older draft is reported as lost/stale and can never replay.
- `continuity-lost`: scoped refresh could not preserve the old rollout; the delivery remains loss evidence while a positively ready new baseline unblocks later queued input.

`fireStuckInputRecovery()` continues to report only that a keypress was attempted. `StuckInputSentinel` owns the later observation that determines whether the attempt worked. JSONL events gain typed transition/outcome fields; existing fields remain readable for compatibility.

### 3. Route exhaustion through the existing recovery authority

The sentinel does not directly decide to refresh a session. On exhaustion it emits a typed, durable `stranded-draft-exhausted` signal to the existing `SessionRecoveryChannel`. The existing recovery consumer remains the channel/consumer seam, but it may act only with the composite authority's typed capability; its configured dark/off state remains explicit.

Recovery requests carry schema version, conversation/delivery ID, source machine, owner epoch, session incarnation, and bounded typed reason—never detector-supplied allow booleans. Channel reads validate size, schema, enums, identifiers, timestamps, control characters, and age. Immediately before **both** scoped session refresh and replay, the composite authority re-reads the durable operator-stop epoch, current owner/lease epoch, conversation activity, session incarnation, delivery state, replay identity, sequencing lease, and breaker. Every refusal is typed and audited.

This action decision is classified as an **invariant deterministic authority**, not an LLM judgment: every admissible state is enumerated and any unavailable input refuses actuation.

Because refresh/replay is critical, one composite `RecoveryActuationAuthority` emits the only typed authorization capability or denial. Deterministic floors are non-overridable. Tier-1 supervision is policy-required only for Stage C and never runs on normal Stage-B verification. It receives at most 4 KiB of ANSI/control-stripped, secret-redacted pane/process narrative plus typed enums, with message bodies/HMAC material excluded; timeout is two seconds and output is a closed veto enum. It evaluates semantic active-work/contradiction signals that process enums cannot represent (for example, a quiet process whose pane says an upload is advancing). Unavailable, slow, inconsistent, or injected output vetoes optional refresh without degrading delivery. It never establishes identity, state, or success.

The final decision, floor inputs, supervisor result, and conversation sequencing lease commit atomically. A capability is an opaque ID referencing a SQLite row with effect, identities/epochs, observed safety-latch epoch/high-watermark, expiry, and `consumedAt`. Authority issuance performs `requested -> authorized(unconsumed)`.

All physical composer/session effects serialize through a `PhysicalEffectLock` interface plus monotonic fsynced epoch. Provider conformance requires cross-process mutual exclusion, nonblocking deadline-aware acquire, kernel release on process death, owner identity, no stale-file authority, and epoch durability. macOS/Linux use `flock`. Windows selects `LockFileEx` on a SHA-256-named file beneath the agent-local lock directory, opened with owner-only DACL/no sharing that weakens exclusivity; the provider reports PID/start identity and treats abandoned/crashed ownership as acquire-then-reconcile, never success-without-reconciliation. If no conforming provider is available, Stage B remains typed-dark and cannot claim parity. All physical mutation uses this interface.

Provider metadata lives in agent-owned restricted storage (`0700`/Windows ACL equivalent); SHA-256 names, no-follow/regular/owner checks where applicable, and durable epoch writes apply. Every acquisition increments epoch before observation; effect arm increments a subepoch. One waiter is a wakeup only; intents stay queued. Ordering is physical lock then short SQLite transaction. Provider conformance tests run on every supported OS, plus a real Windows E2E kills the holder between `dispatch-started` and mutation and proves the successor acquires, increments epoch, reconciles, and never blindly resends/keypresses.

`refresh-complete` requires all of: old `(pid,startTime,tmux incarnation)` absent; new distinct incarnation registered to the same conversation/current owner epoch; Codex launcher/host alive; `TopicResumeMap` bound to the expected rollout or authenticated successor; and `CodexComposerAdapter` reporting exactly one complete empty ready composer twice across a render interval, with no onboarding/approval prompt. The persisted readiness deadline is 90 seconds. Timeout/ambiguity transitions `failed`, performs bounded lease cleanup, and leaves queued inbound untouched for retry. If continuity is positively lost after the old session died, one SQLite transaction terminalizes `continuity-lost`, commits the new ready rollout baseline, releases the lease, and authorizes exactly-once queue drain. Crash before commit leaves input queued; crash after commit resumes drain idempotently. The lost delivery never replays/disappears and no old offset is reused.

Replay takes the recovery episode's durable CAS claim on `(conversationId, deliveryId, ownerEpoch, newIncarnation)` only after fresh readiness/empty composer. One delivery ID may replay once total; receiver dedup plus episode claim provides effective once-only consumption. Denial/veto/dry-run do not consume failure budget. Acted success requires new-incarnation transcript consumption. The durable breaker opens until verified success or operator reset on either three acted failures inside six hours **or three consecutive acted failures over lifetime**; elapsed time never clears consecutive failures. Verified success resets consecutive count; one episode per delivery remains invariant. Operator stop dominates refresh/transfer.

### 4. Preserve state ownership boundaries

| Observed state | Owner | Allowed action |
|---|---|---|
| Framework tool host alive | Framework/session lifecycle | Observe; never command-kill |
| User command with positive stuck verdict | `SessionWatchdog` | Attributed bounded escalation |
| Injected marker still in idle composer | `StuckInputSentinel` | Bounded submit recovery |
| Delivery recovery exhausted | `SessionRecoveryChannel` consumer | Scoped session refresh/replay if enabled and safe |
| Completed turn with explicit open tasks | Continuation/autonomous reconciler | Fresh bounded continuation |
| Completed turn with no obligation | Normal session lifecycle | Remain idle |
| Session process dead with evidenced work | Resume queue | Bounded respawn |

No subsystem infers another subsystem's state from silence alone.

| Durable object / lock | Physical writer | Authorized proposer / effect holder | Serialization boundary |
|---|---|---|---|
| delivery row + transcript cursor | server-owned store worker | funnel / observer | SQLite transaction/CAS |
| normal prepared inbound | server-owned store worker | delivery funnel | injection mutex + sequencing lease |
| attempt owner epoch | server-owned store worker | `StuckInputSentinel` / key primitive | delivery CAS |
| recovery episode/capability | server-owned store worker | consumer/composite authority / refresh owner | SQLite transaction/CAS |
| conversation sequencing lease | server-owned store worker | normal funnel or recovery authority, never both | lease generation |
| transfer import/token | target store worker | transfer/import authority | snapshot transaction + ownership CAS |
| ownership epoch | ownership store writer | shared ownership claim authority | import/loss token in same CAS |
| fallback effect journal | `PendingInjectStore`/independent 0600 file | fallback funnel; reconciler classifies only | used only when lifecycle DB unavailable |
| recovery effect journal | server-owned SQLite worker | composite authority / scoped effect holder | same transaction as capability consume |

## Symbols, claimed states, and corroboration

| Symbol read | Claimed real state | Independent corroboration | Unmeasurable result |
|---|---|---|---|
| Child basename matches the Codex host | Suspected framework infrastructure | Recorded Codex framework + trusted executable identity + incarnation-bound parent-role edge | `ownership-unknown`; preserve and audit; descendants still inspected |
| HMAC of the complete bounded composer buffer matches the delivery | Specific inbound remains in the composer | Durable delivery ID/incarnation plus idle-pane evidence newer than dispatch | `unknown`; no keypress/refresh/replay |
| Complete bounded composer buffer no longer matches after a stable idle observation | Composer no longer displays that complete draft | None required for this observational state; later transcript evidence independently advances consumption | Record only `composer-cleared`; truncation/scroll loss is `unknown` |
| Generation-bound inbound appears after transcript baseline | Codex consumed the inbound | Matching conversation/incarnation/delivery envelope | `unknown`; do not replay or claim consumption |
| Session absent after intervention | Session died | Session registry plus tmux/process liveness | `unknown`; queue no destructive action from absence alone |

## Decision points touched

| Decision | Classification | Justification / floor and authority |
|---|---|---|
| Exclude a confirmed framework-owned host from command killing | `invariant` | Safety floor on a destructive action; exact ownership plus recorded Codex framework. False uncertainty resolves to no destructive action until contextual judgment is available. |
| Decide whether the composer cleared | `invariant` | HMAC-correlated marker disappearance is only a presentation transition. |
| Decide whether Codex consumed/responded | `invariant` | Requires monotonic generation-bound transcript evidence newer than the persisted baseline. |
| Decide whether to refresh/replay after exhaustion | `invariant` | Composite `RecoveryActuationAuthority`: deterministic non-overridable floors cover operator stop, target-session activity, ownership/epoch, incarnation, FIFO sequencing lease, replay identity, episode, and breaker; mandatory Tier-1 validation may veto but cannot authorize around a floor. It emits the sole one-use typed capability or denial. |
| Decide whether completed work should continue | `judgment-candidate` | Existing explicit task ledger/autonomous-run obligation is the floor; existing continuation/reconciler authority remains unchanged. No new decision logic. |

## Self-heal and loop brakes

The recoverable degradation is a stranded inbound draft. The self-heal sequence is the existing four-action keypress ladder followed, when enabled, by one recovery-channel request. Brakes:

- `max-attempts`: four keypress actions plus one recovery request per generation.
- `max-wall-clock`: persisted `deadlineAt`, not tick counts; each probe has a timeout and delayed sweeps cannot extend the deadline.
- `backoff`: persisted exponential intervals 10s, 30s, 90s, 270s between failed attempts, capped at the delivery deadline; fixed polling is not called backoff.
- `dedupe-key`: conversation + immutable delivery ID + owner epoch.
- `breaker`: one replay per delivery; after three failed episodes the durable conversation breaker opens and remains open until positive verified recovery or operator reset—never a rolling-window auto-close.
- `max-notification-latency`: 120s after the last advancing transition (`authorized`, `refresh-complete`, `replay-claimed`, `replayed`). Retries, supervisor in-progress, audits, and lease heartbeats do not reset it.
- `audit-location`: scrubbed metadata in `stuck-input-events.jsonl`, recovery-channel audit, and watchdog intervention JSONL.
- `remediation-actions`: submit-key retry; optional scoped session refresh plus effective once-only pending-inject replay. Compensation is the existing resume mapping, sequencing lease, recovery-episode claim, and replay idempotency gate.

Session death or possible work loss is high severity: record/notify immediately while resume recovery proceeds. A recoverable stranded draft heals first and notifies only after the bounded ladder exhausts or the 120s ceiling is reached.

The watchdog's existing `scheduleSupervisorContinuation()` is removed as an independent injection engine. Any continuation after intervention must enter the canonical delivery funnel and prove an explicit open obligation through `CodexTaskContinuationStore` or autonomous-run state, with the same ownership/incarnation/stop fences. Its 60-second outcome becomes `session-alive` unless incarnation-bound command/turn progress proves `recovered`; ambiguous/absence is `unknown`.

All injection call sites—initial readiness, Telegram/Slack, watchdog recovery, compaction, autonomous recovery, resume queue, and internal continuation—must use one `SessionInputDeliveryFunnel`. Direct state-mutating `sendInput` use is forbidden by a repository lint/wiring ratchet; low-level key APIs remain only for non-message control primitives.

## Multi-machine posture

Unified at the conversation level by production-wiring the currently test-only `TransferOrchestrator` seam as part of this change; it is not claimed as already deployed authority. The implementation supplies real source flush, recipient RPC, target import, verified acknowledgment, and ownership-CAS dependencies and exercises them through production `server.ts`. `LedgerSnapshot` gains versioned delivery-state and recovery-episode rows and the sync manifest covers them. The source enters `transferring`, drains, flushes the SQLite delivery snapshot, and the target's local server-owned store writer imports it in non-actuating `imported-pending-claim` state. The target verifies and durably commits the import before returning the acknowledgment; only then may target ownership advance from epoch e+1 to e+2 and make rows eligible, followed by source release. Failed claim quarantines/GCs the imported rows idempotently. Duplicate import is delivery-ID idempotent. An older/dark/incompatible target refuses verification, so the source retains the non-active transferring record and no machine actuates until retry/rollback restores compatibility. Crash tests cover every protocol boundary. Process PIDs/audit rows remain machine-local physical truth and pool diagnostics merge them. Notices use current owner lease plus durable `(conversation, delivery, notice-kind)` dedupe. No URLs are generated.

Every ownership epoch transition uses the conversation sequencing/effect fence. Planned transfer source first acquires the sequencing lease, drains all effects to terminal journal state, then snapshots; target claim refuses any unexpired sequencing/effect lease or armed/started journal. Refresh holds a durable lease renewed through readiness and non-releasable until journal terminalization; ownership cannot expire underneath it. Source-dead import converts every such record to `unknown/lost-epoch`, fences the old owner epoch permanently, and old-owner wake-up cannot resume. Claim races are tested immediately before/after arm/start, renewal/expiry, snapshot, and stale-owner wake.

Why now: stage B creates live rows from the moment an inbound is prepared until transcript response or deadline, which can span a normal topic transfer even while recovery remains dark. Shipping stage B without transfer support leaves the source holding the only encrypted replay identity and observer cursor while the target accepts later ordinals; that either strands the older message, reverses FIFO, or permits both machines to judge it. Therefore transfer compatibility is a correctness prerequisite of observable delivery state, not merely future recovery hardening.

At-rest and wire encryption are separate. Each machine uses opaque `sealLocalDelivery`/`openLocalDelivery` methods backed by a dedicated versioned delivery-store HKDF subkey, never raw SecretStore master-key reuse. Local AEAD AAD binds agent, conversation, delivery ID, schema, and key version; old keys remain decrypt-only through live-row/terminal TTL expiry. Transfer uses a distinct domain-separated primitive. Canonical closed-schema AEAD AAD binds registered source/recipient fingerprints, pairing epoch, agent, conversation, delivery ID, source/target owner epochs, normalization/schema, and transfer-attempt ID. Source signs the complete canonical sealed envelope—cross-protocol domain tag, algorithm/version, ephemeral public key, nonce/IV, tag, ciphertext, and AAD with strict encodings/lengths—using its registered Ed25519 key. Target resolves that key independently from the authenticated peer-registry entry at the exact pairing epoch, verifies current transfer-source ownership/challenge, rejects revoked/rotated keys, and replay-watermarks the signed attempt before decrypt/import. Missing/extra/wrong fields, duplicate attempt, signature failure, or substitution refuses transfer.

Source decrypts only in memory. Target re-normalizes with the signed supported normalization version, verifies plaintext byte length/envelope schema, recomputes the envelope HMAC under its own correlation key/version (source HMAC is never authoritative), and atomically stores `(hmac,keyVersion,normalizationVersion,length)` with local ciphertext/import state before ACK. Tests cover local row swaps/wrong key version, malicious peer substitution, wrong source/conversation/epoch/recipient, unsupported normalization, distinct keys, rotation, and source loss.

The import-verification token is required by the shared ownership claim/CAS authority for **every** path. It binds conversation, target, expected epoch transition, manifest hash, schema, expiry, source-death episode, and durable membership epoch/set hash. Planned transfer requires authenticated current-source ACK and may import enumerated actionable state. Source-dead recovery requires positive lease expiry plus independent mesh/process unreachability, fences the lost epoch, and searches manifests for at most 120 seconds. All non-terminal rows from the lost epoch import only as `unknown/lost-epoch`, permanently non-actionable; IDs/ordinals/tombstones remain diagnostic.

The sole-survivor exception exists only when the durable eligible membership set at that epoch contains exactly two members: dead source plus claimant. For `N >= 3`, threshold is `floor(N/2)+1` signatures from the full epoch membership set (the dead source remains in N but cannot sign), or a pre-existing unique consensus/lease authority; each token carries exact voter set/threshold. Silence never elects during partition. Placement-score then machine-ID tiebreak names the proposer. Membership change invalidates search/token. Lack of quorum remains unavailable with bounded retry/operator attention. Tokens consume in ownership CAS.

## Configuration, maturation, and operational status

`monitoring.codexSessionLifecycle` uses:

| Key | Exact effect |
|---|---|
| `ledgerObserverEnabled` | constructs ledger/adapters and assigns attempt ownership; never disables host protection |
| `observeOnly` | preserves legacy key effects but suppresses new recovery requests |
| `recoveryEnabled` | permits authority evaluation after maturation |
| `dryRun` | records `dry-run-complete`; mints no capability/effect |

The Stage-B RC artifact canonically includes package/git/config hashes, Echo machine identity, time range, per-case denominators, raw-evidence digests, zero-failure counters, and reviewer decision. Echo signs it with its registered agent Ed25519 key; release tooling verifies it before publication. Migration writes pending activation only for absent→true or already-true observer settings, never explicit false. Startup clears it only after schema, per-connection FULL verification, lock-provider conformance probe, old-callback death, and attempt-owner acquisition all succeed; failure leaves configured-versus-active explicit and Stage B inactive.

The observer is an Eternal Sentinel: normal sweeps have a five-second floor plus the transcript/pane caps above. Transcript, pane, auxiliary-GC, and outage-reconciliation workers each allow one in-flight sweep; missed ticks coalesce rather than queue, and GC resumes its batch next cadence. Store/adapter failure backs off 10s/30s/90s/270s then continues capped. One sustained-failure episode emits one deduplicated notice after bounded self-heal; recovery resumes ordinary cadence. Every sweep/failure is metadata-audited.

Stage A/B publication is conditional on the signed Stage-B RC artifact above, not generic live reproduction alone. Stage C promotion is Echo observe-only ≥24h/50 deliveries → dry-run → explicit canary → fleet opt-in. Status reports mode/health/counts/wiring/breaker/degradations without content.

## Persistence, migration, and rollback

Each machine's local server-owned store worker is the sole SQLite writer. On every connection/reopen it sets and verifies WAL `synchronous=FULL` before accepting dispatch/attempt/recovery effect-boundary writes; inability to confirm makes tracked mutation unavailable. It also uses `busy_timeout=1000ms`, shorter outer deadlines, versioned CAS, quarantine, and `0600`. Tests cover WAL checkpoint/reopen and process/power-loss simulation. Timeout maps to typed backpressure and dark recovery.

`migrateConfig()` adds missing keys only. `generateClaudeMd()` and content-sniffed `migrateClaudeMd()` add diagnostics/behavior awareness. CapabilityIndex and status wiring ship together. Transfer payloads negotiate schema version. Legacy in-memory markers and pending-inject rows are adopted as `unknown` without actuation unless a delivery ID and HMAC can be safely reconstructed. The pending-inject schema/API gains immutable delivery ID, locally encrypted replay envelope, sync re-wrapping, and durable dedup tombstones.

Downgrade safety is forward-compatible: observation/actuation may be disabled, but the compatibility projector preserves delivery IDs/tombstones in legacy pending-inject records until their 24-hour TTL. An older binary lacking that projector is below the downgrade floor; rollback waits for zero live rows or ships a forward hotfix. The prior claim that old code could ignore JSON was incorrect and is removed.

## Observability and alternatives

Metrics expose deliveries by terminal state/framework; dispatch-to-clear, dispatch-to-consume, and dispatch-to-response latency; recovery rung attempts/success; protected and ownership-unknown host observations; replay claims won/lost; and deaths within five minutes of intervention. Every count includes a denominator and no message bodies.

Each attempted/denied CAS, ownership-unknown observation, supervisor input/verdict, and terminalization must commit a durable transition/audit row in the same transaction; actuation refuses if required audit cannot commit. Best-effort JSONL is projection only. Conversation-owned exhaustion notices stay in that conversation; ownerless/corrupt/global failures aggregate into the single alerts topic. Durable dedupe suppresses after recovery, stop, or transfer, and burst tests prove N failures create bounded notices and no topics.

Bounds are workload-derived from `multiMachine.sessionPool.inboundQueue` (`InboundQueueConfig`). Per-conversation live count is `maxPerSession`; global live count is `min(maxTotal, hardMaxTotal)`; total encrypted bytes are `globalCount × (maxPayloadBytes + 512-byte AEAD/schema overhead)`. If queue settings are absent/dark, conservative defaults are 10 per conversation, 100 global, and 256 KiB payload. Only one row per conversation may be unconsumed/dispatched; others are durable prepared queue rows. Twenty terminal rows retain 2× ordinary diagnostic history; 24 hours exceeds the longest 12-hour autonomous window plus delayed response/rollback observation. Each rollout has one persisted monotonic `observedThroughOffset`/complete-event sequence. A shared scanner parses each complete byte once, CAS-advances past unmatched complete events, and fans events out to all live deliveries on that rollout. Each sweep has defaults of 1 MiB/50 ms aggregate, prioritizes nearest observation deadline then round-robins ties, and resumes fairly; status reports backlog bytes, oldest lag, and budget exhaustion count. Max expected observation lag is two sweep intervals below capacity; exceeding it is a typed degradation. Per-rollout chunks remain capped at 256 KiB; reaching the cap mid-event yields explicit `unknown`, never a truncated judgment.

Auxiliary persistence is independently bounded. Active leases/capabilities and unreconciled safety records are never evicted. Dedup records retain at least seven days; transfer watermarks retain through validity+seven days. Terminal episodes/capabilities/notices/audits retain 24h then compact to 30-day counters. The first reached of 100,000 logical rows or 256 MiB SQLite main+WAL bytes opens a recovery-storage breaker. A reserved-capacity control row stores a monotonic breaker epoch; capabilities bind it and effect-time mismatch refuses. If disk-full/read-only prevents even that write, direct size/write-health observation itself fails effects closed—no additional DB write is required—and owning-platform status remains available. Background terminalization batches later. GC deletes ≤500 rows/25 ms and never live evidence.

An append-only/replicated log alone was rejected because actuation requires local transactional CAS across delivery, episode, capability, and ownership epochs; replaying a log does not atomically fence the current tmux owner. A generic workflow/queue engine was rejected because Instar already has durable pending-inject transport, ownership CAS, and transfer manifests; adding another coordinator creates dual authority and an external dependency. The scoped additions extend those primitives and remain SQLite-transactional. Restart-on-silence was rejected because silence is legitimate for waits, hosts, and completed turns.

`CodexRolloutAdapter` owns the upstream-private transcript boundary. Official Codex CLI documentation exposes no supported delivery/turn event hook suitable for this correlation, so the adapter is the explicit compatibility seam rather than a claimed public contract. It exposes versioned internal events; no other component parses raw JSONL. Codex package upgrade is blocked from promotion until captured fixtures/live canary pass. Forced drift makes Stage B use its safety-latched fallback/status policy and keeps Stage C dark; it never blocks the owning platform indefinitely or fabricates consumption.

There is no degraded mode that fabricates consumption from weaker evidence: adapter drift terminalizes affected rows `unknown`, disables automated recovery for them, and keeps later inbound in the durable queue until a safe fresh-session readiness check can drain it. Status and one bounded notice name `rollout-schema-unsupported`; updating the adapter/fixtures is owned by the Instar Codex integration and is a release gate for newly supported Codex versions.

Adapter drift triggers bounded repair for at most 120 seconds, then delivery falls toward the safety-latched legacy path rather than holding normal inbound indefinitely; refresh/replay remains dark until adapter conformance returns. Tier-1 example: process enums say idle while a bounded pane excerpt says “uploading release artifact 72%,” so the closed-enum result `veto-active-work` prevents a capability. Empty, slow, truncated, inconsistent, or prompt-injected output yields `veto-uncertain`. No supervisor output can bypass a deterministic floor or establish transcript success; fixtures prove this under unavailable/delayed/inconsistent results.

End-to-end example: Telegram inbound `D7` is persisted as `prepared`, then tmux dispatch makes it `dispatched`. The complete composer clears, so observation records `composer-cleared` but does nothing destructive. The pinned rollout adapter later emits the expected `user-turn(D7, turn=T9)`, advancing to `turn-consumed`; an assistant item inside task `T9` makes it `responded`. If the complete composer instead still matches after all four legacy attempts, `D7` becomes `exhausted` and opens one recovery episode. A newer dispatch permanently supersedes it. Otherwise the dark recovery pipeline records what its composite authority would decide; only a post-maturation canary may consume a scoped refresh/replay capability.

This spec distinguishes containment from root repair. Scoped refresh/replay is optional containment. The release includes fleet-live Stage A/B after the Echo pre-release canary, dark Stage C, and a live affected-TUI reproduction. Stage-C canary/promotion is post-merge maturation.

## Required testing and production wiring

### Capability map

The production implementation is split across explicit capability seams so
diagnostics and future changes have one named owner:

- `CodexComposerAdapter` reconstructs and classifies the complete visible
  composer without treating disappearance as acceptance.
- `CodexDeliveryObserver` correlates bounded rollout events with composer
  observations and fails ambiguous evidence to `unknown`.
- `InboundDeliveryStore` owns the FULL-durable delivery, attempt, cursor,
  notice, breaker, and transfer records.
- `PhysicalEffectLock` provides cross-process exclusion and monotonic epochs;
  `TrackedPhysicalEffectDispatcher` journals every physical mutation around
  that lock.
- `RecoveryActuationAuthority` is the one-shot, delivery-scoped authority for
  any future Stage-C action; Stage C remains dark in this release.
- `StageBActivationGate` binds activation to exact signed release evidence,
  while `StageBStartupReadiness` proves schema, FULL durability, lock-provider
  conformance, old-callback death, and attempt ownership at restart.
- `FrameworkProcessProvenance` proves a process belongs to the pinned Codex
  host before the command watchdog may classify it as framework infrastructure.

- Unit: store schema/CAS/TTL/HMAC/key failure, queued identical delivery serialization/backpressure bounds, delivery and recovery-episode tables, sequencing-lease CAS races, advancing shared transcript cursor/schema drift, composer adapter boundaries, cached process provenance/tree/PID reuse/live host canary, closed-enum supervisor/composite-authority vetoes/capability expiry, breaker/backoff/deadlines, FIFO supersession, dedupe and migration.
- Integration: real config/API/recovery channel and server-owned store; dark/observe/dry-run/live boundaries; byte-equivalent single-owner legacy key ladder/timer drain; every crash boundary; forged channel input; scoped refresh/new-incarnation readiness; imported-pending-claim at every ownership claimant; domain-bound transfer encryption/rotation/source-loss matrix.
- E2E: production `server.ts`, production-wired `TransferOrchestrator`, canonical session-refresh path, and non-null real store/sentinel/consumer/ownership/supervisor dependencies; pre-feature migration fixture; two-node transfer/import/epoch lifecycle including reconciler race; effective once-only replay and exactly one continuation.
- Live incident evidence: affected Codex TUI before/after reproduction, watchdog host protection observation, verified consumption, bounded continuation, and no duplicate topic session. Release evidence names concrete commands/results.

## Frontloaded Decisions

1. Destructive command remediation fails toward preserving a process when framework ownership or progress is uncertain.
2. Recovery reuses the existing channel/consumer seam and canonical scoped session-refresh owner; no parallel restart controller is introduced.
3. Delivery success requires generation-bound transcript evidence; composer clearing and tmux dispatch are weaker states.
4. Stage A enforces immediately; Stage B must pass its two-hour/50-delivery Echo pre-release canary before the release enables it fleet-wide; Stage C remains observe-only/dark until its separate canary.
5. SQLite CAS, bounded live backpressure, retention, HMAC privacy, effective-once replay, production-wired TransferOrchestrator fencing, durable breaker, and composite Tier-1-supervised actuation are approved behavior-shaping choices.
6. Pinned Codex rollout JSONL, normalized-envelope HMAC plus ordinal/offset, and the pinned event-shape/turn-ID table are the transcript correlation contract; composer recovery additionally requires the complete bounded composer buffer. Missing evidence resolves `unknown`.
7. Replay envelopes use local versioned at-rest keys and recipient-bound sync re-wrapping with epoch/schema AAD; key rotation retains required source material through verified ACK/TTL, while missing keys refuse transfer or resolve local observation `unknown`.
8. Incompatible transfer targets refuse import and cannot claim; the source stays non-actuating in `transferring` until compatibility or existing transfer rollback.
9. Recovery uses a separate monotonic episode state machine, a conversation sequencing lease, scoped session refresh, and one-use effect-bound capabilities; newer dispatched ordinals permanently supersede older exhausted deliveries.
10. Stage B uses its two-hour/50-delivery signed RC gate before publication; Stage C uses a separate ≥24h/50-delivery post-merge canary before fleet recovery enablement.
11. SQLite is the sole recovery-actuation state store. Store failure queues/retries first; reachability fallback requires positive empty-composer evidence plus a durable latch or pending-inject tombstone, and otherwise remains queued with honest out-of-band status.
12. Automatic containment uses the existing scoped canonical session-refresh path; whole-server restart is operator/manual only.

## Open questions

*(none)*

## Known validation risks (decided, not user questions)

- Private Codex rollout/composer formats may drift; package promotion is contract-test/canary gated, drift uses safety-latched fallback, and Stage C stays dark.
- SQLite saturation/disk failure may reduce verification; reserved safety records, durable platform status, and backpressure preserve reachability/evidence without optional effects.
- Multi-machine transfer is complex but required before Stage-B rows go fleet-live; live-row transfer blocking was rejected because it can block operator-requested session moves for the full observation horizon.
- Downgrade below the compatibility projector is unsupported while live rows/tombstones exist; forward hotfix or drained TTL is the chosen boundary.
- Tier-1 semantic veto may be unavailable/inconsistent; Stage C correctness remains deterministic and unavailable supervision only denies optional containment.

## Maturation plan

- **test-agent-live:** production `server.ts` fixture agents exercise Stage A/B with tracked dispatch, four key-attempt rungs, adapter drift, store outage, process/power crash simulation, transfer, and every supported `PhysicalEffectLock` provider.
- **dev-agent-live:** the signed Stage-B RC runs on Echo for at least two hours and 50 representative deliveries with zero false unknown/exhaustion, duplicate attempt ownership, lost inbound, or stale-owner effect.
- **fleet:** Stage A ships immediately; Stage B publication/migration occurs only after the verified RC artifact and activates at restart on machines whose schema, FULL durability, and physical-lock provider pass. Stage C remains opt-in dark.
- **graduation criterion:** Stage B requires the signed RC thresholds above. Stage C requires at least 24 hours and 50 observe-only deliveries, zero false exhaustion/duplicate/stale-owner effects, successful transfer dry-run, and one separately approved effective-once canary.
- **dark-window:** Stage B stays dark from candidate install through the full two-hour/50-delivery RC gate; Stage C stays dark indefinitely until its separate graduation criterion and explicit canary approval are met.

## Acceptance criteria

### Must pass for the implementation PR and release

1. A Codex `codex-code-mode-host` older than every watchdog threshold is never selected, judged, interrupted, or added to escalation state.
2. The same basename under a non-Codex session does not gain protection without corroborating framework ownership.
3. Actual user commands below the protected infrastructure process remain eligible for the existing judge.
4. Every intervention event carries `principal`, `reason`, and `operatorInitiated`; persisted backward-compatible rows include these fields.
5. Normal tracked injection and sentinel keypresses use FULL-durable armed/started/terminal phases under a conforming `PhysicalEffectLock`; boot/runtime reconciliation covers every paste/submit/key boundary, and outage fallback uses its independent effect journal without authorizing recovery.
6. Marker disappearance transitions only to `composer-cleared`; a sent key alone never proves delivery.
7. Monotonic generation-bound transcript evidence records `turn-consumed`, then `responded`.
8. Four attempted recovery keys with the marker still present transition once to `exhausted`.
9. Exhaustion emits at most one recovery request per delivery; composite action-time authority and sequencing CAS refuse after operator stop, ownership change, any newer dispatch, target-session activity, incarnation change, replay claim, capability expiry, or breaker trip.
10. Disabled/unavailable deeper recovery is explicit and produces one bounded status after self-heal exhaustion.
11. Completed idle turns without an explicit obligation are not nudged or restarted.
12. Unit, integration, and E2E lifecycle tests reproduce both live incidents: watchdog targeting the Codex tool host and four fired keys without acceptance.
13. Existing agent installs receive required hook/config/awareness changes idempotently.
14. Full repository test suite is green.
15. Unknown/unobservable evidence never becomes exhaustion or destructive recovery.
16. Tests cover nested user-command descendants, PID reuse, forged/corrupt requests, every crash boundary, transfer/ownership-claim races with distinct keys, queued identical inbounds, transcript/composer schema drift and cursor fairness, both sequencing-lease CAS orderings, replay-loop bounds, refresh readiness, and prompt-injected judge evidence.
17. Aggregate metrics report denominators and latency without plaintext message content.

### Post-merge maturation gates (not PR/release blockers)

1. Echo observe-only runs for at least 24 hours and 50 deliveries with zero false exhaustion, duplicate attempt ownership, stale-owner action, or schema-drift misclassification.
2. Recovery dry-run proves transfer compatibility and composite-authority decisions against live conditions.
3. One separately approved canary demonstrates effective once-only recovery before any fleet opt-in.
4. Post-merge dashboards continue reporting delivery denominators, latency, adapter drift, and breaker state; regression opens the breaker and rolls recovery effects dark without removing host protection.

## Rollback

Host protection can be reverted only by a forward hotfix because a raw rollback reopens a destructive known failure. Recovery actuation can be disabled immediately while observation and delivery-ID tombstones remain. SQLite tables are additive/versioned but are **not** safely ignorable by a legacy injector: downgrade is permitted only to a compatibility-projector version, or after the status endpoint proves zero live records and tombstone TTL expiry. Schema rollback never deletes evidence; corruption/version uncertainty disables actuation and preserves the DB for repair.
