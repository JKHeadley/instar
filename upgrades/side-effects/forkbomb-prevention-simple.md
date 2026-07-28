# Side-Effects Review — fork-bomb prevention (SIMPLE): host-wide spawn cap + single-instance lock + bounded ingress

**Slug:** `forkbomb-prevention-simple` · **Tier:** 2 (converged + approved spec —
`docs/specs/forkbomb-prevention-simple.md`, cross-model + lessons-aware convergence at
`docs/specs/reports/forkbomb-prevention-simple-convergence.md`). Parent principles:
**Structure beats Willpower** (a hard ceiling enforced in code, not a "don't spawn too much"
note) and **Bounded Blast Radius** (the new constitutional standard this PR lands — safety
must be physical/capacity-bounded, not only semantic). This is the SEV-1 fix for the
2026-06-20 host-OOM incident: the Instar server fork-bombed its macOS host into OOM **twice**
(~230–289 concurrent `claude -p`, ≈ 90–115 GB) because `IntelligenceProvider.evaluate()`
spawned one LLM subprocess per call with **zero** concurrency control, `CoherenceGate` fanned
~10 reviewers in parallel per message, and up to three server instances each re-flooded.

This is the deliberately SIMPLE redesign — three primitives, ON by default. It SUPERSEDES the
earlier elaborate predecessor (`docs/specs/forkbomb-prevention.md`): the lanes / reserve-math /
hysteresis / per-gate-typed-shed of that design are explicitly OUT of scope. The cap caps the
unbounded LLM-subprocess spawns that directly produced the real crash-loop.

## Summary of the change — the 3 primitives + the 4 fail-closed seams

**P1 — Host-wide concurrent-spawn cap (the PRIMARY control).** A host-local counting semaphore
(`src/core/hostSpawnSemaphore.ts`) bounds how many LLM subprocesses run **at once** across every
compliant Instar process on the host (default **8**). Holder-SET model: it counts live holder
records under an exclusive `O_CREAT|O_EXCL` flock (reusing the `ProjectRoundLock` primitive), not
decrement/increment counter math, so it is crash-safe by construction — a double-release is a
no-op, pid-reuse can't steal a slot, a partial write is discarded. A crashed holder is reclaimed
only when pid-dead AND heartbeat-stale **on this host**; a foreign-hostname holder is NEVER
reclaimed (refuse-loud), and a `df -P` host-local-disk check gates reclaim (fail-closed). The cap
is enforced by a per-`evaluate()` **wrapper provider** (`src/core/SpawnCapIntelligenceProvider.ts`)
installed at **every** return arm of `buildIntelligenceProvider`, INSIDE the circuit-breaker wrap —
so `CoherenceGate`'s shared-instance fan-out (one `intelligence` field fanned ~10-wide via
`Promise.allSettled`) is bound per call. `reflect.ts`'s former raw-fallback construction is routed
through the same factory funnel.

**P2 — Single-instance lock (`src/core/SingleInstanceLock.ts`).** Refuses a duplicate server
instance of the same agent on a host (the 3× launchd/fleet/tmux multiplier that made the flood
worse), via the same O_CREAT|O_EXCL pid+hostname+heartbeat holder record. Foreign-host locks are
never reclaimed; release runs via `finally` + SIGTERM/SIGINT/exit handlers; a bounded deploy-handoff
grace lets a normal restart hand off cleanly; `INSTAR_ALLOW_SECOND_INSTANCE=1` overrides for a
deliberate second instance. A genuine duplicate refuses-loud rather than starting a second flooder.

**P3 — Bounded ingress + 4 fail-CLOSED gate seams.** A saturated cap makes a spawn request
poll-retry every ~100 ms up to `acquireMs` (default 5000 ms) — poll-retry, NOT an in-memory waiter
queue, so no per-waiter heap growth — bounded by a concurrent-poller ceiling (`waitersMax`, default
64). On genuine exhaustion the call throws a typed `LlmCapacityUnavailableError`
(`isCapacityUnavailable`). The **four safety-gating seams** fail CLOSED on that shed instead of
auto-passing:
1. `MessageSentinel.classify` → held, NOT `category:'normal'`.
2. `InputGuard.reviewTopicCoherence` → flagged `suspicious`, NOT `verdict:'coherent'`.
3. `MessagingToneGate.review` → records unavailable, holds `pass:false`.
4. the OUTBOUND `CoherenceGate` reviewer path → block-the-turn `pass:false`, NOT `pass:true`.

A non-gating (background) call sheds to its existing heuristic path — loud + counted, **never
silent**. The deterministic emergency-stop keyword pre-check runs BEFORE the LLM classifier and is
EXEMPT from the cap — a "stop everything" halt is never gated on capacity.

**Safety-floor posture + observability.** The cap is read with a plain `?? default` (NOT a dev gate)
— it ships **ON by default for every agent**, tunable via `intelligence.spawnCap`
(`maxConcurrent`/`acquireMs`/`waitersMax`) or env (`INSTAR_HOST_SPAWN_MAX`, `INSTAR_SPAWN_ACQUIRE_MS`,
`INSTAR_SPAWN_WAITERS_MAX`), migrated existence-checked. A new `GET /spawn-limiter` route reports
live holder count, cap, available slots, saturation, and waiters. A conservative OS-level
`NumberOfProcesses` ceiling (512) is added to the launchd plist as a host-global belt under the
semaphore. The **"Bounded Blast Radius"** constitutional standard lands in
`docs/STANDARDS-REGISTRY.md` with its lint + burst-invariant ratchet in the same PR.

