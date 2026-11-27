# Convergence report — local-verify-main-on-peer

Spec: `docs/specs/local-verify-main-on-peer.md` (amends `local-verify-capacity` Part D: a peer "never verifies `main`").
Date: 2026-11-17. Author: echo. Implementation reviewed alongside the spec (same branch).

## Rounds

| # | Reviewer | Subject | Verdict | Material findings |
|---|---|---|---|---|
| 1 | Independent Claude reviewer (fresh context, code only) | implementation | did not concur | 1 medium: a peer that went silent while holding a `main` verify blocked every `main` verify for up to 60 minutes. 4 low. |
| 2 | same reviewer | implementation | concur | 4 low (two fixed, two accepted). |
| 3 | Cold Claude spec reviewer (fresh context) | spec + diff | not converged | 1 blocker: the confirming re-run could go to the same peer, so a peer with a broken environment could turn main red alone. 6 should-fix: the every-other-start bound was understated; no kill switch; seven parent sentences changed, not one; rule contradiction; refusals had no signal; missing tests. |
| 4 | same spec reviewer | spec + diff | not converged | No blocker. 1 should-fix: a suspect main could wait up to 60 minutes on a peer run whose verdict would be discarded. 4 minor. |
| 5 | same spec reviewer | spec + diff | **converged** | 4 minor (three applied). |
| 6 | independent code reviewer, round 3 (after the redesign) | implementation | concur | Attacked "a peer can never turn main red or clear a suspect or red main": no path found. 4 low (two fixed). |
| 7 | Codex, gpt-6-astra (cross-family; spec text and parent excerpts only, no logs) | spec | not converged | 9 points: coverage time could credit an unseen merge; restart fallback undefined; two deadlines for "unknown"; "runs it itself" not encoded; import predicates stated twice; head predicate ambiguous; cancellation exceptions incomplete; conflict with the parent's "never blocks local work"; no production-wired test or clock assertion. |
| 8 | Codex, gpt-6-astra | revised spec | **converged** | None. It noted the text alone does not show the new tests pass. |

## What the reviews changed

- The rule itself. First design: `main` goes to a free peer under fair share. Final design: only while main is healthy and a default-off live switch is on; a peer's record is not judged when main is no longer healthy at import; a running peer attempt is taken back when main stops being healthy. Result: a peer can move main from healthy to suspect at most.
- A 5-minute give-back for an unreachable peer (two missed polls), so a reservation cannot block `main` for the 60-minute attempt bound.
- A separate count, pause and signal for a peer that cannot confirm the head, instead of silence.
- The coordinator's own dispatch time for the unverified-since clock, never the peer's clock.
- An "Also amended" list of eight parent sentences, each quoted with its replacement.
- Tests: 30 unit cases in the block "a main verify on whichever host is free", one integration case over the real routes, and an e2e lifecycle with both services built by the production functions.

## Findings accepted and not fixed (stated in the spec)

- A peer `error` record on `main` is re-offered without the per-head backoff (bounded by two peer attempts).
- A peer that is alive but unreachable never receives the cancel; its orphan run ends at its own bound, unimported.
- A slow head check on a stale head can outlast the coordinator's 10-second request timeout and count against the peer after two minutes.
- A merge GitHub already has but the coordinator has not yet observed at dispatch is treated as covered until its own observation (shared with local runs).
- No dedicated signal for "the two hosts disagree on main" (queued as feedback).

## Limits of this review

- Two model families (Claude, GPT). Gemini was not run.
- The Claude reviewers were subagents of the authoring session, each with a fresh context and given the code or spec, not the author's conclusions.
- No reviewer ran the change on two real machines.
