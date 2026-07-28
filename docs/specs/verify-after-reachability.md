---
slug: verify-after-reachability
title: Verify-After Topic Reachability (Postmortem F7)
status: draft
eli16-overview: verify-after-reachability.eli16.md
constitution: Bounded Blast Radius + Structure > Willpower (registered); enacts the proposed "User Experience Is the Product → Blast-Radius Before, Verify-After" sub-standard
earned-from: 2026-06-25 user-reachability postmortem, Failure 7
review-convergence: "2026-06-26T12:03:17.271Z"
review-iterations: 3
review-completed-at: "2026-06-26T12:03:17.271Z"
review-report: "docs/specs/reports/verify-after-reachability-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 7
cheap-to-change-tags: 0
contested-then-cleared: 0
approved: true
approved-by: "Echo (per Justin's standing pre-approval for this autonomous run — goal: 'Justin pre-approved all decisions and any spec approvals')"
approved-at: "2026-06-26"
---

# Verify-After Topic Reachability (F7)

## The constitution standard this enforces

This enacts postmortem sub-standard #7 (**Blast-Radius Before, Verify-After**) of
the proposed umbrella standard *The User Experience Is the Product* (ships dark like
F2/F3/F4/F6, all of which shipped before ratification). Until ratified it also
anchors to two ALREADY-REGISTERED standards: **Bounded Blast Radius** (a destructive
op must not silently expand into "the user can't reach me") and **Structure >
Willpower** ("remember to check the topic still works after a kill" is a wish; a
structural verify is the enforcement). <!-- tracked: topic-28744 F-series umbrella-standard registration -->

## What broke (the postmortem scenario) — stated HONESTLY

On 2026-06-25 an agent force-killed a session and the topic's inbound messages
black-holed. The naive reading "any force-kill black-holes a topic" is **false** and
this spec does not claim it (overselling would itself break the standard's honesty
rule). Verified against the code:

**The dominant single-machine path ALREADY self-heals.** `onTopicMessage`
(`src/commands/server.ts`) unconditionally spawns when the session is absent or dead
(mapped-but-dead → respawn; unmapped → auto-spawn with history). A plain force-kill
is healed by the next inbound. The black-hole is real but NARROW — it needs a
*secondary* failure that defeats the self-heal:

1. **Single-machine — the `spawningTopics` wedge (the real, unguarded bug).**
   `onTopicMessage` guards double-spawn with an in-memory `spawningTopics` set,
   cleared only in the spawn promise's `.finally`. A spawn that HANGS leaves the
   topic flagged "already spawning" → every subsequent inbound is silently skipped,
   with **no timeout on the spawn and no sweep**. (Bounded by scope: the set is
   closure-local, rebuilt on server boot, so it wedges "until the next restart," not
   literally forever — review correction. Still a real, unguarded black-hole.)
2. **Multi-machine — released ownership with no live re-placement.** A
   transfer/pinned-move releases local ownership and pins a target. If the topic
   ends up with NO live session anywhere AND no ownership record that will self-heal
   on inbound (the *released-no-placement* slice), inbound has no self-heal net.

**What does NOT already cover these:** ReapNotifier *notifies* (silent for
`origin:'operator'`/agent force-kills); ResumeQueueDrainer *revives mid-work* (dry-
run; idle kills get nothing); StrandedTopicSentinel *signals a walled-but-online
OWNER only* (dark; blind to released/no-owner/force-killed). None verifies
reachability after a mutation; all three skip the operator/agent force-kill +
ownership-release path. The verify-after primitive is absent.

## The design — TWO separable pieces

Round-1 review showed the original "external clear of a stale `spawningTopics` flag"
self-heal was unsafe (an ABA double-spawn race against a still-in-flight spawn — the
exact bug the flag prevents) and that the multi-machine trigger was described as an
event that does not exist. The redesign splits F7 into a **source-level correctness
fix** (Piece 1) and a **pure-signal verifier** (Piece 2, NO mutation authority) — so
the dangerous self-heal authority is removed entirely.

### Piece 1 — Make the `spawningTopics` wedge VISIBLE (token-safe registry), NOT auto-cleared

