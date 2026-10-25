# Side-Effects Review — Codex session lifecycle reliability

**Version / slug:** `codex-session-lifecycle-reliability`
**Date:** `2026-08-28`
**Author:** `Echo`
**Second-pass reviewer:** `Helmholtz (independent_side_effects_review)`

## Summary of the change

This change makes inbound Codex delivery crash-safe and makes watchdog recovery attribution truthful. It adds a durable SQLite delivery-effect journal (`InboundDeliveryStore`), a kernel-backed physical-effect lock and single dispatcher, recipient-encrypted ownership-transfer custody, a restart-durable scoped recovery authority, executable/vnode process provenance, an authenticated status route, and migration/agent-awareness updates. The decision points are delivery admission, transfer custody, ambiguous-effect recovery, watchdog eligibility, rollout activation, and recovery actuation.

## Decision-point inventory

- `SessionManager` inbound delivery admission — modify — fail closed if the durable journal cannot prepare the delivery.
- `InboundDeliveryStore` boot reconciliation — add — classify unfinished attempts as ambiguous without replaying their body.
- `SessionDrainRunner` custody handoff — modify — source fencing and target durable encrypted import must complete before close/claim.
- `SessionWatchdog` candidate eligibility — modify — protect suspected hosts conservatively; confirmation requires realpath, vnode, start-time, and direct parent agreement.
- `RecoveryActuationAuthority` — add — restart-durable, deterministic, dark-by-default authority for one scoped recovery action at a time.
- `/sessions/inbound-delivery-status` — add — authenticated, read-only machine-local observability.

## 1. Over-block

If SQLite is unavailable, a legitimate inbound message is refused instead of being injected without durability. This is intentional fail-closed behavior: the caller receives a failure and the message remains recoverable upstream, avoiding an unprovable duplicate effect. Exact executable matching protects only `codex-code-mode-host`; similarly named user commands remain eligible for watchdog review.

The first live candidate exposed an additional scope boundary: non-Codex and legacy unknown-framework job injections were entering the Stage-B ledger even though only Codex has a generation-bound acceptance observer. Those rows could never advance and would age into false unknowns. The canonical `rawInject` boundary now journals only a positively identified `codex-cli` session; known non-Codex and unknown frameworks retain their established injection path until they gain an equivalent observer. Semantic tests exercise both bypass sides through public `sendInput`, while the production E2E proves the Codex side still journals and advances.

The first repaired active-turn case exposed a migration interaction with rows
preserved from that earlier candidate: four older non-Codex `prepared` rows could
fill the dispatcher's bounded SQL result before `SessionManager` filtered by
framework, starving a later valid Codex FIFO row. Framework qualification now
occurs inside the bounded selection authority. A regression fixture puts four
older Claude rows ahead of a Codex row and proves the Codex row remains selected;
legacy evidence stays preserved without participating in an observer it cannot use.

A later candidate-wide observation found the fresh-session boundary: Codex does
not create its rollout until the first prompt, so the bootstrap had no generation
ID or byte baseline. Stage B correctly refused the ordinary path, but the older
readiness owner ignored the false return and cleared `PendingInjectStore`, turning
“queued” into a lost message. The startup owner now clears custody only after a
true injection result. Exact full-envelope pending custody is the sole authority
for a pre-rollout bootstrap only when its durable record carries the positive
`freshPreRolloutBootstrap` flag written by a genuinely fresh Codex spawn; resumed,
recovered, legacy, and unflagged records fail closed. The effect remains
journaled/locked, Codex's installed `.codex/hooks.json` `UserPromptSubmit` group
includes the event reporter that publishes the generation, and the observer may
bind only that local already-dispatched null-rollout/-1-offset row from offset zero.
Normal, imported, nonlocal, or pre-bound rows cannot use the exception. A refused
normal or boot-recovery injection retains custody and propagates failure.

