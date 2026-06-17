---
title: "Autonomous Liveness Reconciler"
slug: "autonomous-liveness-reconciler"
author: "echo"
eli16-overview: "autonomous-liveness-reconciler.eli16.md"
review-convergence: "2026-06-17T08:33:15.827Z"
review-iterations: 4
review-completed-at: "2026-06-17T08:33:15.827Z"
review-report: "docs/specs/reports/autonomous-liveness-reconciler-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
cross-model-review-reason: "gemini-2.5-pro degraded (timeout) every round; codex ran clean rounds 1-4"
---

# Autonomous Liveness Reconciler

**Status:** review-convergence (converged round 4) → awaiting user `approved: true`
**Constitutional principle served:** Structure > Willpower (a level-triggered control loop replaces an edge-triggered heuristic), "An autonomous run must outlive its session," and P14 (Distrust Temporary Success — fix the cause, not just the symptom).

## The incident this fixes

On 2026-06-16, an autonomous run on topic 12476 was reaped at 22:13 PDT under reason `age-limit` (the periodic per-session lifetime recycle). That recycle is meant to be invisible — the run should revive and continue, and it survived every earlier recycle that day. This time it did not: the reap was tagged `midWork:false`, so it was never offered to the resume queue, and the run silently died. Its per-topic state file still said `active:true` with ~15h remaining, but no tmux session was executing it. **Nothing watched for that contradiction.** When the user messaged 1h+ later, there was no live session to answer — only the stopped-session sentinel replied. To the user this was indistinguishable from the agent abandoning the work.

### Root cause (CONFIRMED in code — must be fixed too, not just backstopped)

The `build-or-autonomous-active` evidence that makes a recycle resumable is injected at the **single instant** of the reap, in `server.ts` (the `considerEnqueue` path, ~lines 7429-7455). The injection branch is gated on `topicId != null`, where `topicId = telegram?.getTopicForSession(e.session.tmuxSession)`. **When `getTopicForSession` returns null at the reap instant, the entire injection branch is skipped and the run silently dies** — proven by the reap-log row showing reason `age-limit`, NOT `age-limit (active autonomous run)`, i.e. the branch never executed. The likely cause is a session-name→topic map staleness/eviction race at the kill instant.

**This spec therefore mandates TWO changes in the same effort (per the lessons-aware foundation audit — a backstop that masks a deterministic bug is the Phase-2 anti-pattern):**

1. **Root-cause fix (edge path):** in the reap injection, when `getTopicForSession` returns null, FALL BACK to resolving the topic from the session name (the same parse already used at `server.ts:~7491`) and/or the run-state file the reaper already touches. The deterministic null must stop producing silent deaths at the source.
2. **The reconciler (this feature):** a level-triggered backstop for the **residual** orphaning classes the edge fix cannot cover — a crash, a sleep/wake, a missed enqueue, a drainer that gave up. It is NOT the sole fix for the known null.

## Design principle: level-triggered reconciliation

A control loop (the Kubernetes-reconciler pattern) that continuously compares desired vs actual and converges, rather than perfecting any single instant:

- **Desired:** every run whose state file says `active:true` + `remaining>0` has a live session.
- **Actual:** which of those topics actually have a live session.
- **Gap → action:** respawn (conversation-preserving), debounced + capped + lease-gated + quota-gated + pressure-gated, with one honest user notice.

Companion to the AutonomousProgressHeartbeat: heartbeat = "alive but quiet"; reconciler = "dead but marked active."

### Per-topic reconcile-condition record (explicit state, not reconstructed from logs)

Following the reconciler pattern (codex cross-model finding), the loop keeps a per-topic **condition** with a `lastTransitionAt`: one of `healthy | orphaned-observing | debouncing | respawned | capped | blocked-quota | blocked-pressure | blocked-not-owner | blocked-queue-owns | mid-move`. This is the durable observed-state model the status route and audit read, so state is never reconstructed by replaying JSONL.

## Detection

Source of truth = the per-topic autonomous run-state files (`activeAutonomousJobs` + `autonomousRunRemainingForTopic`), reused verbatim — the SAME functions the reaper + drainer read.

