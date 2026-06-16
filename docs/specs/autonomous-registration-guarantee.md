---
title: "Autonomous registration backstop — a committed unregistered run survives reaping"
slug: "autonomous-registration-guarantee"
author: "echo"
parent-principle: "an autonomous run must outlive its session"
eli16-overview: "autonomous-registration-guarantee.eli16.md"
lessons-engaged: ["P1 Structure>Willpower", "P2 Signal-vs-Authority", "P19 No-Unbounded-Loops", "P17 Bounded-Notification-Surface", "Reap KEEP/eligibility agreement (2026-06-13)"]
approved: true
review-convergence: "2026-06-15T23:47:50.219Z"
review-iterations: 2
review-completed-at: "2026-06-15T23:47:50.219Z"
review-report: "docs/specs/reports/autonomous-registration-guarantee-convergence.md"
cross-model-review: "unavailable"
cross-model-review-reason: "worktree has no built dist/core/crossModelReviewer.js; harness unassemblable in-context (matches P1/P2/P4 this run)"
single-run-completable: true
frontloaded-decisions: 10
cheap-to-change-tags: 2
contested-then-cleared: 2
---

# Autonomous registration backstop

> **⚠ BUILD-TIME FINDING (2026-06-15, requires a Part-D revision + focused re-converge before build):**
> D8 reuses `ReapGuard.recentUserMessage(topic, staleCommitmentWindowMs)` — but at build time that dep is a
> **v1 STUB** (`recentUserMessage: () => false`, server.ts:13530; spread into BOTH ReapGuard @13556 and
> SessionReaper @13584). So today ReapGuard's open-commitment KEEP-veto is INERT. Reusing the stub ⇒ this
> feature never injects (inert); implementing a real check only for the new eligibility ⇒ KEEP and
> eligibility DISAGREE (the loop risk D8 exists to prevent). **Correct fix = promote `recentUserMessage` to a
> real message-recency query (messageStore.queryInbox → last inbound user msg age) shared by ReapGuard Gate-I
> AND the new eligibility, so both become functional AND agree.** That is a LIVE ReapGuard KEEP-behavior change
> (safe direction — keeps a recently-messaged session — but reaper-class high-risk) NOT in the converged scope.
> NEXT: add **Part D (recentUserMessage promotion)** with its risk analysis, re-run a focused convergence on
> Part D (reaper-class), then build. The stub is the codebase's own "tracked tuning note" (comment @13524).


## Problem statement

`#1174`/`#1157` shipped the revival machinery: when a **registered** autonomous
run is reaped by the idle/age-limit reaper, the `sessionReaped` wiring reads the
per-topic state file (`.instar/autonomous/<topicId>.local.md`), injects
`build-or-autonomous-active` WorkEvidence, and the ResumeQueue drainer respawns
+ resumes it. That works **only when the run was registered** — i.e. the
autonomous `SKILL.md` Step-2 `Write` actually created the per-topic state file.

The gap: **registration is willpower-based.** An operator can say "go autonomous"
and the agent can do hours of real work without ever invoking the autonomous
skill (no hook, no state file). When the reaper hits that session,
`sessionReaped` finds no state file, injects no evidence, and it dies as a plain
idle-timeout. This is the exact death of 2026-06-14.

**Honest scope (this spec is a BACKSTOP, not a root fix).** A structural
guarantee that *every* unregistered run survives cannot live in the autonomous
stop-hook (if the run was never registered, the hook was never installed, so
nothing fires). This spec instead teaches the always-running reaper to recognize
an *independent* signal that a session is doing real, live work — **a fresh open
agent-commitment for the topic, corroborated by recent user activity** — and
revive it. It therefore covers the realistic case (an autonomous run that made a
promise to the user) and **surfaces** the unregistered state so it gets fixed; it
does **not** cover an unregistered run that made no commitment, and it does not
close the registration gap itself. Closing the root (operator-intent →
server-side provisional registration) is a larger, separately-owned work item
(tracked below). The title says "committed unregistered run" deliberately.

## Proposed design

### Part B (primary) — corroborated commitment-evidence in the reaped path

