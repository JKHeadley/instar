---
slug: spawn-cap-interactive-priority
title: Interactive Priority Lane for the Host Spawn Cap (Postmortem F5)
status: draft
eli16-overview: spawn-cap-interactive-priority.eli16.md
constitution: Bounded Blast Radius + Structure > Willpower (registered); enacts the proposed "User Experience Is the Product → Responsiveness Under Load" sub-standard
earned-from: 2026-06-25 user-reachability postmortem, Failure 5
review-convergence: "2026-06-26T10:38:02.912Z"
review-iterations: 3
review-completed-at: "2026-06-26T10:38:02.912Z"
review-report: "docs/specs/reports/spawn-cap-interactive-priority-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 6
cheap-to-change-tags: 0
contested-then-cleared: 0
approved: true
approved-by: "Echo (per Justin's standing pre-approval for this autonomous run — goal: 'Justin pre-approved all decisions and any spec approvals')"
approved-at: "2026-06-26"
---

# Interactive Priority Lane for the Host Spawn Cap (F5)

## The constitution standard this enforces

This change enacts postmortem sub-standard #5 (**Responsiveness Under Load**) of
the proposed umbrella standard *The User Experience Is the Product*. That umbrella
is **not yet in `docs/STANDARDS-REGISTRY.md`** — it is being established by the
F1–F7 workstream (topic 28744). Until it is registered, this spec also anchors to
two ALREADY-REGISTERED standards it genuinely serves, so its constitutional
traceability does not depend on an unregistered parent:

- **Bounded Blast Radius** — the host spawn cap is the OOM safety floor; this
  change subdivides WITHIN it and never raises the ceiling.
- **Structure > Willpower** — the interactive signal is enforced by a code
  allowlist + lint, not by "remember not to tag the fan-out."

(Registering the umbrella standard is tracked as part of the F-series, not this
spec. <!-- tracked: topic-28744 F-series umbrella-standard registration -->)

## What broke (the postmortem scenario)

The host spawn cap (`hostSpawnSemaphore`, the 2026-06-20 fork-bomb/OOM safety
floor) bounds how many LLM subprocesses run AT ONCE across every Instar process
on the host (default 8). Every provider is wrapped by
`SpawnCapIntelligenceProvider`, whose `evaluate()` acquires a host-wide slot
before the inner `claude -p` / `codex exec` spawn, polling (bounded, ~5s) when
the cap is saturated, then **failing closed** for a gating call.

On 2026-06-25, under sustained saturation, the **user's outbound reply gate**
(`MessagingToneGate` on the operator channel — `gating:true`, synchronously
awaited) competed for a slot on **equal footing** with a flood of background
sentinels and sweeps. Its bounded-acquire window elapsed, it failed closed
(held), and the user got silence. The safety floor that prevents OOM became the
reason the user couldn't be answered.

## What already exists (and why it is NOT enough)

- `LlmQueue` (src/monitoring) already has interactive-vs-background lanes WITH
  preemption — but **the tone-gate path does not route through `LlmQueue`**; it
  calls `provider.evaluate(...)` directly, wrapped only by
  `SpawnCapIntelligenceProvider`. The gap is at the **spawn-cap layer**.

  **Why not just route the tone gate through `LlmQueue` (or unify both queues)
  now? (review C5)** That is the larger, more invasive design — it would re-home
  every direct `provider.evaluate` callsite onto the queue, change the failure
  semantics of ~9 gate seams, and entangle the OOM safety floor (host-wide,
  cross-process, file-locked) with `LlmQueue` (in-process, single-agent). The two
  bounds protect different things: `LlmQueue` paces one agent's spend/lanes;
  `hostSpawnSemaphore` bounds total host subprocesses across ALL agents (the
  fork-bomb). The minimal fix for F5 is to teach the host cap the one distinction
  it lacks (interactive vs background headroom), NOT to re-route the call graph.
  Unifying onto a single priority queue is a worthwhile larger effort, tracked
  separately — this spec deliberately takes the small, safety-preserving step.
  <!-- tracked: topic-28744 F5-followup unify-llm-queues -->