The refreshed v1.3.1218 live candidate invalidated its first delivery window when Codex 0.149 produced a correct response but the observer marked it unknown. Live rollout bytes showed that current Codex retains the generation-bound `task_started`/`task_complete` envelope while omitting the older redundant `internal_chat_message_metadata_passthrough.turn_id` field on each message and adding `thread_settings_applied`/`item_completed`, `world_state`, inter-agent metadata/messages, and tool-search records. The adapter now uses the active task envelope when per-message metadata is absent, rejects a present malformed or conflicting metadata field, ignores only enumerated non-authoritative records and `developer`/`system` context roles, and rejects unknown roles/events. A captured-shape semantic test covers the complete current sequence.

## 2. Under-block

The journal cannot prove whether a process consumed bytes after a crash in the final side-effect window, so it reports `effect-unknown` and refuses blind replay. Consumption is instead established only from the pinned Codex rollout adapter's generation-bound user-turn evidence; composer clearing remains weaker evidence. A renamed, unmeasurable, or conflicting Codex framework executable is `ownership-unknown` and preserved; it is never falsely called confirmed.

The rollout adapter remains version-shape sensitive by design. A future Codex event outside the enumerated vocabulary, a response message outside an active task envelope, or a conflicting legacy turn id still resolves unknown and blocks the release window rather than weakening correlation.

## 3. Level-of-abstraction fit

Persistence and attempt transitions live at the transport/session boundary where the side effect occurs. The watchdog remains a detector for process/liveness evidence; it does not gain new recovery authority. Recovery actuation is centralized in a separate authority with deterministic scope and a dark default, rather than letting each detector act independently.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — the watchdog produces signals consumed by a separate authority.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic — STOP.

The journal's fail-closed checks are transport invariants and idempotency mechanics, explicitly exempted from judgment classification. The exact host exclusion is typed framework attribution, not a semantic guess. Recovery decisions are owned by the scoped authority and are audit-visible.

## 4b. Judgment-point check

No new static heuristic is added at a competing-signals judgment point. Journal state transitions are enumerable transport invariants; executable attribution is exact; and the recovery authority's floors and deterministic scope are declared in the driving spec.

## 5. Interactions

- **Shadowing:** durable preparation occurs before tmux injection, so journal failure intentionally prevents the existing injection path.
- **Double-fire:** a delivery id has one durable state machine; ambiguous attempts are never body-replayed. Kernel flock plus durable phases serialize physical effects, and recovery capabilities are single-use across restart.
- **Races:** SQLite FULL durability, transactions, kernel ownership, action-time owner/epoch fences, and transfer CAS preconditions serialize concurrent delivery updates. Watchdog descendant discovery is read-only and rechecked against incarnation-bound provenance.
- **Feedback loops:** journal/status observations do not themselves trigger injection. The authority is dark by default and bounded when enabled.
- **Rollout compatibility:** the current-shape fallback is subordinate to the existing active-turn state machine. It cannot create a turn, cannot override a conflicting explicit turn id, and cannot match a delivery without the exact post-baseline envelope HMAC.

## 6. External surfaces

Agents gain an authenticated read-only status endpoint and more accurate watchdog outcomes. Persistent state is a per-agent SQLite journal containing HMAC-derived identifiers rather than plaintext message bodies. Telegram and other adapters do not change wire formats. Timing remains dependent on process state, but ambiguous effect is now surfaced honestly. No new operator action is required; therefore no phone-only workflow is introduced.

## 6b. Operator-surface quality

No dashboard or operator action surface is changed — not applicable.

## 7. Multi-machine posture

**Machine-local effects, transferable custody:** tmux processes, watchdog descendants, and whether bytes may have reached a local Codex host are machine-specific truths. During topic transfer the source first enters `transferring`, atomically fences its live rows, encrypts replay material to the target machine's X25519 key, and sends it over the signed recipient-bound mesh RPC. The target validates authenticated source/target/conversation/epochs and durably imports before the source may close or land the target claim. A refused carrier aborts transfer and restores source custody at the newer epoch. Ambiguous effects remain terminal source evidence and are never exported as replayable work.

## 8. Rollback cost