**The run-state file is UNTRUSTED input.** It is local and could be stale or corrupted. The reconciler reads it ONLY for the binary "active + remaining" decision and the topicId; it NEVER sources a cwd, a resume UUID, or a spawn target from it (see §Action).

A run is a **reconcile candidate** iff ALL hold (each fails toward NOT-a-candidate on any read error — the safe direction):

1. `active===true` AND `remaining>0` AND the run is the CURRENT generation. **Concrete generation source:** the run's `started_at` timestamp (already written in the per-topic state file and read by `autonomousRunRemainingForTopic`) is the generation key; a candidate is valid only if no NEWER autonomous-run registration exists for the topic than the `started_at` in the file being read. If a stronger stamp than `started_at` proves necessary at build time, the build adds a minimal monotonic `run_generation` field written ONCE at autonomous-run registration (a small, bounded, named build task — not a parked decision) and compares that. This prevents reviving a run reality has moved past — a stale file from an OBSOLETE prior run on a reused topic id whose `started_at` is older than the current registration is NOT a candidate (codex finding: "active" is otherwise circular authority on an untrusted file).
2. NOT paused.
3. NOT operator-stopped (per-topic record OR `globalOperatorStopAt` OR the `autonomous-emergency-stop` file mtime — all three arms, bounded to the CURRENT run's start, NOT epoch-0 — so a stale stop from a prior run on a reused topic id does not poison a fresh run).
4. NOT mid-machine-move (`movedTo==null` AND no `move_suspended_at`).
5. THIS machine owns the topic AND holds the lease — `topicOwnerElsewhere(topic)===false` (placement owner via `sessionOwnershipRegistry.ownerOf` vs `_meshSelfId`) **AND** the lease is held. **The lease read DEFAULTS TO HELD on a single-machine agent:** `syncStatus` is `null` when multiMachine is disabled (routes.ts ~2234), so the gate treats `holdsLease` as `true` when `syncStatus` is null/absent — otherwise EVERY single-machine dev agent (where this feature is meant to be LIVE) would self-block as `blocked-not-owner` and the reconciler would be inert exactly where it should act. The lease AND-gate only constrains a genuine multi-machine pool, closing the transfer-window split-brain where two machines briefly both read themselves as `ownerOf`.
6. NO live session for the topic — read from the reconciler's **OWN once-per-tick snapshot** of running-session→topic (see §Scalability). NOTE: this is NOT the drainer's `liveSessionForTopic` closure (which calls `listRunningSessions()` per-invocation and would reintroduce the per-run fan-out criterion 6 forbids); the reconciler builds one session→topic memo at the top of each tick and probes it.
7. NOT already being (re)spawned by anyone — a shared **in-flight-spawn predicate** that is true for the ENTIRE queue lifecycle (`claimed → spawning → live + a short grace`), not merely "pending in queue." This closes the double-spawn window where the queue has dequeued an entry but its session is not yet live. **The `spawning` arm carries a TTL** (`respawnTimeoutMs + grace`): a spawn that dies mid-`spawning` without transitioning to live/failed would otherwise leave the predicate stuck-true forever and deadlock the reconciler (`blocked-queue-owns` permanently) — an entry `spawning` older than the TTL is treated as STALE → not-in-flight.
8. Binding is UNAMBIGUOUS — the topic↔session identity resolves consistently across the persisted resume map + the running-session list. An **ambiguous** binding routes to the attention queue as "needs attention," NEVER an auto-respawn (codex finding #1).

## Debounce

A candidate must persist **N consecutive ticks** (default 2) across **≥ a debounce window** (default 180s) before action. The reset rule is sharper than "any disqualifier": a transient `liveSessionForTopic→true` blip does NOT fully zero the death evidence — the debounce resets only when the session is **stably** live (seen live ≥1 full window) OR an authoritative disqualifier (paused / stopped / mid-move / not-owner) appears. This prevents a crash-looping session's intermittent presence from making the reconciler never conclude the run is dead (adversarial F4).

## Action: respawn

**Spawn path (named, not "verbatim reuse"):** call `spawnSessionForTopic(...)` — the low-level primitive the drainer uses for an already-dead session (the reconciler's "dead but marked active" case has no session to kill). The respawn closure resolves its inputs from AUTHORITATIVE sources, never the untrusted state file:

- `topicId` — from the run-state list; asserted to be a registered topic before spawning.
- `resumeUuid` — from `_topicResumeMap` (the canonical resume map). If ABSENT, the default is NOT a silent fresh-conversation spawn (that would continue the work with no memory of prior context — wrong for a continuity feature). Instead a missing resumeUuid raises ONE attention item ("can't resume topic N — no resume UUID") and does NOT respawn, UNLESS `allowFreshFallback:true` is explicitly configured, in which case it spawns fresh and the notice says so honestly (codex finding #2).
- `cwd` — from the authoritative topic-binding registry / project resolution, **realpath-resolved** (symlinks + `..` collapsed) and validated to be inside the agent home (which legitimately INCLUDES the agent-home worktree root `~/.instar/agents/<agent>/.worktrees/…`, a valid non-project-root path) — a cwd whose realpath escapes the agent home is REFUSED. The prefix check is on the resolved real path, never the raw string, to defeat symlink/traversal evasion.
- `sessionName`/`tmuxSession` — derived the same way the drainer derives them.

If any required input is missing or inconsistent, the respawn **fails loudly** (attention item) rather than spawning against guessed inputs.

**Atomic claim + actuation-instant recheck + post-spawn settle (load-bearing — the round-2 security/adversarial fix).** The naive "re-check across no await gap" is unsound because `spawnSessionForTopic` is ITSELF async (it awaits an orphan-reaper scan, dynamic imports, and context build BEFORE the tmux session exists), so a real window persists between the recheck and the session existing. The correct sequence:

1. **CLAIM** the in-flight-spawn key for the topic ATOMICALLY (CAS) as the FIRST actuation step — before the recheck and before calling spawn. If the claim fails (someone else holds it), abort (`blocked-queue-owns`). This is what actually prevents two ticks (or queue + reconciler) from both passing criterion 7 and both spawning.
2. **RECHECK live** (not from the per-tick snapshot): re-read all three operator-stop arms (per-topic record, `globalOperatorStopAt`, the emergency-stop file mtime), live-session, and lease/ownership (logging the observed lease epoch). Any positive → release the claim, abort.
3. **SPAWN** (bounded by `respawnTimeoutMs`).
4. **POST-SPAWN SETTLE:** after the session is created, within the grace window, re-check operator-stop and whether a competing live session appeared; if a stop arrived or a duplicate exists, KILL the just-spawned session (the only fully race-free guarantee given the async spawn interior). Release the claim on settle/fail. **The settle-kill must FIRST clear the session's `midWork:true` tag (and not route through the revival path)** — otherwise the ResumeQueue would revive the very session the settle just killed for violating an operator-stop, re-spawning into a stopped topic (the round-3 security finding: settle-kill + midWork = an operator-stop-bypass). A settle-kill is a terminal abort, never a midWork reap.

**The in-flight claim primitive (codex round-3 clarification).** The claim is a **process-local in-memory map** (topic → claim record with a timestamp), CAS-claimed atomically within the single-threaded event loop (no two ticks interleave a check-then-set). It is deliberately NOT a cross-machine distributed lock and needs no distributed-lock guarantees: criterion 5 already ensures ONLY the owning+lease-holding machine reconciles a given topic, so the claim only has to serialize this machine's own ticks + its own queue/reconciler paths. Crash recovery is trivial — a process restart clears the map, and the reconciler re-derives liveness from the running-session snapshot on the next tick (a claim never outlives the process that holds it). The `spawning`-arm TTL (criterion 7) covers the in-process-but-wedged case.

**Authoritative-source precedence (codex round-3 clarification).** When the untrusted run-state file and the authoritative sources disagree, the authoritative source wins and the state file is never used for that field: `topicId` ← run-state list, cross-checked against the binding (mismatch → ambiguous → attention, no respawn); `resumeUuid` ← `_topicResumeMap` only (absent → attention unless `allowFreshFallback`); `cwd` ← topic-binding registry realpath only (escape → refuse); ownership ← `sessionOwnershipRegistry` + lease; session identity ← the per-tick running-session snapshot. Any disagreement that cannot be resolved to a single authoritative answer routes to `needs-attention` (deduped), NEVER an auto-respawn.

**Respawn-on-reconcile marks the session resumable.** The respawned session is tagged so that if the reaper kills it again it is offered to the ResumeQueue (`midWork:true`), attacking the incident's root cause rather than re-entering the reconciler's respawn budget.

**Bounded.** The spawn is wrapped in a timeout (`Promise.race`, default 45s); a hung spawn cannot wedge the tick. At most ONE respawn per tick (the rest wait for the next tick; debounce state persists), so a recycle storm cannot spawn-storm.

## Anti-reaper-thrash (the headline adversarial finding)

The idle reaper deliberately sheds sessions under pressure. A naive reconciler would respawn what the reaper just killed, the reaper kills it again, and the cap is burned on a HEALTHY run — defeating the feature loudly. Mitigations (all three):

- **Pressure gate — BOUNDED (the round-2 permanent-death fix):** read the reaper's live pressure tier once per tick (hoisted into the per-tick snapshot, not per-candidate). If moderate/critical the reconciler SKIPS (condition `blocked-pressure`) — BUT the skip is bounded: a dead-but-marked-active run that has been `blocked-pressure` for ≥ `maxPressureBlockedTicks` (default 10) OR ≥ `maxPressureBlockedSec` (default 30m) is no longer protected by deferring — skipping protects no live session (the run is already dead). At that bound the reconciler either respawns anyway (a dead run is not load the reaper can shed) OR, if pressure is critical, raises ONE attention item ("topic N orphaned but the machine is under sustained pressure — needs your eyes") so the run cannot stay silently dead forever on a chronically-loaded box.
- **Reap-log consult — bounded window + explicit keys:** defer to the queue/midwork path only if the most recent reaper pressure/age kill for the topic is within `max(tickIntervalSec, reaperCadenceSec) + margin` (NOT one tick — a reaper killing just outside a single tick window would otherwise be missed). The lookup is a bounded tail read (last-N lines) hoisted ONCE per tick, resolving the topic by the ordered keys: session-name parse → topic id → resume/session binding → timestamp window. The reconciler acts only on the "vanished with no reap record" / "reaped midWork:false and queue declined" class.
- **Root-cause fix (above)** removes the largest source of the very orphaning the reconciler would otherwise chase.

## Loop brake (P19) — give up LOUDLY, with separated counters

Two DISTINCT per-topic counters in the reconciler's OWN durable cap (`state/autonomous-liveness-cap.json` — named; this feature owns its cap, see §"On the cap" below):

- **Redie counter** (a respawn that started a session which then re-died): the give-up brake — ≤ `respawnCapPerWindow` (default 3) per `respawnCapWindowSec` (default 6h). On exceeding → STOP, set condition `capped`, raise ONE coalesced attention item. **Unified with the queue (the round-2 re-loop fix):** because a reconciler-respawned session is marked `midWork:true`, a later reaper kill of it is revived by the ResumeQueue under ITS OWN resurrection cap — so a flapping run could thrash under the queue's cap while the reconciler's redie counter never trips. To unify give-up, the reconciler reads the ResumeQueue's resurrection count for the topic (the same stable-key the queue uses) and counts a queue-resurrection of the topic toward ITS redie cap too. The two paths then share ONE effective give-up bound even though each keeps its own counter.
- **Spawn-failure counter** (a respawn that threw before any session existed — infra flakiness): a SEPARATE retry budget with backoff and its own higher ceiling; a transient tmux/quota hiccup must NOT exhaust the "this run is broken" budget (adversarial F3). The `liveness-respawn-failed` raise is de-duplicated per-topic (mirroring the cap's surfaced-once guard) so a persistently-failing spawn does not raise every tick.

Cap state is durable (survives restart) and garbage-collected: the per-tick cleanup evicts cap/surfaced entries whose window has fully expired AND that are not current candidates, so neither map grows unbounded.

### On the cap (resolving the earlier "shared cap" claim honestly)

An earlier draft asserted a single cap "both the ResumeQueue and the reconciler consult." That sharing does not exist in code (the queue's resurrection cap is internal to `state/resume-queue.json`). **Resolution:** the reconciler keeps its OWN cap (above). Collective over-spawn is prevented NOT by a shared counter but by criterion 7 (the shared in-flight-spawn predicate) + the actuation-instant recheck — the reconciler never spawns a topic the queue is spawning or recently spawned. The "unified shared cap" language is removed as aspirational; the in-flight lock is the real coordination mechanism.

## Quota / pressure / session-count gate

The respawn gate folds in the SAME checks the drainer uses (not a single `quotaOk`): `canSpawnSession().allowed` AND the session-count cap AND `migrationInFlight()` AND the pressure gate above. Skip + retry next tick under pressure; never spawn-storm past the cap the drainer respects.

## Shared closures (extract, don't re-create — drift prevention)

The drainer's dep closures (`topicOwnerElsewhere`, `operatorStopSince`, the spawn/quota gates) are currently defined INLINE inside the `new ResumeQueueDrainer({...})` literal. The build EXTRACTS them into named `const`s above the drainer construction and passes the SAME references into BOTH the drainer and the reconciler. This makes "the reconciler and the reaper agree" structurally true instead of a hope, and is the only way the operator-stop file-mtime arm (a correctness-critical detail) cannot be forgotten in a re-created copy.

**Two build constraints surfaced in round 2:** (a) these closures capture `resolveTopicForTmux`, which is itself a **block-local `const`** declared inside the drainer's enclosing `else`-block (server.ts ~7092) — it (and the other block/module locals they capture: `operatorStopsByTopic`, `scopeVerifier`, `quotaManager`) must be HOISTED above the extraction point or the extracted closures won't compile. (b) The liveness probe is the ONE closure NOT shared verbatim: the drainer's `liveSessionForTopic` calls `listRunningSessions()` per-invocation, which would reintroduce the per-run fan-out criterion 6 forbids — the reconciler instead builds its own once-per-tick session→topic memo (reusing the hoisted `resolveTopicForTmux` for the mapping) and probes that.

## User notice — honest self-heal

On a LIVE respawn, post ONE line through the existing one-voice/dedupe send plumbing: `"I noticed my run here had no live session and brought it back — picking it up."` (no computed "~M min ago" — that would risk a false TIME_CLAIM and is dropped). Notices are coalesced per topic per episode (one per flapping episode, not per respawn). No notice in dryRun.

## Safety posture (graduated maturation)

- Ships **DARK on the fleet** (`monitoring.autonomousLivenessReconciler.enabled` OMITTED in ConfigDefaults → dev-agent gate resolves live-on-dev / dark-fleet; hardcoding `enabled:false` would dark the dev agent too — the PR#1001 footgun — so it is deliberately omitted).
- **DryRun-FIRST on dev** (component code-defaults `dryRun:true`): logs `would-respawn` + a **shadow `would-have-capped`** event (so the reaper-thrash/cap behavior — which real dryRun cannot record — is still observable on dev BEFORE the operator flips live; adversarial F6).
- **P7 Tier-0 justification (explicit):** the respawn decision is a pure objective state comparison (active+remaining+no-session+gates), not a policy judgment — no LLM-in-the-loop is correct here; Tier-0 is justified and stated.
- Every transition audited to `logs/autonomous-liveness.jsonl`; `err.message` is length-clamped + path/secret-scrubbed before it ever reaches an attention item or notice.
- **Close-the-Loop maturation:** a registered commitment tracks "observe `would-respawn`/`would-have-capped` on dev for the soak window, then flip `dryRun:false`" so the feature does not rot in dryRun forever.
- Status route `GET /autonomous/liveness` (read-only, 503 when dark, Bearer-auth'd; payload is content-free — topic ids + counters + conditions, no topic content/paths/secrets).

## Config (`monitoring.autonomousLivenessReconciler`)

| key | default | meaning |
|-----|---------|---------|
| `enabled` | (OMITTED → dev-gate) | live-on-dev / dark-fleet |
| `dryRun` | `true` (code default) | observe-only; log would-respawn + would-have-capped |
| `tickIntervalSec` | `120` | reconcile cadence |
| `debounceTicks` | `2` | consecutive observations before acting |
| `debounceWindowSec` | `180` | min wall-clock a candidate must persist |
| `respawnTimeoutMs` | `45000` | bound on a single spawn |
| `respawnCapPerWindow` | `3` | P19 redie brake (unified with the queue's resurrection count) |
| `respawnCapWindowSec` | `21600` | 6h |
| `spawnFailureRetryCeiling` | `6` | separate infra-failure budget |
| `maxPressureBlockedTicks` | `10` | bound on pressure-deferral before acting/escalating |
| `maxPressureBlockedSec` | `1800` | 30m wall-clock bound on pressure-deferral |
| `allowFreshFallback` | `false` | if true, respawn fresh when no resumeUuid (default: raise attention, don't respawn) |
| `inflightSpawnTtlMs` | `respawnTimeoutMs + grace` | stale-`spawning` TTL (deadlock guard) |
| `notifyUser` | `true` | self-heal line on a live respawn |

All raise-to-attention paths (cap give-up, spawn-failure, ambiguous-binding, missing-resumeUuid, sustained-pressure) are de-duplicated per-topic per-episode (the `cappedSurfaced`-style surfaced-once guard) so no path can flood the attention queue (P17).

## Tests (Testing-Integrity: all three tiers + wiring + semantic)

- **Unit:** both sides of each of the 8 criteria; debounce (stable-live reset vs blip); the TWO counters (redie brake vs spawn-failure budget); actuation-instant recheck aborts on a late stop/live; dryRun would-respawn + would-have-capped; cap GC; ambiguous-binding → needs-attention.
- **P19 sustained-failure test:** drive a permanently-rejecting respawn; assert the redie cap bound AND the cross-restart durable-cap bound hold.
- **Integration:** `GET /autonomous/liveness` 200 when enabled (401 unauth, 503 dark).
- **E2E "feature is alive":** seed active-run + remaining + no-session → respawn after debounce; operator-stopped / paused / mid-move / queue-owned / pressure-high / not-lease-holder → NOT respawned; cap gives up loudly after R.
- **Wiring integrity:** `respawn` is bound to the real `spawnSessionForTopic` (named) and preserves `--resume` continuity (a continuity test); the extracted closures are the SAME references the drainer uses (no divergent copy).
- **Root-cause fix test:** the edge-path null fallback resolves the topic and tags `age-limit (active autonomous run)` when `getTopicForSession` returns null.

## Migration parity

- `migrateConfig` adds the `monitoring.autonomousLivenessReconciler` block existence-checked, **OMITTING `enabled`** (only `dryRun`/tunables) so the dev-gate resolves enablement (the omit-`enabled` footgun is called out for the builder).
- CLAUDE.md template (Agent Awareness) + `migrateClaudeMd` content-sniff: the reconciler + `GET /autonomous/liveness` + the proactive trigger ("user asks why a run died / didn't come back").
- `devGatedFeatures` registration WITH the required `justification` field.
- No hook/skill/settings change.

## Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN.** Only the lease-holding + owning machine reconciles a run (criterion 5, now a true lease AND-gate). The condition records + both counters are per-machine and never replicated (the run-state file is already the local authoritative vantage). A run mid-move is owned by neither machine until the move lands (criterion 4). The self-heal notice rides the existing one-voice plumbing (no new cross-machine notice path). `GET /autonomous/liveness` is machine-local; a pool-merged read is an explicit non-goal for v1.

## Frontloaded Decisions

- **Spawn path = `spawnSessionForTopic`** (low-level; the orphaned run has no session to kill); args resolved from `_topicResumeMap` + topic-binding registry + the running-session snapshot, NEVER the untrusted state file; fail loudly on missing/inconsistent inputs. (NOT cheap — a durable side-effect + a real path choice; gated behind dryRun.)
- **The reconciler owns its OWN durable cap** at `state/autonomous-liveness-cap.json` (the "shared cap" framing is dropped); collective over-spawn is prevented by the in-flight-spawn predicate + actuation recheck.
- **dryRun default = true** (NOT cheap — gates a durable respawn; the operator's explicit flip).
- **enabled OMITTED** from ConfigDefaults (dev-gate; never hardcode `enabled:false`).
- **Default tunables** (the config table) — cheap; config-overridable, no external side-effect.
- **Multi-machine = machine-local**, lease AND-gated.
- **Root-cause edge fix ships in the same PR** as the reconciler (backstop ≠ sole fix).

## Open questions

*(none)*