## 1. Correctness / behavioral equivalence

The wrapper is a pure pass-through except for the acquire/release bracket: `evaluate()` acquires a
host slot, calls `inner.evaluate()`, releases in `finally`. When a slot is available (the normal,
unsaturated case — ≤8 concurrent) behavior is byte-identical to before; the cap only changes
behavior under genuine saturation, where the four gating seams hold (the safe direction) and
background calls degrade to their existing heuristics. The breaker-INSIDE ordering (breaker →
spawn-cap → provider) ensures a breaker-open shed never holds a slot. Emergency-stop is unchanged:
it is classified by the deterministic fast-path before any LLM call. Verified: the four fail-closed
seams are asserted (a capacity shed does NOT produce `normal`/`coherent`/`pass:true`) while a generic
LLM error still fails open — proving capacity is the ONLY new hold.

## 2. Concurrency / multi-process safety

The semaphore is the load-bearing concurrency primitive. The burst-invariant ratchet
(`tests/unit/host-spawn-semaphore-burst-invariant.test.ts`) churns 10,000 acquire/release attempts
and asserts live holders NEVER exceed the cap (the standing Bounded-Accumulation proof that the OOM
vector cannot recur), and a TRUE multi-process test forks 12 OS processes racing for 3 slots and
observes ≤3 successes — the cross-process flock holds the cap. Every mutation is under the exclusive
flock; the holder-SET model makes double-release / pid-reuse / partial-write all safe by
construction. The single-instance lock uses the same flock primitive with the same foreign-host /
host-local-disk guards.

## 3. Fail-safe / fail-closed

Two deliberately opposite directions, both safe:
- **Gating calls fail CLOSED** under capacity shed (hold the inbound/outbound turn) — a security/
  coherence gate must never auto-pass when it could not actually evaluate.
- **Background (non-gating) calls fail OPEN to their heuristic** — loud + counted, never silent
  (each is tagged `@silent-fallback-ok` only where genuinely fail-safe; the `no-silent-llm-fallback`
  + `no-silent-fallbacks` ratchets stay green).
- Reclaim is fail-closed: a foreign-hostname holder is never reclaimed; a `df -P` non-host-local-disk
  result refuses reclaim. Uncertainty never frees a slot it shouldn't.

## 4. Blast radius

New: 3 source modules (`hostSpawnSemaphore`, `SpawnCapIntelligenceProvider`, `SingleInstanceLock`),
1 lint, 1 route (`GET /spawn-limiter`). Touched: the factory funnel + `reflect.ts` (route the raw
fallback), `server.ts` boot (configure semaphore + acquire/release the instance lock), the four gate
seams, `types.ts` + `ConfigDefaults.ts` (the `spawnCap` config), `routes.ts` + `CapabilityIndex.ts`
(the route), `setup.ts` (launchd belt), `STANDARDS-REGISTRY.md` (the standard),
`templates.ts` + `PostUpdateMigrator.ts` (CLAUDE.md awareness), `package.json` + the destructive-lint
allowlist (wire the new lint). No schema change, no write-path semantics change beyond the
acquire/release bracket. The cap is ON by default — this is intentional (a SAFETY FLOOR), and the
unsaturated path is behavior-preserving.

## 5. On-by-default justification

This is a safety floor, not a feature behind a dev gate. The 2026-06-20 incident was a full host OOM
×2; the failure mode the cap prevents is catastrophic and physical. Reading the cap with `?? default`
(default 8) means every agent — new and updated — gets the protection without opting in. The default
of 8 is conservative (well below the ~230+ that OOM'd a 128 GB box) yet ample for normal CoherenceGate
fan-out; it is fully tunable for a larger host. Migration is existence-checked so an operator's
explicit override is never clobbered.

## 6. Residual (tracked, NOT fixed here — out of scope)

- The elaborate predecessor's lanes / reserve-math / hysteresis / per-gate-typed-shed are
  deliberately deferred — the simple design was chosen precisely because it is implementable
  CORRECTLY in one pass. If real load data later shows the single global cap is too coarse, the lane
  model is the documented follow-up.
- The launchd `NumberOfProcesses` belt is macOS-only; a Linux/systemd equivalent is a follow-up for
  non-macOS hosts (the in-process semaphore is OS-agnostic and is the primary control regardless).
- No baseline JSON for the new lint — it ships clean (zero violations), so a baseline would be an
  empty no-op (the sibling `lint-no-unfunneled-headless-launch.js` has none either).

## 7. Rollback

Revert the source files. The semaphore/lock/wrapper are additive; reverting the factory-funnel wrap +
the `server.ts` boot lines restores the prior unbounded-spawn behavior, and reverting the four gate
seams restores their prior fail-open. No data migration and no on-disk format to undo — the
host-spawn-holders / single-instance-lock files are host-local runtime state that is simply abandoned
on revert. The config defaults are additive and harmless if left in place.
