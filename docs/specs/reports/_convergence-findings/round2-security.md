# Round 2 — Security convergence check (provider-fallback-default-policy)

Scope: (1) verify the round-1 SECURITY resolution M5 (§4.4 boot-snapshot operator-set
detection) is sound + implementable; (2) find any NEW material security issue the rewrite
INTRODUCED, especially §4.5's new per-attempt swap timeout. Grounded in
`src/core/IntelligenceRouter.ts`, `src/commands/server.ts` (router construction ~4687 +
the CartographerSweep auto-vivify ~11266), `src/core/Config.ts` (the file→config load),
`src/server/outboundGateBudget.ts` (the existing race precedent), and
`src/core/uncaughtExceptionPolicy.ts` (the process-level rejection policy).

## M5 verification — operator-set detection (§4.4): SOUND, with one implementability caveat

- The mechanism holds against the codebase. The ONLY runtime mutator of
  `config.sessions.componentFrameworks` in the entire tree is the CartographerSweep
  auto-vivify at `server.ts:11266-11268` (`sessions ??= {}; componentFrameworks ??= {};
  overrides.CartographerSweep = …`). That site runs at ~line 11266, well AFTER the router
  construction at ~line 4687. A boot snapshot of "operator-set" taken AT the construction
  site therefore observes the genuine operator value before any mutator can vivify it.
  Verified by grep: no other assignment to `componentFrameworks` exists anywhere in `src/`.
- The §4.1 `job`-exclusion further de-fangs the contention (the default no longer writes the
  slot CartographerSweep targets), exactly as §4.4 claims.

- **[minor] §4.4's "RAW on-disk config value" phrasing is imprecise and could mislead the
  implementer.** `loadConfig()` (`Config.ts:864-867`) copies `componentFrameworks` from the
  parsed file **by reference** into `config.sessions.componentFrameworks` and does NOT retain
  a separate raw `fileConfig` object the construction site can reach. So at line 4687 the
  ONLY available value is the already-processed `config.sessions.componentFrameworks` — which
  is correct to snapshot, but it is "the in-memory config object *before any mutator runs*",
  not a re-read of the file. The load-bearing guarantee is an **ordering** one (snapshot
  before line 11266), not a "read the file" one. If an implementer takes "RAW on-disk value"
  literally and re-reads the file at a LATER point (e.g. inside `resolveConfig`), they
  re-introduce the coupling M5 exists to kill. **Resolution:** restate §4.4 as "snapshot
  `operatorSetComponentFrameworks = config.sessions?.componentFrameworks !== undefined`
  ONCE, at the router construction site (`server.ts` ~4687), which provably precedes the only
  in-memory mutator (CartographerSweep, ~11266)" — an ordering contract, not a file re-read.
  This is documentation precision, not a design change; the mechanism itself is sound.

## NEW material issue introduced by §4.5 (per-attempt swap timeout)

- **[material] §4.5's timeout race orphans the abandoned `tp.evaluate()` promise, whose later
  rejection can CRASH the server under the fail-toward-crash unhandledRejection policy.** JS
  has no promise cancellation: when the per-attempt timeout wins the `Promise.race`, the
  underlying `tp.evaluate()` keeps running and, if it later REJECTS (a provider error arriving
  after the cap — the single most likely outcome of the slow-provider scenario §4.5 targets),
  that rejection is unhandled. `server.ts:17535` routes every `unhandledRejection` to
  `handleProcessLevelError` → `uncaughtExceptionPolicy.ts`, whose default is **fatal →
  `process.exit(1)`** for any message NOT in the `NON_FATAL_UNCAUGHT_PATTERNS` allowlist
  (line 174). The allowlist covers raw network strings (`fetch failed`, `ECONNRESET`, …) but
  NOT the error shapes the CLI-based off-Claude providers actually throw — subprocess
  exit-code errors, `LlmCircuitOpenError`, custom rate-limit messages, JSON-parse failures.
  So an orphaned codex/gemini/pi rejection arriving after the cap is classified FATAL and
  takes the whole server down. The existing race precedent that §4.5 implicitly leans on
  (`outboundGateBudget.ts`) is safe ONLY because its raced promise (`MessagingToneGate.review`)
  is documented never-rejecting/fail-open — `tp.evaluate()` has no such guarantee. Worse, the
  timeout fires PRECISELY during a provider outage (slow == struggling), so §4.5 systematically
  manufactures orphaned-rejection-during-outage events — the exact failure class the policy
  comment at `uncaughtExceptionPolicy.ts:63-67` records as "the 2026-06-15
  crash-during-API-instability (an uncaught `fetch failed` took the server down mid-outage)."
  This converts a recoverable provider stall into a server kill — strictly worse than the
  stall §4.5 exists to fix. **Resolution:** §4.5 MUST mandate that the abandoned evaluate
  promise gets a `.catch()` attached the instant the timeout wins (swallow-and-log, never let
  it escape), AND that the per-attempt timer is `unref()`'d (mirror `outboundGateBudget.ts:38-43`
  so a pending cap timer can't keep the process alive). Add an explicit unit test: "a swap
  target that times out and THEN rejects produces NO unhandledRejection." Without the mandated
  `.catch`, this change can crash the agent mid-outage.

## Secondary observations (not blockers)

- **[minor] §4.5's per-attempt timeout does not trip the abandoned provider's circuit
  breaker, so a chronically-slow primary keeps being re-selected and re-eats the cap every
  call.** A timeout is not an error the breaker sees (`IntelligenceRouter.ts` has no
  latency-trip; round-1 M1 explicitly deferred latency-based tripping to the per-attempt cap).
  Net: the cap bounds a SINGLE call's latency but never removes a slow primary from rotation,
  so steady-state latency stays at cap×chain-length per gating call during a slow-provider
  episode. Acceptable for this spec (it does bound each call), but should be named as a known
  residual so it is not mistaken for "the slow provider is removed." **Resolution:** add one
  line to §4.5 acknowledging the cap bounds per-call latency but does not evict a slow primary
  (a latency-based breaker trip is the deferred follow-up from M1).

- **[minor] §4.5 can hold multiple in-flight provider calls for ONE gating decision.** Because
  each abandoned-but-uncancelled `tp.evaluate()` keeps running while the loop advances, a
  slow chain can have attempts N, N+1, N+2 executing concurrently for the same decision —
  cost/load amplification (each still bills tokens) during exactly the outage window. Not a
  security leak (no credential crosses, no state corruption — evaluate is pure
  request/response), and bounded by chain length, but worth a sentence so the cost is a known
  trade, not a surprise. **Resolution:** note in §4.5 that abandoned attempts continue in the
  background (uncancellable) and may briefly run in parallel; this is the accepted cost of a
  non-cancellable race and is bounded by the active-tail length.

## On the gating-caller budget claim (§4.5 / §6.3)

- Confirmed by grep: of the gating callers §6.3 names, ONLY `MessagingToneGate` wraps its
  evaluate in an overall budget (`reviewWithinBudget`). `MessageSentinel`,
  `ExternalOperationGate`, `InputGuard`, and `RelationshipAnomalyScorer` impose NO own
  timeout — so for them the per-attempt cap × chain-length IS the only ceiling, exactly as
  §4.5 already states ("where a caller has none, the per-attempt cap × chain-length is the
  ceiling"). Not a new defect — the spec scoped this correctly. It only RAISES the stakes on
  the orphaned-rejection fix above: these callers now each spawn potentially-orphaned provider
  calls on every swap, so the mandated `.catch` is load-bearing for them, not optional.
