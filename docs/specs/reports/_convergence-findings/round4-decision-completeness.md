# Round 4 (FINAL) — Decision-Completeness Convergence Check

**Spec:** `docs/specs/provider-fallback-default-policy.md` (rounds 1–3 folded in)
**Lens:** Decision-Completeness (Autonomy Principle 2). Structural convergence criterion =
ZERO live user-decisions parked.
**Scope (per directive):** verify (1) `## Open questions` still *(none)* + zero parked
user-decisions; (2) whether the round-3 edits (§4.5 Promise.race/timeoutMs, §4.6 live-read
+layer, swapAttemptTimeoutMs inline default) introduced any NEW decision that must be
frontloaded — all should be type-B engineering choices; (3) confirm final counts unchanged:
frontloaded=4, cheap-tags=0, contested-cleared=1.
**Grounding read this round:** full spec §4.5/§4.6/Frontloaded/Open; `src/core/IntelligenceRouter.ts`;
`src/core/CircuitBreakingIntelligenceProvider.ts` (`acquireOrWait`/`rateLimitWaitMs` :184-198);
`src/core/InputGuard.ts` (`Promise.race` :320 — the cited precedent); `src/core/
CodexCliIntelligenceProvider.ts` + `ClaudeCliIntelligenceProvider.ts` (`execFile` + `timeoutMs`);
`src/core/CodexCliIntelligenceProvider.ts:148-149` (the `codexExecJson` inline-parse, no-migrate
precedent); `src/core/PostUpdateMigrator.ts:5525` (the pi-cli migration guard); `src/commands/
server.ts:4687` (router construction, `resolveConfig` live-read :4693) and `:11266-11267`
(CartographerSweep `componentFrameworks ??=` auto-vivify); round-3 findings.

---

## (1) Structural convergence — live user-decisions parked

- **`## Open questions` = *(none — all resolved into Frontloaded Decisions above.)*`** ✅
  Verified verbatim at spec lines 454-456. No `[decide in convergence]`, `TBD`, `???`,
  `operator must choose`, `your call`, or any park marker anywhere in the body.
- **`## Frontloaded Decisions`** present (lines 431-452), 4 items, each with a stated
  resolution + section cross-reference.
- **Live user-decisions parked: 0.** Structural criterion met.

## (2) Did the round-3 edits introduce a NEW un-frontloaded decision?

The three named round-3 additions, each classified — and each grounded against live code:

- **§4.5 `Promise.race([tp.evaluate(), timeoutPromise])` orphan-safety** → **type-B,
  correctly resolved; NOT parked.** Round-3 REPLACED the round-2 `.catch()`/`unref()`/
  `AbortSignal` mechanism (built on a mis-grounded crash premise) with the codebase's own
  shipped `Promise.race` pattern. GROUNDED: `InputGuard.ts:320` already uses
  `await Promise.race([...])` — the cited "InputGuard precedent" is real, not invented. This is
  a *simplification* that removes prescription, not a new branch a user must adjudicate. The
  "no crash hazard with `Promise.race`" claim is a correct property of the form (the race
  attaches a settlement handler to each input), so the round-2 `AbortSignal on IntelligenceOptions`
  language is correctly DROPPED (grounded: no such field exists, "it has no receiver"). **Not a
  user-decision.**

