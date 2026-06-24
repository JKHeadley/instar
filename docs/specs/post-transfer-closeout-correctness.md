---
title: "Post-Transfer Closeout Correctness (liveness-gate the stale-ownership kill)"
slug: "post-transfer-closeout-correctness"
parent-principle: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions — a multi-machine janitor must verify the destination actually holds live work before it terminates the only live worker; never kill on a stale-ownership guess."
status: draft
author: Echo (autonomous mesh-robustness mission, ownership-follows-live-work worktree)
date: 2026-06-24
risk-class: safety-critical (the changed decision can terminate a LIVE local session); mitigated by fail-closed-everywhere + a default-OFF gate
eli16-overview: "post-transfer-closeout-correctness.eli16.md"
lessons-engaged:
  - "P2 Signal vs Authority — the liveness signal informs the decision; the kill still routes through the guarded terminateSession authority (see 'Signal vs. authority')."
  - "P19 No Unbounded Loops — the snapshot refresher is level-triggered on a fixed cadence, bounded fan-out, 5s per-attempt timeout, no retry storm, per-pass eviction; every failure resolves to the SAFE WITHHOLD direction so a dedicated backoff/breaker would only add failure modes (see 'Snapshot refresher — bounded, with brakes' + Frontloaded Decision 7)."
  - "P10 Comprehensive-First / No Deferrals — A/B/D are out-of-this-scope (the scope is 'stop the dangerous kill'), durably tracked via a one-time-action commitment + PromiseBeacon on merge, not a vague comment (see 'Tracked follow-through')."
  - "Maturation Path — ships ENABLED on developer agents via resolveDevAgentGate (live on echo, dark on the fleet); the fleet-OFF default is the dark stage of the ladder, not a permanent kill (see the Dark flag section)."
  - "Close the Loop — a long-lived WITHHOLD is the safe direction, audited per-episode to sentinel-events.jsonl, and the stale-record correction is handed to the OwnershipReconciler + the tracked A/B follow-on work so it is re-surfaced, never left to rot silently."
review-convergence: "2026-06-24T09:07:25.481Z"
review-iterations: 4
review-completed-at: "2026-06-24T09:07:25.481Z"
review-report: "docs/specs/reports/post-transfer-closeout-correctness-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 7
cheap-to-change-tags: 0
contested-then-cleared: 0
approved: true
approved-by: "Justin — blanket pre-approval, topic 27515 24h autonomous mesh mission"
---

# Post-Transfer Closeout Correctness (F1 — liveness-gate the stale-ownership kill)

## Problem (F1 — verified live, operator-named)

On a multi-machine setup, `SessionReaper`'s **post-transfer closeout** can terminate the LIVE local
session for a topic when the local ownership record is STALE.

The closeout block lives in `src/monitoring/SessionReaper.ts` (`tick()`), gated by
`if (this.cfg.topicMovedCloseout && this.deps.topicOwnerElsewhere)` (verified at
**SessionReaper.ts:651**). Its ONLY withhold guard is `otherOwner && pinnedHere` — i.e. the topic's
placement pin names THIS machine while ownership still says another (**SessionReaper.ts:666-676**).
That guard exists for the 2026-06-12 reconcile-toward-us incident; it does NOT cover the stale case.

The failure path (**SessionReaper.ts:677-725**): when `topicOwnerElsewhere(topicId)` returns a
non-null owner and the topic is NOT pinned-here, the closeout counts a dwell streak and, after
`topicMovedConfirmTicks` (**default 2**, SessionReaper.ts:140), calls
`await this.deps.terminate(session.id, reason)` against the only LIVE worker (**SessionReaper.ts:695**).
**Nothing verifies the remote owner actually has a live session for the topic.** The owner string is
sourced purely from the local `SessionOwnershipRegistry.ownerOf(...)` record
(`topicOwnerElsewhere` wiring at **src/commands/server.ts:15080-15089** →
`sessionOwnershipRegistry.ownerOf(String(topicId))`); a stale ownership record is taken as ground
truth.

**P19 veto-breaker (the operator-visible symptom).** When the live worker keeps the closeout from
landing (the `recent-user-message` KEEP-guard vetoes the terminate), the breaker
(`topicMovedVetoes` ≥ `topicMovedVetoBreakerAttempts`, **default 5**, SessionReaper.ts:141) opens and
raises a `closeout-breaker:<id>` attention item titled **"Topic N moved to X, but the old session
won't close"** (**SessionReaper.ts:711-723**). That is the exact item the operator saw — and it
escalates the WRONG thing: the real fault is that the janitor is trying to kill a live worker on a
stale label at all.

**Secondary (breaker-counter churn).** The per-tick GC at the top of `tick()` deletes
`topicMovedStreak`/`topicMovedVetoes` for any session id not in the live set
(**SessionReaper.ts:637-638**). When a session respawns under a NEW id, its veto count resets to 0,
so the breaker takes far longer to open — **observed 32 min instead of the intended ~10**.

## Scope of THIS spec (tight — one coherent change in SessionReaper.ts + its server.ts wiring)

Three parts, all behind ONE new dark flag. Parts **A/B/D** of the broader audit (ownership
release-on-complete, claim-on-spawn, double-dispatch recovery gate) are an explicit **SEPARATE
follow-up PR — OUT OF SCOPE here** <!-- tracked: ownership-follows-live-work -->; reviewers should not expect them. This spec fixes only the
dangerous decision: never terminate a live local worker on stale/unverified ownership.

> **Reading this spec** (both cross-model passes flagged the density): this is the dense, normative
> reviewer/implementer document. For the plain-English version, read the ELI16 companion
> (`post-transfer-closeout-correctness.eli16.md`); for the design's evolution through review, read the
> convergence report under `docs/specs/reports/`. Inline `(codex Rn / gemini Rn)` tags are deliberate
> traceability to the cross-model finding that drove a given correction — skip them on a first read.

---

## Part C (load-bearing): liveness-gate the closeout

### The new dep

Add an optional dep to `SessionReaperDeps` (**SessionReaper.ts:231-312**), shaped exactly like the
existing optional pool deps (`topicOwnerElsewhere?`, `topicPinnedHere?`):

```ts
/** Post-transfer closeout correctness (F1): does the machine that OWNS this topic
 *  (per the ownership registry) actually have a LIVE session for it right now?
 *    state:true     → the owner is genuinely serving the topic → the local session is a
 *                     duplicate leftover → closeout may proceed.
 *    state:false    → the owner has NO live session for the topic → the local session is
 *                     the only live worker → WITHHOLD (never terminate it).
 *    state:'unknown'→ liveness cannot be determined (snapshot missing, peer unreachable,
 *                     feature mid-wire) → WITHHOLD (fail-closed; an UNKNOWN must NEVER act).
 *  `reachableAt` (ms) is the timestamp of the snapshot pass that produced this answer —
 *  it backs the true-side dwell-advancement check (a confirm tick only counts when
 *  `reachableAt` ADVANCED since the streak began, so two ticks can't re-read ONE stale
 *  snapshot). Present on true/false, absent on 'unknown'.
 *  Absent dep (single-machine / gate off / pre-wire) ⇒ the liveness gate is inert and
 *  the closeout keeps today's behavior. */
remoteOwnerHasLiveSession?: (topicId: number, ownerMachineId: string)
  => { state: boolean | 'unknown'; reachableAt?: number };
```

The STRUCTURED return (not a bare `boolean | 'unknown'`) is deliberate — corrected per the codex R3
pass: the true-side dwell-advancement logic below needs the snapshot's `reachableAt`, and surfacing it
through the SAME single dep call (rather than a second lookup) keeps the liveness verdict and its
freshness timestamp atomic — they describe ONE snapshot read, never a split.

Type-shape verified against the existing optional deps: `topicOwnerElsewhere?: (topicId: number) =>
string | null` (**SessionReaper.ts:259**) and `topicPinnedHere?: (topicId: number) => boolean`
(**SessionReaper.ts:264**).

**Owner identity = the STABLE `machineId`, NOT the display nickname (corrected — Frontloaded
Decision 5).** A nickname is a presentation string: it is operator-editable (`PATCH
/pool/machines/:machineId`), may be duplicated, and may resolve inconsistently across peers — keying
liveness on it is a real outside-design failure (a nickname change would silently flip a fresh
snapshot to `'unknown'`). The raw stable machineId is already available at the wiring layer:
`topicOwnerElsewhere`'s wiring computes `reg.ownerOf(String(topicId))` — which RETURNS the machineId —
and only then maps it to `nickname ?? owner` for DISPLAY (**server.ts:15085-15087**). So the closeout
must thread the machineId, not the display string, into `remoteOwnerHasLiveSession`. Concretely:

- The reaper resolves the owner's stable id and its display label from a SINGLE atomic
  ownership-registry read. **Corrected per the codex R2 pass: a SINGLE dep, not two.** Two separate
  deps (`ownerMachineIdOf` + `topicOwnerElsewhere`) called at different points in the tick could
  straddle an ownership change between reads (machineId of owner A, display of owner B). So REPLACE the
  display-only `topicOwnerElsewhere` consumption in the closeout with one combined dep that does ONE
  registry read and returns both: `topicOwnerElsewhereInfo?: (topicId: number) => { machineId: string;
  displayName: string } | null` — `machineId` = the un-nicknamed `reg.ownerOf(...)` value (the
  liveness/snapshot key), `displayName` = `nickname ?? machineId` (audit/operator text). The closeout
  block destructures both from one call, so the liveness key and the display text are guaranteed to
  describe the SAME owner from the SAME instant. (`topicOwnerElsewhere` is retained for any existing
  caller / back-compat, but the closeout uses the combined `…Info` form.)
- The peer `/sessions` fan-out already tags each remote machine by its stable `machineId`
  (**routes.ts:5996-6001** — `nickname` is carried alongside, but the key is `p.machineId`), so the
  snapshot keys naturally on machineId with zero new identity surface. The snapshot key and the
  closeout's owner key are the SAME `reg.ownerOf(...)` machineId — never a nickname string match.

**Frontloaded Decision 5** is updated below to record this stable-machineId keying via the single
atomic `topicOwnerElsewhereInfo` read.

### The decision table (inserted into the `else if (otherOwner)` arm, gated by the new flag)

The new logic sits inside the existing `else if (otherOwner)` branch (**SessionReaper.ts:677**),
AFTER the pin-conflict hold (which already wins, unchanged) and BEFORE the dwell-streak / terminate
machinery. When `cfg.closeoutLivenessGate` is **false**, this block is skipped entirely and the
closeout is byte-identical to today.

**Exact control flow of the gating condition (codex R6 #3 — both new deps, no accidental-disable, no
display-name fallback).** The closeout's outer gate stays `cfg.topicMovedCloseout`. Inside it:
- **`closeoutLivenessGate` OFF** → the closeout reads the legacy `deps.topicOwnerElsewhere` (display
  id) and runs the existing path verbatim; the new `…Info`/liveness deps are never consulted. (OFF is
  byte-identical, as in the Dark flag section.)
- **`closeoutLivenessGate` ON** → the closeout resolves the owner via `deps.topicOwnerElsewhereInfo`
  (the single combined `{ machineId, displayName }` read). The gated path REQUIRES this dep: if
  `topicOwnerElsewhereInfo` is ABSENT (e.g. a partial-wire window), the closeout does NOT silently fall
  back to the display-only `topicOwnerElsewhere` and does NOT proceed to terminate — it takes the
  fail-closed WITHHOLD path (no closeout attempt this tick), exactly like a `'unknown'` liveness
  reading. There is NO branch where the gate is ON and the closeout terminates using a display-name
  owner identity. `topicOwnerElsewhereInfo` returning `null` (no owner-elsewhere) means the topic is
  not owned elsewhere → the `else if (otherOwner)` arm is simply not entered (the topic-home/unowned
  reset arm runs), identical to legacy.

