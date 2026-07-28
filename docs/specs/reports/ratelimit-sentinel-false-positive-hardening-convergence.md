# Convergence Report — RateLimitSentinel False-Positive Hardening

## Cross-model review: codex-cli:gpt-5.5

A real GPT-5.5 external pass (via the agent's own `codex` CLI) ran in **every** round (4/4), and a
Gemini-2.5-Pro external pass ran CLEAN in round 1. Gemini degraded (timeout under load) in rounds 2/4 —
recorded honestly — but a genuine non-Claude opinion landed in every round, so the spec received real
cross-model review. Codex's findings drove material design changes (see Original vs Converged).

## ELI10 Overview

Echo (this agent) watches its own Claude Code sessions and tries to rescue any that die on a real
Anthropic API error — it nudges them to continue and escalates to the user if they stay dead. Justin
noticed the rescue alarm firing when nothing was wrong. Investigation proved him right: across several
debugging sessions, the "API error" detector fired with **no real API error**, and then nagged for ~11
minutes while the session was visibly alive and working.

Two flaws stacked up. First, the detector decided "this turn died on an API error" by scanning the
terminal for words like `API Error:` or `fetch failed` — but those words were on screen because the
session was literally *investigating* API errors, and because a "message queued" note contained
`fetch failed`. It matched the word, not the event. Second, the "did it recover?" check looked for the
session's transcript file in only one folder (`~/.claude`), but Echo runs sessions across several
account folders to spread out usage — so it could never find the transcript, concluded "never
recovered," and escalated blind.

The fix makes the detector require corroboration (the error must be the last *meaningful* thing on a
*frozen* screen — a working session constantly animates, so a frozen screen is the real "turn ended"
signal), and makes the verifier look in the session's *own* account folder (which Echo already knows,
because it chose it at launch). Crucially, an alive/animating screen is never counted as a failure —
only a screen that is BOTH frozen AND still showing the error escalates. Two default-on kill-switches
ship as instant rollback levers. Genuinely-stuck sessions are still caught; the false alarms stop.

## Original vs Converged

The original draft had the right diagnosis but two dangerous fixes that the review caught:

