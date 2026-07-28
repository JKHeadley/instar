---
title: "Ownership Follows Live Work (release-on-complete + claim-on-spawn + double-dispatch recovery gate)"
slug: "ownership-follows-live-work"
parent-principle: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions — the ownership RECORD must track where the live work actually is: a session that completes releases, a session that spawns claims, and a non-router recovery path must never re-run a topic this machine no longer owns. Make the record self-correcting so the stale state that PR #1258 had to defend against can no longer arise."
status: draft
author: echo
date: 2026-06-24
risk-class: safety-critical (ownership CAS is real cross-machine authority; a bad claim/release moves the run-fence — mitigated by the fenced-epoch FSM, fail-closed-everywhere, and a default-OFF dev-agent gate)
eli16-overview: "ownership-follows-live-work.eli16.md"
lessons-engaged:
  - "P2 Signal vs Authority — ownership is AUTHORITY (it moves the §L3 run-fence), so every new write goes through the SAME guarded `SessionOwnershipRegistry.cas()` + `applyOwnershipAction()` FSM at a fenced `epoch+1`; Part D's ownerOf read is a SIGNAL that informs forward-vs-rerun, never a new kill/authority (see 'Signal vs. authority')."
  - "P19 No Unbounded Loops — no new repeating loop is introduced (release fires once on the existing `sessionComplete` event; claim fires once per spawn; the recovery gate is a one-shot pre-respawn check); the existing reconciler/applier ticks are untouched (see 'Decision points touched')."
  - "P10 Comprehensive-First / No Deferrals — A, B, and D ship together as the deliberate completion of the PR #1258 follow-up tracked-commitment; nothing is split out except the genuinely-separate evented-lease end-state (named in 'Out of scope') (see 'Tracked follow-through')."
  - "Maturation Path — ships ENABLED on developer agents via resolveDevAgentGate (live on echo, dark on the fleet); the fleet-OFF default is the dark stage of the ladder, not a permanent kill (see the Dark flag section)."
  - "Close the Loop — this spec CLOSES the loop opened by PR #1258's tracked commitment (ownership-follows-live-work Part A/B/D); on merge it records the retirement of PR #1258's compensating liveness-snapshot gate as a tracked follow-up once A/B have soaked (see 'Tracked follow-through')."
approved: true
approved-by: "Justin — blanket pre-approval, topic 27515 (24h autonomous mesh mission, 'pre-approval for any decisions or specs needed')"
review-convergence: "2026-06-24T10:43:29.642Z"
review-iterations: 3
review-completed-at: "2026-06-24T10:43:29.642Z"
review-report: "docs/specs/reports/ownership-follows-live-work-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 11
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Ownership Follows Live Work (the defense-in-depth fix for stale-ownership)

## Problem (the follow-up to PR #1258, verified live against the code)

PR #1258 (`post-transfer-closeout-correctness`, shipped) **stopped the harm**: it liveness-gates the
`SessionReaper` post-transfer closeout so the reaper never terminates a live local session on a stale
ownership label. That is a compensating control — it makes the closeout SAFE *in the presence of* a
stale record. This spec **removes the stale record itself**, so the dangerous state can't arise:
three independent gaps in the `SessionOwnership` lifecycle let the registry record drift away from
where the live session actually is.

The ownership FSM (`src/core/SessionOwnership.ts`) is **claim-before-release, fenced by `(status,
epoch)`**: `place → claim(active) → transfer(transferring) → claim(active) → release(released)`
(statuses `placing | active | transferring | released`, **SessionOwnership.ts:22**; actions `place |
claim | transfer | release | force-claim | abort-transfer`, **SessionOwnership.ts:44-70**). The
registry write path is `SessionOwnershipRegistry.cas(action, { sessionKey, sender, nonce })`
(**SessionOwnershipRegistry.ts:142**), which runs the FSM transition, the per-session replay check,
and a durable CAS at `epoch+1`. **The `sessionKey` is `String(topicId)`** — the durable Telegram
forum-thread id (verified: `reg.ownerOf(String(topicId))` at **server.ts:7491**, **server.ts:15106**,
**server.ts:16176**; the route handler uses `String(body.topic).trim()` at **routes.ts:12633**).

Three gaps, each verified against the real code:

**Gap A — nothing issues `release` when a session COMPLETES.** The `release` action exists and the FSM
allows it only from `active` (`release-requires-active`, **SessionOwnership.ts:174**), but it is issued
TODAY in exactly TWO places, **both user-move transfers** — the NL-move handler
(**server.ts:18221-18224**, guarded `if (ownReg.ownerOf(sessionKey) === meshSelfId)`) and
`POST /pool/transfer` (**routes.ts:12850-12855**, guarded `if (self && …ownerOf(topicId) === self)`).
**No `release` is issued on session completion.** The completion signal is the SessionManager
`'sessionComplete'` event (emitted at **SessionManager.ts:1123, 1313, 1411**; handled in server.ts at
**server.ts:13247** for the ThreadlineRouter demotion). So a session that was transferred here and
then finishes leaves the record stuck `active(owner=this machine)` forever — the exact stale label
PR #1258's closeout has to defend against.

**Gap B — an autonomous spawn/resume CLAIMS nothing.** Autonomous runs are keyed on topicId and live
at `.instar/autonomous/<topicId>.local.md`. They spawn via the module helper
`spawnSessionForTopic(...)` (**server.ts:732**), which calls `sessionManager` to start a tmux session
but issues **no ownership CAS**. The router's place/claim seams (`casClaimOwnership` →
`{type:'place'}` at **server.ts:17652-17664**; `confirmClaim` → `{type:'claim'}` at
**server.ts:17670-17674**) only fire on the inbound `_sessionRouter.route(...)` path
(**server.ts:2114**). An autonomous spawn BYPASSES `route()` entirely, so ownership stays on whatever
machine last held it. The `AutonomousLivenessReconciler.respawn` closure (**server.ts:7862-7877**)
calls `spawnSessionForTopic` directly — it already *gates* on `topicOwnerElsewhere`
(**server.ts:7796**, `sharedTopicOwnerElsewhere` at **server.ts:7486-7493**) so it won't respawn a run
owned elsewhere, but **it never CLAIMS ownership when it does spawn**, so a live autonomous session on
this machine can run with the ownership record pointing at a peer.

**Gap D — non-router recovery paths re-feed the LEFTOVER session locally with NO ownership check.** The
single recovery funnel `SessionRecovery.checkAndRecover(topicId, sessionName)`
(**SessionRecovery.ts:150**, dispatched from `SessionMonitor` at **SessionMonitor.ts:293, 383**) drives
BOTH recovery sub-paths and has **zero** ownership consultation (grep of `SessionRecovery.ts`,
`ContextWedgeSentinel.ts`, `ActiveWorkSilenceSentinel.ts`, `SessionMonitor.ts` for
`ownerOf|topicOwner|holdsLease|forward` → no matches):
- **Context-exhaustion fresh-respawn** — `recoverFromContextExhaustion` (**SessionRecovery.ts:362**)
  uses `respawnSessionFresh` (**SessionRecovery.ts:96, 446**), wired in server.ts at
  **server.ts:8901** (`respawnSessionFresh`), which clears the resume UUID and re-feeds the recovery
  prompt (Telegram via `respawnSessionForTopic` at **server.ts:9005**) — respawning the topic's session
  in place with no ownership check.
- **Stuck recovery re-run** — `recoverFromStall` (**SessionRecovery.ts:305**) calls
  `this.deps.respawnSession(topicId, sessionName, recoveryPrompt)` (**SessionRecovery.ts:337**) and
  re-runs locally, unconditionally.

Neither path goes through `route()` — the only path that consults `isRemotelyHandled(outcome, self)`
and short-circuits when the owner is elsewhere (**server.ts:2131-2133**, `isRemotelyHandled` at
**SessionRouter.ts:108**). **The load-bearing asymmetry:** the `AutonomousLivenessReconciler` DOES gate
its respawn on `topicOwnerElsewhere` (**server.ts:7796**, re-checked at the actuation instant at
**AutonomousLivenessReconciler.ts:629-631**) — but the `SessionRecovery` recovery funnel has no
equivalent check, so in the active-active session pool a machine that noticed a wedge/stall re-runs a
topic regardless of who owns it. If the leftover session is still alive while the topic moved, the same
inbound message gets handled on BOTH machines = double reply. (`reinjectStuck` at **server.ts:18695**
is a SEPARATE lease-gated stuck-message-recovery loop that re-enters `route()` and so forwards
correctly — but its outer gate is `holdsLease()` (machine-level, **server.ts:18725**), not per-topic
ownership; it is the third Part-D site, addressed below.)

> **Reading this spec.** This is the dense normative reviewer/implementer document. For the
> plain-English version read the ELI16 companion (`ownership-follows-live-work.eli16.md`). Every code
> anchor below was verified against the real source in this worktree (base JKHeadley/main @ v1.3.651);
> the "Prompt-vs-code corrections" section records where the driving prompt diverged from the code.

---