When `cfg.closeoutLivenessGate` is **true**, the owner resolved from `topicOwnerElsewhereInfo` is
non-null, AND `deps.remoteOwnerHasLiveSession` is present, consult the liveness dep ONCE (wrapped in
try/catch — a throw is treated as `'unknown'`, matching the existing `catch → skip rule` convention at
SessionReaper.ts:665):

| `remoteOwnerHasLiveSession(topicId, otherOwner)` | Decision | Action |
|---|---|---|
| `true` | genuine move — leftover is a real duplicate | **proceed** to the existing closeout path (dwell streak → terminate, with the Part E origin) |
| `false` | owner has NO live session — local is the only worker | **WITHHOLD** (do NOT terminate); emit the neutral once-per-episode `possibleStaleOwner` audit (NON-directional — no `reconcileToward`) |
| `'unknown'` (or dep throws, or — under the gate — dep ABSENT) | liveness undeterminable | **WITHHOLD** (fail-closed); audit once per episode |

Notes that make this exact and single-run-completable:

- **WITHHOLD shape mirrors the existing pinned-here hold** (**SessionReaper.ts:666-676**): on the
  FIRST withhold tick of an episode, emit ONE audit row
  (`audit('reap-skipped-topic-moved', session, { rule: 'topic-moved-away', otherOwner, skipped:
  'no-live-remote-session' | 'remote-liveness-unknown', possibleStaleOwner: true })`) and set the `-1`
  held sentinel into
  `topicMovedStreak` so the audit is once-per-episode, not per-tick. Also `topicMovedVetoes.delete(...)`
  — a withheld episode never accrues breaker vetoes (it never attempted a terminate). Re-use the
  exact `-1` sentinel convention already in the file so a later genuine move starts clean (the
  existing `else if ((topicMovedStreak ?? 0) !== 0)` reset at SessionReaper.ts:726-731 already clears
  `-1`).
- **The false-case audit is OBSERVATIONAL and NON-DIRECTIONAL (reconciled per codex R5 #3).** This
  spec does NOT add ownership-CAS machinery (that is Part A/B, out of scope) and the false-case audit
  must NOT carry a directional `reconcileToward: 'self'` field — a `false` reading can be a TRANSIENT of
  an in-flight transfer (ownership claimed on the new owner before its session is visible in
  `/sessions`, or `/sessions` propagation lag), and a directional "correct toward me" field could train
  an operator or a future automation to treat a transient as confirmed stale ownership and fight an
  in-progress transfer. So the withhold audit records ONLY neutral, factual evidence:
  `{ remoteOwnerListedSession: false, withheldCloseout: true, possibleStaleOwner: true, ownerMachineId,
  snapshotAgeMs }`. `possibleStaleOwner` is a flag for the SEPARATE Part A/B follow-up <!-- tracked: ownership-follows-live-work --> to weigh
  ALONGSIDE other evidence (the pin, a CAS generation) — it is not an instruction to reconcile, and no
  reconciliation direction is asserted here. The existing `OwnershipReconciler` continues to drive
  records toward the pin on its own authority; this spec introduces no new write path and no directional
  claim. The WITHHOLD is unconditionally safe (we never kill the live worker); the audit stays purely
  descriptive of what was observed.
  The withhold itself (not killing the live worker) is the load-bearing safety outcome; the actual
  label correction stays the follow-up PR's <!-- tracked: ownership-follows-live-work --> (CAS) job, where the pin/another authority confirms
  direction. **Frontloaded Decision 3** records this boundary explicitly so reviewers don't expect a
  CAS write here.
- **UNKNOWN must never act.** This is the whole bug. The `'unknown'` row and the dep-absent-under-gate
  row both WITHHOLD. **When the gate is ON,** the only path that reaches the closeout terminate is an
  explicit `true` (when the gate is OFF, the Part C block is skipped entirely and the closeout keeps
  its legacy unconditional behavior — see the Dark flag section).

### What `remoteOwnerHasLiveSession` reads (grounded against the REAL pool API)

There is **no synchronous local registry field** that says "the remote owner has a live session for
topic N" — verified: `MachinePoolRegistry`'s heartbeat carries only `activeSessionCount`
(**MachinePoolRegistry.ts:115**), not per-topic session bindings; `SessionOwnershipRegistry` exposes
`ownerOf` / `placementTargetOf` (**SessionOwnershipRegistry.ts:117,127**) but no liveness signal. The
ONLY authoritative cross-machine source is each peer's own `GET /sessions` list, which the existing
`GET /sessions?scope=pool` fan-out already consumes — each remote session object is tagged with the
peer's `machineId` and carries the session's topic binding (**routes.ts:5974-6012**: the handler
fetches `${p.url}/sessions` per online peer and merges the tagged list).

That fan-out is **async HTTP**; the reaper's closeout decision is synchronous up to its existing
`await deps.terminate(...)`. So the dep is fed from a **periodically-refreshed local snapshot** built
at the wiring layer (server.ts), NOT a live per-call fetch:

- **Wiring (server.ts, alongside the existing `topicOwnerElsewhere` / `topicPinnedHere` closures at
  server.ts:15080-15099).** Maintain a small in-memory map `liveRemoteTopics: Map<machineId,
  { topics: Set<number>; reachableAt: number }>`, refreshed on a bounded cadence (reuse the reaper
  tick cadence — `tickIntervalSec`, default 120s) by the SAME per-peer `GET /sessions` fan-out the
  pool route already performs. **Concrete implementation choice (frontloaded — not an open fork):**
  extract the existing route's per-peer fetch loop (routes.ts:5974-6012) into a small reusable helper
  (`fetchPeerSessions(peerUrls): Promise<TaggedSession[]>`) and call it from BOTH the existing route
  and the new refresher, so the two share one bounded, timeout-guarded fan-out (no duplicated fetch
  logic, no new endpoint). If a low-risk extraction proves awkward at build time, the equivalent
  fallback is to call `ctx.resolvePeerUrls()` + the same per-peer `/sessions` fetch inline in the
  refresher — behaviourally identical, internal-only, byte-for-byte the same observable result; either
  way NO new endpoint is invented and routes.ts:5974 stays the single proven fetch pattern. For each
  fetched peer, the snapshot
  records, keyed on the peer's stable `machineId`, the set of topic ids that have a live session on
  that peer (read the topic binding off each returned session object, the same field the local reaper
  reads via `topicBinding`).
- **The liveness contract — what `true` actually asserts (codex R4 #1).** `GET /sessions` lists a
  peer's KNOWN session objects; this feature treats a topic appearing there as "the owner has a session
  bound to this topic", NOT a stronger "the owner can process new work this instant" (a session can be
  briefly wedged / mid-shutdown / disconnected from Telegram yet still listed). This weaker contract is
  the CORRECT one for the closeout decision: the question the closeout asks is "is my local session a
  DUPLICATE leftover?", and a listed remote session for the topic means it IS a duplicate (two sessions
  for one topic) regardless of the remote's instantaneous work-eligibility. Conversely a topic ABSENT
  from every peer's `/sessions` is the real stale-owner signal (`false`) the feature exists to catch.
  The spec deliberately does NOT require a deeper "eligible-to-serve" probe — that would re-introduce a
  per-tick liveness RPC (forbidden) and is the evented/lease end-state's job (Parts A/B). The audit
  text says "remote has a listed session for the topic", not "remote is healthy", so the contract is
  honest. (This is an intro to the predicate; the single NORMATIVE definition — including the
  opaque-counts-as-listed rule — is the "Peer `/sessions` liveness contract — THE ONE NORMATIVE
  DEFINITION" bullet under "Snapshot-consistency notes"; this note does not introduce a competing
  version.)
- **`remoteOwnerHasLiveSession(topicId, ownerMachineId)` resolution (empty-set is a VALID FRESH
  answer, not unknown — corrected per the codex pass):**
  - snapshot entry for `ownerMachineId` **exists AND is fresh** (`now − reachableAt ≤` the staleness
    bound, default 2× the refresh cadence) → return `topics.has(topicId)`. **An EMPTY `topics` set on
    a fresh, successfully-fetched peer is a definitive `false`** — it means "I reached that machine and
    it has zero live sessions", which is exactly the stale-owner signal this feature exists to detect.
    Freshness is therefore "the peer was REACHED at `reachableAt` ≤ bound", never "the set is
    non-empty". A refresh that successfully reaches a peer with no sessions MUST still record a fresh
    entry with an empty set (so the stale-owner case returns `false`, not `'unknown'`).
  - snapshot entry is **absent** (never reached this machine) **or stale** (`reachableAt` older than
    the bound — the peer was unreachable / timed out at the last refresh, classified exactly like the
    fan-out's `peerFetchReason` at routes.ts:5982,5991-6012) → return `'unknown'` (fail-closed — the
    WITHHOLD path). A peer that FAILED its fetch this refresh does NOT update `reachableAt`, so its
    entry ages into stale → `'unknown'`, never a falsely-fresh empty set.
  - any error reading the snapshot → return `'unknown'`.

  This keys on the SAME stable `machineId` the closeout resolves from the single atomic
  `topicOwnerElsewhereInfo` read, so the owner key used for the liveness lookup and the owner key used
  for display describe the SAME owner from the SAME instant (the divergence codex R2 flagged is closed
  by the single-read dep above, not by an assertion). **Frontloaded Decision 1** records the
  snapshot-not-live-fetch choice (a synchronous live HTTP call on the reaper tick is forbidden).

##### Snapshot-consistency notes (cross-model codex R2 #1/#4/#5, gemini R2 #2/#3)

Four consistency assumptions the design relies on, made explicit so an outside reader can weigh them:

