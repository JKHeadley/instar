# Round 4 — FINAL convergence check, Scalability / Perf lens

Scope: verify ONLY that the round-3 fixes (R3-1 live-read+layered §4.6, R3-2
Promise.race+`timeoutMs` §4.5) introduced no NEW perf issue. Grounded against
`src/core/IntelligenceRouter.ts` (live `evaluate()`/`for()` hot path),
`src/commands/server.ts:4687–4720` (router construction + `resolveConfig`),
`server.ts:11253–11267` (CartographerSweep live mutation).

## Verified SOUND — no new material

- **(1) §4.6 live-read + layering is O(1)/shallow per call, NOT a rebuild — CONFIRMED.**
  - The expensive part (the active-framework SET — boot-computed `INTERNAL_FRAMEWORK_PREFERENCE ∩ active`)
    is **memoized once at boot** by §4.6's own prescription ("memoize only the active-framework SET,
    NOT the resulting config"). It is never recomputed per call.
  - Per `evaluate()`/`for()` call, `resolveConfig()` is consumed exactly **once**
    (`IntelligenceRouter.ts:126`, `:159`). The spec's per-call work is: read the live
    `config.sessions.componentFrameworks` (today's bare 2-property access, `server.ts:4693`),
    then EITHER return it unchanged (operator-set branch → zero allocation) OR shallow-spread the
    boot-computed default UNDER any live override. The default object is a **tiny fixed shape**
    (`{ categories: {sentinel, gate, reflector}, failureSwap: [...] }` — ~4 keys), so the layering
    is a single one-level spread of a constant-size object, not a tree walk or a config rebuild.
  - Cost class is unchanged from today's bare live read: O(1), at most one tiny object allocation
    on the unset-default branch. The CartographerSweep live-override preservation (the reason
    layering exists) is a correctness fix, and it is satisfied by reading the SAME mutated object
    (`server.ts:11266–11267` writes the exact object `resolveConfig` reads), adding no scan.

- **(2) §4.5 Promise.race + `timeoutMs` is O(1) per attempt, off the hot path — CONFIRMED.**
  - The swap loop runs **only in the `catch` branch** of a **gating** call whose primary already
    failed (`IntelligenceRouter.ts:196–230`). The dominant traffic — every non-gating call and
    every gating call whose primary SUCCEEDS — never enters it, so §4.5 adds **zero** cost to the
    hot path (the happy path is still a single `await primary.evaluate()`, `:194`).
  - Per swap attempt the added work is: one `Promise.race([tp.evaluate(), timeoutPromise])` wrapper
    + one timer + setting `options.timeoutMs = swapAttemptTimeoutMs`. All constant-time per attempt;
    no per-attempt structural/allocation growth.
  - The total bound `cap × (1 + activeTail.length)` is over a **fixed-length** chain (3–4 links),
    so the swap cost is constant-bounded, not input-scaled. This is the round-3 latency guarantee
    re-confirmed under the applied Promise.race form; no regression vs the round-3 scalability pass.
  - No orphan-accumulation perf hazard: the `timeoutMs`→SIGTERM kill (round-3 R3-2) bounds the
    in-flight CLI subprocess to the cap, and Promise.race attaches a settlement handler to the
    abandoned input (no leaked unhandled promise). Resource footprint per timed-out attempt is
    bounded, not growing.

## No new hot-path cost from layering on every gating call
The layering decision (operator-set vs computed-default-under-live-override) resolves with the
same single `resolveConfig()` read already on the path; it does not add a second config read, a
config reload, or a per-call recompute. Gating vs non-gating is a single boolean check
(`options?.attribution?.gating === true`, `:190`). Nothing in the round-3 fixes converts an
O(1) per-call path into anything super-constant.

## Verdict
No new perf material. The round-3 fixes are cheap-by-construction: the costly active-set is
boot-memoized, the layering is a constant-size shallow spread, and the Promise.race/timeoutMs
cost is constant-per-attempt and confined to the already-failed gating swap branch.