Round-2 review (HIGH) showed that *any* mechanism which clears the flag while the
spawn body is still in flight RELOCATES the double-spawn race rather than dissolving
it: the spawn body is **non-cancellable** (no `AbortController` on this path), so a
timeout that rejects + clears the flag does NOT stop the underlying work — it later
runs `registerTopicSession` / the respawn's pre-emptive `kill-session` / the message
inject concurrently with a second spawn, all OUTSIDE any flag-token guard. A
"backstop sweep" gated on "no pending promise" is also logically unreachable (a
genuinely-hung spawn has an *unsettled* promise, so the gate never opens). So Piece 1
deliberately does NOT auto-clear or timeout-clear the flag. It does the minimum that
is provably safe:

- **Promote `spawningTopics` from a closure-local `Set<number>` to a small injected
  `SpawningTopicsRegistry`** carrying, per entry, `{ token, startedAtMs }`. One
  component, used by the inbound hot path AND the drain path (the 4 add/clear
  callsites + the declaration — the only users). This is the seam the verifier reads
  "is this topic stuck-spawning and since when" from.
- **Token-guard the EXISTING `.finally` clearer (the ABA fix — the one safe change).**
  `add(topic)` returns a unique `token`; the `.finally` clear only deletes if the live
  entry's token still equals the caller's. So a late `.finally` from a spawn that has
  already been superseded cannot delete a newer entry. The `.finally` on true settle
  (success or genuine rejection) remains the **sole** clearer — no new clearer is
  added, so no new race is created.
- **A hung spawn KEEPS its flag → it is DETECTED and SURFACED by Piece 2**, not
  cleared. Making the silent wedge LOUD is the F7 win; the topic stays wedged until
  the hung spawn settles or a restart, but the user/operator now KNOWS (vs the
  2026-06-25 silence). This is the safe, honest core.

**Deferred (tracked, with rationale — NOT an orphan deferral):** the *mechanical
auto-recovery* of a hung spawn (so it heals without a restart) genuinely requires
making the spawn body **cancellable** — an `AbortController` threaded through
`spawnSessionForTopic`/`respawnSessionForTopic` that tears down any partial tmux and
makes a post-abort `registerTopicSession` a token-checked no-op. That is a real,
separate piece of work whose absence does NOT block F7's value (surfacing-loud
already satisfies *Verify-After* / *Degradation Is an Event*), and doing it wrong
re-opens the exact double-spawn race. It is explicitly out of THIS spec and tracked.
<!-- tracked: topic-28744 F7-followup cancellable-spawn-autoheal -->

Piece 1's only behavior change is the token-guard (defensive; today's `.finally` is
already the sole clearer) + the registry seam. It is live (no detection surface), and
introduces NO timeout, NO sweep, NO new clearer — so it cannot re-introduce the
double-spawn the Set prevents.

### Piece 2 — `TopicReachabilityVerifier` (PURE SIGNAL — no mutation authority)

A detector that, after a destructive mutation, verifies the topic is still inbound-
reachable and SURFACES a genuine orphan. It mutates NOTHING (the round-1 self-heal is
removed). Note precisely: Piece 1 does NOT mechanically heal a hung spawn — it makes
the hung state SAFE (token-guarded) and OBSERVABLE (the registry seam); the verifier
then SURFACES it rather than clearing it (clearing is the racy auto-heal that is
deferred). So the verifier never needs — and never has — flag-clearing authority. This
makes it a pure signal that can ship LIVE on a dev agent (resolving the Maturation-Path
conformance finding) while staying dark on the fleet.

#### A. Triggers (honest about what is/ isn't an event)

1. `sessionReaped` (a real `EventEmitter` event, once per kill at `terminateSession`).
   A `disposition:'terminal'` kill schedules a verify. A `recovery-bounce` (kill-to-
   respawn) is NOT blanket-dropped (round-2 finding): it ALSO schedules a post-grace
   verify — it normally self-heals (the respawn lands → REACHABLE → no surface, same
   honesty guard as a normal kill), but if the *respawn itself wedges in
   `spawningTopics`*, that is exactly the single-machine orphan F7 exists to catch, so
   it must be reachable to the verifier, not filtered out.
