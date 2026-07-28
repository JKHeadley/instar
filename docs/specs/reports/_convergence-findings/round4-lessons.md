# Round 4 — Lessons-aware + Foundation lens (convergence check on round-3 edits)

Scope: verify ONLY the four round-3 deltas against instar principles, code-grounded.
All six code claims the round-3 edits rest on were re-grounded against shipped code
(file:line evidence below). NEW material only.

## Verified — no change owed

- **(1) §4.5 simplify (Promise.race + existing `timeoutMs→SIGTERM`, drop AbortSignal) — ALIGNED.**
  Grounded TRUE: the `Promise.race([evaluate(), timeoutPromise])` form is the *shipped*
  InputGuard pattern (`src/core/InputGuard.ts:320`), and a per-attempt `timeoutMs→SIGTERM`
  is wired on all four CLI providers (claude:70, codex:365, gemini:102, pi:92) flowing from
  `IntelligenceOptions.timeoutMs` (`src/core/types.ts:854`). `IntelligenceOptions` has NO
  `signal` field, so the dropped AbortSignal language genuinely had no receiver. Reusing
  shipped primitives instead of inventing a new engine API is squarely **Structure>Willpower
  + "do NOT rebuild" (§2)**: zero new surface to maintain or remember, the cap and the
  subprocess-kill collapse to ONE bound. No new principle violated. (R4-precision below.)

- **(2) §4.6 live-read+layer — HONORS No Silent Degradation + Signal-vs-Authority.**
  Grounded TRUE: CartographerSweep genuinely mutates
  `config.sessions.componentFrameworks.overrides.CartographerSweep` at runtime
  (`src/commands/server.ts:11266–11268`) AFTER the router is constructed
  (`server.ts:4687`, `resolveConfig: () => config.sessions?.componentFrameworks` read LIVE).
  A frozen memoized default would have ignored that mutation and silently flipped the
  freshness sweep to refuse-to-author on every default-policy agent — a textbook silent
  degradation. §4.6 reading live + layering the computed default UNDER the live override
  FIXES that silent regression rather than introducing one. The boot-snapshot still decides
  only default-vs-operator (authority of the choice) while the engine reads contents live
  (signal) — Signal-vs-Authority intact. Correct.

- **(3) §6.5 Framework-Agnostic — still airtight.** The four-pronged resolution
  (operator-DIRECTED · fully overridable §4.4 · single uniform mechanism, no
  framework-specific code path · no-op on Claude-only §4.2) holds, and the order lives in
  ONE named constant `INTERNAL_FRAMEWORK_PREFERENCE`. Round-3 edits touched none of these
  four legs. A chosen/documented/overridable default is framework-OPTIMIZING, not
  framework-PRIVILEGING. Resolved-in-favor stands.

- **(4) No NEW principle contradiction from the round-3 edits.** The two round-3 changes
  REMOVED surface (deleted an unreceived AbortSignal API; replaced a frozen memo with a
  live read). Removing surface cannot introduce a Structure>Willpower or No-Silent-Degradation
  contradiction; it reduces both. The layered-read (R3-1) closes a cross-feature regression
  rather than opening one. No Migration-Parity, Agent-Awareness, or Testing-Integrity
  obligation was altered by round-3 (§5, §7, §8 unchanged in substance).

## NEW (precision only — non-blocking, not change-owed)

- **R4-precision (Claim-4 wording):** §4.5's "dominate the provider's inner `rateLimitWaitMs`
  (≈120s)" — the load-bearing claim (5s cap RACES and abandons a rate-limit-waiting attempt)
  is TRUE and correct: `CircuitBreakingIntelligenceProvider.acquireOrWait` honors
  `options.rateLimitWaitMs` (`CircuitBreakingIntelligenceProvider.ts:187`) and the
  `Promise.race` cap abandons the whole `evaluate()` at 5s regardless of that internal wait.
  The "≈120s" figure is an example value, not a constant in code (the breaker's own default
  open window is 15min, `LlmCircuitBreaker.ts:209`). The spec's mechanism is sound; the
  number is illustrative — no edit required, noted so a future reader doesn't hunt for a
  literal `120000`.
