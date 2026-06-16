# Round 3 — Lessons-Aware + Foundation lens (convergence check on the rewritten spec)

Scope: verify ONLY the three asks. NEW material only (no re-statement of converged round-1/2 findings).

## The three verifications

### (1) §6.4 No-Deferrals — round-2 N3 fix landed and is SOUND ✅ (no new material)
The round-2 N3 fix (§6.4 relabeled "CALLER-HANDLED" + the `<!-- tracked: -->` note) **satisfies the No-Deferrals standard.** Grounded against live code:
- `MessagingToneGate.parseResponse` (`src/core/MessagingToneGate.ts:627`) returns `failOpen = {pass:true,...}` on a missing JSON match (`:632`) and on a non-boolean `pass` (`:635`), wrapped in an outer `try/catch` that also fail-opens (`:643`).
- `VALID_RULES` (the B1..B20 allowlist, `:60`) is enforced at `:277` — a `!parsed.pass` verdict carrying an invalid/invented rule is fail-opened with `invalidRule:true` (`:285`,`:297`).
So a malformed/low-quality answer from ANY provider (Claude included) is parsed, allowlist-validated, and safely fail-opened **at the gate** — output validation is the caller's job per *Signal vs. Authority*, not the router's. The spec changes only WHICH provider can serve a weak answer; it does not change that property. The sole residual (well-formed-but-semantically-wrong) is a pre-existing, provider-independent property of ANY LLM gate — not introduced here, correctly out-of-scope, and `<!-- tracked -->` for hygiene rather than owed. This is **not a deferral of in-scope work** (which is what No-Deferrals governs). The round-2 conformance flag is closed correctly.

### (2) §6.5 Framework-Agnostic — still airtight after the edits ✅ (no new material)
The §6.5 resolution (framework-OPTIMIZING not -privileging: operator-directed + fully overridable + single uniform mechanism + no-op on Claude-only + ONE named constant) is unchanged by the round-2 edits. The round-2 edits (N1 orphan-safety, N2 cap basis, N5/N7 probe contract) touched §4.5/§4.2/§4.4 — none of them introduce a framework-specific code path or weaken overridability. `INTERNAL_FRAMEWORK_PREFERENCE` (§4.1) remains the single inspectable order; §4.4 override-verbatim is intact; §4.2 no-op-on-Claude-only is intact. Airtight stands.

### (3) Foundation audit of the round-2 edits — NO new principle contradiction, NO repeated mistake ✅ (no new material)
Audited the two specific round-2 touches the prompt names (the orphan-safety engine touch + the AbortSignal) against the foundation:

- **Orphan-safety engine touch (§4.5 / N1) — grounded as net-NEW, not a re-touch of working code.** Verified `src/core/IntelligenceRouter.ts:192-218`: the swap loop today `await`s each `tp.evaluate()` with **zero** timeout / AbortSignal machinery (`grep AbortSignal|setTimeout|signal` over the file → no hits). So §4.5 is genuinely additive. The mandated `.catch(()=>{})` + timer-clear is the CORRECT direction vs *No Silent Degradation / fail-closed*: a timed-out attempt is treated as a failed attempt → next target → Claude tail → fail-closed if all exhausted (§4.5 last para). It does NOT convert a fail-closed outcome into a silent pass — the fail-closed re-throw at `:217` is preserved untouched. No contradiction.
  - The N1 crash-hazard reasoning is real: `src/core/uncaughtExceptionPolicy.ts` ends a non-allowlisted error at `process.exit(1)` (FATAL path verified) — so an un-swallowed orphan rejection WOULD crash mid-outage. The spec correctly flags `.catch(()=>{})` as **non-negotiable**. This is the *opposite* of a repeated mistake — it is the spec catching a fail-toward-crash hazard before build.

- **AbortSignal (§4.5) — consistent with No-Silent-Degradation; honest about the bounded orphan.** §4.5 propagates `AbortSignal` where supported and, where a provider can't cancel, runs the orphan to completion and discards the result (a bounded waste — "at most one extra in-flight CLI per timed-out swap attempt, breaker- and cap-bounded"). This is honest degradation, not silent: the waste is named, bounded, and documented; it does not pretend cancellation it can't deliver. Consistent with the *No Silent Degradation* standard (degrade visibly + bounded, never silently).
  - `rateLimitWaitMs` dominance (N2) is grounded: `CircuitBreakingIntelligenceProvider.ts:187-190` honors `acquireOrWait(waitMs)`; the 5s cap racing the whole `tp.evaluate()` abandons that inner wait — the §4.5 N2 claim holds against code. The earlier wrong "5s caller budget" / non-existent `gateTimeoutMs` were already removed in round 2; no stale residue of either remains in the §4.5 text (re-read confirms only `swapAttemptTimeoutMs` + the real `OUTBOUND_GATE_REVIEW_BUDGET_MS=20s` are cited).

- **Foundation cross-check vs the operator's own lessons:** no repeat of a known mistake.
  - *Signal vs Authority* — the router stays a signal/transport; output validation stays at the caller (§6.4). No authority creep into the router. ✓
  - *No Silent Degradation* — every swap/degrade routes `onDegrade → DegradationReporter` + `/metrics/features` (§6.6); the timeout fail-open is per-attempt and visible. ✓
  - *Framework-Agnostic* — §6.5, above. ✓
  - *No Deferrals* — §6.4, above. ✓
  - No contradiction with "Mirror decision-methods share gates" (no mirrored guard pair is touched), nor with "Quiet by default" (no new push surface added — degrade events ride the existing reporter/metrics, not a Telegram push).

## Verdict
No NEW material. All three asks verify clean against the live code. The round-2 fixes (N1 orphan-safety, N3 §6.4 relabel, N5/N6/N7/N8 precision) landed correctly and introduced no new principle contradiction. §6.4 satisfies No-Deferrals; §6.5 Framework-Agnostic remains airtight. **Converged** on the lessons-aware + foundation lens.