- `attribution` already carries `gating` and `deferrable`; neither is a correct
  interactive signal. `gating:true` is set by ~9 seams including
  **CoherenceReviewer**, which fans ~10 parallel reviewers per message — the
  ORIGINAL fork-bomb driver. "gating = priority" would flood the interactive
  reserve and re-create the starvation. `deferrable` marks background but its
  absence does not mean "user-blocking."

## The gap

`hostSpawnSemaphore.acquire(id)` is **all-or-nothing and lane-blind**. AND the
wrapper's bounded-ingress has a **second lane-blind gate** (the waiters cap)
that the reserve math never sees — see §B below, the blocking finding from
review.

---

## The design

### A. The interactive signal — structural allowlist, not convention

Add `attribution.lane?: 'interactive' | 'background'` to the attribution object
(optional; **default `background`**). But the signal is **not trusted on the
caller's word** — `SpawnCapIntelligenceProvider.evaluate()` enforces a hard-coded
component allowlist:

```
INTERACTIVE_ALLOWLIST = { 'MessagingToneGate', 'MessageSentinel' }   // see A.1
resolvedLane =
  (attribution?.lane === 'interactive'
   && INTERACTIVE_ALLOWLIST.has(attribution.component)
   && interactiveContextPredicate(attribution))   // A.1
    ? 'interactive' : 'background'
```

Any call that sets `lane:'interactive'` from a component NOT on the allowlist —
including a future copy-paste onto the CoherenceReviewer fan-out — is **silently
downgraded to background**.

**Honest trust boundary (review correction).** This is structural against the
realistic failure mode (accidental internal mis-tagging / copy-paste of the
fan-out) — NOT an unspoofable cryptographic gate. `attribution.lane`,
`.component`, and the `synchronousReply` predicate are all caller-set fields; the
trust model is "instar's own in-process seams set attribution," never "the field
is derived from untrusted message content." So `lane`/`component` are never
attacker-controlled in the threat model. The allowlist hardens against the thing
that actually goes wrong (a refactor tagging a fan-out path), and we state it as
that, not as "impossible by construction."

Two structural guards:
- A unit test asserts a CoherenceReviewer call tagged `interactive` resolves to
  `background`, **and** a second test pins the exact `INTERACTIVE_ALLOWLIST`
  membership (fails on ANY addition to the set) — so the allowlist constant
  itself cannot silently grow, not just the assignment sites.
- A lint (`scripts/lint-interactive-lane-allowlist.js`, modeled on
  `lint-no-unbounded-llm-spawn`) fails CI on any static `lane: 'interactive'`
  assignment outside the two allowlisted seams. (It cannot catch a
  runtime-constructed attribution; the membership test + the wrapper downgrade
  are the backstops for that — and the downgrade is fail-safe regardless.)

(A future refinement, noted not adopted: replace the hard-coded component
allowlist with a central `interactiveLaneEligible` flag in the existing
`componentCategories` registry, so lint + runtime read one source. Kept as a
hard allowlist for v1 — fewer moving parts on a safety-adjacent path. <!-- tracked: topic-28744 F5-followup interactive-lane-registry -->)

#### A.1 The exact tagged seams + predicate (both pinned — no "if/where")

1. **`MessagingToneGate`** when `context.recipientClass === 'operator'` **AND**
   the send is a **synchronous reply to a live inbound turn** (not a proactive
   cadence emission). This requires NEW wiring (the field does not exist today):
   add `synchronousReply?: boolean` to `ToneReviewContext`, resolve it
   **structurally at each tone-gate call seam** (the reply path sets `true`; the
   proactive senders — PresenceProxy / PromiseBeacon / watchdog — set/leave
   `false`), exactly as `recipientClass` is resolved at the route seam today.
   `review()` reads it and sets `attribution.lane:'interactive'` only when
   `recipientClass === 'operator' && synchronousReply === true`. Default is
   `false` (and the wrapper default lane is `background`), so any un-wired seam
   degrades to `background` — never a false-interactive (fail-safe). This closes
   review finding F4 (recipientClass alone is too broad).