Recovery actuation can be darkened immediately, but a raw binary rollback is fenced while live delivery evidence or its 24-hour tombstones exist. Every delivery mutation projects a non-replayable ID tombstone into the legacy pending-inject surface and refreshes a downgrade-floor marker; `UpdateChecker.rollback()` refuses below that floor. A forward hotfix or a fully drained tombstone window is the supported rollback path. Schema evidence is never deleted to make rollback appear safe.

## Conclusion

The independent reviews found material spec-to-code gaps and correctly blocked the first release candidates. The revisions close them with package-bound signed activation evidence, rollout identity/offset/turn correlation, live-row transfer preservation, crash-safe effect fencing, exact-cap scanner handling, framework scoping, and current Codex 0.149 rollout compatibility. Each live mismatch invalidated its evidence window instead of being rationalized away. The final exact-candidate canary then completed 50 dedicated deliveries over 133 minutes with every forbidden counter at zero and all required case classes represented. Echo signed the package-bound release artifact, Mencius independently concurred with the evidence, and the publication hook now mechanically refuses a missing, malformed, wrongly versioned, or invalidly signed artifact. Focused unit, integration, production E2E, build, and signed-artifact verification gates pass for the release delta.

## Second-pass review (if required)

**Reviewer:** Helmholtz (`independent_side_effects_review`)
**Independent read of the artifact:** concur

Helmholtz granted final code clearance after independently checking the shared and legacy rollout scanners' exact-cap behavior, including no-final-newline, partial-tail, and exact-newline cases, and running the focused suite successfully (49/49). No code blocker remained. The reviewer explicitly kept the signed Stage-B canary artifact as a separate release gate.

After the first live candidate exposed observerless non-Codex rows, Helmholtz
withheld clearance until both known non-Codex and unknown-framework injections
were covered semantically through the production `sendInput` path. The revised
tests use a real manager and SQLite store, stub only the external framework/tmux
seams, and prove both paths inject without adding a delivery row. Together with
the positive Codex production E2E, the refreshed focused gate passed 18/18 and
Helmholtz granted clearance with no remaining blocker.

After the first v1.3.1218 delivery exposed Codex 0.149 rollout drift, Mencius
(`stage_b_parser_review`) independently withheld clearance for malformed-present
metadata, omitted current record types, incomplete fixtures, and the resulting
spec mismatch. The final re-review concurred after both scanners distinguished
true metadata absence from malformed presence, the allowlist and fixture covered
the observed non-authoritative world/inter-agent/tool-search shapes, system and
malformed cases were tested, and the authoritative spec named the task envelope
as generation authority. Mencius found no remaining parser, test, or spec blocker;
the signed live canary remains the separate release gate.

The subsequent active-turn canary made Mencius withhold clearance again: moving
only the framework predicate before `LIMIT 4` left the same starvation class for
dead-incarnation and stale-owner Codex rows, including configurations above 100
live rows. Final concurrence followed only after the store exposed the entire
configured live-row ceiling, `SessionManager` evaluated a single running-session
map and ownership predicates before its four-effect cap, and unit/production E2E
regressions covered both row 106 and actual dead/stale-owner skipping. The
action-time ownership fence remains unchanged for races.

The fresh-session canary then exposed a custody loss before Codex had created its
first rollout. Mencius withheld clearance until the exception required a durable
positive fresh-spawn flag, the Codex-native `UserPromptSubmit` group installed the
generation reporter, every false injection retained custody, boot recovery
propagated refusal as failure, and resume-to-fresh fallback awaited the replacement
injection. After the stale menu test was updated to preserve its zero-keypress
assertion under the typed-refusal contract, the focused five-file matrix passed
59/59 and Mencius concurred with no remaining code, security, custody,
migration-parity, or test blocker.

