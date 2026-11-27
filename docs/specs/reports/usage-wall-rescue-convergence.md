# Convergence Report — Usage-Wall Rescue

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier outside review (codex CLI, gpt-6-astra) ran on every one of the six rounds. Gemini was not signed in on this machine; the Claude clean-door reader was not used.

## ELI10 Overview

When a Claude subscription runs out of usage, Claude Code stops and shows "Usage limit reached". On 4 November two conversations sat stuck like that for hours, even though the agent had two other accounts with plenty of room and already knew how to move a conversation to another account. Nothing told it to.

This change adds a "usage wall" signal to the watchdog, teaches the agent which account a conversation is really on (including conversations started on the default login with no account label), moves the conversation to an account with room, labels new conversations with a good account when they start, and fixes the standby message that used to read the stuck screen as "recovered". It is one switch, on by default (the operator approved this on 4 November), and does nothing unless the agent has at least two working accounts.

The trade-off is that the agent now restarts a stuck conversation by itself. The review spent most of its effort making sure it only does that when the conversation really is stuck, never loops, never blames the wrong account, and never tells the person something untrue.

## Original vs Converged

- **Originally**, the wall text could match anywhere on a line, and one stray line after it was tolerated. **Now** the banner must open the line, nothing but Claude Code's own screen furniture may follow it, and each furniture row must match completely, so quoted or printed text does not count.
- **Originally**, an unlabelled session was blamed on whatever account the default login held now. **Now** that answer is only a candidate: it is never blamed, never recorded as full, its reading cannot veto and its reset time cannot delay the move, but it stays excluded as a target so the session can never be "moved" back onto a walled account (a loop the final verification caught); only a proven identity (label or explicit login folder) is checked against its own reading.
- **Originally**, any five unsuccessful tries tripped a day-long stop, including "no room" checks. **Now** only real failed moves count, "no room" retries every ten minutes so the session moves as soon as room appears, and errors while checking are holds, not failures.
- **Originally**, the standby could say "being moved" when no move would happen, and could repeat the "no room" message. **Now** wording comes from the same decision the move uses, speaks from the last real check of the current wall (cleared when the screen moves on), and stays quiet once the person was confirmed told.
- **Originally**, new sessions were labelled with the drain-first account, which could be nearly full or never read. **Now** they go to the account with the most room among those read successfully in the last hour.
- Added: a check that a near reset (the window actually blocking service, within 15 minutes) waits instead of restarting; a per-machine cap of 12 moves an hour, reserved right before each move and returned when nothing restarted; a coalesced quota refresh when a reading contradicts the wall; plain notices to the conversation when it cannot be moved; the legacy throttle swap routed through the same brakes.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | conformance gate (3), safety (9), decision/lessons (9), GPT (4) | 17 (deduplicated) | 4 | Corroboration, brakes, anchored patterns, truthful wording, fresh-reading tagging, funnelled throttle path, user notices |
| 2 | internal (2), GPT (5) | 6 | 1 | Shared admission for wording, explicit-home unresolved, failed-move timing, reworded no-room |
| 3 | internal (2), GPT (3) | 5 | 0 | Episode-scoped outcome, suppress duplicate notice, hourly-cap reservation, refresh on contradiction, spinner on raw lines |
| 4 | internal (1), GPT (3) | 4 | 0 | Coalesced refresh, unproven candidate not vetoed, confirmed delivery, blocking-window reset |
| 5 | GPT (3 + 1 precision) | 3 | 1 | Unknown-source semantics, whole-row chrome, check vs move failures |
| 6 (cap) | GPT (4) | 4 | 0 | Candidate never blamed in any case, shared exclusion in wording, end-anchored chrome rows, wall-cleared signal. Final verification by the internal reviewer (no seventh round, per the Tier-2 cap) caught that passing an unknown source let a session be "moved" back onto its walled default login and loop; fixed by keeping the candidate excluded as a target (never blamed), with a test. Also widened the auto-continue row to any time phrase. |

Standards-Conformance Gate: ran (3 flags) in round 1, all addressed (brakes; corroboration; convergence argument).