2. **`MessageSentinel`** when classifying an **operator INBOUND** message
   (`recipientClass`/origin = operator inbound). This is the user *reaching* the
   agent — including the documented "stop everything / emergency stop" intercept.
   The postmortem blindspot is the user not reaching OR hearing the agent; both
   directions get the reserve. Without this, the emergency-stop classification
   would be squeezed into the background floor under interactive load — a
   user-reachability regression (review finding, adversarial #4). Bounding: the
   operator is one human; the volume is tiny, so it cannot dilute a 2-slot
   reserve.
   **Documented residual (review R2):** emergency-stop classification shares the
   interactive lane with ordinary operator inbound; its robustness is bounded by
   the one-human-operator-channel assumption. A *compromised or automated*
   operator channel flooding operator-inbound classify calls could shed an
   emergency-stop *within* the interactive lane. That is explicitly OUT OF SCOPE
   here (a giving-itself-its-own-micro-reserve refinement is tracked, not built —
   it would only matter under operator-channel compromise, which is a different
   threat than F5). Background safety sentinels remain protected by `Rb`
   regardless. <!-- tracked: topic-28744 F5-followup emergency-stop-microreserve -->

`InputGuard` and all sentinels/sweeps/reflectors/jobs and the CoherenceGate
fan-out remain `background` (the safe default).

### B. Lane-aware bounded ingress (the BLOCKING fix)

Review surfaced a blocking hole: today the wrapper rejects a caller with
`waiters-full` **before** it ever attempts `acquire`, and that ceiling is
lane-blind:

```
if (_activePollers >= waitersMax) throw LlmCapacityUnavailableError('waiters-full')
_activePollers++ ; ... semaphore.acquire(id)
```

Under the incident regime a background flood fills `waitersMax` and an
interactive reply is shed before reaching its reserved headroom — re-creating
F5. The fix makes ingress lane-aware:

1. **Interactive fast-path FIRST.** For a resolved-interactive call, attempt
   `semaphore.acquire(id, 'interactive')` **before** the waiters-cap check. An
   interactive caller that can immediately claim free reserved headroom is NEVER
   rejected as a "waiter."
2. **Per-lane waiter accounting — a CARVE-OUT of `waitersMax`, never additive.**
   The total poller ceiling stays **exactly `waitersMax`** (the in-memory
   prompt-state bound — the rewrite must NOT silently raise it the way §C never
   raises N). Of those, `interactiveWaiters` (default **4**, NOT 8 — sized to the
   one-human operator-channel cardinality the allowlist enforces) are reserved
   for interactive pollers. The controlling gate is a JOINT
   `totalPollers < waitersMax` (the aggregate never exceeds `waitersMax`) PLUS a
   background sub-cap: a background poller is admitted only while
   `totalPollers < waitersMax` AND `backgroundPollers < (waitersMax −
   interactiveWaiters)`; an interactive poller while `totalPollers < waitersMax`
   (it may use the contended band too).
   So a background flood can never consume the interactive waiter reserve, and
   the aggregate is still `waitersMax`. (This is the same "carve within the
   existing ceiling, never raise it" discipline as §C — pinned explicitly so the
   blocking fix doesn't itself re-introduce an unpinned second gate, which was
   the F5 root cause.)
3. The typed shed error, the ~100ms poll, and the total-cap semantics are
   otherwise unchanged.

**Fairness is best-effort (review C1).** There is no FIFO queue among pollers
(by design — the foundation's bounded-ingress is a poll-the-holder-set model, not
a wait queue). So repeated fresh interactive arrivals can, in principle, win
freed slots ahead of an already-waiting interactive poller. For the actual
workload (≤ a couple concurrent operator-channel calls) this never bites; we
state it as an accepted best-effort property rather than implying strict
ordering.

A regression test: `(waitersMax − interactiveWaiters)` background pollers
in-flight + free interactive reserve ⇒ an interactive `evaluate` still acquires
(must NOT throw `waiters-full`); and total concurrent pollers never exceed
`waitersMax`.

### C. Symmetric reserved headroom in the holder-set count

Holder records gain an optional `lane`. Inside `acquire(id, lane)`, **over the
same pruned `live[]` array, in the same critical section** (review finding:
same-snapshot invariant — counts MUST be post-prune so a dead interactive holder
releases its reserve):

- `liveTotal = live.length`
- `liveInteractive = live.filter(h => h.lane === 'interactive').length`
  (**equality only** — any other/missing value is background; see §E)
- `liveBackground = liveTotal − liveInteractive`

Admit:
- `interactive`: iff `liveTotal < N` **AND** `liveInteractive < (N − Rb)`
- `background`: iff `liveTotal < N` **AND** `liveBackground < (N − Ri)`

`liveTotal < N` is the **unconditional first predicate of every lane** — the OOM
floor is byte-identical. Because every holder is exactly one lane,
`liveInteractive + liveBackground == liveTotal`, so each lane predicate is
strictly tighter than the total — there is no arithmetic path to exceed `N`.

Defaults: `N=8`, `Ri=2`, `Rb=2`. No waiting-between-lanes ⇒ **no deadlock**; no
killing of in-flight work ⇒ **no preemption blast radius**.

### D. What the guarantee actually is (precise — not "jumps the queue")

Reservation does **not** make an interactive poller win a contended freed slot
(there is no queue, no preemption). It guarantees: **up to `Ri` concurrent
interactive calls are admitted immediately, regardless of background load**,
because background can never occupy more than `N − Ri` slots. The `(Ri+1)`-th
concurrent interactive call and beyond still race the bounded poll fairly. For
the postmortem (a single operator reply, `Ri=2`) this fully solves F5 — the
reply never waits. The earlier "jumps the queue" framing is dropped; the correct
description is a **concurrency floor for ≤ Ri interactive calls** plus the
symmetric background floor.

By design an interactive call sheds at `liveInteractive = N − Rb` even if the
reserved background slots sit idle (reserved-but-idle inversion). For
low-cardinality operator replies this is fine; it is the deliberate cost of
guaranteeing the background floor.

### E. Holder-file schema + the under-count safety rule (normative)

The holders file (`~/.instar/host-spawn-holders.json`) gains an OPTIONAL `lane`
per record. `version` stays `1` (additive optional field). Two NORMATIVE rules
(review finding: a garbage lane that *drops* a holder would under-count → grant
more slots → erode the OOM ceiling):

1. **`lane` is NEVER part of `isWellFormedHolder`.** A malformed/missing/garbage
   lane never drops a holder; the holder stays counted (the OOM floor is
   sacrosanct).
2. **Classification is equality, never parsing:** `h.lane === 'interactive'` ⇒
   interactive, **everything else** (missing, `null`, number, arbitrary string)
   ⇒ background. No `.toLowerCase()`, no enum-parse that can throw or reject. So
   a malformed lane can neither crash `acquire` nor mis-count toward the
   protected reserve.

**Mixed-version rollout (best-effort reserve, guaranteed cap).** An OLD reader
ignores `lane`; a NEW reader counts a missing-`lane` record as background. The
**total cap is bounded in both directions at all times.** But the *reservation*
is **best-effort while any old (lane-blind) process is live on the host** — an
old process honors only `liveTotal < N`, so it can occupy slots a new process
would reserve. Honest statement: mid-rollout the OOM floor is guaranteed; the
priority is only fully enforced once every co-resident agent runs the lane-aware
version. (Moot during the dark rollout — the flag is off by default.) The
`/spawn-limiter` status exposes a `laneAwareHolders` vs `liveHolders` delta so
"is my reserve actually honored right now" is a read, not an assumption.

**When disabled, no `lane` is written at all** (truly byte-identical file, not
merely "decision-identical") — cleanest rollback.

### F. Config, clamp algorithm, and flag mechanism (all pinned)

Config block `intelligence.spawnCap.interactivePriority`:
- `enabled` — **omitted from `ConfigDefaults`** so it resolves via
  `resolveDevAgentGate` (live-on-dev / dark-fleet). RATIONALE for the apparent
  contradiction with the parent block's "NEVER resolveDevAgentGate": that
  prohibition protects the **safety FLOOR** (the cap N), which is unchanged and
  never gated here. This flag toggles only the **UX subdivision**, whose
  disabled state is byte-identical-to-today's-safe-behavior — so dev-gating the
  *toggle* never weakens the floor. `enabled` is honored as `=== true` only; any
  non-`true`/missing value ⇒ off (safe direction).
- `ri` (default 2), `rb` (default 2) — seeded in `ConfigDefaults`. Env overrides
  `INSTAR_SPAWN_INTERACTIVE_RI` / `_RB` mirror the existing
  `INSTAR_HOST_SPAWN_*` pattern.

**Clamp algorithm (deterministic, pinned), computed against the RUNTIME-resolved
effective `N`** (`resolveSpawnCap`, which honors `INSTAR_HOST_SPAWN_MAX` > config
> 8 — NOT the literal 8):

```
N  = resolveSpawnCap(...)                       // effective cap
ri = (Number.isFinite(cfgRi) && cfgRi >= 0) ? Math.floor(cfgRi) : 2  // permits 0; >=0 not >0
rb = (Number.isFinite(cfgRb) && cfgRb >= 0) ? Math.floor(cfgRb) : 2
Ri = clamp(0, ri, N - 1)                        // interactive reserve first
Rb = clamp(0, rb, N - 1 - Ri)                   // background reserve takes the rest
```

This guarantees `Ri ≥ 0`, `Rb ≥ 0`, `Ri + Rb ≤ N − 1` (≥1 always-contended
slot), and both lanes retain a non-empty band — for any `N ≥ 1`. At `N = 1` both
clamp to 0 ⇒ the feature is inert and the lone slot is fully contended (correct
degenerate behavior). **`ri`/`rb` use a `>= 0` finite filter, NOT
`resolveSpawnCap`'s `> 0` filter** (review NEW-3): the cap rejects a non-positive
value because a 0 cap is nonsensical, but a legitimate `ri:0` / `rb:0` (operator
chooses zero reserve for that lane) must be PRESERVED, not silently bumped to the
default — so the parse is `Number.isFinite(x) && x >= 0 ? Math.floor(x) :
default`, never `||` and never the cap's positivity filter.

**Interactive reserve has priority over background reserve (review C3 — stated,
not surprising):** when `ri + rb > N − 1`, `Ri` is honored first and `Rb` takes
the remainder (can be squeezed to 0). This is a deliberate, documented order
(F5 is about the user's responsiveness). To make a reshaped config visible
rather than silent, the resolver emits ONE loud startup log line when the clamp
changes the requested values (`interactive-priority: requested ri=R rb=R clamped
to Ri=.. Rb=.. for N=..`) — config that gets reshaped is surfaced, never
swallowed.

The `enabled/ri/rb` values are threaded through `configureHostSpawnSemaphore`
alongside the resolved cap so they are clamped against the SAME effective N the
semaphore enforces. The lazy `getHostSpawnSemaphore()` path (when boot never
calls `configure`) resolves the SAME defaults (`enabled` via the dev-gate,
`ri=2`, `rb=2`) so `Ri/Rb` are never `undefined` in that path (review NEW-4).

**Why `Ri + Rb ≤ N − 1` and not `= N`:** a full partition (`Ri + Rb = N`, zero
contended band) is also total-safe and deadlock-free, but it makes the cap rigid
— neither lane could ever use a momentarily-idle slot of the other even with no
contention, wasting capacity. The `−1` keeps at least one slot fluid. (Stated so
the constraint is justified, not arbitrary.)

### G. Observability — effectiveness, not just gauges (review finding + conformance flag)

`GET /spawn-limiter` **retains all existing fields** (`cap, liveHolders,
localHolders, foreignHolders, available, saturated, waiters, acquireMs,
waitersMax, holdersPath`) and ADDS:
- gauges: `liveInteractive`, `liveBackground`, `laneAwareHolders`, `ri`, `rb`,
  `interactivePriorityEnabled`
- **local-process** effectiveness counters (explicitly labeled as per-process in
  the API, since the cap is host-wide and multiple agents may run — review C4;
  an operator reading them must not mistake one process's counts for the whole
  host):
  - `interactiveShedTotalLocal` — interactive calls shed (acquire-timeout OR
    waiters-full on the interactive path). **An interactive shed is the literal
    recurrence of the F5 postmortem** ("user got silence"), so it ALSO surfaces
    via `DegradationReporter` — but **COALESCED, not one event per shed** (review
    M2): emit at most one degradation event per cooldown window (default 5 min)
    carrying the occurrence count since the last emit. Per-shed events would
    self-amplify exactly under the saturation they report (and a flooded operator
    channel would turn each shed into an attention-surface event) — so the
    counter is precise per-shed while the *notification* is rate-bounded.
  - `interactiveAdmittedIntoReserveTotalLocal` — interactive acquires that
    succeeded while `liveBackground ≥ N − Ri` (i.e. would have shed under
    all-or-nothing — the reservation *helped*).
  - `backgroundRefusedByReserveTotalLocal` — background refusals caused
    specifically by the reserve (not by total saturation).

Disabled-state semantics: when `interactivePriorityEnabled` is false, no `lane`
is written, so `liveInteractive` reports 0 and `liveBackground` equals
`liveHolders`; the counters stay 0. Foreign holders carry no `lane` ⇒ counted as
`background` (documented).

## Layered invariants, bounded loops, complexity (round-3 review)

**End-to-end layer invariant (codex round-3).** There are two lane-aware layers;
their roles are distinct and must not be conflated:
- **Waiter admission (§B)** controls ONLY memory pressure (how many `evaluate`
  calls may hold prompt state + poll at once). It never decides spawn count.
- **Holder acquisition (§C)** is the AUTHORITATIVE control for spawn count and
  reserve semantics (`liveTotal < N` is the OOM floor; `Ri/Rb` the reserves).

So an interactive call can pass waiter admission yet still (correctly) fail to
acquire when `Rb` is protecting background slots — that is the reserve doing its
job, not a bug. The two layers compose: waiter admission gates entry, holder
acquisition gates the spawn.

**Bounded loops retain their existing brakes (conformance flag).** The change
introduces NO new loop. The bounded-ingress poll keeps its existing brakes
unchanged: the per-call `acquireMs` budget (default 5s) caps total poll time and
the (now lane-partitioned) `waitersMax` caps concurrent pollers — on either, the
call sheds with the typed `LlmCapacityUnavailableError`. The ~100ms poll is the
foundation's, not new here.

**Operator-inbound burst bound (codex round-3).** The operator channel is not
strictly one-call-at-a-time — webhook relays, mobile retries, bridge bots, and
reconnect replay can briefly burst inbound classify calls. This is bounded, not
unbounded: (a) the existing inbound dedup/queue collapses duplicate deliveries
upstream of the gate; (b) even an un-deduped burst is capped at the interactive
lane's `interactiveWaiters` (4) + `Ri` (2) — beyond that it degrades to the SAME
fair race as today (never worse than the pre-feature baseline), and the `Rb`
background floor is untouched. A dedicated per-source inbound rate-guard is a
tracked refinement, not required for F5. <!-- tracked: topic-28744 F5-followup operator-inbound-rateguard -->

**Acknowledged complexity (gemini round-3).** This adds configuration (`ri`/`rb`)
and lane logic to a critical safety component — a real, intentional cost. It is
the minimal safety-preserving step for F5; the longer-term simplification is to
unify spawn-capping and pacing onto a single priority queue, which would retire
both this lane logic AND `LlmQueue`'s separate lanes. That unification is the
recommended next investment (tracked: `topic-28744 F5-followup unify-llm-queues`)
— this spec deliberately does not attempt it inline.

## Cross-machine posture (instar-dev Phase-4 Q7)

**Host-local BY DESIGN.** The cap is per-HOST (the holders file is host-local,
never synced — the fork-bomb is a per-host OOM hazard). The lane rides inside
that host-local file; no replication, no proxied read, no cross-host coupling. A
multi-machine agent runs one independent cap+priority per host, which is correct.
On a misconfigured shared-volume holders file (the pre-existing refuse-loud
hazard) lane reservation is best-effort only — consistent with the existing cap's
stance there.

## Signal vs authority (instar-dev Phase-4 Q4)

The change subdivides EXISTING authority (the cap already blocks spawns) by a
lane; it adds no new brittle blocking logic — the predicate is pure integer
counting over the holder set, the same shape as today's `liveHolders < cap`. The
interactive signal is an explicit caller-set field **hardened by a code
allowlist + lint**, not a heuristic classifier. Complies with
docs/signal-vs-authority.md.

## House-standard obligations (in scope — not deferred)

- **Migration Parity:** the `interactivePriority` block (`ri`/`rb`; `enabled`
  omitted by design for the dev-gate) is added to `migrateConfig()` with
  existence checks so deployed agents receive the defaults on update.
- **Agent Awareness:** the `/spawn-limiter` new fields are reflected in the
  CapabilityIndex/CLAUDE.md template note for the spawn-limiter capability (the
  status surface gains lane/effectiveness fields).

## Scope decision (no orphan deferrals)

- **In scope:** the lane signal + allowlist + lint; lane-aware ingress (§B); the
  reserved-headroom mechanism + same-snapshot counting; the clamp algorithm; the
  schema migration + under-count safety rules; the config + flag; the
  `/spawn-limiter` retention + effectiveness counters + loud shed event;
  migrateConfig + Agent-Awareness; the full test matrix.
- **Preemption** (killing an in-flight background subprocess to free a slot) is
  **deliberately out of this design**, not deferred WIP: reservation fully solves
  the postmortem (an operator reply always has headroom), and preempting a
  subprocess on the *fork-bomb safety floor* carries cleanup/blast-radius risk a
  v1 must not take. If a future workload shows reserved headroom insufficient
  (surfaced by `interactiveShedTotal` > 0 under load), preemption is a separate
  spec. <!-- tracked: topic-28744 F5-followup preemption -->

## Tests (all three tiers)

- **Unit (`hostSpawnSemaphore-priority.test.ts`):**
  - interactive admitted when background fills the contended band but interactive
    reserve is free; background refused at `N − Ri` even with total slots free;
  - symmetric: background reserve protected against an interactive flood;
  - **prune frees interactive headroom**: a stale interactive holder (pid dead +
    heartbeat past `HOLDER_STALE_MS`) is pruned and a subsequent interactive
    acquire succeeds against the freed reserve (same-snapshot invariant);
  - **under-count safety**: a record with garbage `lane` is NOT dropped and
    counts as background (OOM floor preserved);
  - clamp: `ri+rb ≥ N`, `NaN`, negative, `ri:0`, and `N=1`/`N=2` (env-shrunk via
    `INSTAR_HOST_SPAWN_MAX`) all yield valid `Ri/Rb` and never zero the cap;
  - `enabled:false` (and non-`true` garbage) → lane ignored, no `lane` written,
    byte-identical file.
- **Unit (`SpawnCapIntelligenceProvider`):**
  - allowlist enforcement: `MessagingToneGate`+synchronousReply → interactive;
    CoherenceReviewer tagged `interactive` → downgraded to background; absent lane
    → background;
  - **lane-aware ingress regression (B)**: `(waitersMax − interactiveWaiters)`
    background pollers + free interactive reserve ⇒ interactive `evaluate`
    acquires (no `waiters-full`); AND total concurrent pollers never exceed
    `waitersMax` (carve-out, not additive);
  - a genuinely saturated interactive call still throws the typed shed (fails
    closed) AND increments `interactiveShedTotalLocal` + emits a COALESCED
    DegradationReporter event (≤ one per cooldown window, carrying the count).
- **Wiring-integrity (Testing Integrity Standard — round-2 conformance flag):**
  the priority deps injected into `SpawnCapIntelligenceProvider` /
  `configureHostSpawnSemaphore` are not null and not no-ops — with the flag ON,
  `acquire` actually consults `Ri/Rb` (a wiring test that a background acquire is
  refused at `N − Ri` proves the injected reserve is live, not a stub); with the
  flag OFF, the same path is byte-identical to all-or-nothing.
- **Integration:** under a saturated cap, a tagged-interactive `evaluate`
  acquires while background `evaluate`s shed; flag off ⇒ both shed identically.
- **E2E (alive):** the priority config is read at boot; `/spawn-limiter` returns
  200 with the existing fields PLUS the new lane gauges + effectiveness counters
  wired (not 503).