## Scope of THIS spec

Three parts (A, B, D), all behind ONE new dark flag (`multiMachine.ownershipFollowsLiveWork`,
dev-agent-gated). The genuinely-separate evented/lease end-state (push-based ownership lifecycle) is
explicitly OUT OF SCOPE and named in "Out of scope". This spec makes the ownership RECORD track the
live work; it does not redesign the FSM, the replication model, or the reaper closeout (PR #1258 owns
the closeout).

---

## Part A (load-bearing): release-on-complete

### The change

On the SessionManager `'sessionComplete'` event, if THIS machine is the topic's `active` owner, issue
a `release` CAS so the record advances to `released` instead of being stuck `active`.

- **Wire on the existing event.** Add a `sessionComplete` handler ALONGSIDE the existing one at
  **server.ts:13247** (the ThreadlineRouter demotion handler) — same event, same construction site,
  same `sessionOwnershipRegistry` (`ownReg`) and `_meshSelfId` already in scope. Do NOT create a new
  poll/loop; the event already fires exactly-once per completion (SessionManager's exactly-once
  `beforeSessionKill`/`sessionComplete`/`sessionReaped` contract, **SessionManager.ts:945**).
- **Resolve the topicId from the completing session.** The handler receives `session: Session`. Map it
  to a topic id the SAME way the reaper does — via the topic binding (`telegram?.getSessionForTopic`
  is the inverse; the forward map is the topic-binding lookup the reaper uses at
  **SessionReaper.ts** `topicBinding`). Concretely: resolve `topicId` from the session's tmux name via
  the same `resolveTopicForTmux`/topic-binding source already used elsewhere in server.ts
  (**server.ts:7787**, `resolveTopicForTmux(s.tmuxSession)`). A session with **no** topic binding
  (non-Telegram / headless / unbound) is NOT topic-owned → skip (no release). **`resolveTopicForTmux`
  throws or returns null/undefined → skip (no release)** — fail-closed toward NOT releasing, since a
  topicId we cannot resolve is a record we cannot prove is ours (resolves the adversarial X2 / decision-
  completeness ordering finding; the handler wraps the resolve in a try/catch that treats any
  throw/empty as "unbound → skip"). This is the SAFE direction: only release a record we can prove is
  THIS topic's.
- **Owner check before release — guard on the COMPLETING SESSION's identity, not just `owner===self`
  (fail-closed; closes the same-machine A∥B clobber).** Issue the release ONLY when ALL hold: (a)
  `ownReg.ownerOf(String(topicId)) === meshSelfId`, (b) the record's status is `active`, AND (c) **the
  record this machine owns is the SAME live work that just completed — i.e. no NEWER live session for
  this topic exists on this machine.** Concretely: after resolving `topicId`, re-check that the topic
  has **no currently-live session** bound to it (`telegram?.getSessionForTopic(topicId)` returns no
  live tmux session, OR the live session it returns IS the one that just completed). If a DIFFERENT,
  still-live session is already bound to the topic (an autonomous run respawned for the same topic
  between this session's completion and the handler firing — the same-machine A∥B interleaving the
  adversarial reviewer surfaced), **do NOT release** — releasing would orphan the record of a live
  session ("released record, live session" = the stale-record-in-reverse). The FSM rejects a release
  on any non-`active`/non-owner status (`release-requires-active`/`release-not-owner`), so (a)+(b) are
  belt + suspenders; (c) is the load-bearing addition that the `owner===self` check alone cannot catch
  (the new session also makes `owner===self`). If the owner is a peer, there is no record, status ≠
  `active`, or a newer live session for the topic exists → **do nothing** (the record is not ours to
  release, or it belongs to live work). **Frontloaded Decision 9** records the session-identity guard.
- **Issue via the existing CAS + emitPlacement pairing.** Reuse the exact local-release shape already
  proven at **server.ts:18223**:

  ```ts
  // inside the new sessionComplete handler, gated by the flag
  const sk = String(topicId);
  // (c) session-identity guard: the topic must have no DIFFERENT live session (a newer
  // autonomous respawn for the same topic must not be released out from under).
  const liveForTopic = telegram?.getSessionForTopic?.(topicId); // the current live session, if any
  // Compare by a STABLE per-session identity, NOT a reusable tmux name. The real `Session` type
  // carries `startedAt: Date` (set at creation, never mutated) — that is the current stable
  // instance key (verified: there is NO `uuid` field on Session today; `startedAt` is the basis).
  // A tmux NAME can be reused across respawn (instar reuses the topic-derived tmux name), so a
  // name-only compare could match an OLD completion to a NEW session by name and wrongly proceed —
  // a respawn always has a strictly-later `startedAt`, so comparing `startedAt` distinguishes a
  // genuinely-different instance. (If a stable per-spawn id is later added to Session, prefer it;
  // `startedAt` is the documented basis until then.)
  const sameStart = (a, b) => a != null && b != null && String(a) === String(b); // startedAt is the
  // stable per-instance key (its concrete type — string or Date — is normalized via String()).
  const liveIsDifferentInstance =
    liveForTopic && !sameStart(liveForTopic.startedAt, session.startedAt);
  // Fail-closed if instance identity is unprovable: if EITHER startedAt is missing (cannot prove
  // same-instance), treat as "a different/unknowable session may be live" → withhold the release.
  const instanceIdentityUnprovable = liveForTopic && (!liveForTopic.startedAt || !session.startedAt);
  const newerLiveSession = !!liveIsDifferentInstance || !!instanceIdentityUnprovable;
  if (ownershipFollowsLiveWork && _meshSelfId && !newerLiveSession && ownReg.ownerOf(sk) === _meshSelfId) {
    const rec = ownReg.read(sk);
    if (rec?.status === 'active') {
      const prevOwner = rec.ownerMachineId;
      const r = ownReg.cas(
        { type: 'release', machineId: _meshSelfId },
        { sessionKey: sk, sender: _meshSelfId, nonce: ownershipNonce(_meshSelfId, 'rel-complete', sk) },
      );
      emitPlacement(sk, r, 'released', prevOwner); // REQUIRED — the cas-emit-placement lint fails CI on any unpaired cas()
    }
  }
  ```

  **Nonce — collision-resistant (closes the same-millisecond replay-drop, security + decision-
  completeness finding).** The original `Math.round(performance.now())` is millisecond-resolution, so a
  release→re-place→release on the SAME `sessionKey` within one ms could collide nonces and the second
  legitimately-distinct action be dropped as a replay (the replay key is `(sessionKey, sender,
  ownershipEpoch)`). All three new callsites (Part A release, Part B place+claim) therefore mint the
  nonce through a shared `ownershipNonce(machineId, verb, sk)` helper that appends a process-monotonic
  counter (and `crypto.randomUUID()`): `` `${machineId}:${verb}:${sk}:${Date.now()}:${nextNonceSeq()}:${randomUUID()}` ``.
  This guarantees per-process uniqueness regardless of clock resolution; the helper is the single nonce
  source so the format can never drift between callsites. (**Frontloaded Decision 10**.)

  `emitPlacement` (**server.ts:16289**) is MANDATORY on every `cas()` callsite — `scripts/lint-cas-emit-placement.js`
  fails CI on any unpaired call (verified the lint exists). It records the placement reason `'released'`
  into the coherence journal so the release replicates to peers exactly like the user-move release does.
- **Concurrency / fenced-epoch safety.** The `release` is a normal `epoch+1` CAS. If a peer has
  already advanced the record (e.g. a transfer claimed it away between the owner check and the CAS), our
  release **loses the CAS** (`cas-lost`, **SessionOwnershipRegistry.ts:156-159**) and is a no-op — we
  do NOT retry-storm or force. Losing to a higher epoch is the CORRECT outcome: if the topic was
  claimed away while our session was completing, the new owner's `active` record must win, not our
  stale `release`. The FSM's `release-not-owner`/`release-requires-active` guards also reject a release
  against a record we no longer own. **Frontloaded Decision 1** records "release is best-effort,
  CAS-fenced, never forced".

### Why this is the durable fix PR #1258 deferred

PR #1258's liveness snapshot exists ONLY because a completed-but-not-released session leaves a stale
`active` record. With Part A, that record becomes `released` the instant the session completes →
`ownerOf` returns `null` (released records read as no-owner, **SessionOwnershipRegistry.ts:119**) →
the reaper's `topicOwnerElsewhere` returns null → the closeout's `else if (otherOwner)` arm is not even
entered. The stale label that the snapshot gate compensates for can no longer exist on the
release-on-complete path. (The reciprocal race — a session that completes between a peer's snapshot and
the reaper's decision — is what PR #1258's `reachableAt`-advancement dwell still covers; A makes it
rare, not impossible, which is why PR #1258's gate is RETIRED only after A+B soak, not deleted here —
see "Tracked follow-through".)

---

## Part B: claim-on-spawn

### The change

An autonomous-session spawn/resume issues a `place → claim` so ownership follows the live session onto
THIS machine.