## Proportion

Tier 2; about 19 files, roughly 1,700 added lines including about 800 lines of tests; 6 of 6 review rounds used. ⚠ The full cap was used: each GPT round kept finding a real, narrower edge in the same two areas (which account a session is on, and what the person is told). The final round's items were fixed and verified rather than re-reviewed.

## Left behind

- Model-specific walls (for example an Opus-only weekly limit) that the 5-hour/weekly reading does not reflect read as `source-not-walled` for a labelled session and hold: today's behavior for that case. Worth a follow-up if seen in the field; feedback queue.
- The scheduler's reactive target choice stays drain-first (I6, unchanged); only spawn tagging uses most-room. Acceptable: targets are still under the soft threshold.
- More than 12 walled sessions on one machine in an hour: the rest wait for the next hour.
- An untagged session whose identity cannot be proven is moved on the banner alone; a false banner costs one restart. If its default-slot candidate is the only account with room, the session waits (the candidate stays excluded to prevent a restart loop).
- Precision (round 5): the signal-vs-authority wording was tightened to say when the pane alone authorizes a move.

## Full Findings Catalog

Round 1 (deduplicated):
1. Conformance: deterministic classifier triggers a move without corroboration → account-reading corroboration added (proven identity), refresh on contradiction.
2. Conformance: no growing back-off or breaker → doubling back-off, per-session breaker on failed moves, per-machine hourly cap.
3. Conformance: convergence assumed success clears the wall → brakes bound failure; resumed pane stops matching.
4. "Being moved" could be untrue → wording from shared admission (refined rounds 2–6).
5. No-room counted toward the breaker → only failed moves count.
6. Untagged resolution trusted the current default → candidate semantics (refined rounds 4–6).
7. Spawn tagging could pick unread/stale or nearly-full accounts → fresh reading, most room.
8. Tagging widened the proactive monitor's population → named as Frontloaded Decision 3, within the approved scope.
9. Wall text matched mid-line → anchored banner, zero session lines after it.
10. Fleet cap too small for a walled default login → 12/hour per machine.
11. Codex untagged churned the breaker → `disabled`.
12. Per-session maps never pruned → prune after 48 hours.
13. No notice when a session cannot be moved → plain direct notices.
14. Near reset should wait → `resets-soon`.
15. `autoSwapOnRateLimit:false` silently disabled the rescue → kept as an honored opt-out, surfaced as `disabledBy` (Frontloaded Decision 5).
16. Legacy throttle path bypassed brakes → same funnel.
17. Q3 baseline contradicted an older spec → baseline documented (#2246 reinstated Q3).
Round 2: shared admission for wording; explicit home without pool match is unresolved; reset-soon needs a fresh, future reset; failed-move timing separate; no-room wording no longer over-claims; stale 100% reading not "known walled".
Round 3: duplicate no-room message → "already told" result; sticky outcome → episode-scoped; hourly cap counted no-room and raced → reserved before the move, returned on no-room; healthy reading taken before the wall → coalesced refresh; retry spinner hidden by chrome filtering → checked on raw lines.
Round 4: refresh fan-out → coalesced; unproven candidate's healthy reading vetoed rescue → not for candidates; failed delivery silenced the standby → only confirmed delivery counts; reset-soon used pressured windows → blocking (exhausted) windows first.
Round 5: candidate still blamed when unhealthy → unknown source; chrome matched prose → anchored rows; check errors tripped the breaker → only swap failures count.
Round 6: candidate semantics unconditional (never blamed); wording uses the same exclusion as the move; chrome rows end-anchored; wall-cleared signal ends the episode. Final verification: an unknown-source swap could restart a session onto its own walled default login and loop (success resets the breaker) → the candidate stays excluded as a target; the auto-continue row accepts any time phrase.

## Convergence verdict

Converged at the round-6 cap. Every design finding of every round was fixed in the spec and the code; the last round's fixes were verified by the independent internal reviewer and by unit tests rather than a seventh round. No safety, security or data-loss finding remains open. Items above are left behind as accepted, bounded risks.