- **§4.5 subprocess kill = the providers' EXISTING `timeoutMs → SIGTERM`** → **type-B,
  correctly resolved; NOT parked.** GROUNDED: `CodexCliIntelligenceProvider.ts` and
  `ClaudeCliIntelligenceProvider.ts` both `execFile` with a `timeoutMs`. The swap loop passing a
  tight per-attempt `timeoutMs` into `tp.evaluate()`'s options reuses an existing mechanism — "no
  new engine API," as the spec states. The cap dominating the provider's inner `rateLimitWaitMs`
  (≈120s) is grounded at `CircuitBreakingIntelligenceProvider.ts:184-198` (`acquireOrWait(waitMs)`
  honors `options.rateLimitWaitMs`). This is a HARD safety requirement (the cap is what prevents
  re-creating tonight's stall), not a taste call. **Not a user-decision.**

- **§4.6 live-read + layered resolution** → **type-B, correctly resolved; NOT parked.** GROUNDED:
  the router is constructed at `commands/server.ts:4687` with `resolveConfig: () =>
  config.sessions?.componentFrameworks` (live-read, line 4693), and CartographerSweep mutates that
  same object via `s.componentFrameworks ??= {}` at `commands/server.ts:11266-11267`. The §4.6
  "layer the computed default UNDER any live in-memory override" choice is FORCED by a real
  cross-feature regression (a frozen memoized default would silently make the freshness sweep
  refuse-to-author), not chosen by preference. The boot-snapshot-decides-default-vs-operator vs
  live-read-block-contents split (§4.4 ordering contract: 4687 provably runs before 11266) is the
  *correct* resolution of a mutation-ordering constraint, not an open branch. **Not a
  user-decision.**

- **§4.5/§5 `swapAttemptTimeoutMs` inline default (`?? 5000`, no migration)** → **type-B,
  correctly resolved; NOT parked.** GROUNDED: the cited `codexExecJson` precedent is real —
  `CodexCliIntelligenceProvider.ts:148-149` reads `intelligence.codexExecJson` via an inline
  config parse, and `grep` confirms it has NO `ConfigDefaults`/`migrateConfig` entry. So "absent ⇒
  5s default, present ⇒ operator wins, no persisted block" follows an established pattern. A
  reversible internal tuning knob behind a config key, no external/published contract. **Not a
  user-decision.**

**Bonus grounding closures (round-3's own corrections, re-verified):**
- The §8 `migrateClaudeMd` marker warning "Do NOT use a marker containing the bare token `pi-cli`"
  is GROUNDED: `PostUpdateMigrator.ts:5525` guards on
  `content.includes('Per-Component Framework Routing') && !content.includes("pi-cli")` — a `pi-cli`
  token in the new marker would genuinely break that guard. Correct, real collision avoided.
- `INTERNAL_FRAMEWORK_PREFERENCE` does NOT exist in `src/` yet — correct (it is net-new code this
  spec DEFINES, §4.1, not a stale grounding claim).

**NEW un-frontloaded user-decision introduced by the round-3 edits: NONE.** Every round-3
addition is type-B (internal, reversible, no external/published contract), in-spec resolved,
fail-open/fail-closed safe, AND grounded against live code.

## (3) Final counts

- **frontloaded-decisions = 4** (Q1 active-probe, Q2 runtime-computed, Q4 `job` excluded,
  Q5 model-size preservation) — matches spec line 452.
- **cheap-to-change-after tags = 0** — confirmed; none escalated to type-A, no "cheap-to-change"
  framing in the spec.
- **contested-then-cleared = 1** (Q4 `job` exclusion — contested INCLUDE vs EXCLUDE, cleared to
  the conservative type-B EXCLUDE) — matches spec line 452.

All counts UNCHANGED from round 3.

## Verdict

**CONVERGED** on the decision-completeness lens. `## Open questions` = *(none)*; zero live
user-decisions parked; all 4 Frontloaded Decisions are genuine type-B engineering choices; the
round-3 edits (Promise.race orphan-safety, existing `timeoutMs → SIGTERM` reuse, §4.6 live-read
+layer, `swapAttemptTimeoutMs` inline default) introduced NO new un-frontloaded decision — each
is type-B, resolved in-spec, AND grounded against live code (InputGuard Promise.race precedent,
provider execFile+timeoutMs, codexExecJson inline-default precedent, server.ts construction/
auto-vivify ordering, pi-cli migration-guard collision). No grounding nits remain for the
building agent. Final counts: frontloaded = 4 · cheap-to-change = 0 · contested-then-cleared = 1.