- **The spawn locus.** `spawnSessionForTopic(...)` (**server.ts:732**) is the single module helper the
  autonomous reconciler respawn uses (**server.ts:7865**). Rather than mutate the generic helper (it is
  also used by router-driven spawns that ALREADY claim via `route()`, and by the resume-queue drainer),
  thread the claim at the **autonomous** call site — the `AutonomousLivenessReconciler.respawn` closure
  (**server.ts:7862-7877**) — so the claim is scoped to the path that genuinely bypasses the router.
  (Frontloaded Decision 2: claim at the autonomous respawn closure, NOT inside `spawnSessionForTopic`,
  to avoid double-claiming on the router path and to keep the helper generic.)
- **Also at autonomous-run START.** An autonomous run is started by a skill writing
  `.instar/autonomous/<topicId>.local.md`; the FIRST live session for that topic is spawned through the
  ordinary inbound `route()` path (which claims) OR, when the run is started while a session is already
  live, no spawn occurs. The claim-on-spawn obligation is therefore precisely: **whenever the
  autonomous machinery spawns a tmux session for a topic without going through `route()`** — which today
  is the reconciler `respawn` closure. If a future autonomous start path spawns directly, it MUST
  thread the same claim (a normative obligation, locked by the Tier-1 test below). There is no separate
  HTTP `POST /autonomous` route that spawns (verified: `/autonomous/*` routes are read/stop/evaluate
  only — `routes.ts:4216-4405` — the run is file-driven + lazily spawned).
- **The claim sequence (FSM-correct).** Ownership of a never-seen / released topic must go `place` →
  `claim` (a bare `claim` on a missing/released record is rejected `no-record`/`claim-out-of-sequence`,
  **SessionOwnership.ts:117,128**). So the autonomous claim mirrors the router's two-step seam:

  ```ts
  // after a successful spawnSessionForTopic on the autonomous path, gated by the flag
  const sk = String(topicId);
  if (ownershipFollowsLiveWork && _meshSelfId) {
    const cur = ownReg.read(sk);
    if (!cur || cur.status === 'released') {
      // never-seen / released → place then claim onto self
      const prev0 = cur?.ownerMachineId;
      const rp = ownReg.cas({ type: 'place', machineId: _meshSelfId }, { sessionKey: sk, sender: _meshSelfId, nonce: ownershipNonce(_meshSelfId, 'auto-place', sk) });
      emitPlacement(sk, rp, 'placed', prev0);
      if (rp.ok) {
        const rc = ownReg.cas({ type: 'claim', machineId: _meshSelfId }, { sessionKey: sk, sender: _meshSelfId, nonce: ownershipNonce(_meshSelfId, 'auto-claim', sk) });
        emitPlacement(sk, rc, 'placed', _meshSelfId);
      }
    }
    // cur.status === 'active' && owner === self  → already ours, no-op
    // cur.status === 'active' && owner !== peer  → see "owned-elsewhere" rule below
  }
  ```

- **Owned-elsewhere is NOT force-claimed (fail-closed — the load-bearing safety rule).** If the record
  is `active`/`transferring`/`placing` owned by a PEER, the autonomous spawn does **NOT** steal it.
  Crucially, the reconciler ALREADY refuses to respawn a run whose topic is owned elsewhere
  (`topicOwnerElsewhere` gate, **server.ts:7796**) — so the owned-by-peer + autonomous-spawn case
  should not occur on the reconciler path at all. If it ever does (a race where ownership moved between
  the gate read and the spawn), the claim is **withheld** and ONE neutral audit row records the
  divergence (`auto-spawn-owned-elsewhere`, observational, non-directional). A force-claim of a live
  peer is reserved for the `OwnershipReconciler`'s death-evidence path (**OwnershipReconciler.ts:217**,
  `force-claim` requires offline-past-bound + quorum, **SessionOwnership.ts:141-152**) — never an
  autonomous spawn. (Frontloaded Decision 3.)
- **Fenced-epoch safety.** Both `place` and `claim` are `epoch+1` CAS; a lost CAS (a peer advanced
  first) is a no-op — the session still runs locally (the spawn already succeeded), it just doesn't own
  the record this tick, and the existing reconciler/applier converges ownership on its next tick. A
  claim can never advance past a higher epoch (the durable CAS rejects it), so a stale autonomous claim
  cannot clobber a fresher transfer. **Frontloaded Decision 1** (CAS-fenced, never forced) covers this.
- **The failed-claim window is a BOUNDED, self-healing degraded state — named, not hand-waved (closes
  the codex#2 / adversarial-B1 "live session, peer-owned record = split-brain" finding).** When `place`
  succeeds but `claim` loses the CAS (or `place` itself loses), the topic has a live local session while
  the ownership record names a PEER. This is the SAME transient shape the active-active pool already
  tolerates today (a router-claimed session whose claim raced a transfer) — it is NOT a new split-brain
  class, and it is bounded on BOTH ends:
  - **Harm during the window is already prevented by Part D + the existing forward path.** An inbound
    message for the topic routes to the record's (peer) owner — NOT to the local session — so the live
    local session does NOT double-handle. The peer either serves it or (if the peer is in fact gone) the
    reconciler's death-evidence force-claim moves ownership back. So "live session, peer-owned record"
    produces NO double-reply while it lasts; it is a momentary ownership-lag, not a correctness fork.
  - **Convergence is the EXISTING reconciler/failover policy (no new mechanism, no unbounded wait).**
    The `OwnershipReconciler` already reconciles a live-session-vs-record divergence; the autonomous
    session is reaped/converged by the same machinery that handled this before the spec. The window is
    therefore bounded by the **existing reconciler/failover policy**, not by anything this spec adds —
    stated as that policy, NOT as a hard "exactly one tick" guarantee, because the reconciler's
    force-claim of a peer-owned record requires its own death-evidence/quorum conditions, so convergence
    of a live-local-vs-stale-peer-record divergence is bounded by THAT policy's timing (which may be more
    than one tick when the peer is alive-but-wrong). The honest claim is: the window is no worse than,
    and converges by, the SAME machinery that handled this exact divergence before this spec — Part B
    adds no new bound and no new loop. Part B does NOT add a retry/settle loop on the failed claim (P19):
    it withholds, lets the spawn run, and leans on the existing reconciler — a single retry-on-next-spawn
    at most, never a storm.
  - **Honest scope:** Part B's job is to make the COMMON case (uncontended autonomous spawn) claim
    immediately; the rare lost-claim case degrades to exactly today's reconciler-converges behavior, no
    worse. (**Frontloaded Decision 11** records the bounded-degraded-state contract.)

---

## Part D: double-dispatch recovery gate

### The change

Gate the two non-router recovery respawn/re-run paths on
`sessionOwnershipRegistry.ownerOf(String(topicId)) !== self` → **forward to the owner, do NOT re-run
locally**.