The next candidate-wide window exposed the upgrade-in-place version of that
boundary: a pane created by the rejected candidate remained alive without ever
establishing a rollout, so later Telegram retries repeatedly failed and each
attempt manufactured a terminal `dispatch-failed` row. The corrected preflight
now refuses before ledger preparation. Separately, after a two-minute startup
grace, Telegram ingress classifies a generationless Codex pane as stale, clears
any unusable resume UUID, and fresh-respawns with bounded topic history plus the
still-custodied inbound. Process liveness remains truthful for watchdog callers;
only conversational routing applies this recovery classification. Unit coverage
tests both sides of the grace/generation boundary, and production E2E proves a
refused stale-generation input creates no delivery row.

Mencius initially withheld concurrence because one existing routing double had
not adopted the new classifier and the first no-row assertion used an observer
view that excluded `dispatch-failed` rows. Final concurrence followed after the
E2E asserted the store's full logical-row count and a behavioral Telegram test
drove the real routing branch: it bypasses injection/death classification,
removes the resume binding, replaces the pane fresh, and proves both bounded
history and the current inbound reach the bootstrap. The refreshed three-file
matrix passed 23/23; no code, custody, migration, or test blocker remained.

The following candidate-wide window exposed a control-plane/data-plane mix-up
on the operator session itself. Context-wall recovery injected `/compact`
through the ordinary topic-message funnel; InputGuard then added its own warning.
Both physical sends were correctly serialized, but both were incorrectly minted
as inbound deliveries even though Codex renders neither as a normal user turn,
so the observer terminalized both as false `unknown`. The window was discarded.
The correction introduces a closed in-process `/compact` control path: it bypasses
content-origin InputGuard, creates no delivery row, and still executes under the
same `PhysicalEffectLock` after interrupted-effect reconciliation. Unit coverage
proves the dispatcher acquires the lock without changing logical-row count and
the SessionManager wiring uses that control path.

Mencius withheld concurrence through three additional passes until the control
path and every delivery path shared the same authority. The final implementation
resolves Telegram directly and Slack through session → routing key → durable
`ConversationRegistry` ID; normal live injection, immediate bootstrap, pending-
inject boot recovery, resume-failure fresh spawn, and context-recovery fresh spawn
all preserve that key. The `/compact` action-time fence also checks pre-fix Slack
rows keyed by tmux name during upgrade. A genuine bound `InputGuard` test proves
the ordinary suspicious-message warning fires while the closed control path
bypasses it, and real-store tests prove liveness, owner-epoch, canonical active-
dispatch, and legacy active-dispatch refusal. Mencius's final verdict was
**CONCUR**, with no remaining code, security, custody, migration, or test blocker;
the independent focused review set passed 51/51, while the final local correction
matrix passed 81/81 before the two custody regressions were added and those tests
passed 15/15 with a green TypeScript build.

## Evidence pointers

- `docs/specs/reports/codex-session-lifecycle-reliability-convergence.md`
- `tests/unit/InboundDeliveryStore.test.ts`
- `tests/unit/RecoveryActuationAuthority.test.ts`
- `tests/integration/codex-inbound-effect-journal.test.ts`
- `tests/integration/physical-effect-lock-provider.test.ts`
- `tests/unit/FrameworkProcessProvenance.test.ts`
- `tests/unit/SessionDrainRunner.test.ts`
- `tests/e2e/codex-session-lifecycle-reliability.test.ts`
- `.instar/state/codex-stage-b-rc.json` (Echo-local signed candidate evidence; operational state, not shipped source)
- `src/data/codexStageBReleaseEvidence.ts` (Echo-signed package `1.3.1219` release evidence)
- Live rejected RC row `09a75bd5-5905-4ea3-b1d2-1ff66b227a66` and its exact Codex 0.149 rollout sequence (candidate-local, message content excluded from the signed artifact).

## Class-Closure Declaration (display-only mirror)

`defectClass: unbounded-self-action`, `closure: n/a`, `reason: RecoveryActuationAuthority is a caller-invoked one-shot authority whose capability is single-use and delivery-scoped; Stage C actuation remains dark. The periodic Stage-B observer records evidence and bounded notices but cannot restart, replay, respawn, or otherwise actuate recovery.`
