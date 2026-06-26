# Convergence Report — Verify-After Topic Reachability (F7)

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass (codex-cli) ran on every round. Gemini-cli was
attempted each round but its calls degraded (timeout) — so the external assurance is
codex's. Codex's final-round "SERIOUS ISSUES" verdict was raised SOLELY on two
stale-sentence internal contradictions (a pre-rewrite "Piece 1 (spawn timeout +
sweep)" line and a "Piece 1 fixes the wedge at source" phrase) that the independent
internal round-3 reviewer flagged identically as LOW/editorial — both fixed in the
final spec. No external design objection survives.

## ELI10 Overview

When I shut down or move one of my own work sessions, there's a narrow risk I leave
that conversation with no working path for your next message — it black-holes. That
bit us on 2026-06-25. Importantly (and the spec is honest about this), the common case
already self-heals: your next message normally just spins up a fresh session. The real
gaps are specific — a session start-up that hangs leaves a "currently starting" flag
stuck so future messages get skipped, and on a multi-machine setup a handed-off
conversation can land on a machine that can't serve it.

The fix has two parts. Part 1 makes that stuck-start-up state SAFE and OBSERVABLE
(a tagged, timestamped record) — but deliberately does NOT try to auto-clear it,
because two review rounds proved any auto-clear races a still-running start-up into
starting a *second* session. Part 2 is a pure watcher: right after I kill/move a
session, it checks the conversation is still reachable and, if not, raises one calm
"you might not be able to reach me here" alert. It never kills, moves, starts, or
clears anything — a smoke alarm, not a firefighter. The fully-automatic un-sticking
(which needs cleanly cancellable start-ups) is written down as a tracked follow-up.

The tradeoff: a genuinely hung start-up still needs a human/restart to un-stick — but
you're no longer in the dark about it, which is the whole point of the standard.

## Original vs Converged

The original design had a **dangerous self-heal**: an external actor would clear a
"stale" stuck-spawn flag. Two review rounds proved this RELOCATES the exact
double-spawn race it tried to fix — the spawn body is non-cancellable, so clearing the
flag while the body runs lets a second spawn start and the two race on session
registration / kill / inject. The converged design **removes all auto-clearing**
(no timeout-clear, no sweep) and instead **surfaces the hung state loudly** as a pure
signal, deferring the genuinely-hard cancellable-spawn auto-heal to a tracked
follow-up. It also got materially more honest and safer: the "reachable" term is
defined as admission/routing reachability (checks session-cap/quota/adapter, not just
the flag); the multi-machine trigger was corrected from a phantom "event" to a named
new tap; surfacing is NORMAL-priority + coalesced + flap-backoff-capped + pressure/
emergency-stop-aware with a re-sweep so no orphan is silently lost; and detection is
scoped to the released-no-placement slice so it doesn't double-voice with the existing
StrandedTopicSentinel / OwnershipReconciler.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1 | lessons-aware/foundation, adversarial, scalability/integration, decision-completeness, conformance | 2 blocking + ~10 material | Reframed to two-piece (source fix + pure-signal verifier), but with a timeout-clear + sweep |
| 2 | foundation (CONVERGED), adversarial (ITERATE), codex, gemini(degraded), conformance | 1 HIGH + ~5 material | HIGH: timeout RELOCATES the race (non-cancellable body). Removed timeout+sweep; "surface don't clear"; defined "reachable"; recovery-bounce post-grace verify; pressure/halt rolled-up + re-sweep; flap backoff; wiring-integrity tests |
| 3 | convergence-confirm (CONVERGED), codex (stale-text only), gemini(degraded), conformance (tracked-deferral) | 0 material (2 editorial) | Fixed the two stale-text contradictions (§E + Piece-2 intro) |

## Full Findings Catalog (condensed)

**Round 1 (blocking + material):** self-heal ABA double-spawn race [→ removed self-heal];
multi-machine trigger is not an event [→ named new tap]; attention-flood [→ NORMAL +
coalesce + topic-key]; trigger-storm [→ global cap + pressure-aware + filter
recovery-bounce]; false-reachable [→ check cap/quota/adapter, honest wedged-session
scope]; one-voice overlap [→ released-no-placement only]; closure→injectable registry
[→ named]; migration-parity + guard-manifest [→ added]; unflagged TTL risk [→ resolved
by removing the clear]; decision-completeness gaps [→ all frontloaded].
**Round 2 (HIGH + material):** timeout relocates the race [→ removed timeout, surface
instead, defer auto-heal]; backstop sweep unreachable [→ removed]; never-surfaced
orphan under pressure/halt [→ rolled-up + re-sweep]; single-flapper flood [→ backoff];
recovery-bounce blind spot [→ post-grace verify].
**Round 3 (editorial only):** two stale-text contradictions [→ fixed]; tracked deferral
of the cancellable-spawn auto-heal (legitimate — marker present, justified).

## Convergence verdict

Converged at iteration 3. The independent round-3 reviewer returned CONVERGED ("the
'surface-don't-clear' core is sound and honest, the auto-heal deferral is legitimate,
no material design hole"); the only round-3 findings were two editorial stale-sentence
contradictions, now fixed. The design's safety rests on construction: Piece 1 adds NO
new flag-clearer (the existing `.finally` remains the sole clearer, token-guarded), so
it cannot create a new double-spawn race; Piece 2 is pure signal (zero mutation). Every
black-hole slice is either covered by Piece 2 or honestly carved to a named sibling
guard with one voice preserved. Spec is ready for user review and approval.

## Open questions

*(none — all resolved; the one deferral (cancellable-spawn auto-heal) is tracked, not
an open user-decision.)*