1. **"Pane moved ⇒ recovered" would have re-created the bug.** The first draft treated any terminal
   change as recovery. Both the security reviewer and the lessons-aware reviewer flagged this as a
   **blocker**: a stuck-but-animating pane (spinner, elapsed timer) "moves" constantly, so this would
   have *suppressed* real escalations — and an actively-*thinking* session (exactly Justin's screenshot)
   would have looked "recovered" with no finished output. The converged design replaces it with a
   three-way verdict that mirrors the *existing, proven* `evaluateThrottleSettle` shape: only a **frozen
   pane still showing the error** escalates; an alive/animating pane is `not-yet-proven` (never a
   counted failure); recovery requires meaningful content to advance past the error.

2. **"Glob every `~/.claude*` home, newest file wins" was worse than the bug.** The scalability reviewer
   measured it: ~10,000 synchronous file-stat calls per verify tick on the server event loop. The
   security reviewer flagged it as a cross-account leak that could even adopt a *different concurrent
   session's* transcript as recovery proof. The converged design resolves from the session's **own
   account home** — persisted at spawn time (the root-cause fix both external models recommended) and
   cached as an atomic path after first resolution — with an exact-UUID-only cross-home step purely for
   pre-fix sessions. One stat, exact attribution, no leak.

The review also added: reuse of the existing `SessionRefresh` home-resolver (and fixing the identical
latent bug in `CompactionSentinel`, which the lessons-aware reviewer caught); two default-on kill
switches; reason-coded observability; all three test tiers plus wiring-integrity; an explicit
local-only multi-machine posture; and a documented future direction (structured spawn-emitted events as
the eventual replacement for terminal-scraping inference).

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes | Conformance gate |
|-----------|-----------------------|-------------------|--------------|------------------|
| 1 | security, scalability, decision/lessons, codex; gemini CLEAN | 2 blockers + ~12 should-fix | Full rewrite: account-home verifier, three-way pane fallback, shared resolver, CompactionSentinel in scope, observability, 3-tier tests | ran (2 flags) |
| 2 | codex; conformance (E2E, Signal-vs-Authority) | 7 refinements | FD4 grace state for alive panes; FD1 chrome-normalized settle; spawn-time configHome; reason-coded obs; late-transcript test; signal-only lever clarification | ran (2 flags) |
| 3 | codex, gemini (complexity) | 6 clarifications | Widen tail 3→8; anchor chrome regexes; envelope-cap outcome; reframe FD3 (atomic primary + deprecated ladder); future-IPC note | ran (0 flags) |
| 4 | codex (internal consistency) | 5 consistency fixes | Goal#2↔FD4 reconcile; meaningfulTail n=8; counter semantics; configHome schema/restore; raw-tail retention | ran (0 flags) |
| 5 | (converged) | 0 material | none | ran (0 flags) |

## Full Findings Catalog

**Iteration 1 (blockers):**
- *[BLOCKER, security + lessons-aware]* Pane-movement-as-recovery contradicts the frozen=stuck lesson and fails open on an animating stuck pane. → Replaced with three-way verdict (recovered / still-stuck / not-yet-proven); only frozen-AND-erroring escalates.
- *[BLOCKER, scalability]* Multi-home glob = ~10k sync `statSync` per verify tick on the event loop. → Account-home resolution (one dir), per-session path cache, one stat per verify; cross-home enumeration TTL-cached + dirs-only.

**Iteration 1 (should-fix):** cross-home newest-wins adopts a foreign session's transcript (→ exact-UUID-only cross-home); `$HOME` wildcard crosses agent/account boundaries (→ scoped to session's own account home, basename-relativized logging); `errorTerminatedTurn` 3-line window as chrome-fragile as the throttle window that needed 20→45 (→ settle-corroboration + widened to 8); reuse the existing `SessionRefresh` multi-home resolver and fix the identical `CompactionSentinel` bug (→ shared `findTranscriptAcrossClaudeHomes`); add observability metrics; require all three test tiers + wiring-integrity; state multi-machine local-only posture; ship default-on kill-switches; define `jsonlRoot` precedence as single-home-restricting.

**Iteration 2:** FD4 must not count an alive "thinking" pane as a failed attempt (→ not-yet-proven grace state); FD1 settle must be chrome-normalized so a ticking footer doesn't suppress a real error forever; persist `configHome` at spawn (elevated from future-opt to in-scope); reason-code the suppression counter; add late-transcript re-resolution test + E2E lifecycle tier; reconcile the `idleErrorTailCorroboration` lever with Signal-vs-Authority (→ levers change signal sensitivity only; FD4 verifier independently gates escalation).

**Iteration 3:** widen terminal tail 3→8 (real errors have diagnostic trailers); anchor chrome regexes to known Claude UI shapes + negative tests; define envelope-cap terminal outcome; reframe FD3 as atomic-primary + deprecated backward-compat ladder (both externals' root-cause recommendation); note FD4 reuses the existing three-state settle shape (not over-engineering); document structured-IPC-events as the future direction.

**Iteration 4 (internal-consistency, from multi-round editing):** Goal #2 wording reconciled with FD4's `alive-unverified` outcome; `meaningfulTail` default corrected 3→8 to match FD2; explicit counter semantics (attempts increment on nudge only; wall-clock always caps); `configHome` field named (`SessionInfo`, in-memory) with stale-path/restore handling; raw unstripped tail retained for over-strip diagnosability.

## Convergence verdict

Converged at iteration 5 (no material findings; final conformance gate 0 flags; Open questions
`*(none)*`). The two round-1 blockers and all should-fixes were resolved in the rewrite; rounds 2–4 were
a strictly shrinking sequence of refinements → clarifications → internal-consistency fixes, each folded.
The design core (settle-corroborated idle-error + account-home-primary verifier + three-state pane
fallback + shared resolver covering both sentinels) has been stable since the iteration-1 rewrite. The
only remaining substantive reviewer theme — replacing terminal-scraping with structured spawn-emitted
events — is explicitly out of scope and future-tracked by mutual agreement of both external models.
Spec is ready for user review and approval.
