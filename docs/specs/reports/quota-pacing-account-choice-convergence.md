# Convergence Report — Quota pacing, step 2: account choice reads each limit window correctly

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier external pass (codex CLI, gpt-6-astra) ran in all six rounds. Gemini was not available (`gemini-not-authed`). The Anthropic clean-door read (`claude-code`, which ran on claude-opus-5-5, not the configured claude-fable-5) also ran every round; it is a second Claude read, not a cross-model opinion.

## ELI10 Overview

When Instar starts a session it has to choose which subscription account pays for it. The idea is to send work to the account whose unused allowance is about to expire, so nothing is wasted at a weekly reset. The arithmetic behind that choice had three mistakes. It mixed the five-hour limit's deadline with the weekly limit's room, so the wrong account looked urgent. It ignored the separate Fable limit. And it kept judging an account by last week's number after its week had already reset.

This step gives both of Instar's account pickers one shared rule. That includes the default picker, which most sessions go through and which never looked at deadlines at all. The weekly deadline drives urgency, the Fable limit counts for Fable sessions (and can never leave a session with no account), and any limit we haven't freshly read counts as "not yet checked" instead of "empty" or "last week's number". An account like that is used only when nothing with a real reading qualifies, and it asks for a fresh reading straight away.

It starts on Echo's own machines only, behind a switch. Every placement is logged with what the old rule would have picked, and after two weekly resets per account a review decides whether it goes to every agent. The main tradeoff is more states to reason about (seven per window) in exchange for never treating an unread account as free room.

## Original vs Converged

- **Originally**, an account whose reset time had passed was treated as 0% used. **After review**, it is "unmeasured": never counted as room, ranked below every account with a real reading, and it triggers a fresh read. Four reviewers and the constitution gate independently flagged the original as certifying capacity nobody had read.
- **Originally**, the fix only touched `selectAccount`. **After review**, it also covers `spawnAccount`, the fleet's default spawn path, which ranks by least-used and never looked at reset times. Without this the fix would have missed most sessions.
- **Originally**, any empty reset time was one thing. **After review**, the poller records where each window came from. An idle account read live (nothing running) is a real reading; a rollout-file guess is not. Otherwise idle accounts, the ones with the most spare room, would have gone to the back of the line.
- **Originally**, a Fable session with no Fable room got no account at all, which means the default login. **After review**, the Fable limit can only reorder accounts or fall back, so the never-loop invariant holds.
- **Originally**, the shadow log was one capped file with no way to join outcomes. **After review**, it holds one row per placement with its session name, a paged pool read and a summary view. Evaluation logging was dropped as unneeded.
- A burst-spreading rule was added in round 4 and dropped in round 5 as unsound (per-machine only, and it reset too early). It is listed in Left behind.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | all six lenses, codex, clean-door, gate (fit: weak) | 17 | 9 | rolled = unmeasured with tiers; spawnAccount included; caller table; isFableModel; Fable fallback; shadow dedupe; markers |
| 2 | adversarial, decisions, integration, codex, clean-door | 9 | 8 | Codex placeholder; unread vs not-offered; score = least room / soonest reset; execution rows; re-read gate; rotation |
| 3 | adversarial, decisions, integration, codex, clean-door, gate (7 flags) | 6 | 6 | windowBasis (idle vs rolled-history); breaker; 5-hour grace; shared freshness; pool summary + paging |
| 4 | decisions, codex, clean-door, gate (3 flags) | 4 | 8 | resetsAtBeforeRewrite; Codex idle premise as judgment-candidate; score labelled heuristic; burst rule added |
| 5 | adversarial, integration, decisions, codex, clean-door | 5 | 5 | burst rule dropped; synthesized measuredAt; per-window classification; spawnAccount both tiers |
| 6 (cap) | codex (2 consistency), clean-door (2) ; internal lenses: none | 4 | 6 | idle/valid predicate wording; stale-tier ordering; evaluation rows dropped; old-cycle uses resetsAtBeforeRewrite |

Standards-Conformance Gate: ran every round (round 1: 0 flags, fit weak; round 2: unavailable, request returned an empty body; round 3: 7 flags; round 4: 3 flags; round 6: 4 flags, all on reused existing limits or caps, recorded as judgment-candidates). Internal reviewers ran on claude-opus-5-5 subagents in all rounds.

## Proportion

Tier 2 (changes placement for every spawn on the gated machines): 244-line spec, 6 rounds used of 6. ⚠ That is high for a ranking fix. The rounds kept finding real interactions with poller encodings (Codex and Claude empty-reset forms) that the first draft did not know about.

## Left behind

- Fable awareness for swaps of running sessions (no per-session model input in the swap paths; cheap later step since session records store a model).
- Mid-session `/model` changes are not seen by placement.
- Spreading a burst across accounts between readings (clean-door round 6 asked again; accepted: today's picker bunches the same way, the 5-hour soft line and wall rescue catch it, and the review counts default-path 5-hour walls separately).
- `spawnAccount()` returns no account when every reading is stale (existing gap, unchanged).
- A fleet observe-only mode, for the fleet-rung review to decide.
- Logging throttle and monitor evaluations (dropped; the review reads placement outcomes).
- Gate flags on the existing 90% line, the 60-minute freshness and the 0.25-hour clamp: these are reused unchanged and keep their existing classifications.
- `isFresh` does not know about synthesized times; harmless, because such an account can only land in the unmeasured tier.
- Precision items: name the spawn limit that bounds shadow rows; how often the day-roll summary is rebuilt; the never-loop wording around `spawnAccount`.

## Full Findings Catalog

Round-by-round reviewer outputs are kept in the convergence scratch directory for this session. The summary of design findings and their resolutions is in Original vs Converged and the Iteration Summary above. Each finding was resolved by a spec edit committed on branch `echo/quota-pacing-step2-account-choice`; the commit messages name the round.

## Convergence verdict

Converged at round 6, the cap. In the final round all three internal reviewers (security/adversarial, scalability/integration, decision-completeness/lessons) reported no design findings. The two outside passes raised four items. Two were consistency contradictions in the wording, fixed in place. Two were accepted: burst spreading (Left behind, with the reason above) and the shadow log's size (cut by dropping evaluation rows). None of the accepted items is about safety, security or data loss. Final counts: 12 frontloaded decisions, 15 classified decision rows, 0 cheap-to-change tags, 15 contested and cleared, 0 open user decisions.
