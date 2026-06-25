# Side-Effects Review — Idle-Error Detection: Tail-Gated, Frame-Discriminated Signal (CMT-1785)

Spec: `docs/specs/idle-error-tailgate-corroboration.md` (converged 4 rounds, approved).
Change: replace the bare `TERMINAL_ERROR_PATTERNS.some(includes)` idle-error detector at the
`SessionManager` idle path with a tail-gated, frame-discriminated classifier (`IdleErrorClassifier`)
fed by a shared `paneTail` helper; widen the idle-error capture 30→45 rows; add a once-per-episode
structured observability record.

## 1. Over-block (what legitimate inputs does this reject that it shouldn't?)
The classifier can SUPPRESS a fire the old bare match would have made — that is the whole point —
but the risk is suppressing a GENUINE error (under-fire). Mitigated: (a) the two-tier begins-with
grammar fires on real Claude render forms (`⏺ API Error:` / `  ⎿  API Error:`), pinned by tests using
the actual captured fixtures; (b) the 45-row capture clears the input-box chrome that pushes the
error up; (c) the 20-line non-empty tail clears realistic chrome with margin; (d) a missed error
falls through to the pre-existing 15m idle-kill (slower recovery, never silent loss); (e) the
`result:'suppressed'` structured record makes a wave of real misses observable.

## 2. Under-block (what failure modes does it still miss?)
- A genuine Claude error rendered in a form that is neither `API Error:`-led nor a glyph-led
  begins-with-pattern line (unknown future render) → missed → 15m idle-kill fallback. The drift
  test fails loudly if the known render fixtures stop matching.
- A residual false-POSITIVE (accepted): a tool result rendered glyph-led whose line begins with a
  terminal token (e.g. `⎿ fetch failed`) fires. Bounded: the actuator is non-destructive (one wasted
  nudge the verify step proves a no-op). Documented in the spec §5.

## 3. Level-of-abstraction fit
Correct layer: this is a deterministic SIGNAL-emitter (Signal vs Authority), feeding the existing
`apiErrorAtIdle` → `rateLimitSentinel` recovery actuator. It gains no blocking authority. The shared
`paneTail` helper is the right home for the tail-gating logic (was being copied per consumer). The
recovery actuator it feeds is honestly named a deterministic Tier-0 non-destructive self-heal (nudge
→ verify → escalate-to-notice + zombie-kill veto; no respawn).

## 4. Signal vs authority compliance
Compliant. The classifier returns a boolean SIGNAL; the actuator decides and verifies before any
action. The match set is a strict subset of the old buffer-wide match (tail + frame ⊂ buffer-wide),
so the change is monotonic-suppressing — it can only reduce spurious actuations, never add one.

## 5. Interactions
- The `detectRateLimited` branch runs FIRST and is untouched — a server throttle still routes to
  `rateLimitedAtIdle` and never reaches the classifier (pinned by the wiring test's intent; the
  branch order is preserved). The wider 45-row capture is a no-op for `detectRateLimited` (it slices
  its own last ~20 lines).
- `errorNudgedSessions` (the nudge episode guard) is unchanged; the new `idleErrorClassified` set
  mirrors its full lifecycle (armed once/episode; cleared in BOTH the re-arm block AND
  `sessionComplete` — no leak on the session-death path).
- `StuckSignatureClassifier` migrates to the shared `liveTail` via `.join('\n')` — behavior-preserving
  (its existing 13-test corpus passes unchanged = the characterization guard).

## 6. External surfaces
None new. No HTTP route, no config, no agent-installed file, no user-facing message. The only new
output is structured `console.log` records to `logs/server.log` (operator log), once per idle episode,
credential-free (matchedPattern is a fixed token; no raw pane content is logged).

## 7. Multi-machine posture (Cross-Machine Coherence)
Machine-local BY DESIGN. The classifier reads one local tmux pane on the host running the session —
no cross-machine state, no generated URL, no replicated surface. The downstream `rateLimitSentinel`
has a Telegram-notify surface, but the change is monotonic-suppressing, so it can only REDUCE
user-facing cross-machine notices, never add one. Correct posture, declared explicitly.

## 8. Rollback cost
Single-commit revert: restore the bare `.some(includes)` gate + the 30-row capture, delete
`IdleErrorClassifier.ts` + `paneTail.ts` + tests + the `idleErrorClassified` field/clears + the
structured record, and revert the `StuckSignatureClassifier` import (behavior-preserving, mechanical).
No migration, no durable state, no config. The revert IS the immediate operator action if a future
Claude render change is ever suspected of under-firing.