- **Dwell on the `true` branch IS a real second independent observation — it requires `reachableAt`
  advancement (codex R2 #1 / R3 #3, the adopted stricter design).** Because the refresh cadence equals
  the reaper tick, two consecutive ticks could otherwise re-read the SAME stale snapshot generation and
  both see the same stale `true` — which would make the dwell prove nothing about renewed liveness. So
  the `true`-branch dwell is tightened (see "Fail-closed everywhere" below for the exact mechanism): a
  confirm tick only counts toward `topicMovedConfirmTicks` when the snapshot's `reachableAt` has
  ADVANCED since the streak began, so the streak completes only across a genuinely RE-CONFIRMED
  liveness reading from a fresh refresh pass — a real second observation, not a re-read of one stale
  generation. (Two roles, both genuine and now both observation-backed: the dwell confirms stable
  ownership-elsewhere state across ticks AND, via the advancement requirement, renewed remote liveness;
  the snapshot-freshness bound is the per-reading recency gate. The earlier "dwell only confirms
  ownership stability, not liveness" framing is superseded by this stricter advancement requirement —
  this spec adopts the stricter one everywhere.) The remaining `true`-side residual race (a remote
  session that completes between the last fresh snapshot and the terminate) is named and bounded in
  "Fail-closed everywhere", and the freshest-interaction veto in Part E is the additional guard for the
  harmful sub-case.
- **Topic-id stability (codex R2 #4).** The topic id is the durable Telegram forum-thread id (the same
  id `topicBinding` returns and the whole reaper/pool already keys on). It is fleet-stable and is not
  reused for a different conversation, so a topic-keyed breaker entry cannot contaminate a different
  topic incarnation. The episode-hygiene clears (terminate-success / topic-home / pin-conflict, in the
  Secondary section) already reset the entry at every episode boundary, so even a hypothetical id reuse
  would start clean. No stronger composite episode key is needed.
- **Peer `/sessions` liveness contract — THE ONE NORMATIVE DEFINITION (codex R2 #5 / R5 #1 / R6 #1,
  gemini R2 #3).** This bullet is the single authoritative predicate; every other mention in the spec
  (the Part C "liveness contract" note and the "Remote 'live' predicate" subsection under "Fail-closed
  everywhere") POINTS to this one and does not restate a competing version. The predicate, chosen to be
  implementable from TODAY's `/sessions` API:

  > **A topic counts as live-on-a-peer when that peer's `/sessions` lists a session bound to the topic
  > that is NOT explicitly terminal/shutting-down. An entry whose state cannot be classified counts as
  > LISTED (i.e. counts as live) — opaque is NOT treated as dead.**

  Rationale — this is deliberately the WEAKER, observable contract, NOT "eligible to serve new work":
  the closeout's question is "is my local session a DUPLICATE leftover?", and a peer listing a
  non-terminal session for the topic means it IS a duplicate by presence, regardless of whether that
  remote is momentarily wedged/reconnecting. Treating an OPAQUE entry as dead (the rejected stronger
  reading) would turn a genuine duplicate into an indefinite WITHHOLD plus a noisy stale-owner audit —
  the failure codex R5/R6 #1 named. The builder excludes ONLY clearly-terminal/shutting-down entries
  (the states the peer itself already marks as ending). A completing/terminating session drops out on
  the peer's next tick, so a just-completed remote ages out within ≤ one refresh cadence → the topic
  reads `false`/empty → WITHHOLD. (If `/sessions` is ever extended to expose a reliable
  work-eligibility state, tightening this predicate is a SEPARATE, deliberately-scoped change — never an
  implicit reading here.) The freshness comparison is per-machine wall-clock at the FRONTING machine
  only (`reachableAt` and "now" are both read on THIS machine), so it does NOT depend on cross-fleet
  clock synchronization — there is no comparison of one machine's clock against another's (see the
  clock-basis note for the monotonic-vs-wall-clock refinement).
- **Fan-out scope — poll the OWNER, not the whole pool (codex R5 #4 / R6 #4 — fleet scaling + exact
  discovery rule).** The closeout only ever needs liveness for the ONE `ownerMachineId` a stale-owned
  topic points to, so the refresher does NOT fan out to every peer every tick. **The owner set is
  derived deterministically:** iterate THIS machine's current live local sessions, take each session's
  non-null `topicBinding`, call `topicOwnerElsewhereInfo(topicId)`, and collect the distinct
  `.machineId` of every result that is non-null (i.e. the topics that ARE owned-elsewhere AND have a
  live local leftover here — the exact set the closeout could act on this tick). The refresher fetches
  `/sessions` from precisely those owner machineIds — typically one or two peers, not N. (Source is the
  live-local-session list + the ownership registry read, NOT a scan of all reaper candidates or all
  ownership records — so the cost tracks actual leftovers, not pool size.) This bounds the
  per-tick HTTP to O(distinct remote owners with a leftover here), NOT O(pool size), so the fleet-wide
  cost is far below the naive O(N²) a poll-all-peers design would incur. (If that owner set is empty —
  no owned-elsewhere leftovers — the refresher does no HTTP at all that tick.) The existing pool
  `/sessions` fan-out is reused only as the per-peer FETCH primitive, scoped to this owner set.
- **Warmup ordering — ONE concrete scheduler contract: the closeout always reads the PREVIOUS
  snapshot; discovery only feeds the NEXT refresh (codex R7 #1/#2).** To kill the ambiguity codex R7
  flagged, the contract is stated unambiguously and there is NO synchronous fetch in the read path:
  - **The refresher runs ASYNCHRONOUSLY on its own cadence**, populating `liveRemoteTopics` in the
    background. It NEVER runs inline inside the closeout decision.
  - **The closeout decision reads ONLY the already-populated `liveRemoteTopics` snapshot** (the most
    recent completed refresh) — never a fetch it triggers this tick.
  - **Discovery feeds the NEXT refresh, not this read.** When the closeout encounters a topic whose
    owner is not yet covered by the snapshot, it reads `'unknown'` → WITHHOLD this tick, and the
    discovered owner is ENQUEUED so the NEXT refresh pass covers it.
  - **Net first-owned-elsewhere-tick behavior (the test-locked case):** the closeout reads `'unknown'`
    → WITHHOLD on the first tick a topic newly reads owned-elsewhere (the owner is not yet in the
    snapshot), then on a subsequent tick — once the enqueued owner has been refreshed — it reads the
    real `true`/`false`. This one-cycle (≤ one cadence) warmup STALL is explicitly ACCEPTED: it errs
    toward keeping the live session (the safe direction), and a genuine leftover simply sheds one tick
    later. The warmup delay is never a correctness problem (only a latency one) because the only thing
    it delays is a KILL. The Tier-1 test locks this first-tick `'unknown'`→WITHHOLD behavior explicitly.
- **Many-to-one polling under a peer failure — bounded, not a DoS (gemini R7 #2).** If ONE peer owns
  many topics and then fails, every other machine's owner-set will include that one dead peer, so they
  all poll it — a "thundering ripple" at a single endpoint. This is bounded and harmless: each poll is
  a single `/sessions` GET capped by `AbortSignal.timeout(5000)`, fired at most once per cadence per
  machine (the jittered ~120s cadence, de-synchronized), and a DEAD peer simply times out → its
  machineId ages to stale → `'unknown'` → WITHHOLD on every caller (the safe direction). The dead
  peer's endpoint sees at most (pool size − 1) timed-out connects per ~120s — trivial load, and it is
  dead anyway. No machine retries within the cadence (level-triggered), so there is no amplification.
  A healthy peer that merely owns many topics is hit ONCE per caller per cadence regardless of how many
  topics it owns (the fan-out is per-OWNER-machineId, deduped, not per-topic).
- **Fail-safe vs. fail-live — leftover cleanup is not abandoned under partition (gemini R2 #2).**
  Withholding on `'unknown'` suppresses ONLY the closeout (the dangerous path); it does not pin the
  session against the ordinary idle pipeline. A genuine duplicate leftover that goes quiet still
  becomes idle-reapable through the normal SessionReaper idle path (the closeout block falls through to
  it every tick — SessionReaper.ts comment at the closeout site), so a sustained partition delays
  closeout-driven cleanup but does NOT leak zombies indefinitely. Fail-closed here trades a bounded
  cleanup delay for never killing the sole live worker — the correct direction for a safety-critical
  reaper change.

#### Snapshot refresher — bounded, with brakes (No Unbounded Loops — every repeating behavior carries its own brakes)

The refresher is a repeating background behavior, so it carries its own brakes (it must not become an
unbounded retry loop or an unbounded-growth map). The "No Unbounded Loops" standard's canonical three
brakes are **backoff + breaker + per-attempt cap**; this refresher satisfies the INTENT of all three
while deliberately substituting the equivalent-or-stronger mechanism for two, because its failure
direction is uniquely safe (every failure → WITHHOLD → never a kill). The mapping, made explicit so the
deviation is a weighed engineering judgment and not an oversight:
- **per-attempt cap → a per-attempt TIMEOUT** (`AbortSignal.timeout(5000)`): a strictly stronger bound
  than a retry-count cap (it bounds wall-clock, not just count), and there is no per-attempt RETRY to
  cap because the refresher does not retry within a pass.
- **backoff → not needed (there is no retry)**: the loop is LEVEL-triggered on the fixed cadence, so
  the "next attempt" is the next scheduled tick — there is no tight retry to back off. A fixed cadence
  is the spacing.
- **breaker → an OBSERVABILITY breaker, not a behavior-changing one.** A classic breaker exists to STOP
  a loop whose continued running causes harm — but here continued running can only ever resolve to
  WITHHOLD (the safe direction), so STOPPING the refresher would be wrong (it would freeze the snapshot
  and strand every topic at `'unknown'` forever). So the breaker this refresher ships is a degraded-state
  SURFACER, not a stopper: a consecutive-failure counter (`closeoutSnapshotConsecutiveFailures`) counts
  refresh passes where EVERY peer fetch failed; when it crosses a threshold (default 5 ≈ 10 min at the
  120s cadence) it raises ONE deduped attention item ("post-transfer liveness snapshot has been unable
  to reach any peer for N passes — closeout is safely withholding all leftovers; check mesh
  connectivity") and resets on the first successful pass. This satisfies the standard's breaker
  requirement in the form that fits a safe-failure loop — it makes the persistent-degraded condition
  VISIBLE rather than silently withholding forever — without the harmful behavior change of halting a
  loop whose only outcome is the safe direction. (The dedupe rides the same P17 attention coalescing the
  existing closeout-breaker escalation uses at SessionReaper.ts:711-723.) The cadence + per-attempt
  timeout + this observability breaker + the per-pass eviction together are the standard's three brakes,
  each in the shape this specific loop's safety profile calls for.

Concretely the brakes are:

- **Per-attempt timeout + owner-scoped fan-out.** Each peer `/sessions` fetch reuses the EXISTING
  fan-out's `AbortSignal.timeout(5000)` (routes.ts:5987) and runs the fetched peers concurrently via
  the same `Promise.all` shape — the whole refresh is bounded by one 5s timeout, never a hang. The peer
  SET is NOT the whole pool: it is exactly the set of `ownerMachineId`s that currently back an
  owned-elsewhere topic on THIS machine (the "Fan-out scope" point above — typically one or two,
  intersected with `resolvePeerUrls()` so only registered online owners are fetched), so the fan-out
  width is O(distinct remote owners with a leftover here), not O(pool size), and is zero when there are
  no owned-elsewhere leftovers.
- **No retry storm.** The refresher is LEVEL-triggered on the fixed reaper cadence (one pass per
  `tickIntervalSec`), NOT a per-failure retry loop: a peer that fails is simply left stale until the
  next scheduled pass (where its absence → `'unknown'` → WITHHOLD — the safe direction). There is no
  exponential backoff to tune because there is no retry — the next attempt is the next scheduled tick.
  Because every failure path resolves to WITHHOLD (never a kill), a wedged or perpetually-unreachable
  refresher is a SAFE failure (the closeout simply never sheds that topic's leftover); the cadence is
  the spacing and the observability breaker above SURFACES the persistent-degraded condition (rather
  than a behavior-changing stopper, which would be wrong for a safe-failure loop). If the refresh
  callback ever throws, it is caught and logged and the previous snapshot is left in place (which ages
  into stale → `'unknown'`), so one bad pass never wedges the loop.
- **Jitter (anti-thundering-herd — gemini R3 #3).** The refresh fires off the reaper tick, which is
  already a per-process timer (not a wall-clock-aligned cron), so independent agents do not naturally
  align — BUT a fleet-wide simultaneous restart could phase-align the ticks and produce a synchronized
  burst of peer `/sessions` fans-out. Apply a small randomized jitter (±10% of `tickIntervalSec`,
  seeded once per process) to the refresh timing so the polling cadence de-synchronizes across machines.
  This is the same cheap anti-herd pattern used elsewhere in the codebase; it costs nothing and removes
  the only realistic load-spike mode of an otherwise-bounded fan-out.
- **Bounded map growth (eviction).** `liveRemoteTopics` is keyed on machineId, so its size is bounded
  by the pool's machine count — but a peer that LEAVES the pool must not leak a stale entry forever. On
  each refresh, evict any `machineId` no longer in `resolvePeerUrls()` (a deregistered/removed peer).
  The `topics` set per entry is bounded by that peer's live-session count. This is O(pool machines),
  not O(topics-ever-seen).
- **Refresher lifecycle = the gate.** The refresher is constructed/started ONLY when
  `closeoutLivenessGate` resolves true, and is the only thing that ever populates the snapshot; when the
  gate is off it is never constructed (no extra `/sessions` polling on a fleet agent — see Frontloaded
  Decision 7).

- **Gate posture for the wiring:** the snapshot refresh + the liveness dep are only
  constructed/injected when `closeoutLivenessGate` resolves true (see the Flag section). When the gate
  is off, `deps.remoteOwnerHasLiveSession` is left **absent**, the snapshot refresher is NOT
  constructed, the new `topicOwnerElsewhereInfo` combined dep is NOT consulted by the closeout (the
  closeout takes its existing legacy `topicOwnerElsewhere` display-only path verbatim), the Part E
  bypass is NOT passed, and the secondary maps stay session-id-keyed — so the closeout is byte-identical
  to today. (`topicOwnerElsewhereInfo` MAY still be constructed as a pure read helper, but the closeout
  never calls it on the OFF path; the byte-identical guarantee is about the closeout's executed code
  path and its observable terminate behavior, not about whether an unused closure exists — and the
  gate-OFF regression-lock test asserts the observable path, not closure existence.)

#### Why polling, not a stronger consistency model (Alternatives — raised by both cross-model passes)

The snapshot-poll is a DELIBERATE choice of the minimum-safe interim, not the ideal end-state. The
stronger alternatives and why each is deferred, NOT adopted here <!-- tracked: ownership-follows-live-work -->:

- **Evented session lifecycle (peers publish session start/stop over a bus/threadline).** The race-free
  ideal — liveness becomes push, not poll. Deferred <!-- tracked: ownership-follows-live-work --> because it is a new cross-machine pub/sub surface
  with its own delivery/ordering/replay guarantees to design; building it INSIDE a safety-critical
  reaper hotfix would widen the blast radius far past the one dangerous decision this spec fixes.
- **Per-topic lease heartbeat / ownership generation token (CAS).** Make the ownership RECORD itself
  self-correcting (a lease that expires when the owner's session ends, or a generation token bumped on
  claim/release), so a stale record cannot exist to mislead the closeout. This IS the right end-state —
  and it is exactly Parts A/B (release-on-complete + claim-on-spawn), the tracked follow-up <!-- tracked: ownership-follows-live-work -->. The reason
  it is not the "main fix" HERE: it touches the ownership-CAS write surface across every claim/release
  path and needs its own migration + tests; this spec's job is to make the closeout SAFE in the
  presence of the stale record that exists TODAY, so the dangerous kill stops immediately while the
  deeper lifecycle fix lands separately.
- **External consensus store (etcd/Consul).** Rejected outright — instar is deliberately file-based / no
  external-database-dependency (a core Key Design Decision), and a distributed consensus dependency for
  one reaper decision is wildly disproportionate.

The poll reuses an EXISTING, proven cross-machine read (`GET /sessions` fan-out) with zero new network
surface, fails closed, and is reversible behind one dark flag — which is precisely what a
safety-critical interim fix should be while the evented/lease end-state is built as Parts A/B.

**Retirement criterion — this is a compensating control, not the durable architecture (codex R6 #3).**
When Part A (release-on-complete) + Part B (claim-on-spawn) land and make the ownership RECORD itself
self-correcting (a stale record can no longer exist), the pieces of THIS gate retire as follows: the
liveness SNAPSHOT + refresher + the `remoteOwnerHasLiveSession` dep can be REMOVED (the ownership
record is then trustworthy, so the closeout can act on it directly without a second liveness probe);
the `reachableAt`-advancement dwell collapses back to a plain confirm-tick count (no stale-snapshot
re-read to guard against); the Part E narrow bypass and the breaker-counter topic-key REMAIN (they fix
orthogonal real problems — the recent-message false-positive and the session-id-churn count reset — that
A/B do not address). The follow-through commitment (Out of scope) carries this retirement plan so the
interim machinery does not silently become permanent. Until A/B land, this gate is the safe interim;
after they land, most of it is deliberately deleted.

---

## Part E: let a genuine move's leftover actually shed

### The problem

The audit found a genuine-move leftover can be vetoed FOREVER by the `recent-user-message`
KEEP-guard: a message that arrived just before the move still reads as "recent". Verified: the guard
returns `keep('recent-user-message')` at **ReapGuard.ts:137-139**, and the closeout's
`terminate(session.id, reason)` call (**SessionReaper.ts:695**) currently passes **no opts**, so it
runs as `origin: 'autonomous'` (the default at **SessionManager.ts:1003**), which re-checks every
KEEP-guard and vetoes on recent-user-message.

### IMPORTANT — the prompt's `origin: 'topic-moved'` does not exist in the code

The real `terminateSession` origin enum is **`'operator' | 'autonomous'`** (**SessionManager.ts:977**)
— there is no `'topic-moved'` value. Moreover, the reaper's `terminate` DEP signature only exposes
`{ bypassActiveProcessKeep?, workEvidence? }` (**SessionReaper.ts:285-289**) — it does NOT currently
forward `origin` at all. Two facts shape the design:

1. `origin: 'operator'` is a HEAVY bypass — it skips protected, the lease gate, AND the entire
   KEEP-guard (**SessionManager.ts:1006-1072**). Using it would over-bypass (e.g. it would also blow
   past `active-subagent`, `structural-long-work`, `open-commitment`).
2. The existing narrow precedent is `bypassActiveProcessKeep`, which lifts **only** the
   `active-process` keep-reason and re-checks every other guard (**SessionManager.ts:1063-1066**).

### The design (a narrow, named bypass — NOT origin: 'operator')

Add a **new narrow bypass option** to `terminateSession`, mirroring `bypassActiveProcessKeep`:
`bypassRecentUserMessageForConfirmedMove?: boolean`. It lifts **only** the `recent-user-message`
keep-reason (and nothing else) — extending the `bypassThis` computation at **SessionManager.ts:1063**:

```ts
const bypassThis = !!(
  (opts?.bypassRecoveryFlag && blocked?.reason === 'recovery-in-flight') ||
  (opts?.bypassActiveProcessKeep && blocked?.reason === 'active-process') ||
  (opts?.bypassRecentUserMessageForConfirmedMove && blocked?.reason === 'recent-user-message')
);
```

Thread it through the reaper's `terminate` dep signature (**SessionReaper.ts:285-289**) as a new
optional field, and wire it at **server.ts:15064-15067** (the dep currently forwards only
`bypassActiveProcessKeep`).

**The closeout passes this bypass ONLY in the liveness-CONFIRMED genuine-move case** — i.e. only when
Part C's `remoteOwnerHasLiveSession` returned `true`. The reaper's call at **SessionReaper.ts:695**
becomes:

```ts
const res = await this.deps.terminate(session.id, reason, {
  bypassRecentUserMessageForConfirmedMove: true, // ONLY reached when Part C confirmed true
  workEvidence: [],
});
```

- **NEVER** in the stale (`false`) case — that path WITHHELD and never reaches terminate.
- **NEVER** in the `'unknown'` case — that path WITHHELD and never reaches terminate.
- When `closeoutLivenessGate` is **off**, the bypass is NOT passed (the closeout terminate keeps its
  current opts-less call), so behavior is byte-identical to today.

Rationale for a narrow bypass over `origin:'operator'`: a genuine duplicate leftover should shed even
though a pre-move message looks recent, but it must STILL be protected by every OTHER guard
(`active-subagent`, `structural-long-work`, `open-commitment`, `recovery-in-flight`, …). Only the
stale-recent-message signal is the false positive here. **Frontloaded Decision 2** records this.

### The freshest-interaction hard veto (post-snapshot user message — cross-model codex R2 #3)

The bypass's premise is "the recent message arrived *before* the move, so it is a stale-recent false
positive." That premise FAILS in the one window where Part E could cause real harm: a brief
dual-live / propagation-lag interval where BOTH sessions are momentarily live and the user just typed
to the LOCAL one. There, the local session holds the FRESHEST user intent, and lifting
`recent-user-message` would shed exactly the worker the user is actively talking to. So the bypass
carries a hard veto that re-narrows it to genuinely-stale messages only:

- The closeout computes `snapshotReachableAt` for the owner (the `reachableAt` that backed the `true`
  reading — already available from the snapshot entry). The bypass is passed **ONLY IF** the bound
  topic's most-recent user message is OLDER than `snapshotReachableAt` — i.e. the message predates the
  evidence that the remote is live. If the topic has a user message NEWER than the snapshot
  (`recentUserMessageAt(topicId) > snapshotReachableAt`), the bypass is **withheld** and the ordinary
  `recent-user-message` KEEP-guard vetoes the closeout this tick (the safe direction — the local
  session with the freshest interaction is kept). Wire a `recentUserMessageAt?: (topicId) => number |
  null` read (the same topic-state source the existing `recentUserMessage` guard already consults at
  ReapGuard.ts:137) so the comparison is a local, synchronous lookup.
- **Clock-basis consistency (codex R4 #4).** The comparison `recentUserMessageAt > snapshotReachableAt`
  is only sound if both timestamps share ONE clock basis. Both MUST be **this machine's local
  wall-clock at the moment the event was observed locally**: `snapshotReachableAt` is already stamped on
  this machine when the fan-out fetch resolved (not the peer's clock), and `recentUserMessageAt` MUST be
  the LOCAL-RECEIPT time the message landed on this machine (the timestamp the existing
  `recent-user-message` guard already uses), NEVER the Telegram-side `message.date` / a persisted
  event-origin time. The existing guard already keys off local receipt, so reusing its source preserves
  the basis for free; the spec states this explicitly so an implementer does not accidentally swap in a
  platform-origin timestamp. (Even a basis mismatch would only ever fail toward WITHHOLD — withholding
  the bypass keeps the live session — but the comparison is specified to be correct, not merely
  fail-safe.)
- **Wall-clock vs. monotonic (gemini R6 #2).** Both timestamps are `Date.now()` EPOCH stamps (a message
  receipt time and a fetch-resolve time persisted/compared as absolute instants), not durations — so a
  monotonic source (`performance.now()`) cannot directly replace them (you cannot compare a monotonic
  reading to a stored epoch). An NTP step on this one machine could in principle perturb the comparison,
  but the failure is fail-safe BY DIRECTION: a backward step makes a pre-move message look NEWER →
  bypass withheld → the live session is KEPT; a forward step at worst sheds a leftover slightly early on
  a topic the dwell already confirmed moved. Where the reaper compares DURATIONS rather than instants
  (the staleness bound `now − reachableAt`, the GC grace window), a monotonic basis IS the more robust
  choice and SHOULD be used for those duration checks; the instant-vs-instant message/snapshot ordering
  stays epoch-based by necessity. This split (monotonic for durations, epoch for the cross-event
  ordering, fail-safe on skew either way) is stated so the implementer makes the right per-comparison
  choice rather than blanket-applying one clock.
- This makes Part E provably unable to shed a session that received user input — AS OBSERVED ON THIS
  MACHINE — after liveness was observed: a post-snapshot LOCAL message is, by construction, NEWER than
  `snapshotReachableAt`, so the bypass is never passed and the kill never happens. The pre-move
  stale-recent message (the actual false positive) is OLDER than the snapshot and still sheds correctly.
  **Frontloaded Decision 2** is updated to record this freshest-interaction veto as part of the bypass
  condition.
- **Honest scope of the veto — LOCAL freshness, not global (codex R7 #3).** "Freshest interaction"
  means the freshest user message THIS machine has observed. In a multi-machine chat system a user
  message could be observed by ANOTHER machine first; the veto does not prove the remote has seen or
  processed the latest user intent. The user-visible consequence, stated plainly: a confirmed-genuine
  LOCAL leftover can be shed even if another machine momentarily holds fresher unseen input — and that
  is acceptable because (a) Part C already CONFIRMED the move to a live remote owner (so the remote IS
  serving the topic), and (b) the normal routing + spawn-recovery path delivers the conversation's next
  message to the owner regardless. The veto's job is only to stop shedding a leftover the LOCAL user is
  actively typing to during a brief dual-live window; cross-machine freshest-intent ordering is the
  routing layer's job, not the reaper's. This is a leftover-shedding heuristic, honestly scoped, not a
  global consistency claim.
- Unit coverage (added to the Part E tests below, both sides): with Part C `true` AND the topic's last
  user message OLDER than the snapshot → bypass passed, leftover sheds; with Part C `true` BUT a user
  message NEWER than the snapshot → bypass NOT passed, `recent-user-message` vetoes, session kept.

---

## Secondary: breaker-counter stability across session-id churn

### The problem (verified)

The GC loop deletes `topicMovedStreak`/`topicMovedVetoes` for ids not in the live set
(**SessionReaper.ts:637-638**), and both maps are keyed on `session.id` (declared at
**SessionReaper.ts:345,348**). A respawn → new id → veto count resets → breaker opens far too late.

### The fix (minimal — re-key on the topic id)

Key the two closeout-state maps on the **stable topic id** instead of the volatile session id. The
topic id is already resolved at the top of the closeout block via `this.deps.topicBinding
(session.tmuxSession)` (**SessionReaper.ts:655**), and the closeout is fundamentally a per-TOPIC
notion (the topic moved, not the session). Concretely:

- **The two maps' value shapes (codex R4/R5 — ONE authoritative gated shape, specified exactly).** When
  the gate is ON the maps are keyed `Map<number, …>` by topic id. `topicMovedVetoes` stays a plain
  `number` (the breaker count). `topicMovedStreak` (under the gate) becomes a single STRUCTURED value
  with a `kind` discriminant — `lastSeenAt` is present on BOTH variants so GC treats held and counting
  episodes uniformly (codex R6 #2 — the old bare `-1` carried no `lastSeenAt` and so could not
  participate in the grace-window eviction, leaking or dropping held episodes):
  `Map<number, { kind: 'counting'; count: number; lastTrueReachableAt: number; lastSeenAt: number }
  | { kind: 'held'; lastSeenAt: number }>` — in the `counting` variant `count` is the
  consecutive-distinct-generation dwell and `lastTrueReachableAt` is the snapshot `reachableAt` of the
  most recent `true` generation that advanced the streak (so "a confirm tick only counts when
  `reachableAt` advanced" is `reachableAt > lastTrueReachableAt`; this is the EXACT field the
  authoritative dwell state machine in Part E's "dwell state machine" subsection uses — there is ONLY
  this one shape, no `firstReachableAt`). The `held` variant REPLACES the legacy `-1` sentinel for the
  pin-conflict / WITHHOLD episodes — it carries NO count/`lastTrueReachableAt` (it never confirms toward
  terminate) but DOES carry `lastSeenAt`, so the GC grace window applies to a held topic exactly as it
  does to a counting one (a held topic whose session vanishes is grace-window-evicted, never leaked;
  a held topic still bound is kept). References to the `-1` sentinel elsewhere in this spec mean the
  `{ kind: 'held' }` variant; `held` is the held-and-audited state, `counting` advances toward
  terminate.
  **OFF-mode preserves the old behavior:** when the gate is false the maps stay session-id-keyed and
  `topicMovedStreak` stays the original `Map<string, number | -1>` plain-count shape — the richer value
  is only constructed on the gated path, so the OFF code path's observable behavior is unchanged. The
  key (topicId vs session.id) AND the value richness are both selected by the flag at the single
  read/write site. (Frontloaded Decision 4 is corrected accordingly: under the gate the `topicMovedStreak`
  VALUE type DOES change to the richer struct; it is `topicMovedVetoes` whose value type stays a plain
  number, and OFF-mode keeps both legacy shapes.)
- Change the maps to topic-keyed (per above) at the closeout block's read/write sites
  (SessionReaper.ts:669-730), using the resolved `topicId`. A session whose topic binding is **null**
  simply does not participate in the closeout (it already cannot — `otherOwner` is null when `topicId`
  is null, SessionReaper.ts:656), so a null-topic key never arises.
- **GC with a short grace window (codex R4 #3 — a one-tick respawn gap must NOT drop breaker
  continuity).** The naive "GC any topic with no live session bound THIS tick" would erase the
  topic-keyed count during the brief gap between a session dying and its same-topic respawn appearing —
  defeating the whole point of the topic key. Instead, evict a topic-keyed entry only when it has had no
  live session bound AND has not been owned-elsewhere for a short grace window (default `2 ×
  tickIntervalSec`, i.e. survives at least one full respawn gap): stamp each entry's `lastSeenTick` (or
  a timestamp) when its topic has a live binding or is owned-elsewhere this tick, and GC only entries
  whose last-seen is older than the grace window. Build the `liveTopics: Set<number>` from
  `sessions.map(s => topicBinding(s.tmuxSession))` (mirroring the existing `live` id-set at
  SessionReaper.ts:631) to detect "bound this tick". This carries the count across a same-topic respawn
  (including a one-tick gap) while still cleaning up a genuinely-gone topic after the grace window. (A
  longer-lived entry is harmless — the map is bounded O(topics seen in the grace window), and every
  episode-ending transition below clears it eagerly anyway.)
- **Episode hygiene — the count must not contaminate a NEW closeout episode for the same topic.**
  Re-keying on topicId is what makes the count survive a same-topic respawn (the fix), but it also
  means a stale `-1`/streak/veto for topic N could otherwise bleed into a later, genuinely-new closeout
  episode for topic N (e.g. the topic moved away, came home, then moved away again — a fresh episode
  that must start from a clean breaker, not inherit the prior episode's veto count). Two existing
  clears already scope this correctly and MUST be preserved under the topic key: (a) a SUCCESSFUL
  terminate deletes the topic's streak+veto (SessionReaper.ts:700-701) — episode over; (b) the
  topic-returns-home / unowned arm (`else if (... !== 0)` at SessionReaper.ts:726-731) resets the streak
  to 0 and deletes the veto whenever `otherOwner` goes null — so any episode that ENDS by the topic
  coming back home clears the count before a future move starts a fresh episode. The pin-conflict hold
  arm likewise deletes the veto (SessionReaper.ts:676). Because every episode-ending transition
  (terminate-success, topic-home/unowned, pin-conflict) already clears the topic-keyed state, a new
  episode for the same topic always starts clean — the only thing the topic key intentionally preserves
  is the count WITHIN one continuous owned-elsewhere episode across a session-id respawn. The unit test
  below (counter stability) asserts BOTH: preserved across same-topic respawn WITHIN an episode, and
  reset when the topic returns home BETWEEN episodes.
- **This re-key is also gated by `closeoutLivenessGate`** to keep the whole change behind ONE flag
  and guarantee behaviorally-identical OFF behavior. When the flag is off, the maps stay session-id-keyed
  with their LEGACY value shapes (`topicMovedStreak: Map<string, number | -1>`, `topicMovedVetoes:
  Map<string, number>`) exactly as today. (Implementation: select BOTH the key — `topicId` vs
  `session.id` — AND the `topicMovedStreak` value shape — the richer `{ count, lastTrueReachableAt,
  lastSeenAt } | -1` struct vs the legacy plain count — by the flag at the single point where the maps
  are read/written in the closeout block. `topicMovedVetoes` keeps a plain-number value either way.)
  **Frontloaded Decision 4** records keeping this under the same flag.

---

## Dark flag (this is instar-dev — gate ALL new behavior)

Add `closeoutLivenessGate: boolean` to `SessionReaperConfig` (**SessionReaper.ts:31-113**) with
**default `false`** in `DEFAULT_SESSION_REAPER_CONFIG` (**SessionReaper.ts:115-142**) — ships dark.
Config lives under `monitoring.sessionReaper.closeoutLivenessGate` (the existing sessionReaper config
block, read at **server.ts:15058,15125**). Verified the sessionReaper config is already an optional
`config.monitoring?.sessionReaper` object — the new boolean field is purely additive.

- **Resolution:** in the server.ts gate IIFE that already resolves dev-agent gates for
  `cpuAwareActiveProcessKeep` / `busyOrphanDetection` (**server.ts:15124-15134**), resolve
  `closeoutLivenessGate` the same way: `resolveDevAgentGate(rcfg.closeoutLivenessGate, config)` — dark
  fleet-wide, live on a dev agent (echo) for dogfooding; an explicit config value always wins. This
  matches the established standard_development_agent_dark_feature_gate pattern in this file.
- **Maturation Path (ships ENABLED on developer agents — explicit).** This is NOT a feature that ships
  inert everywhere: `resolveDevAgentGate` makes `closeoutLivenessGate` resolve **true on a developer
  agent** (echo) while staying dark on the fleet, so the change is genuinely dogfooded on a live
  multi-machine dev pair before any fleet promotion — satisfying the Maturation-Path standard (a
  feature must ship enabled on dev agents, not behind a flag that is OFF even there). The fleet-OFF
  default is the dark stage of the maturation ladder, not a permanent kill; promotion to the fleet is
  the deliberate follow-on once the dev-agent dogfood (see `## Verification`) confirms the withhold /
  shed behavior on real stale-ownership and genuine-move scenarios. No `DARK_GATE_EXCLUSIONS`
  justification is needed because the feature is NOT excluded from the dev-agent gate — it rides it.
- **Maturation Path (the dev-agent-enabled posture — this gate IS the maturation path, not a bare
  dark flag).** Per the Maturation-Path standard, this feature is NOT dark-everywhere: `resolveDevAgentGate`
  makes it LIVE on the development agent (echo) by omitting `enabled` from config so the dev-gate
  resolves it on, and DARK on the fleet. That is the standard dogfood-on-dev maturation ladder — the
  feature runs and is exercised on a real multi-machine dev pair (the `## Verification` battery) before
  any fleet flip. To satisfy the lint/registry, the new flag is registered in `DEV_GATED_FEATURES` (so
  the omit-`enabled` dev-gated-live posture is recognized, not flagged as an un-exempted hard-off), NOT
  in `DARK_GATE_EXCLUSIONS` (it is not a never-on-dev exclusion). The fleet flip is a later, separate,
  evidence-gated step after the dev soak — tracked, not deferred-and-forgotten <!-- tracked: ownership-follows-live-work --> (see the commitment
  under Out of scope).
- **OFF ⇒ behaviorally identical to today** (the precise meaning of "byte-identical OFF" used
  throughout this spec — corrected per the codex R3 pass: the code path is NOT literally byte-identical,
  since the new config field, the new `terminateSession` option, and the new dep shapes now exist; what
  is byte-identical is the OBSERVABLE BEHAVIOR while the resolved flag is false). When the resolved flag
  is false, the server.ts wiring leaves `remoteOwnerHasLiveSession` ABSENT (and does not build the
  snapshot refresher), the reaper skips the Part C decision block and the Part E bypass, and the
  secondary maps stay session-id-keyed. The closeout's observable behavior is exactly that of canonical
  main; the OFF-side regression-lock tests assert observable behavior, not literal byte identity.
- **Migration parity:** `closeoutLivenessGate` is a new config DEFAULT (false). Per the Migration
  Parity Standard, register it in `migrateConfig()` / `PostUpdateMigrator` with an existence check
  (only add when missing) so existing agents pick up the (false) default on update. A false default is
  a true no-op, so existing agents are unaffected until deliberately enabled.

---

## Signal vs. authority (explicit)

This spec changes only the **DECISION to attempt** the closeout terminate; it never bypasses an
authority guard wholesale. The terminate still runs through the SAME guarded `terminateSession`
authority (**SessionManager.ts:971-1072**) with its protected-set, lease-holder, and KEEP-guard
checks intact. The Part E addition is a NARROW, named keep-reason bypass of EXACTLY ONE reason
(`recent-user-message`), in the EXACT shape of the existing `bypassActiveProcessKeep` precedent, used
ONLY on a liveness-confirmed genuine move — every other KEEP-guard is re-checked and still vetoes.
`remoteOwnerHasLiveSession` is a SIGNAL that informs the decision; it is not an authority that kills.

## Fail-closed everywhere (explicit)

Every uncertainty WITHHOLDS (never kills a live local session): `remoteOwnerHasLiveSession` returning
`'unknown'`, the dep throwing, the dep being absent while the gate is on, a stale/absent snapshot, a
peer unreachable at the last refresh, or a `topicBinding` of null. **With `closeoutLivenessGate` ON,**
the ONLY path that reaches the closeout terminate is an explicit `true` from
`remoteOwnerHasLiveSession`. (With the gate OFF the Part C block does not run and the closeout retains
today's unconditional legacy behavior — the gate-ON claim is scoped accordingly; the whole point of the
default-OFF gate is to stage this new conservatism before it ships.) This is the inverse of the bug,
which killed on a guess.

**The one residual `true`-side race, named and accepted.** A `true` reading is a snapshot up to the
staleness bound old, so there is exactly one residual window: the remote owner's session could
complete in the interval BETWEEN the snapshot's `reachableAt` and the reaper's decision, after which
`true` is briefly stale and the closeout could shed the local leftover believing the owner is still
serving. This is an inherent property of any polling-based consistency model and is an ACCEPTED
trade-off here, bounded and made tolerable by three facts: (1) the window is at most the staleness
bound (default 2× cadence ≈ 4 min) and shrinks to ~one cadence on the common path; (2) this race only
ever fires on the `true` branch — a GENUINE move that was real at snapshot time — so the worst case is
shedding a leftover on a topic that DID move, never the original bug (killing the sole worker of a
topic that did NOT move). **Stated plainly (codex R3 #5):** in this worst case the remote session
completed AFTER the snapshot and BEFORE the local terminate, so for a brief interval the topic could
have NO live worker on EITHER machine until the conversation's next message re-spawns one. This is a
strictly milder failure than the original bug (a transient no-worker gap on a topic that genuinely
moved, self-healing on the next inbound message via the normal spawn path — versus permanently killing
the sole worker of a topic that never moved), and it is made operator-visible: the closeout's
terminate audit on the `true` branch records `confirmedMove: true` + the snapshot `reachableAt`, so a
post-hoc "confirmed true but the remote had just completed" can be seen in `sentinel-events.jsonl`. The
fully race-free guarantee belongs to Part A (release-on-complete). (3) the dwell streak
(`topicMovedConfirmTicks`, default 2)
means the `true` reading must persist across consecutive ticks before terminate, so a single stale
snapshot does not act. **The dwell streak is tightened so it actually adds protection (codex R2 #1):**
the dwell only narrows this window if the two confirm ticks read DIFFERENT snapshots — two ticks
reading the SAME stale snapshot would both see the same stale `true`. So the `true`-branch dwell
requires the snapshot's `reachableAt` to have ADVANCED since the streak began: the closeout records the
`reachableAt` it saw at the first `true` tick, and a subsequent tick only counts toward the streak if
its snapshot `reachableAt` is newer (a genuinely re-confirmed liveness), otherwise the streak holds at
its current count without advancing — so terminate requires `topicMovedConfirmTicks` reads each backed
by a FRESH refresh, not the same stale one re-read. This makes the dwell a real second observation, not
a clock tick. The fully race-free guarantee (a peer that just completed cannot read `true`) still
belongs to the Part A/B follow-up <!-- tracked: ownership-follows-live-work --> (release-on-complete makes the ownership record itself
self-correcting); this spec's scope is removing the dangerous `false`/`unknown`→kill behavior, and it
does that completely.

**The dwell state machine, specified exactly (codex R4 #2).** Per topic-keyed entry the closeout
tracks the canonical `{ count, lastTrueReachableAt, lastSeenAt } | -1` value (the SINGLE map-value
shape defined in the Secondary section — `count` + `lastTrueReachableAt` drive the streak below,
`lastSeenAt` backs the GC grace window, `-1` is the held sentinel; there is no separate
`firstReachableAt` field). The transition rules over `count` / `lastTrueReachableAt`, deterministic:
- On a `state:true` reading whose `reachableAt > lastTrueReachableAt` (strictly newer snapshot
  generation): `count += 1`, `lastTrueReachableAt = reachableAt`. Terminate is attempted only when
  `count ≥ topicMovedConfirmTicks` — i.e. after N DISTINCT true snapshot generations.
- On a `state:true` reading whose `reachableAt == lastTrueReachableAt` (the SAME generation re-read,
  the cadence==tick case): `count` is UNCHANGED (the tick does not advance the streak) — the
  protection codex R2 #1 demanded.
- On `state:false` OR `state:'unknown'`: RESET the streak (`count = 0`, `lastTrueReachableAt = 0`) and
  take the WITHHOLD path — so an alternating `true → unknown → true` sequence never accrues a false
  streak across the gap; the streak must be built from CONSECUTIVE fresh-true generations.
- **Transitions involving the `-1` held sentinel (codex R6 #2 — made explicit so `-1 → true` is not an
  implementation gap).** The `-1` sentinel is entered ONLY by the WITHHOLD paths (the Part C
  `false`/`'unknown'` once-per-episode withhold and the pin-conflict hold), to mark "held + audited once
  this episode". Its transitions:
  - **`-1` + `state:true`** (a genuine move now confirmed after a prior withhold/hold episode): the held
    episode is OVER — REPLACE `-1` with a fresh counting struct `{ count: 1, lastTrueReachableAt:
    reachableAt, lastSeenAt: now }` (start the dwell from 1; do NOT treat the held episode's absence of a
    count as a head start).
  - **`-1` + `state:false`/`'unknown'`** (still held): KEEP `-1` (no new audit — the once-per-episode
    audit already fired when `-1` was set), stay on the WITHHOLD path.
  - **`-1` + topic-home/unowned/pin-conflict-cleared**: the existing episode-hygiene reset
    (SessionReaper.ts:726-731) DELETES/zeroes the entry, so the next move starts clean.
  This is the only `reachableAt`-keyed streak state; it lives in the same topic-keyed map family as
  the breaker counters (cleared by the same episode-hygiene transitions) so it cannot leak across
  episodes.

**Remote "live" predicate — see the ONE normative definition.** `topics.has(topicId)`'s meaning is
defined once, in the "Peer `/sessions` liveness contract — THE ONE NORMATIVE DEFINITION" bullet under
"Snapshot-consistency notes" above (a topic counts as live-on-a-peer when the peer's `/sessions` lists
a NON-TERMINAL session bound to it; an opaque/unclassifiable entry counts as LISTED, never as dead).
This subsection does not restate it (avoiding the multi-location drift codex R6 #1 flagged) — the
snapshot builder here simply applies that predicate (exclude only clearly-terminal/shutting-down
entries when recording the topic set), and the audit text says "remote has a listed non-terminal
session for the topic", never "remote is healthy/serving".

**Partial-rollout honesty (codex R4 #4).** With the dev-agent gate, the flag is ON on some machines and
OFF on others during the rollout. This produces no inconsistent OWNERSHIP state (the gate only changes
the local closeout DECISION, never a replicated record), but it CAN produce asymmetric closeout
DIAGNOSTICS across the fleet — a gate-ON machine emits `reap-skipped-topic-moved` withholds where a
gate-OFF machine would have attempted (and audited) a terminate. This is expected and benign (the whole
point of staged rollout), but an operator comparing two machines' sentinel logs should know the
asymmetry is the gate, not a bug.

**At-most-one-local-session-per-topic invariant (codex R2 #3).** The topic-keyed breaker state assumes
a topic has at most ONE local live session on this machine — which the session pool already enforces
(a topic is owned by one machine and runs one session there; a second local session for the same topic
is itself a double-dispatch the Part D gate exists to prevent). This spec STATES that invariant rather
than silently relying on it: if two local sessions were ever bound to the same topic simultaneously
(a pre-existing pathology this spec does not introduce), they would share the topic-keyed streak/veto
counters, and the closeout would evaluate each session independently in the per-session loop (each gets
its own terminate attempt; the shared counter would over-count vetoes, opening the breaker sooner —
the SAFE direction, never a wrong kill). The Tier-1 tests assert single-session-per-topic is the
expected shape; a same-topic double-binding is out of scope (it is the Part D double-dispatch concern).

**Clock-skew on `reachableAt` (gemini R2 #3).** Freshness compares `now − reachableAt` against the
staleness bound. `reachableAt` is stamped on THIS machine when the fan-out fetch resolves (a local
clock, not the peer's), so peer↔local clock skew does not enter the comparison — both `now` and
`reachableAt` are this machine's monotonic-ish wall clock. (The pool's existing clock-skew tracking is
about cross-machine lease reasoning, not this single-machine timestamp.) Even were skew to mis-bound the
window, the fail-closed design means the only consequence is an over-eager `'unknown'` (→ WITHHOLD, the
safe direction), never a wrong kill. Noted so the assumption is explicit, not silent.

## Frontloaded Decisions

All design decisions are resolved here (the building agent has standing pre-authorization for this
mission; none of these touch durable external side-effects, money, identity, or a published
user-visible interface — they are internal reaper-decision wiring, reversible behind the
default-OFF `closeoutLivenessGate`).

1. **Liveness source = a periodically-refreshed local snapshot of peer `GET /sessions`, NOT a live
   per-call HTTP fetch.** The reaper decision is synchronous; a synchronous live HTTP call on the
   tick is forbidden. The snapshot is refreshed at the reaper tick cadence from the SAME per-peer
   `/sessions` fan-out the existing `GET /sessions?scope=pool` route uses (routes.ts:5974) — no new
   endpoint is invented. Each fetch is bounded by the existing `AbortSignal.timeout(5000)`; the
   refresher is level-triggered on the cadence (no retry loop/backoff — the next attempt is the next
   tick), and the snapshot map is evicted of peers no longer in `resolvePeerUrls()` each pass (bounded
   O(pool machines)). Staleness bound = 2× the refresh cadence; past it the answer is `'unknown'`
   (WITHHOLD). A FRESH successfully-fetched peer with an EMPTY session set is a definitive `false`
   (not `'unknown'`) — freshness means "reached", never "non-empty".
2. **Part E bypass = a new NARROW `bypassRecentUserMessageForConfirmedMove` option, NOT
   `origin:'operator'` and NOT the prompt's nonexistent `origin:'topic-moved'`.** It lifts ONLY the
   `recent-user-message` keep-reason, mirroring `bypassActiveProcessKeep`; every other guard still
   vetoes. Passed ONLY when Part C confirmed `true` **AND** the topic's most-recent LOCALLY-OBSERVED
   user message is OLDER than the liveness snapshot's `reachableAt` (the freshest-interaction hard
   veto — a message THIS machine observed AFTER the liveness evidence keeps the local session). The
   claim is deliberately scoped to LOCALLY-observed input, not a global "the remote cannot have it":
   the timestamp source is this machine's own topic-state (`recentUserMessageAt`, the same source the
   existing `recent-user-message` guard reads), so the veto guarantees only that the LOCAL session with
   the freshest LOCALLY-seen interaction is kept — which is exactly the harm being prevented (shedding
   the worker the user is talking to HERE). A pre-move stale-recent message (older than the snapshot) is
   the only thing the bypass clears.
3. **The Part C false case is a NEUTRAL OBSERVATIONAL AUDIT ONLY — no ownership-CAS write, no
   directional reconcile field.** The audit records only factual evidence (`remoteOwnerListedSession:
   false`, `withheldCloseout: true`, `possibleStaleOwner: true`, `ownerMachineId`, `snapshotAgeMs`) —
   NOT a directional `reconcileToward: 'self'` (corrected per codex R5 #3: a directional field could
   train an operator/automation to treat an in-flight-transfer transient as confirmed stale). The
   actual ownership correction is the existing `OwnershipReconciler`'s job and/or the SEPARATE Part A/B
   follow-up PR <!-- tracked: ownership-follows-live-work -->, which weigh `possibleStaleOwner` alongside other evidence. The load-bearing safety
   outcome of this spec is the WITHHOLD (not killing the live worker); correcting the label is
   deliberately out of scope to keep the change tight.
4. **The secondary breaker-counter fix (re-key on topic id) rides the SAME `closeoutLivenessGate`
   flag.** One flag governs the whole change; OFF is behaviorally identical. Under the gate, the flag
   selects BOTH the key (topicId vs session.id) AND the `topicMovedStreak` value shape (the richer
   `{ count, lastTrueReachableAt, lastSeenAt } | -1` struct vs the legacy plain count); `topicMovedVetoes`
   keeps a plain-number value either way, and OFF-mode keeps both legacy shapes. (Corrected per the
   codex R5 pass — the earlier "value types are unchanged" wording was wrong: the gated `topicMovedStreak`
   value type DOES change; that is intentional and OFF-gated.)
5. **Owner identity for the liveness lookup = the STABLE `machineId`, NOT the display nickname, read
   ATOMICALLY with the display label from ONE registry call.** The closeout consumes the single combined
   dep `topicOwnerElsewhereInfo(topicId) → { machineId, displayName } | null` (NOT two separate deps —
   the obsolete `ownerMachineIdOf` two-dep idea was rejected per the codex R2 pass because two reads can
   straddle an ownership change). `machineId` (the un-nicknamed `reg.ownerOf(...)` value, also tagged on
   each remote session by the pool fan-out at routes.ts:5996) is the snapshot/liveness key, so a
   nickname rename/duplication can never flip a fresh liveness answer; `displayName` (= `nickname ??
   machineId`) is retained ONLY for audit/operator text. Because both come from ONE registry read, the
   liveness key and the display text always describe the SAME owner from the SAME instant. (Corrected
   from the original display-id keying per the cross-model codex passes — see the "Owner identity"
   subsection under Part C.)
6. **Gate posture = the existing `resolveDevAgentGate` dev-agent dark pattern** already used for
   `cpuAwareActiveProcessKeep` / `busyOrphanDetection` in the same construction site
   (server.ts:15124-15134). No new gate machinery; default false; explicit config wins.
7. **The snapshot refresher's brakes = cadence (spacing) + per-fetch 5s timeout (cap) + an
   OBSERVABILITY breaker (surface, don't stop) + per-pass eviction (bounded memory).** Because every
   refresh-failure path resolves to `'unknown'` → WITHHOLD (a SAFE failure — the closeout simply never
   sheds that topic's leftover), a BEHAVIOR-CHANGING breaker (one that STOPS the loop) would be wrong
   here: stopping the refresher would freeze the snapshot and strand every topic at `'unknown'` forever.
   So the breaker is an observability surfacer: a consecutive-all-peers-failed counter that, past a
   threshold (default 5 passes ≈ 10 min), raises ONE deduped attention item and resets on the first
   success — making the persistent-degraded condition VISIBLE without the harmful halt. The
   level-triggered cadence is the spacing (next attempt = next tick), each peer fetch is bounded by the
   existing `AbortSignal.timeout(5000)`, a thrown callback is caught (previous snapshot ages into stale →
   `'unknown'`), and `liveRemoteTopics` is evicted of departed peers each pass (bounded O(pool
   machines)). The refresher is constructed/started ONLY when the gate resolves true, so a fleet agent
   adds zero extra `/sessions` polling. (Resolves the conformance gate's "No Unbounded Loops" flag — all
   three brakes present, each in the shape this safe-failure loop calls for — and the cross-model
   load/eviction findings.)

> All decisions are frontloaded above; the building agent holds standing pre-authorization for this
> mission and every decision is internal, reversible behind the default-OFF `closeoutLivenessGate`.

## Decision points touched

This spec adds NO new external block/allow/route gate. It changes the reaper's INTERNAL closeout
decision (consult `remoteOwnerHasLiveSession` before attempting the closeout terminate) and adds ONE
narrow keep-reason bypass on the EXISTING `terminateSession` authority — guarded by the new
default-OFF `closeoutLivenessGate`. No existing decision boundary is removed or weakened; the change
makes the closeout STRICTLY more conservative (it can only ever WITHHOLD a kill it would otherwise
have attempted, except in the confirmed-genuine case where Part E lets a true duplicate shed).

## Out of scope (explicit — SEPARATE follow-up PR) <!-- tracked: ownership-follows-live-work -->

- **Part A — ownership release-on-complete:** releasing the ownership record the instant a session
  completes, so a stale record can't outlive its session.
- **Part B — claim-on-spawn:** claiming ownership the instant a session spawns for a topic.
- **Part D — double-dispatch recovery gate:** a gate preventing two machines from both serving a
  topic during a contested transfer.

These are real and tracked, but each is its own change with its own ownership-CAS surface and its own
tests. Bundling them here would widen the blast radius of a safety-critical reaper change. Reviewers
should NOT expect A/B/D in this PR. <!-- tracked: ownership-follows-live-work -->

**Tracked follow-through (No-Deferrals — not a vague comment).** A/B/D are not a soft "later" — this
PR's `## Verification` step demonstrates that WITHOUT release-on-complete (Part A), a stale ownership
record is exactly what produces the `false`/`'unknown'` withhold path here, so the WITHHOLD this spec
adds is the SAFE-DIRECTION interim until A lands. The follow-through is registered via the commitment
mechanism — which IS instar's canonical durable planning surface for "a future action I promised to
complete" (the constitution's "Close the Loop / Untracked = Abandoned" standard mandates exactly this,
not an external tracker). On merge of THIS PR, the building agent opens a durable commitment
(`POST /commitments`, type one-time-action) titled "ownership-follows-live-work Part A/B/D —
release-on-complete + claim-on-spawn + double-dispatch gate" so the follow-through survives session
turnover and is re-surfaced by the PromiseBeacon. (Codex R2 #5 read this as scope creep; it is the
opposite — using instar's own canonical commitment registry is the standard's required mechanism, and
the commitment is a post-merge release step, NOT implementation work bundled into this change.) This
spec does NOT defer required work out of its own scope — A/B/D were never in this scope (the scope is
"stop the dangerous kill"); the commitment guarantees the remaining ownership-lifecycle work is
registered, not remembered.

## Multi-machine posture (Cross-Machine Coherence — mandatory declaration)

Every state surface this spec introduces, with its posture when the agent runs on more than one
machine:

- **`liveRemoteTopics` snapshot (NEW) — MACHINE-LOCAL BY DESIGN.** It is THIS machine's own
  periodically-refreshed view of which topics have a live session on each peer, built FROM the peer
  `GET /sessions` fan-out this machine performs. It is intentionally NOT replicated and NOT proxied:
  every machine independently runs its OWN closeout against its OWN locally-built snapshot, because the
  closeout decision is inherently local ("should *I* shed *my* leftover for this topic?"). Replicating
  one machine's snapshot to another would be wrong — each machine must reason from its own fan-out. It
  is rebuilt from scratch each refresh, so it never needs migration/backup. **Reason it is correctly
  machine-local:** the question it answers ("does the owner have a live worker, so may I shed my
  leftover?") is asked and answered per-machine; there is no shared-truth requirement.
- **`closeoutLivenessGate` config flag (NEW) — per-machine resolution is CORRECT here, not a bug.**
  The known multi-machine dev-gate hazard (an inconsistent dev-gate across an agent's machines =
  half-active feature) does NOT bite this feature: the closeout is a per-machine janitor, and each
  machine making its OWN strictly-more-conservative decision is independently safe. **Honest about the
  mixed state (codex R5 #4):** a gate-ON machine is safer than it was; a gate-OFF machine RETAINS today's
  dangerous behavior — so during a staged rollout the original bug can still occur on the not-yet-promoted
  machines. This is acceptable for dev-gating (the whole point of the maturation ladder is to soak the
  fix on a dev machine before fleet promotion), but the claim is NOT "the fleet is strictly safer the
  moment this merges" — it is "each promoted machine is safer, and a mixed fleet is only PARTIALLY
  mitigated until promotion completes." The promotion-to-fleet step (tracked via the follow-through
  commitment) is what closes the gap fleet-wide. Crucially, what the partial rollout can NEVER do is
  corrupt cross-machine STATE: the gate only changes a machine's LOCAL closeout decision, never a
  replicated record (unlike a transfer/placement feature, where half-activation strands a seat — the
  lesson from the `dev-gate-breaks-multimachine-features` incident). So the dev-agent dark gate (live on
  echo, dark on the fleet) is the right posture and no pool-consistency requirement applies — the only
  asymmetry is diagnostic (which machines have the fix yet), not a corruption.
- **Breaker counter maps (`topicMovedStreak`/`topicMovedVetoes`) — MACHINE-LOCAL (unchanged posture).**
  They already are per-machine in-memory reaper state; re-keying them on topicId changes the key, not
  the locality. No replication.

No generated URLs, no user-facing notices that cross a machine boundary, and no durable on-disk state
are introduced — the audit rows land in this machine's existing `logs/sentinel-events.jsonl` (already
machine-local). So the only NEW surface is the machine-local snapshot, declared above.

## Implementation checklist (the canonical "must implement" list — read this if nothing else)

The dense prose above explains WHY; this is the compact normative WHAT. Everything here is gated behind
`closeoutLivenessGate` (OFF ⇒ none of it runs; behavior identical to today).

1. **Config:** add `closeoutLivenessGate: boolean` to `SessionReaperConfig` (default `false`); resolve
   it via `resolveDevAgentGate` (live on dev, dark on fleet); register in `migrateConfig()` /
   `PostUpdateMigrator` (existence-checked).
2. **Combined owner dep:** add `topicOwnerElsewhereInfo(topicId) → { machineId, displayName } | null`
   (ONE atomic registry read; closeout uses this, not the old two-dep idea).
3. **Liveness dep:** add `remoteOwnerHasLiveSession(topicId, ownerMachineId) → { state: true|false|
   'unknown'; reachableAt? }`, reading the machine-local `liveRemoteTopics: Map<machineId, { topics:
   Set<number>; reachableAt }>` snapshot. Predicate = the ONE normative contract (peer lists a
   NON-terminal session for the topic; opaque counts as listed; empty fresh set = `false`; absent/stale
   = `'unknown'`).
4. **Snapshot refresher (gated):** owner set = distinct `.machineId` from `topicOwnerElsewhereInfo` over
   live-local-session topic bindings; fetch `/sessions` from exactly those owners (reuse the existing
   fan-out primitive, 5s timeout); level-triggered on the jittered (±10%) reaper cadence; evict departed
   peers each pass; observability breaker (consecutive-all-failed ≥ threshold → ONE deduped attention
   item, never stops the loop); enqueue newly-seen owners for the next pass.
5. **Part C decision (gated, inside `else if (otherOwner)`, AFTER pin-conflict, BEFORE dwell):**
   `true` → proceed to dwell→terminate (with Part E bypass); `false` → WITHHOLD + neutral once-per-episode
   `possibleStaleOwner` audit + `-1` sentinel + delete vetoes; `'unknown'`/throw/dep-absent → WITHHOLD +
   `possibleStaleOwner` audit. Only `true` reaches terminate.
6. **Dwell advancement:** `topicMovedStreak` value = `{ count, lastTrueReachableAt, lastSeenAt } | -1`
   (gated; legacy `number | -1` when OFF). A `true` tick counts ONLY when `reachableAt >
   lastTrueReachableAt`; `false`/`'unknown'` resets; `-1 + true` → fresh `{count:1,…}`.
7. **Part E bypass:** add `bypassRecentUserMessageForConfirmedMove?: boolean` to `terminateSession`
   (lifts ONLY `recent-user-message`, all other guards re-checked); thread through the reaper terminate
   dep; pass it ONLY on Part C `true` AND only when `recentUserMessageAt(topicId) ≤ snapshotReachableAt`
   (the freshest-interaction veto, local-receipt clock basis).
8. **Secondary re-key (gated):** key `topicMovedStreak`/`topicMovedVetoes` on topicId; GC with a grace
   window (`2 × tickIntervalSec`, last-seen stamped); episode-hygiene clears preserved.
9. **Follow-through:** on merge, open the Part A/B/D commitment (with the retirement plan).
10. **Tests:** all three tiers, both sides of every boundary listed below (incl. the `unknown`→WITHHOLD
    inverse-of-the-bug case, the OFF-behavior regression-lock, the `-1→true` transition, and the
    double-binding pathological case).

## Tests (all three tiers — non-negotiable; both sides of every boundary)

### Tier 1 — Unit (the decision table, in isolation, real deps)

- **Part C decision table — both sides of EVERY boundary:**
  - `remoteOwnerHasLiveSession → true` ⇒ closeout PROCEEDS (terminate attempted with the Part E
    bypass); assert terminate called.
  - `→ false` ⇒ WITHHOLD; assert terminate NOT called, the once-per-episode `reap-skipped-topic-moved`
    audit emitted with `skipped: 'no-live-remote-session'`, the `-1` held sentinel set, and
    `topicMovedVetoes` NOT incremented.
  - `→ 'unknown'` ⇒ WITHHOLD; assert terminate NOT called, audit `skipped: 'remote-liveness-unknown'`.
    **(The unknown→withhold case is the single most important test — it is the inverse of the bug.)**
  - **dep THROWS** ⇒ treated as `'unknown'` ⇒ WITHHOLD (assert no terminate).
  - **dep ABSENT while gate ON** ⇒ WITHHOLD (assert no terminate).
  - **gate OFF** ⇒ the Part C block is skipped and the closeout behaves EXACTLY as the pre-existing
    closeout test (a regression-lock on byte-identical OFF behavior).
- **Part C interaction with pin-conflict:** `pinnedHere && otherOwner` STILL holds (pin-conflict wins
  ahead of the liveness gate), regardless of `remoteOwnerHasLiveSession` — assert the existing
  pin-conflict hold is unchanged.
- **Part E bypass — both sides:** with gate ON and Part C `true` AND the topic's last user message
  OLDER than the snapshot `reachableAt`, the closeout terminate is called with
  `bypassRecentUserMessageForConfirmedMove: true`; a `recent-user-message`-blocked guard now CLEARS for
  that reason. **Freshest-interaction veto (both sides, codex R2 #3):** with gate ON and Part C `true`
  BUT a user message NEWER than the snapshot `reachableAt`, the bypass is NOT passed and
  `recent-user-message` STILL vetoes — the session the user is actively talking to is kept. With Part C
  `false`/`'unknown'`, terminate is NEVER called (so the bypass is never passed). With gate OFF,
  terminate is called WITHOUT the bypass. Plus a `terminateSession`-level
  unit: the new bypass lifts ONLY `recent-user-message` and STILL vetoes on `active-subagent` /
  `open-commitment` / `recovery-in-flight` (both sides of the narrow-bypass boundary). **Bypass-contract
  guard (codex R2 #4 — prevent bypass proliferation from eroding the guard model):** the unit asserts
  the keep-reason-bypass CONTRACT each `bypass*` option must honor — (a) reason-specific (lifts exactly
  ONE named `blocked.reason`, never a category or wildcard), (b) the lifted terminate is still AUDITED
  (the terminate's audit row records which keep-reason was bypassed and the confirmed-move origin), and
  (c) callable only from the named confirmed context (the closeout passes it ONLY on Part C `true`).
  This locks the precedent so a future "just add another bypass" is held to the same narrow, audited,
  context-bound contract rather than drifting toward a broad operator-grade skip.
- **Secondary — counter stability + episode hygiene:** with gate ON, a session respawn under a NEW id
  but the SAME topic PRESERVES the veto/streak count WITHIN one continuous owned-elsewhere episode
  (topic-keyed); a topic with no live session this tick is GC'd. **Episode-reset boundary (codex F4 —
  cross-episode contamination):** when the topic returns home / goes unowned BETWEEN episodes
  (`otherOwner` → null), the topic-keyed streak+veto MUST be cleared, so a LATER move of the same topic
  starts a fresh breaker from 0 — assert a stale prior-episode veto count does NOT carry into the new
  episode. Likewise assert a successful terminate and a pin-conflict hold each clear the topic-keyed
  count. With gate OFF, the maps stay session-id-keyed and the count resets on respawn (the pre-fix
  behavior — regression-locked as the OFF side). **`-1 → true` transition (codex R6 #2):** assert a
  held (`-1`) entry that next reads `state:true` REPLACES `-1` with `{ count: 1, lastTrueReachableAt,
  lastSeenAt }` (dwell starts from 1, no head-start), and a held entry that next reads `false`/`unknown`
  KEEPS `-1` with no new audit.
- **Secondary — double-local-binding pathological case (codex R7 #4 — the invariant's failure side):**
  the at-most-one-local-session-per-topic invariant is normally guaranteed by the pool, but assert the
  closeout's behavior IF two local sessions are ever bound to the same topic: each is evaluated
  independently in the per-session loop, the SHARED topic-keyed counter over-counts vetoes (opening the
  breaker SOONER — the safe direction), and every terminate still routes through the guarded
  `terminateSession` authority (no session is killed without its guards). Assert no wrong kill results —
  the shared counter is conservative, never permissive.

### Tier 2 — Integration (the route/dep wiring)

- **Snapshot refresher wiring:** stand up a fake peer serving `GET /sessions` with a session bound to
  topic N; assert the server.ts snapshot refresher records topic N under that peer's stable
  `machineId`, and `remoteOwnerHasLiveSession(N, ownerMachineId)` returns `true`; remove the session →
  next refresh → returns `false` (a fresh, reachable peer with an EMPTY topics set — assert empty≠unknown);
  make the peer unreachable → its `reachableAt` ages past the bound → returns `'unknown'`.
- **Dep-presence under the gate:** gate ON ⇒ `remoteOwnerHasLiveSession` is injected into the reaper
  deps and the refresher runs; gate OFF ⇒ the dep is ABSENT and no refresher is constructed (assert
  via the reaper's deps object and the absence of peer `/sessions` polling).
- **Owner-id parity:** assert the snapshot keys on the SAME stable `machineId` that
  `topicOwnerElsewhereInfo` returns as `.machineId` (the un-nicknamed `reg.ownerOf(...)` value), so a
  topic owned by a NICKNAMED peer still resolves liveness correctly — and a nickname rename of that peer
  does NOT flip the answer to `'unknown'` (the machineId-keying regression-lock for codex F1). Assert
  the combined dep returns `{ machineId, displayName }` from ONE read so the liveness key and the audit
  display text describe the same owner (the atomic-read regression-lock for codex R2 #2).
- **Snapshot observability breaker:** make ALL peers fail their fetch for `threshold` consecutive
  refresh passes; assert ONE deduped attention item is raised (not one per pass), the refresher KEEPS
  running (it does NOT stop — every answer stays `'unknown'` → WITHHOLD), and the counter resets on the
  first successful pass (no further attention item).

### Tier 3 — E2E (feature-alive with the flag ON)

- **Feature-alive (the Phase-1 must-have):** boot the production initialization path (server.ts mirror)
  with `monitoring.sessionReaper.closeoutLivenessGate` resolved ON; assert the reaper is constructed
  WITH a non-null, non-no-op `remoteOwnerHasLiveSession` dep (wiring-integrity: the dep delegates to a
  real snapshot, not a stub), the snapshot refresher is live, and the closeout consults it. Flag OFF ⇒
  the dep is absent and the closeout runs the legacy path (the alive-vs-inert boundary).
- **Lifecycle regression:** the live-bug scenario end-to-end — a stale ownership record points to a
  peer that has NO live session for the topic; assert the local LIVE session is NOT terminated (gate
  ON), versus the pre-fix behavior where it would have been (gate OFF, documented as the regression
  the gate fixes).

## Migration parity

`closeoutLivenessGate` is a new config DEFAULT (false). Register it in `migrateConfig()` /
`PostUpdateMigrator` with an existence check (add only when missing). A false default is a true no-op,
so existing agents are unaffected until the dev-agent gate (or an explicit config value) enables it.
No hook/skill/template change is required (this is internal monitoring behavior, not an agent-facing
capability) — but if any capability-index or CLAUDE.md awareness line is wanted, it is the standard
sessionReaper config note, not a new endpoint.

## Verification (after deploy, on a dev agent with the gate ON)

On a live multi-machine pair: induce a stale ownership record (ownership says peer X owns topic N
while peer X has no live session for N — e.g. let the peer's session complete without releasing
ownership). Confirm the local LIVE session is NOT terminated and `logs/sentinel-events.jsonl` shows a
`reap-skipped-topic-moved` row with `skipped: 'no-live-remote-session'` (or `'remote-liveness-unknown'`
if the peer was unreachable). Confirm a genuine move (peer X DOES have a live session for N) still
sheds the local leftover even when a message arrived just before the move (Part E). Confirm the
breaker, if it ever opens, counts across a same-topic respawn (the secondary fix) — it should no
longer take ~32 min. Also confirm the topic-keyed-counter GC grace window (default `2 × tickIntervalSec`)
is a safe upper bound on observed same-topic respawn latency under load (gemini R5 #3): if a respawn
gap ever exceeds it the breaker continuity would be lost (degrading only to the PRE-FIX behavior, never
a wrong kill) — bump the grace window if observed respawn latency approaches it.

### Fleet-promotion acceptance criteria (codex R6 #4 — the dark stage has an exit)

Because the safety fix is INERT on a gate-OFF machine, the fix only protects the fleet once promoted —
so the dark stage is not open-ended. Promoting `closeoutLivenessGate` from dev-only to fleet-default
requires ALL of the following, gating the flip (this is the Close-the-Loop exit for the maturation
ladder, tracked by the same follow-through commitment as A/B/D):
1. **A bounded dev soak** — the gate runs LIVE on the echo dev multi-machine pair for at least the
   declared soak window (≥7 days of real multi-machine traffic) with the full `## Verification` battery
   passing.
2. **Telemetry evidence from the soak**, read from `logs/sentinel-events.jsonl` + `/metrics/features`:
   (a) ≥1 real `reap-skipped-topic-moved {skipped:'no-live-remote-session'}` withhold observed AND the
   local session demonstrably survived (the bug it fixes actually fired and was caught); (b) genuine
   moves still shed (no stuck `closeout-breaker` flood on real moves); (c) ZERO observed cases of a sole
   live worker terminated under the gate.
3. **Zero open `closeout-breaker` regressions** attributable to the gate during the soak.
The flip itself is an operator-gated step (not auto); this section is the explicit, evidence-bound exit
condition so "ships dark" cannot quietly become "never promoted, fleet stays exposed."

## Open questions

*(none)*

## Do not duplicate

Existing related work (checked): the post-transfer closeout itself (on main, SessionReaper.ts), the
WS1.3 pin-conflict hold (on main), the WS1.2 P19 breaker (on main). The liveness-gate of the closeout
specifically is NOT yet built. The broader ownership-lifecycle work (release-on-complete /
claim-on-spawn / double-dispatch gate) is the explicit Part A/B/D follow-up <!-- tracked: ownership-follows-live-work -->, deliberately not in this
spec.