`CommitmentTracker` tracks open commitments, each optionally carrying a
`topicId`. The `sessionReaped` evidence wiring (today reads only the per-topic
state file) gains a **second, additive** evidence source, pinned to the SAME
branch the existing source uses — **only when the reap `reason` is an age-limit /
pressure reap AND the per-topic state file is absent** (so other reaps and
registered runs pay zero added cost and behave identically):

- Add `CommitmentTracker.getActiveByTopicId(topicId: number): Commitment[]` — a
  thin synchronous wrapper over `getActive().filter(c => c.topicId === topicId)`
  (no new state, no I/O, no lock — Node's single thread guarantees no torn read
  vs `mutate()`).
- **Qualifying commitment (D2).** A commitment counts as live-work evidence only
  if ALL hold: `status === 'pending'` (NOT `verified`/`violated` — a violated
  commitment is a *failing* session, not a working one); it carries the reaped
  session's `topicId`; it is **agent-driven** (`owner === 'agent'`, OR
  `owner === 'user'` with `blockedOn` ∈ {none, undefined}) — a commitment
  *waiting on the user* (`blockedOn` ∈ {user-input, user-authorization}) is the
  opposite of an active autonomous run and is excluded; it is not
  beacon-paused/suppressed; and (multi-machine) it originated on THIS machine
  (`originMachineId` is this machine or absent — a replicated peer commitment is
  advisory data, never revival authority).
- **Freshness (D1).** Keyed on **`createdAt` only** — the moment the promise was
  made. There is NO `updatedAt` on `Commitment`, and bookkeeping fields
  (`lastHeartbeatAt`, `lastProbe`, beacon counters) MUST NOT count as "fresh":
  a 3-day-old promise a beacon pinged 5 min ago is not evidence of a live
  session. `createdAt` within `freshCommitmentWindowMs` (default **6h**).
- **The KEEP/eligibility AGREEMENT invariant (D8 — the load-bearing safety
  rule).** Injection additionally requires a **recent user message on the topic
  within `staleCommitmentWindowMs`** — the SAME `recentUserMessage(topic, window)`
  predicate `ReapGuard`'s open-commitment KEEP-probe already uses
  (`ReapGuard.ts`). This is non-negotiable: the 2026-06-13 incident (13 idle
  sessions across 6 topics age-killed→revived in a loop, each tagged solely on a
  commitment the KEEP-guard had judged stale) happened precisely because a
  revival path disagreed with the KEEP-guard on "what an open commitment means."
  The reaper's KEEP decision and this eligibility decision MUST agree, or the
  loop returns. By gating on the same predicate, a commitment that would NOT keep
  the session alive cannot revive it either.
- When all of the above hold, inject `build-or-autonomous-active` **once per
  reaped session** (the count of matching commitments is irrelevant) and tag the
  entry with the **distinct reason** `COMMITMENT_ACTIVE_RUN_REASON` (parallel to
  `AGE_LIMIT_ACTIVE_RUN_REASON`) so the drainer can route it to the correct
  drain-time re-check. The session then flows through the **already-shipped**
  `evidenceEligible` gate → ResumeQueue → drainer, inheriting the resurrection
  cap (≤2 resumes/24h/topic, then gives up loudly — P19 bound).
- **Drain-time re-validation (D9).** The existing drainer re-checks liveness only
  for `AGE_LIMIT_ACTIVE_RUN_REASON` via `autonomousRunFinished` (which reads the
  state file — absent here). Add a parallel `commitmentStillActiveForTopic(topicId)`
  drainer predicate, gated on `COMMITMENT_ACTIVE_RUN_REASON`, that re-reads the
  qualifying-commitment + agreement check at drain time and invalidates
  `commitment-no-longer-active` if the commitment was delivered/expired/violated
  or the user-activity window lapsed between enqueue and drain. Without this a
  done-but-not-marked commitment would revive finished work.