2. **Ownership release/transfer.** Correction (round-1 blocking #4): `emitPlacement`
   is a **journal write, not an event** — there is no subscriber surface. So Piece 2
   adds an **explicit new tap**: a single optional callback funnel the server-side
   release/transfer CAS arms invoke (the `released` + `transfer` arms at the ~6
   placement callsites), passing the affected topic. This is named new code, not a
   free subscription.

Each trigger enqueues a **per-topic-coalesced** verify (one pending verify per topic
regardless of reap count), run after a `graceMs` window (so a normal kill→next-
inbound-respawn or transfer→claim self-heals before we judge). The pending set is
**globally bounded** (`maxPendingVerifies`, overflow counted in status).

**Pressure-aware WITHOUT going blind (round-2 finding):** under
`pressureTier()==='critical'`, the verifier skips the per-topic verify CHURN (the
mass-reap is itself the pressure; a verify-storm must not amplify it) — but it does
NOT go silent: it still emits at most ONE rolled-up "N topics may be unreachable
(system under pressure)" item (the roll-up bounds it to one), AND it records the
skipped topics. **On pressure-clear AND on emergency-stop-lift it runs a one-shot
re-sweep** of topics whose verify was skipped/suppressed in the window, so an orphan
that *began* during the window — and outlives it — surfaces once the system is healthy
enough to act (closing the "never-surfaced orphan" gap). (`pressureTier` is exposed
via a public getter / shared `PressureGauge` — wiring, named here.)

#### B. Reachability predicate

**Definition of "reachable" (review — codex):** a topic is reachable iff the user's
next inbound message can EITHER be delivered to a live session now OR cause a session
to be admitted+spawned now. (It is *admission/routing* reachability, not mere
addressability — a topic at the session cap cannot admit a spawn, so it is not
reachable even though it is addressable.)

REACHABLE if ANY (read over live local state + the placement snapshot; no mesh call):
- a **live, non-wedged** session exists for it (note: wedge-detection is
  SessionWatchdog's domain — the verifier treats a live tmux session as reachable and
  does NOT re-implement wedge detection; stated honestly, not oversold — finding 4);
   OR
- it is unowned/dead-owner AND the **auto-spawn path is FUNCTIONAL** — meaning NOT
  stuck-spawning past `stuckSpawnMs` (the registry's `startedAtMs` is older than the
  threshold — a DETECTION threshold, not a clear threshold; the flag is never cleared)
  **AND** `maxSessions` headroom exists **AND** the account is not quota-walled **AND**
  the adapter is connected (finding 4: the flag alone is insufficient; a topic at the
  session cap is effectively orphaned); OR
- it has an owner/placement on a machine that can actually serve, judged from a
  **FRESH** placement snapshot (see §multi-machine).

ORPHANED (the only state that surfaces) = none hold. Concretely: single-machine →
no session + stuck-spawning-past-TTL OR at-cap/quota/adapter-down with no session;
multi-machine → no live session anywhere + released-no-placement (see §multi-machine);
plus the **durable-inbound-queue-stall** case the spec named (a committed custody row
that is not draining, no session, owner not provably dead — review M2) is ORPHANED.

A topic that simply has no session now but whose next inbound WILL spawn is
**REACHABLE, not orphaned** — the honesty guard against screaming on every idle kill.

#### C. On an orphan — SURFACE ONLY (no mutation)

- Raise an attention item at **`priority: 'NORMAL'`** (NEVER high/urgent — high/urgent
  bypass coalescing, the 2026-05-22 flood lesson — review M3), with a **single stable
  `sourceContext: 'topic-reachability'`** so the existing attention-flood guard +
  `topicCreationBudget` ceiling coalesce it. Dedup key = **topic**, re-armed after a
  subsequent **verified-reachable** observation — BUT with a **per-topic minimum
  re-surface interval + exponential backoff that applies REGARDLESS of intervening
  verified-reachable observations** (round-2 finding): a topic that oscillates
  orphan→reachable→orphan every grace window cannot mint an item each cycle — the
  backoff caps a single flapper at a slow, widening cadence (it never goes fully
  silent on a genuine persistent problem, but it cannot flood).
- **Burst roll-up:** when orphan count in a window exceeds a threshold (a mass-reap or
  a partition), emit ONE rolled-up "N topics may be unreachable (cause)" item instead
  of N (finding 2/5).
- **Emergency-stop suppression (with re-sweep):** while an operator emergency-stop /
  MessageSentinel halt is active, SUPPRESS surfacing (the operator is deliberately
  quieting the system — a flood then is the opposite of help — finding 6). On
  halt-lift, the one-shot re-sweep (§A) re-checks suppressed topics so a real orphan
  that outlives the halt is not permanently silenced.
- It NEVER clears a flag, spawns, kills, transfers, or re-places. Its entire effect is
  an attention item.

#### D. Multi-machine posture — released-no-placement ONLY, freshness-gated

To preserve ONE voice (review M4/finding 5), the verifier surfaces the multi-machine
case ONLY for the **released-no-placement** slice — a topic with no live session and
no ownership record that any actor will self-heal. It explicitly DEFERS:
- *owner online-but-walled* → StrandedTopicSentinel's territory;
- *provably-dead owner* → OwnershipReconciler's Case C / re-placement.
It judges from a **freshness-gated** placement snapshot: if the snapshot is stale /
partition-suspected (the local view can't tell "remote owner dead" from "I'm
partitioned"), it does NOT scream per-topic — it emits at most one rolled-up "may be
partitioned from machine M (N topics)" item, fail-safe (finding 5). It never re-places
(the OwnershipReconciler owns that authority — F7 must not be a second re-placement
actor).

### E. Dark / flagged / maturation

- **Piece 1** (registry seam + token-guarded `.finally`): an in-memory correctness
  fix, live, no config surface of its own and no detection surface to flag. It has NO
  spawn timeout and NO sweep (round-2 removed both — re-introducing either re-opens the
  double-spawn race this rewrite eliminated).
- **Piece 2** (the verifier, pure signal): `monitoring.topicReachabilityVerifier`
  **omitted from `ConfigDefaults`** → `resolveDevAgentGate` (LIVE on a dev agent,
  dark fleet). Because it is **pure signal (no mutation)**, it ships **enabled, NOT
  dryRun, on a dev agent** — satisfying the Maturation-Path standard (the conformance
  finding); there is no actuation to gate. The `selfHeal*` flag from round-1 is
  **deleted** (no self-heal exists anymore).

## Integration obligations (review — Migration Parity + guard posture)

- **Guard-manifest registration (required):** register Piece 2 in `GUARD_MANIFEST`
  via `guardRegistry.register('monitoring.topicReachabilityVerifier.enabled', () =>
  verifier.guardStatus())` so a disabled/off state shows on `GET /guards` +
  GuardPostureProbe (a bespoke `/topic-reachability` route alone is invisible to
  `/guards` — review #6). The richer route is in addition to, not instead of.
- **Migration parity:** add `migrateConfigTopicReachabilityVerifierDevGate`
  (strip a default-shaped `enabled:false` from existing agents, the #1001 trap) and an
  Agent-Awareness/CLAUDE.md-template note for the `/topic-reachability` route. The
  Piece-1 TTL/timeout change is in-memory runtime (no config migration) — stated.

## Signal vs authority (instar-dev Phase-4 Q4)

Piece 2 is a **pure signal producer** — zero mutation authority (the dangerous round-1
self-heal is gone). Piece 1 is a correctness fix to an existing concurrency guard
(bound + token), not new blocking authority — it makes the *existing* flag SAFE, and
the token guard makes the clear race-free by construction. Complies with
docs/signal-vs-authority.md.

## Frontloaded Decisions (review decision-completeness — all pinned)

- `stuckSpawnMs` (the verifier's DETECTION threshold — a registry entry older than
  this is "stuck-spawning", surfaced as an orphan; the flag is NEVER cleared by it) =
  **180000** (3 min; comfortably > a healthy spawn, which loads ≤50 history messages —
  bounded, review-confirmed — so a slow-but-healthy spawn is not mis-flagged). Config
  `monitoring.topicReachabilityVerifier.stuckSpawnMs`.
- NO `spawnTimeoutMs` / NO backstop-sweep / NO `staleMs` — round-2 removed both (the
  timeout relocated the race; the sweep was logically unreachable). The token-guard on
  the existing `.finally` is the only Piece-1 behavior change.
- `graceMs` (verify delay after a mutation) = **30000** (30s; > normal respawn time so
  a healthy bounce isn't flagged). Config `monitoring.topicReachabilityVerifier.graceMs`.
- `maxPendingVerifies` = **500** (mirrors ReapNotifier's `AFFECTED_SET_CAP`); overflow
  surfaced as `affectedOverflow` in status.
- orphan-burst roll-up threshold = **10 topics / window**.
- per-topic re-surface backoff: floor **3600000** (1h), exponential, applied REGARDLESS
  of verified-reachable re-arm (the flap cap).
- Config interface (complete): `monitoring.topicReachabilityVerifier = { enabled?,
  graceMs, stuckSpawnMs, maxPendingVerifies, burstThreshold, resurfaceFloorMs }`
  (enabled omitted → dev-gate). No `intelligence.*` change (Piece 1 is in-memory only).
- `refresh` op (round-1 #10): `/sessions/refresh` kills+respawns inline and re-
  establishes itself → NOT a verify trigger (it self-heals synchronously). Stated.

## Tests (all three tiers)

- **Unit (`spawningTopicsRegistry.test.ts`):** token-guarded clear — A's late
  `.finally` does NOT delete B's freshly-added entry (the ABA test); the `.finally` on
  true settle IS the sole clearer; `startedAtMs` is readable for the verifier; NO
  timeout and NO sweep mutate the entry (the entry persists until its own `.finally`).
- **Unit (`topicReachabilityVerifier.test.ts`):** reachable (no session, not stuck,
  cap headroom) → no surface; orphan single-machine (stuck-spawning past `stuckSpawnMs`)
  → surfaces NORMAL (and does NOT clear the flag — pure signal); orphan
  at-cap/quota/adapter-down → surfaces; orphan released-no-placement → surfaces, does
  NOT re-place; walled-owner / provably-dead-owner → does NOT surface (one voice);
  `recovery-bounce` that self-heals → no surface; `recovery-bounce` whose respawn wedges
  → SURFACES (the round-2 blind-spot test); grace window: kill-then-respawn-within-grace
  → no false orphan; mass-reap → per-topic-coalesced + global cap + overflow counted;
  critical pressure → per-topic churn skipped BUT one rolled-up item emitted AND skipped
  topics re-swept on pressure-clear; emergency-stop active → suppressed AND re-swept on
  halt-lift; single flapping topic → backoff caps re-surface cadence (does NOT mint per
  cycle); stale/partition snapshot → at most one rolled-up "may be partitioned" item.
- **Wiring-integrity (Testing Integrity Standard — round-2 conformance):** the injected
  `SpawningTopicsRegistry` and the verifier's deps (attention sink, pressure getter,
  placement-snapshot reader, registry) are NOT null and NOT no-ops — the verifier
  actually reads the real registry / real snapshot and writes a real attention item.
- **Integration:** a real `sessionReaped(terminal)` + a real release-tap fire a verify;
  a genuinely-orphaned topic yields exactly one NORMAL attention item (deduped);
  registered in `GET /guards`.
- **E2E (alive):** config read at boot; `/topic-reachability` returns 200 (not 503)
  with the feature wired; single-machine + dev-gate-off → no-op; appears in `/guards`.

## Status surface

`GET /topic-reachability` → `{ enabled, verifiedCount, orphansSurfaced,
orphansSuppressedWithinGrace, affectedOverflow, lastTickAt }` (no `dryRun`/`selfHeal*`
— pure signal, no actuation). Plus the `guardRegistry` entry for `/guards`.