- **The decision predicate (THE ONE NORMATIVE RULE).** Before a recovery path respawns or re-injects a
  topic's session, compute:

  > `owner = ownReg.ownerOf(String(topicId))` (null when no record / released).
  > - `owner === self`  → **re-run locally** (today's behavior; the recovery is correct, we own it).
  > - `owner === a known peer` → **do NOT re-run locally; FORWARD** the inbound to the owner via the
  >   existing forward mechanism (see below).
  > - `owner === null` (no record / released) → **re-run locally** (no peer owns it — re-running here is
  >   the only way the conversation continues; this is the SAFE direction, see fail-closed note).

- **Part D's direction is MIXED, and named honestly per state — NOT uniformly "fail-closed" (closes
  the codex#1 / gemini#3 / conformance-gate / adversarial-D1 finding).** The harm Part D prevents is a
  DOUBLE reply (two machines handling one message). For a KNOWN peer owner the direction is
  fail-CLOSED-toward-no-double-dispatch (withhold the local re-run). For an UNKNOWN-ownership state
  (registry unreadable) the direction is deliberately fail-OPEN-toward-conversation-continuity (re-run
  locally) — a different and weaker guarantee. Calling the registry-error path "fail-closed" would be
  dishonest: it is exactly the condition where this machine has the LEAST knowledge of peer ownership,
  so re-running can double-dispatch. We make that tradeoff EXPLICIT and instrument it (see telemetry
  below) rather than mislabel it. The per-state rules:
  - `owner === a reachable peer` (record says peer, peer is online) → **forward, don't re-run**
    (fail-closed; the owner serves it, double-dispatch avoided).
  - `owner === an UNREACHABLE peer` (record names a peer but the peer is offline/unreachable) →
    **re-run is WITHHELD** this attempt (fail-closed); the message is NOT lost — it rides the existing
    forward/queue path (the router's `deliverMessage` → durable inbound queue, the SAME path `route()`
    uses, **server.ts:17675**), and if the owner stays dark the existing ownership reconciler + failover
    re-place machinery (force-claim on death evidence) eventually moves ownership and the conversation
    resumes. We do NOT locally steal-and-rerun on a bare unreachability (that is exactly the
    double-dispatch the reaper-closeout incident was about). The withhold-on-unreachable is bounded by
    the durable inbound queue's OWN TTL + loss-notice machinery (it is not an unbounded hold: a message
    that can never be delivered surfaces the existing "I didn't get to these N messages" loss notice
    rather than growing the queue forever — this closes the adversarial-D2 unbounded-queue concern by
    pointing at the existing bound, not inventing a new one). **Honest scope:** this trades a bounded
    recovery delay for never double-replying — the correct direction for a recovery path.
  - **`isOwnerReachable` THROWS or is INDETERMINATE for a peer-owned record → treat as the
    UNREACHABLE-peer branch (withhold + queue), NOT local re-run (closes the adversarial-#2 /
    decision-completeness-#3 gap).** The record NAMES a peer owner; we simply cannot confirm reachability
    this instant. Because a peer IS named, the safe direction is the unreachable-peer one (don't
    double-dispatch) — distinct from the `ownerOf`-throw case below where we have NO owner evidence at
    all. (**Frontloaded Decision 4** updated to enumerate this case.)
  - `owner === null` (released / never-seen) → **re-run locally** — there is no competing owner, so
    re-running here cannot double-dispatch, and NOT re-running would silently drop the recovery. This is
    why the `null` case re-runs while the `unreachable-peer` case withholds: `null` means "nobody owns
    this", `unreachable-peer` means "someone else owns this, just can't be reached right now".
  - **`ownerOf` THROWS / registry unreadable → re-run locally — and this is fail-OPEN, stated as
    such.** We have NO owner evidence at all (distinct from the reachability-throw case, where the record
    DID name a peer). The simplest safe rule, and the one the tests lock, is: a registry read error →
    re-run locally (fail toward the conversation continuing on the machine that noticed the wedge),
    because a recovery path that silently does nothing on a registry blip is a worse failure (a dead
    conversation) than a rare double-reply. This is the one place Part D deliberately prefers "continue
    the conversation" over "never double-dispatch", bounded by the fact that a registry read error is
    rare and transient. **A PERSISTENT registry-read failure degrades to the OLD double-dispatch-prone
    behavior** — a degenerate already-broken state (the registry being unreadable is itself a sev
    incident), not a new regression this spec introduces. (**Frontloaded Decision 4** records this
    asymmetry explicitly.)
  - **Telemetry obligation (so the fail-OPEN tradeoff is measured, not assumed — required by the
    conformance gate + both external reviewers).** Every time the registry-error or reachability-throw
    branch is taken, Part D emits ONE neutral observational row (`recovery-gate-registry-unknown` /
    `recovery-gate-reachability-unknown`) to the existing machine-local `logs/sentinel-events.jsonl`,
    carrying `{ ts, topicId, decision: 're-run-local' | 'withhold', reason }` (the audit-row schema is
    fixed here — closes decision-completeness-#6). The dev-soak's fleet-promotion acceptance criteria
    (below) add a hard gate: **registry-error re-runs and any observed double-dispatch attributable to
    the fail-open path must be ZERO (or a counted, understood rarity)** before the flag is promoted —
    making "registry errors are rare enough to justify this" a measured fact, not an assumption.

- **The gate locus — the SINGLE recovery funnel `SessionRecovery.checkAndRecover`.** Both
  recovery sub-paths flow through `checkAndRecover(topicId, sessionName)` (**SessionRecovery.ts:150**),
  which ALREADY receives the `topicId`. Add the ownership decision THERE (one gate, both sub-paths),
  rather than at each scattered sentinel — the minimal, single-funnel change. Inject a
  `topicOwnerElsewhere`-shaped dep into `SessionRecoveryDeps` (mirroring the autonomous reconciler's
  `topicOwnerElsewhere` dep, **AutonomousLivenessReconciler.ts** + its wiring at **server.ts:7796**,
  reusing the same `sharedTopicOwnerElsewhere` closure at **server.ts:7486**) and a reachability dep
  (`isOwnerReachable`). At the top of `checkAndRecover` (flag ON):
  - `ownerOf === self` (or no record / released) per the predicate above → proceed with the existing
    `recoverFromContextExhaustion`/`recoverFromStall` (today's behavior).
  - `ownerOf === reachable peer` → do NOT recover locally; the owner's own recovery owns this topic.
    Forward intent: re-feed the topic's pending inbound through `route()` (**server.ts:2114**) so the
    existing `isRemotelyHandled` short-circuit (**server.ts:2131**) forwards it to the owner — never a
    local respawn/re-inject.
  - `ownerOf === unreachable peer` (incl. reachability-throw/indeterminate) → WITHHOLD the local
    recovery (the message rides the durable inbound queue / forward path); do not steal-and-rerun on a
    bare unreachability.
- **The forward mechanism — fully specified, not just "reuse `route()`" (closes the codex#3 /
  adversarial-X1 underspecified-payload finding).** The forward path is `_sessionRouter.route(...)`
  (**server.ts:2114**) + the `isRemotelyHandled` short-circuit (**server.ts:2131**, covering
  `forward`/`duplicate`/remote `spawned`/`owner-dead-replaced`). The recovery gate does NOT fabricate a
  message — it forwards the topic's ALREADY-DURABLE pending inbound, identified the SAME way `route()`
  and the stuck-recovery loop identify it today:
  - **Message identity + source.** The pending inbound for a topic is the durable, platform-keyed
    message the existing inbound pipeline already persists (the Telegram update / durable inbound queue
    entry, keyed on the platform event id — the SAME idempotency key `route()` and the per-message
    dedupe ledger already use). The recovery gate re-feeds THAT entry through `route()`; `route()`'s
    existing exactly-once ledger (the per-message event-id dedupe) guarantees the owner handles it once.
    The gate adds NO new identity scheme and NO new dedupe — it relies on the existing per-event-id
    exactly-once contract.
  - **No-pending-inbound case (explicit).** If there is NO pending inbound for the topic (the wedge was
    detected on an idle session with nothing queued), the gate has nothing to forward: it simply
    WITHHOLDS the local respawn and emits no forward (the topic genuinely has no message to serve, so a
    local respawn would be re-running nothing). The leftover idle session is then converged by the
    existing reaper/reconciler — there is no message to strand. (Closes the "what if no pending inbound"
    sub-question.)
  - **`route()` IS a `SessionRecovery` dependency, with a precise signature (wiring + count/ordering
    made explicit — closes codex-r2#1).** `SessionRecovery` does not import the router today; Part D
    injects a `forwardPendingInboundViaRoute(topicId): { forwarded: number; nonePending: boolean }`-
    shaped dep into `SessionRecoveryDeps` (the same DI pattern as the `topicOwnerElsewhere`/
    `isOwnerReachable` deps), bound at server-init to the existing durable-inbound re-feed through
    `_sessionRouter.route(...)`. Semantics are fixed here, NOT left to the implementer: it delegates to
    the SAME durable-inbound-queue drain the existing stuck-recovery path uses, forwarding **all
    currently-pending inbound for the topic in queue (FIFO) order** (never a fabricated single message),
    and returns the count + a `nonePending` flag. Ordering and exactly-once are the existing queue
    drain's + `route()`'s per-event-id ledger's responsibility — Part D adds neither a new ordering rule
    nor a new dedupe. `nonePending: true` is the no-pending-inbound case above (withhold the local
    respawn, emit no forward). No new forward path is invented; the dep makes the existing drain
    reachable from the recovery funnel with a defined return contract.
- **The third site — `reinjectStuck` / `recoverStuckMessages`** (**server.ts:18695**) ALREADY re-enters
  `telegram.onTopicMessage` → `route()`, so it WOULD forward correctly — EXCEPT its outer gate is
  `holdsLease()` (machine-level, **server.ts:18725**), so a lease-holder that is not the topic's owner
  runs stuck-recovery for a topic it doesn't own. The fix: make `recoverStuckMessages` consult the SAME
  shared reachability helper (below) and, **per-topic (granularity made explicit — closes
  decision-completeness-#7): SKIP the entire stuck-recovery re-feed for a topic owned by a reachable
  peer, leaving that topic's stuck messages IN the durable queue untouched** (not de-queued, not
  dropped) so the owner's own stuck-recovery drains them; it does NOT skip per-message within a topic
  (the unit is the topic, because ownership is per-topic). Topics this machine owns (or that are
  unowned) re-feed exactly as today (its `route()`-re-entry already forwards correctly for the rest).
- **Owner-reachability source — ONE shared helper, used by BOTH Part-D gates (closes
  decision-completeness-#4 unification).** "reachable peer" = the SAME signal the router already uses:
  `machinePoolRegistry?.getCapacity(owner)?.online === true` (the `isMachineAlive` seam at
  **server.ts:17639** reads exactly this). Part D binds this as a SINGLE `isOwnerReachable(owner)`
  helper injected into BOTH `checkAndRecover` (via `SessionRecoveryDeps`) and the `recoverStuckMessages`
  gate — never two inlined copies — so the two gates can never make divergent reachability calls. Any
  throw from the helper is the unreachable-peer branch (above). **Reachability-check timing (closes
  decision-completeness-#3):** the check is at decision time (gate entry); NO separate re-check just
  before the `route()` forward is required, because `route()` ITSELF re-resolves the live owner and
  applies `isRemotelyHandled` at dispatch — so a peer that went dark between the gate read and the
  forward is caught by `route()`'s own logic, not by a stale Part-D snapshot. The Part-D check decides
  re-run-vs-forward; `route()` owns the actual delivery decision. This is why a single entry-time read
  is sufficient and correct.

---

## Dark flag (this is instar-dev — gate ALL new behavior)

Add a single new flag `multiMachine.ownershipFollowsLiveWork: boolean`, **OMITTED from ConfigDefaults**
so `resolveDevAgentGate` resolves it LIVE on a dev agent (echo) / DARK on the fleet. This mirrors the
sibling `multiMachine.seamlessness.*` dev-gated flags (`ws3OneVoice`, `ws13Reconcile`, `ws41DurableAck`,
`ws43RoleGuard`) which are deliberately omitted from `ConfigDefaults.ts` (**ConfigDefaults.ts:927-984**)
and registered in `DEV_GATED_FEATURES`.

- **Placement.** A FLAT boolean under `multiMachine` (NOT under `seamlessness`, and NOT named with a
  per-WS prefix) — chosen because Parts A/B/D touch the ownership lifecycle broadly (server.ts spawn +
  complete + recovery sites), not a single seamlessness work-stream. (Frontloaded Decision 6.)
- **Resolution.** At each of the three wiring sites, resolve once:
  `const ownershipFollowsLiveWork = resolveDevAgentGate((config.multiMachine as { ownershipFollowsLiveWork?: boolean } | undefined)?.ownershipFollowsLiveWork, config);`
  (the canonical funnel, **devAgentGate.ts:40**; `explicitEnabled ?? !!config.developmentAgent`). An
  explicit config value always wins (false force-darks even a dev agent; true is the fleet-flip).
- **Registration.** Add ONE entry to `DEV_GATED_FEATURES` (**devGatedFeatures.ts:45**) —
  `name: 'ownershipFollowsLiveWork'`, `configPath: 'multiMachine.ownershipFollowsLiveWork'`,
  with a justification noting: ownership CAS is fenced-epoch + fail-closed + best-effort (never forces,
  loses safely to a higher epoch); no spend, no destructive fs/git action; single-machine agents are a
  strict no-op (`_meshSelfId` null → every gate short-circuits, exactly like `sharedTopicOwnerElsewhere`
  at **server.ts:7490**). NOT in `DARK_GATE_EXCLUSIONS` — it rides the dev-agent gate (it is dogfooded
  on the echo dev multi-machine pair, the maturation ladder).
- **Type.** Add the optional field to the `multiMachine` config type in `src/core/types.ts` (the
  `multiMachine` interface, near the other multi-machine flags) — `ownershipFollowsLiveWork?: boolean`,
  documented as dev-gated/omitted-default so the dark-gate lint recognizes the omit-`enabled` posture.
- **Migration parity — NONE required.** Because the flag is OMITTED from ConfigDefaults (the gate
  decides at runtime), there is **no** `migrateConfig`/`PostUpdateMigrator` entry to add — this matches
  the established dev-gated-omit pattern (`migrateConfigSeamlessnessDevGate`, **PostUpdateMigrator.ts:401**,
  only patches flags that need a default; an omitted dev-gated flag needs none). A dev agent picks it up
  live on its next boot; the fleet stays dark until an explicit flip. (Frontloaded Decision 7.)

- **OFF ⇒ behaviorally identical to today.** When the resolved flag is false: the new `sessionComplete`
  release handler does nothing (early-returns before any CAS), the autonomous claim is not issued, and
  the recovery paths run their existing logic unchanged (direct inject / fresh-respawn / lease-gated
  re-feed exactly as today). No new CAS is attempted, no ownership record changes, no recovery decision
  differs. The OFF-side regression-lock tests assert this observable behavior (not literal byte
  identity — the new config field, the new handler closure, and the new gate reads now exist in the
  source).

---

## Signal vs. authority (explicit)

- **Parts A & B issue real AUTHORITY** — a `release`/`place`/`claim` moves the §L3 run-fence (who may
  run the agent for a topic, `mayRun` at **SessionOwnership.ts:189**). So every new write goes through
  the SAME guarded `SessionOwnershipRegistry.cas()` → `applyOwnershipAction()` FSM at a fenced `epoch+1`
  (**SessionOwnership.ts:91**), with the per-session replay nonce check and the durable CAS. No new
  authority surface is created; no FSM transition is added or weakened. A claim that would advance past
  a higher epoch is rejected by the durable CAS (clock-proof), and a release on a record we no longer
  own is rejected by the FSM (`release-not-owner`/`release-requires-active`).
- **Part D's `ownerOf` read is a SIGNAL** — it informs the forward-vs-rerun decision; it never kills,
  spawns, or writes ownership. The forward itself reuses the existing `route()` authority path. So Part
  D adds no new gate authority — it makes an EXISTING recovery decision consult ownership before
  re-running, strictly REDUCING double-dispatch (it can only ever withhold a local re-run / route it to
  the owner, never cause a new kill or a new send).

## Safe-direction-per-part (explicit — A & B are fail-closed; D is mixed and labeled honestly)

Parts A and B are uniformly fail-CLOSED (every uncertainty → withhold the write). Part D is MIXED by
ownership state — fail-closed-toward-no-double-dispatch for a known peer owner, but deliberately
fail-OPEN-toward-conversation-continuity for an unknown-ownership registry error. We name this split
honestly rather than calling the whole feature "fail-closed" (the original framing the cross-model +
conformance reviewers correctly flagged).

- **Part A (release) — fail-closed:** every uncertainty → DO NOT release. No record / not-owner /
  status≠active / CAS-lost / **`resolveTopicForTmux` throw or empty** / **a newer live session exists
  for the topic (the session-identity guard)** / registry throw → no-op. Releasing wrongly would orphan
  a live session's record; withholding a release at worst leaves a stale `active` that the existing
  reconciler/applier + PR #1258's closeout gate still handle. Safe direction = withhold the release.
- **Part B (claim) — fail-closed:** every uncertainty → DO NOT force. Owned-by-peer / CAS-lost /
  registry throw → withhold the claim (the session still runs locally; ownership converges on the
  reconciler's next tick — the bounded-degraded-state contract above). Claiming wrongly (stealing a live
  peer's topic) would split-brain the run-fence; withholding a claim only delays ownership convergence.
  Safe direction = withhold the claim, never force-claim.
- **Part D (recovery gate) — MIXED, stated per state:**
  - reachable-peer-owner → **fail-closed** (forward, no local re-run).
  - unreachable-peer-owner, **incl. reachability-throw/indeterminate** → **fail-closed** (withhold the
    local re-run; the message rides the durable inbound queue, itself bounded by that queue's TTL +
    loss-notice — never an unbounded hold, never a silent strand).
  - null/released owner → re-run locally (no competing owner; cannot double-dispatch).
  - **`ownerOf`-throw / registry-unreadable → fail-OPEN (re-run locally), labeled as such** — a dead
    conversation is a worse failure than a rare double-reply; instrumented with the
    `recovery-gate-registry-unknown` telemetry row and gated to ZERO-or-counted in the fleet-promotion
    criteria. A *persistent* registry failure degrades to the OLD double-dispatch-prone behavior (an
    already-broken state, not a new regression). (Frontloaded Decision 4 + 8.)

## Foundation assumption — ownership CAS replication correctness (surfaced, per the lessons-aware audit)

Parts A/B add two CAS callsites to the EXISTING replicated ownership lifecycle; they do not redesign it.
This spec's correctness therefore RESTS ON two foundation properties of `SessionOwnershipRegistry.cas()`
+ the `emitPlacement` → coherence-journal → `OwnershipApplier` replication path it reuses:
1. The durable CAS correctly rejects a release/claim that does not advance `epoch+1`, and rejects a
   release against a record we no longer own (`release-not-owner` / `release-requires-active` FSM guards).
2. A CAS landing on THIS machine replicates to peers durably (eventually-visible via the applier).

These are the SAME properties the already-shipped user-move release/transfer and PR #1258's closeout
gate already depend on — this spec adds no new replication assumption. The honest consequence: **during
the mixed-fleet soak, PR #1258's liveness-snapshot gate is STILL the defense against a peer whose
applier is lagged** (a gate-OFF peer emits no release at all; a gate-ON peer's release may not yet be
visible). That is exactly why the Tracked follow-through retires the snapshot gate ONLY after the soak
proves zero orphaned-record incidents — the retirement is evidence-gated on validated replication under
partition/clock-skew, not on this spec merging. If foundation property (2) were ever violated (a
release that never replicates), Parts A/B would orphan records on a peer — which is precisely the
incident class the soak telemetry + the retained snapshot gate exist to catch before retirement.

---

## Multi-machine posture (Cross-Machine Coherence — mandatory declaration)

Every state surface this spec touches, with its posture when the agent runs on more than one machine.
This spec adds **no new state surface** — it writes to the EXISTING cross-machine ownership registry.

- **`SessionOwnership` registry (EXISTING — REPLICATED, ground its real model).** The registry is a
  per-session FSM record (`SessionOwnershipRecord`, **SessionOwnership.ts:24**) whose CAS landings are
  emitted to the **coherence journal** (`emitPlacement`, **server.ts:16289**) and replicated to peers;
  the `OwnershipApplier` (**server.ts:16263-16282**, `ownershipApplierWiring.ts`) materializes durable
  local ownership FROM the replicated placement journal on every machine that consumes it. So a Part A
  `release` or a Part B `place/claim` on THIS machine REPLICATES (via the same `emitPlacement` →
  journal → applier path the user-move release/transfer already uses) — that is the whole point: the
  release/claim must be visible to the reaper-closeout machine. **This is correct and required**, not a
  new posture: Parts A/B simply add two more CAS callsites to the existing replicated lifecycle. The
  durable store is active on every machine that runs the placement-replication applier
  (`shouldActivateDurableOwnership`, **server.ts:16130-16144**); single-machine agents stay InMemory and
  every new gate is a strict no-op (`_meshSelfId` null short-circuit).
- **`ownershipFollowsLiveWork` flag (NEW) — per-machine resolution is CORRECT here.** Unlike a
  transfer/placement feature where half-activation strands a seat (the `dev-gate-breaks-multimachine-features`
  lesson), Parts A/B/D each make a STRICTLY-MORE-CORRECT local decision (release a record we own, claim
  a record for a session we run, forward instead of double-dispatch). A gate-OFF machine retains today's
  (stale-prone) behavior; a gate-ON machine self-corrects its own records. **The mixed-fleet honesty:**
  during the staged rollout, a gate-ON machine releases-on-complete and claims-on-spawn while a gate-OFF
  peer does not — so ownership records are *more* accurate for the ON machine's sessions and unchanged
  for the OFF machine's. This produces no inconsistent/ corrupt cross-machine state (each CAS is fenced;
  a gate-OFF machine simply omits some releases/claims, which the existing reconciler/applier already
  tolerate — they were the only correction mechanism before this spec). The only asymmetry is *which
  machine's sessions keep their record fresh* — a strict improvement, never a corruption. The
  fleet-flip is the tracked maturation exit.
- **Recovery audit rows (Part D / Part B owned-elsewhere) — MACHINE-LOCAL.** The neutral
  observational audit rows land in this machine's existing `logs/sentinel-events.jsonl` /
  `logs/autonomous-liveness.jsonl` (already machine-local). No new durable surface, no cross-machine
  notice, no generated URL.

No new on-disk state, no new endpoint, no user-facing cross-machine notice is introduced.

---

## Prompt-vs-code corrections (grounding discipline)

Verified against the real source; the driving prompt diverged in three places, and the code wins:

1. **Part B is claim-on-spawn, NOT add-a-gate.** The prompt implied the autonomous path lacks an
   ownership check entirely. In fact the `AutonomousLivenessReconciler` ALREADY gates respawn on
   `topicOwnerElsewhere` (**server.ts:7796**) so it won't respawn a run owned elsewhere — but it never
   CLAIMS ownership when it DOES spawn. So Part B adds the `place/claim` on the spawn, and the
   owned-elsewhere case is already handled by the existing gate (Part B only needs a withhold+audit for
   the rare post-gate race). Corrected in "Part B".
2. **`release` is already issued today — but only on user-move transfers, never on completion.** The
   prompt said "nothing issues `release`". The code issues `release` at **server.ts:18223** (NL move)
   and **routes.ts:12852** (`/pool/transfer`). Part A's precise gap is "no release on `sessionComplete`",
   which is what this spec wires. Corrected in "Problem / Gap A".
3. **The recovery re-feed paths share ONE ungated funnel — `SessionRecovery.checkAndRecover`.** The
   prompt grouped "context-exhaustion respawn + stuck-recovery re-run" as separate sites. The code: both
   flow through the single funnel `SessionRecovery.checkAndRecover(topicId, sessionName)`
   (**SessionRecovery.ts:150**) — context-exhaustion via `recoverFromContextExhaustion`
   (**:362** → `respawnSessionFresh`) and stuck via `recoverFromStall` (**:305** → `respawnSession`,
   **:337**) — and that funnel has ZERO ownership consultation. The cleanest fix is ONE ownership gate
   in `checkAndRecover` (it already receives the topicId), not three scattered patches. A SEPARATE third
   path, `reinjectStuck`/`recoverStuckMessages` (**server.ts:18695**), already re-enters `route()` (so
   it forwards) but is gated only on `holdsLease()` (machine-level, **server.ts:18725**), not per-topic
   ownership — so it needs a per-topic owner check added. Corrected in "Part D".

No anchor was confabulated. Every `file:line` above was read from this worktree's source.

## Frontloaded Decisions

All design decisions are resolved here (standing operator pre-authorization, topic 27515; none touch
money, identity, published interfaces, or durable external side-effects — they are internal ownership
CAS + recovery wiring, reversible behind the default-OFF `multiMachine.ownershipFollowsLiveWork`).

1. **Every new ownership write is best-effort, CAS-fenced at `epoch+1`, and NEVER forced.** A lost CAS
   (peer advanced first) is a no-op; a release/claim against a record we no longer own is FSM-rejected.
   No retry storm; the existing reconciler/applier converges. `force-claim` stays the reconciler's
   death-evidence-only verb (**SessionOwnership.ts:141**).
2. **Part B claims at the autonomous respawn closure (server.ts:7862), NOT inside the generic
   `spawnSessionForTopic` helper** — to avoid double-claiming on the router path (which already claims)
   and to keep the helper generic.
3. **Part B does NOT force-claim an owned-by-peer topic.** Owned-elsewhere is already filtered by the
   reconciler's `topicOwnerElsewhere` gate; the residual post-gate race withholds the claim + emits ONE
   neutral non-directional audit row. Stealing a live peer's topic is reserved for the reconciler's
   force-claim (death evidence + quorum).
4. **Part D's safe direction is asymmetric by ownership state, and the fail-OPEN case is labeled as
   such (not "fail-closed"):** reachable-peer-owner → forward (fail-closed, no local re-run);
   unreachable-peer-owner **incl. `isOwnerReachable` throw/indeterminate** → withhold local re-run
   (fail-closed), ride the durable inbound queue (bounded by that queue's TTL + loss-notice);
   null/released owner → re-run locally (no competing owner); **`ownerOf`/registry read ERROR → re-run
   locally — fail-OPEN, instrumented** (a dead conversation is a worse failure than a rare double-reply;
   emits the `recovery-gate-registry-unknown` telemetry row; gated to ZERO-or-counted in fleet promotion;
   a persistent registry failure degrades to the old double-dispatch-prone behavior, an already-broken
   state). Stated per-case so the implementer applies the right direction at each site, and the one
   weaker-guarantee branch is honest about being fail-open.
5. **Part D gates at the SINGLE recovery funnel `SessionRecovery.checkAndRecover` (SessionRecovery.ts:150)**
   — one ownership gate covering both context-exhaustion (`recoverFromContextExhaustion`) and stuck
   (`recoverFromStall`) sub-paths — PLUS a per-topic owner check on the separate lease-gated
   `recoverStuckMessages` (**server.ts:18695**, which already forwards via `route()` but is gated only
   on `holdsLease()`). Reachability = `machinePoolRegistry.getCapacity(owner).online` (the router's own
   `isMachineAlive` signal, **server.ts:17639**).
6. **The flag is a FLAT `multiMachine.ownershipFollowsLiveWork` boolean** (not under `seamlessness`,
   not WS-prefixed) — it spans the ownership lifecycle (spawn/complete/recovery), not one work-stream.
7. **No `migrateConfig`/`PostUpdateMigrator` entry** — the flag is OMITTED from ConfigDefaults so the
   dev-agent gate decides at runtime; the established dev-gated-omit pattern needs no migration.
8. **Gate posture = the existing `resolveDevAgentGate` dev-agent dark pattern** (the same funnel used by
   `ws13Reconcile` et al.); default-omitted; explicit config wins; registered in `DEV_GATED_FEATURES`,
   not `DARK_GATE_EXCLUSIONS`.
9. **Part A guards the release on the COMPLETING SESSION's identity (by stable instance key
   `session.startedAt`, NOT the reusable tmux name), not just `owner===self`.** Before releasing, the
   handler verifies no DIFFERENT live session (compared by `startedAt` — the real stable instance key on
   the `Session` type, since tmux NAMES are reused across respawn; fail-closed/withhold if either
   `startedAt` is missing) is bound to the topic. This closes the same-machine A∥B interleaving where an old session's
   completion would otherwise release a record a new live session is using ("released record, live
   session" = stale-record-in-reverse). `owner===self` alone cannot catch it because the new session is
   also `owner===self`. **The not-yet-bound residual is SAFE by the best-effort contract (FD1):** if a
   newly-spawned session has not yet registered its topic-binding at the instant the old session
   completes, `getSessionForTopic` returns nothing → the release proceeds → the new session's Part B
   claim-on-spawn re-establishes ownership (place→claim) and the fenced-epoch CAS + reconciler converge.
   This is the spec's already-committed safe direction (release is best-effort, CAS-fenced, never
   forced), not a regression — locked by a Tier-1 test.
10. **All three new CAS callsites mint nonces through ONE shared `ownershipNonce(machineId, verb, sk)`
    helper** that appends a process-monotonic counter + `randomUUID()` (not bare millisecond
    `performance.now()`), so a release→re-place→release on the same `sessionKey` within one millisecond
    cannot collide nonces and have a legitimately-distinct action dropped as a replay. One helper = the
    nonce format can never drift between callsites.
11. **Part B's failed-claim window is a BOUNDED, self-healing degraded state, not a split-brain class.**
    When `place` succeeds but `claim` loses the CAS, the topic has a live local session while the record
    names a peer; an inbound routes to the (peer) record-owner so the local session does NOT
    double-handle, and the EXISTING `OwnershipReconciler`/failover machinery converges the divergence —
    bounded by that existing reconciler/failover policy (NOT a hard "one tick" guarantee: force-claiming
    a live-but-wrong peer needs death-evidence/quorum, so it may exceed one tick). Part B adds NO
    retry/settle loop on the failed claim (P19) — it degrades to exactly today's reconciler-converges
    behavior, no worse, and adds no new bound.

> All decisions are frontloaded above; the building agent holds standing pre-authorization for this
> mission and every decision is internal, reversible behind the default-OFF flag.

## Decision points touched

This spec adds NO new external block/allow/route gate and NO new repeating loop. It adds:
- TWO new `cas()` callsites (Part A release-on-complete; Part B place+claim-on-autonomous-spawn), each
  paired with the mandatory `emitPlacement` (cas-emit-placement lint).
- A per-topic ownership check inside THREE existing recovery decisions (Part D), each strictly reducing
  double-dispatch. No existing decision boundary is removed or weakened.

## Out of scope (explicit — SEPARATE follow-up)

- **Evented / push-based ownership lifecycle** (peers publish session start/stop over a bus so liveness
  is push, not poll/CAS). This is the race-free end-state PR #1258's spec named; it is a new
  cross-machine pub/sub surface with its own delivery/ordering guarantees and is deliberately not in
  this PR.
- **Per-topic lease heartbeat / TTL on the ownership record** (a record that self-expires when the
  owner's session ends). Parts A/B make the record track live work via explicit release/claim; a
  lease-TTL would make it self-correct even without an explicit release. Deferred as a separate
  hardening once A/B soak. **Why explicit release/claim NOW instead of a lease (the alternatives
  tradeoff both external reviewers asked for):** three ownership-lifecycle shapes were weighed —
  (i) **explicit release-on-complete + claim-on-spawn** (THIS spec): minimal, reuses the existing fenced
  CAS + replication path with ZERO new cross-machine surface, ships behind one dark flag, and directly
  removes the stale-`active` cause PR #1258 compensates for; (ii) **per-topic lease + TTL heartbeat**:
  strictly more robust because it ALSO self-corrects the **crash-before-complete** gap (a machine that
  dies before `sessionComplete` fires never releases — explicit release does NOT cover that; the
  EXISTING `OwnershipReconciler` death-evidence force-claim does, just more slowly), but it adds a new
  periodic heartbeat write + a TTL-expiry authority surface (a record self-expiring is a new
  authority-mutation that needs its own fail-closed reasoning); (iii) **evented/push lifecycle**: the
  race-free end-state, but a whole new cross-machine pub/sub surface with delivery/ordering guarantees.
  We choose (i) as the smallest correct step: it closes the COMMON (clean-completion) cause now with no
  new surface, and the crash-before-complete residual is ALREADY handled (more slowly) by the existing
  reconciler — so (ii)/(iii) are hardening, not prerequisites. The lease-TTL (ii) is the named next rung
  once (i) soaks.
- **The reaper closeout itself** — owned by PR #1258 (already shipped). This spec does NOT touch
  `SessionReaper.ts`; it makes the record A/B keep accurate so the closeout's compensating snapshot gate
  can eventually retire (see Tracked follow-through).

**Tracked follow-through (Close the Loop — not a vague comment).** This spec CLOSES the loop opened by
PR #1258's tracked commitment ("ownership-follows-live-work Part A/B/D"). On merge of THIS PR, the
building agent (a) marks that PR-#1258 commitment DELIVERED, and (b) opens ONE new durable commitment
(`POST /commitments`, type one-time-action) titled "PR #1258 liveness-snapshot gate retirement — after
A/B soak, the closeout can act on the (now self-correcting) ownership record directly" so the
compensating control's retirement (the `remoteOwnerHasLiveSession` dep + snapshot refresher + the
`reachableAt`-advancement dwell) is registered, not remembered. The retirement is a SEPARATE
evidence-gated step (it requires the A/B dev soak telemetry below), never bundled here.

## Tests (all three tiers — non-negotiable; both sides of every boundary)

### Tier 1 — Unit (the decision logic, in isolation, real deps)

- **Part A — release-on-complete, both sides:**
  - flag ON, `sessionComplete` for a topic this machine actively owns → `release` CAS issued
    (`ownerOf` afterward is null), `emitPlacement('released')` called.
  - flag ON, owner is a PEER → NO release CAS attempted (assert `cas` not called).
  - flag ON, no record / status `released` / status `transferring` → NO release (FSM would reject;
    assert short-circuit before CAS).
  - flag ON, session has NO topic binding → NO release.
  - flag ON, `resolveTopicForTmux` THROWS or returns empty → NO release (fail-closed skip; assert no CAS).
  - **flag ON, session-identity guard: a DIFFERENT live session is already bound to the topic (newer
    autonomous respawn, compared by stable instance id/generation) → NO release** (assert the completing
    session does NOT release a record the new live session is using — the same-machine A∥B clobber test;
    FD9). Include a variant where the bound session has the SAME reused tmux NAME but a different
    `uuid`/`startedAt` → still NO release (the name-reuse trap is caught by the instance-id compare).
  - **flag ON, new session NOT YET bound at completion instant (`getSessionForTopic` returns nothing)
    → release PROCEEDS** (the best-effort safe direction; assert Part B's subsequent claim-on-spawn
    re-establishes ownership — the not-yet-bound interleaving lock, FD9).
  - flag ON, CAS lost (peer advanced the epoch) → no-op, no retry, no throw.
  - **flag OFF** → no release CAS ever, byte-identical-observable to today (regression-lock).
- **Part B — claim-on-spawn, both sides:**
  - flag ON, autonomous respawn for a never-seen / released topic → `place` then `claim` onto self,
    `ownerOf` afterward === self.
  - flag ON, topic already `active`-owned by SELF → no-op (no duplicate CAS).
  - flag ON, topic `active`-owned by a PEER (the post-gate race) → NO claim, ONE neutral
    `auto-spawn-owned-elsewhere` audit row, session still spawned (assert spawn not blocked).
  - flag ON, `place` CAS lost → `claim` not attempted; no throw.
  - **flag OFF** → no place/claim CAS ever (regression-lock).
  - **force-claim contract guard:** assert the autonomous path NEVER issues `force-claim` (it is the
    reconciler's death-evidence verb), regardless of ownership state.
- **Part D — recovery gate, both sides of EVERY ownership state** (driven through the
  `SessionRecovery.checkAndRecover` funnel + the `recoverStuckMessages` path):
  - `ownerOf === self` → recovery re-runs locally (`checkAndRecover` proceeds to context-exhaustion /
    stuck recovery; stuck-reinject re-feeds).
  - `ownerOf === reachable peer` → `checkAndRecover` does NOT recover locally (no fresh respawn, no
    stall respawn) and the inbound routes via `route()` to the owner; `recoverStuckMessages` skips the
    topic. **(This is the inverse-of-double-dispatch case — the single most important Part D test.)**
  - `ownerOf === unreachable peer` → local re-run WITHHELD, the message rides the forward/queue path
    (assert no direct local inject, no fresh respawn).
  - **`isOwnerReachable` THROWS / indeterminate for a peer-owned record → treated as unreachable-peer:
    local re-run WITHHELD** (assert NOT a local re-run; the record names a peer, so we don't
    double-dispatch — the distinguishing test vs the `ownerOf`-throw case below).
  - `ownerOf === null` (released / never-seen) → re-run locally (assert the conversation is NOT stranded).
  - `ownerOf` THROWS (registry unreadable) → re-run locally — **fail-OPEN — AND assert the
    `recovery-gate-registry-unknown` telemetry row is emitted** with `decision:'re-run-local'` (so the
    tradeoff is measured, not silent).
  - **no-pending-inbound case:** `ownerOf === reachable peer` but there is NO pending inbound for the
    topic → assert the local respawn is WITHHELD and NO forward is emitted (nothing to serve; no strand).
  - **shared-reachability-helper unification:** assert `checkAndRecover` and `recoverStuckMessages`
    resolve reachability through the SAME injected `isOwnerReachable` helper (one call site, not two
    divergent inlined reads).
  - **flag OFF** → all three recovery paths run their existing logic unchanged (regression-lock: direct
    inject happens, fresh respawn happens, lease-gated reinject happens, with NO ownership consultation).
- **Nonce collision-resistance (FD10):** assert two `ownershipNonce(self, verb, sk)` calls for the SAME
  machine+verb+sessionKey within the same millisecond produce DISTINCT nonces (counter/UUID suffix), so
  a release→re-place→release within one ms is not dropped as a replay.
- **Co-occurrence / epoch-race cases:**
  - **A∥B race:** a session completes (A issues release) at the SAME tick a concurrent autonomous
    respawn (B issues place/claim) for the same topic — assert the FSM/CAS resolves to a single
    consistent record at the highest epoch (one wins the CAS, the loser is a no-op), never a torn state.
  - **B∥transfer race:** an autonomous claim races a `transfer` from a peer — assert the claim that
    would advance past the transfer's higher epoch LOSES the CAS (fenced-epoch correctness), so the
    transfer target's `active` wins, never the stale autonomous claim.
  - **D∥A race:** a recovery path reads `ownerOf === self`, then A releases the record before the
    re-run lands — assert the re-run still proceeds (it was decided on the read; a release that lands
    after is the next message's concern; no double-dispatch results because no peer claimed).
  - **Same-machine A∥B clobber (FD9):** on ONE machine, an old session for topic T completes (Part A)
    while a NEW autonomous session for T is already live (Part B claimed it) — assert Part A's
    session-identity guard WITHHOLDS the release (the record stays `active(self)` for the live new
    session), i.e. no "released record, live session".
  - **B failed-claim bounded-degraded-state (FD11):** `place` ok but `claim` lost (peer won the epoch)
    → assert the session still runs, NO retry loop is entered, the record stays peer-owned this tick,
    and an inbound for the topic routes to the (peer) owner not the local session (no double-handle).
- **Mixed-fleet co-existence (a gate-ON machine paired with a gate-OFF peer — externals asked this be
  proven, not asserted):**
  - ON-owner completes vs OFF-peer: the ON machine releases-on-complete; assert the record becomes
    `released` and the OFF peer's behavior is unchanged (it relies on the existing reconciler + PR #1258
    closeout exactly as before) — no torn/corrupt cross-machine record.
  - OFF-owner vs ON-recovery: a topic owned by an OFF (stale-prone) peer; the ON machine's recovery gate
    reads the (possibly stale) `active(peer)` record and forwards — assert it does NOT locally re-run a
    topic the record says a peer owns (the ON machine's stricter behavior is safe against an OFF peer's
    stale record).
  - ON autonomous respawn racing an OFF peer's transfer/reaper → assert fenced-epoch CAS still resolves
    to a single consistent record (the ON claim loses to a higher-epoch transfer), never a fork.

### Tier 2 — Integration (the route/dep wiring, full HTTP pipeline)

- **Release-on-complete wiring:** stand up the server init path with the flag ON, a durable ownership
  store, a topic owned by self; emit `sessionComplete` for that topic's session → assert the durable
  record advances to `released` AND a `'released'` placement is emitted to the coherence journal (so it
  replicates).
- **Claim-on-spawn wiring:** with the flag ON, drive the autonomous reconciler `respawn` for a topic
  with no ownership record → assert the durable record ends `active(owner=self)` and a `'placed'`
  placement is journaled.
- **Recovery-gate wiring:** with the flag ON and a fake peer owning topic N (online), trigger each
  recovery path for topic N → assert NO local re-inject/respawn happened and the inbound was routed via
  `route()` to the peer (assert the `[session-pool] … not dispatching locally` short-circuit, or the
  forward call). Then mark the peer offline → assert the re-run is WITHHELD (not double-dispatched) and
  the message is queued/forwarded, not directly injected.
- **Flag-presence:** flag ON ⇒ the new sessionComplete handler + the autonomous claim + the recovery
  gates are wired; flag OFF ⇒ none are (assert via the absence of the `'released'`/`'placed'` journal
  entries on completion/spawn and the unchanged direct-inject on recovery).

### Tier 3 — E2E (feature-alive with the flag ON, production init path)

- **Feature-alive (the Phase-1 must-have):** boot the production server.ts mirror with
  `multiMachine.ownershipFollowsLiveWork` resolved ON; assert (a) the `sessionComplete` release handler
  is registered and delegates to the REAL `sessionOwnershipRegistry.cas` (wiring-integrity: not a stub),
  (b) the autonomous respawn path is wired with the claim, (c) the recovery paths consult `ownerOf`.
  Flag OFF ⇒ none are active and the legacy paths run (the alive-vs-inert boundary).
- **Lifecycle regression — the PR #1258 stale-record scenario, fixed at the source:** a session is
  transferred here and then completes; assert (flag ON) the ownership record becomes `released` so a
  peer's reaper closeout reads `topicOwnerElsewhere === null` and never even considers a kill — versus
  (flag OFF) the record stays `active` (the stale label PR #1258 had to defend against). This is the
  end-to-end proof that A removes the stale state rather than just defending it.
- **Double-dispatch regression:** a topic moves from machine X→Y, X's leftover session wedges; assert
  (flag ON) X's ContextWedge fresh-respawn is SKIPPED (Y owns the topic) so the message is served only
  by Y — versus (flag OFF) X respawns and double-replies.

## Verification (after deploy, on a dev agent with the flag ON)

On a live multi-machine pair:
1. **Part A:** transfer a topic to this machine, let its session complete, and confirm
   `GET /pool/placement?topic=N` (or the ownership read) shows the record `released`/unowned within one
   applier tick, and `logs` show the `'released'` placement — instead of a stuck `active`.
2. **Part B:** start an autonomous run on a topic this machine spawns directly (reconciler respawn) and
   confirm ownership resolves to THIS machine (`GET /pool/placement?topic=N` → owner=self, reason placed)
   rather than staying on the prior owner.
3. **Part D:** induce a context-wedge on a leftover session for a topic that moved to the peer; confirm
   the wedge fresh-respawn is SKIPPED (the leftover is not respawned; the peer serves) and the user gets
   exactly ONE reply, not two.

### Fleet-promotion acceptance criteria (the dark stage has an exit)

Promoting `ownershipFollowsLiveWork` from dev-only to fleet-default requires ALL of, gating the flip
(tracked by the follow-through commitment):
1. **A bounded dev soak** — LIVE on the echo dev multi-machine pair ≥7 days of real multi-machine
   traffic with the full Verification battery passing.
2. **Telemetry from the soak:** (a) ≥1 real release-on-complete observed and the record demonstrably
   became unowned; (b) ≥1 autonomous claim-on-spawn moved ownership onto the spawning machine; (c) ≥1
   recovery-gate forward (a double-dispatch averted) observed; (d) ZERO observed wrong-steals (an
   autonomous claim that force-stole a live peer) and ZERO stranded conversations (a recovery gate that
   withheld a re-run AND the message was never served); (e) **the fail-OPEN registry-error path
   measured: count of `recovery-gate-registry-unknown` re-runs is ZERO, or a counted/understood rarity
   with NO double-dispatch attributable to it** (this is what turns "registry errors are rare enough to
   justify the fail-open" from an assumption into a measured fact — the explicit ask from the conformance
   gate + both external reviewers); (f) **ZERO orphaned-record incidents** (a release that landed while a
   live session still ran), validating the CAS-replication foundation assumption before the PR #1258
   snapshot-gate retirement is even considered.
3. **Zero open ownership-correctness regressions** attributable to the gate during the soak.
The flip itself is operator-gated.

## Migration parity

No migration required: the flag is OMITTED from ConfigDefaults so the dev-agent gate resolves it at
runtime (live-on-dev / dark-on-fleet); the established dev-gated-omit pattern adds no
`migrateConfig`/`PostUpdateMigrator` entry. No hook/skill/template change (this is internal
ownership-lifecycle + monitoring behavior, not an agent-facing capability). The `DEV_GATED_FEATURES`
registration is the only required addition beyond the wiring + the type field.

## Do not duplicate

Existing related work (checked): the ownership FSM + registry (`SessionOwnership.ts` /
`SessionOwnershipRegistry.ts`), the user-move release (server.ts:18223, routes.ts:12852), the router
place/claim seams (server.ts:17652-17674), the `OwnershipReconciler` (cooperative transfer/claim/
force-claim convergence), the `OwnershipApplier` (replicated-placement materialization), and PR #1258's
liveness-gated closeout (`SessionReaper.ts`). NONE of these issue a release-on-complete, a
claim-on-autonomous-spawn, or a per-topic recovery-gate today — those are exactly Parts A/B/D and are
NOT yet built. This spec does NOT touch `SessionReaper.ts` (PR #1258 owns it) or the FSM transitions.

## Open questions

*(none)*