- **Fail-open (D7).** If any of these reads throws, the new source contributes
  NOTHING and the reap proceeds exactly as today (no injection, no revive). The
  call is wrapped in the existing enqueue-hook try/catch ("a throw fails toward
  no injection, never a spawn"). A null/absent `commitmentTracker` → no injection.

This is **Signal vs Authority**: the commitment is a *signal*; the authority that
decides revival remains the unchanged `evidenceEligible`/drainer. **No new
WorkEvidence enum value** (avoids touching the clamped `WorkEvidenceName` union);
provenance rides the reason tag + the audit field below.

### Part A (rides on Part B) — surface the unregistered run (observe-only)

When Part B fires (evidence via a commitment, no per-topic state file), an
autonomous-flavored run is proceeding unregistered. Surface it **observe-only**:
ONE attention signal routed through the **existing aggregated attention budget
chokepoint** (`raiseAggregated` / the topic-creation budget — NOT a feature-local
per-key emit; per P17 the bound lives at the creation chokepoint so a unique key
can't dodge it). Dedup key `unregistered-autonomous:<topic>` with a TTL of one
reaper pressure-cycle (reuse the reap-log's existing session+topic dedup). It
never blocks; it makes the invisible visible so the run gets registered.

### Part C (minor, descoped) — stopGate legacy-path correction

`stopGate.ts`'s `readAutonomousActive` defaults to `.claude/autonomous-state.local.md`
— a **doubly-stale** path: the file moved to `.instar/` (PostUpdateMigrator
@3515) AND the convention is now per-topic. Scoped fix for THIS spec: correct the
legacy single-file path to `<stateDir>/autonomous-state.local.md` (the real
legacy location) so the hot-path heuristic stops reading a path that hasn't
existed since the move. The **per-topic** resolution requires threading
topicId/stateDir through `HotPathInputs` + both `routes.ts` call sites (which
pass neither today) — that plumbing is a tracked work item below; this PR only
corrects the legacy single-file path. No per-topic behavior change here.

### Part D (load-bearing — added after build grounding) — promote `recentUserMessage` to a real predicate

**The fact that forces this part.** Part B's D8 agreement-invariant gates injection on
"the SAME `recentUserMessage(topic, window)` predicate ReapGuard's open-commitment
KEEP-probe already uses." Build grounding found that predicate is a **v1 STUB** —
`recentUserMessage: () => false` (`src/commands/server.ts:13530`, spread into `ReapGuard`
and `SessionReaper`). So today ReapGuard's open-commitment KEEP-veto is **INERT**.
Reusing the stub makes GAP-B's D8 check always-false (injection never fires — the
feature is dead); implementing a real check **only on the new eligibility path** while
ReapGuard keeps the stub makes KEEP and eligibility **DISAGREE** — exactly the 2026-06-13
13-session loop D8 exists to prevent. Neither is acceptable; the predicate must become
real and **shared**.

**The promotion (store CORRECTED in re-converge — F1).** Replace the stub with a real
predicate `recentUserMessage(topicId, windowMs)` that returns true iff there is an **inbound
USER message** on the topic within `windowMs`. **Correct store: `TelegramAdapter.getTopicHistory(topicId, limit)`**
(`src/messaging/TelegramAdapter.ts:3529` → `LogEntry[]`, an in-memory recent-tail cache) — NOT
`MessageStore.queryInbox`, which is the **Threadline agent-to-agent** store and contains no
Telegram user messages (grounding it there would re-create the exact inert-predicate bug Part D
exists to fix). The build filters `LogEntry` to **inbound user** entries (not agent/system echoes)
and checks the newest such entry's timestamp against `windowMs` — the exact `LogEntry`
direction/role + timestamp fields are ground-checked at build time. Synchronous (`getTopicHistory`
returns a cached array, no I/O) — which also dissolves the sync→async concern below. It is wired
ONCE and **shared by every consumer of the `recentUserMessage` dep** (see blast-radius), so the
KEEP decisions and the new GAP-B eligibility (D8) are computed from the identical truth and
**cannot disagree**. The D8 agreement specifically pairs with the **commitment-coupled** KEEP
(`ReapGuard.ts:149`, window = `staleCommitmentWindowMs` = `staleCommitmentWindowMinutes` 480 / 8h,
`ConfigDefaults.ts:153`); GAP-B's eligibility uses that same window.

**Sync/async wiring (build must resolve).** The stub is synchronous (`() => false`);
`queryInbox` is async. The build either (a) makes the KEEP-probe async and has ReapGuard
`await` it, or (b) pre-computes per-candidate recency into a sync snapshot the probe reads.
Decided at build time against ReapGuard's actual call-site signature; both preserve the
shared-predicate guarantee.

**Reaper-class risk — full blast-radius (F2/F2a, corrected in re-converge).** The stub at
`server.ts:13530` is spread into BOTH `ReapGuard` AND `SessionReaper`, so promoting it un-stubs
**five live sites at once** — every one in the **safe (keep-more) direction**:
- `ReapGuard.ts:137` — a **standalone recency KEEP** (window `recentUserWindowMs` ~30min, NOT
  commitment-coupled): a session messaged in the last ~30min is kept.
- `ReapGuard.ts:149` — the **commitment-coupled KEEP** (8h `staleCommitmentWindowMs`): the D8 one
  GAP-B's eligibility agrees with.
- `ReapGuard.ts:221` / `:239` — the same two KEEPs mirrored on the `terminateSession()` enforcement
  path (the shared guard chain; order/reasons preserved).
- `SessionReaper.ts:489` — a **`staleIdle` INVERSION**: `staleIdle = … && !recentUserMessage(…)`.
  With the stub (`false`) `!false=true`, so an active-children session can be reaped as stale;
  promoted, a recent message makes `staleIdle` false → the session is KEPT.
None of the five makes the reaper kill MORE — each retains a likely-in-use session; the only
downside is mild resource-retention (a recently-messaged-but-idle session lingers up to its
window), bounded and deliberate.

**Why the catastrophic LOOP is CONTAINED (grounded-verified in re-converge).** The 2026-06-13
loop needs the **revival** path to fire (reap → revive → reap). Revival is the Part B injection,
which ships **dark/dryRun** (`monitoring.resumeQueue` dev-gate). Verified at
`ResumeQueueDrainer.ts:311-317`: `if (queue.isDryRun()) { …audit…; return { blocked:'dry-run' } }`
returns BEFORE the `respawnTopic`/`triggerJob` spawn block, and `ResumeQueue` ships `dryRun:true`.
So dryRun genuinely suppresses the SPAWN (not just logs) ⇒ no revival ⇒ the loop is **structurally
impossible** while injection is dark, even with all five KEEP sites live. Rollout: ship the real
`recentUserMessage` + injection dark, soak, and enable injection only after the dark soak confirms
KEEP and eligibility agree on real data.

**Fail-open (D7, extended).** If `getTopicHistory` throws, the predicate returns `false` — no KEEP
on this basis, no injection. A throw fails toward today's behavior, never toward a spurious
keep/revive.

## Decision points touched

- The reaped-session evidence wiring gains an additive, corroborated evidence
  source (OR, not a replacement; the state-file source is untouched).
- No new HTTP route. No new WorkEvidence enum member. One additive optional
  reap-log field (`evidenceSource`, D3). No new blocking authority — Part A is
  observe-only, Part B feeds the existing gate, Part C is a read-path fix.

## Frontloaded Decisions

- **D1 — Freshness anchor.** `createdAt` only, within `freshCommitmentWindowMs`
  (default 6h). Bookkeeping/beacon timestamps explicitly do NOT refresh freshness
  (there is no `updatedAt`). Pinned in a unit test (both sides of the boundary).
- **D2 — Qualifying set.** `status==='pending'` + matching `topicId` + agent-driven
  (`owner:'agent'`, or `owner:'user'` with no user-blocking `blockedOn`) + not
  beacon-paused/suppressed + local-origin. Missing `owner` treated as `agent`.
- **D3 — Audit field.** Add optional `evidenceSource?: 'state-file' | 'commitment'`
  to the reap-log entry shape + `recordReaped`'s arg (default `'state-file'`,
  back-compat: older entries omit ⇒ `'state-file'`). **PII constraint:** the
  audit may carry `evidenceSource` and at most the commitment **id** (`CMT-…`);
  it MUST NOT copy `userRequest`/`agentResponse` (world-readable JSONL, user PII).
- **D4 — Part A surface.** Observe-only, routed through the aggregated attention
  budget chokepoint, dedup `unregistered-autonomous:<topic>` (one pressure-cycle
  TTL). Never blocks.
- **D5 — Dark + dryRun.** Part B injection rides the existing
  `monitoring.resumeQueue` dev-gate + dryRun (dryRun logs "would inject
  commitment-evidence" without changing eligibility). `freshCommitmentWindowMs`
  and `staleCommitmentWindowMs` (reuse ReapGuard's existing value) are
  code-defaulted and ABSENT from ConfigDefaults/migrateConfig — same posture as
  every `monitoring.resumeQueue.*` key (absent=default; no migration needed).
- **D6 — Multi-machine posture.** See below.
- **D7 — Fail-open.** A throw/absent-tracker injects nothing; the kill path is
  never endangered (inherits the enqueue-hook try/catch). Asserted in a test.
- **D8 — KEEP/eligibility agreement.** Injection requires the same
  `recentUserMessage(topic, staleCommitmentWindowMs)` corroboration ReapGuard's
  KEEP-probe uses. (The anti-loop invariant — see Part B.)
- **D9 — Drain-time re-check.** `COMMITMENT_ACTIVE_RUN_REASON` +
  `commitmentStillActiveForTopic` re-validate at drain; invalidate if the
  commitment closed or the user-activity window lapsed.
- **D10 — Supervision tier.** Tier 0 — pure structural/staleness predicates, no
  policy judgment; the authority (`evidenceEligible`/drainer) is unchanged.

## Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN.** The reaper, ResumeQueue, and per-topic state file
are machine-local; `CommitmentTracker.getActive()` is read from the LOCAL tracker
for a session reaped on THIS machine (same pattern as the existing
`activeCommitmentForTopic` closure). Evidence is computed at reap time, not
stored — nothing strands on topic transfer, no URL generated. A commitments
`stateSync` kind does not exist today (the WS2 family is
preferences/relationships/learnings/knowledge/evolutionActions/userRegistry/topicOperator);
D2's local-origin filter pre-empts the hazard if it ever ships (a replicated peer
commitment is advisory data, never revival authority — the constitution's rule).

## Testing (3-tier, NON-NEGOTIABLE)

- **Unit:** `getActiveByTopicId` filter; the `createdAt` freshness boundary BOTH
  sides (fresh `pending` agent-commitment ⇒ qualifies; stale, `violated`,
  user-blocked, no-topicId, or replicated-origin ⇒ does NOT); the D8 agreement
  gate (no recent user message ⇒ no injection even with a fresh commitment); the
  D7 fail-open (throwing tracker ⇒ zero injection); `commitmentStillActiveForTopic`
  drain predicate both sides.
- **Integration:** full `sessionReaped → considerEnqueue → evidenceEligible →
  ResumeQueue` with a commitment-only (no state-file) age-limit reap → session
  becomes eligible AND the reap-log entry carries `evidenceSource:'commitment'`;
  dryRun path logs-but-does-not-enqueue; wiring-integrity (a null `commitmentTracker`
  in the handler fails toward no-injection, never throws).
- **E2E:** an unregistered-but-committed autonomous run actually survives an
  age-limit reap (the "feature is alive" test); Part A raises exactly one deduped
  attention signal per reap-episode; the resurrection cap bounds a revive-loop
  (drive kill→revive against a fresh-commitment topic with NO recent user message
  → asserts it does NOT loop — the P19 + 2026-06-13 regression test).

## Tracked work items (owned)

1. **Root registration fix** (the structural close of "registration is
   willpower-based"): detect operator "go autonomous" intent and provisionally
   register the per-topic state file server-side, so coverage no longer depends
   on a commitment existing. <!-- tracked: CMT-1570 -->
2. **stopGate per-topic resolution**: thread topicId/stateDir through
   `HotPathInputs` + the two `routes.ts` call sites so the heuristic reads the
   per-topic file, not just the corrected legacy single-file. <!-- tracked: CMT-1571 -->

## Open questions

*(none)*
