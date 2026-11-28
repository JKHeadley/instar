# Convergence Report — Confirm-page PIN guesses from strangers go through the sign-in limits (SEC-135)

## ⚠ Round cap reached (6 of 6, Tier 2): final fixes applied, no quiet confirming round yet

Round 6's external review raised two DESIGN-class findings. One is security-related: the per-token limit must survive a store outage. Both were applied exactly as specified. The skill's rule at the cap is that a remaining safety or security design finding goes to the operator rather than being accepted silently. That is why this report is not a convergence verdict. It asks for one more confirming round (or the operator's acceptance) together with the experience decision below.

## Cross-model review: codex-cli:gpt-6.2-astra

A real GPT-tier external pass ran in all six rounds (`cross-model-review.mjs --family codex-cli`). Gemini was not installed. The Claude clean-door reviewer was available but not used.

## ELI10 Overview

Anyone who knows the agent's web address can open its "yes or no" pages for outside services, because those pages must work before you sign in. Each opening used to hand out a fresh ticket with 5 PIN tries, and up to 30 tickets a minute were handed to anyone. That made about 9,000 PIN guesses an hour possible.

After review, the fix is simple: an answer from an unknown browser now goes through exactly the same limits as the dashboard sign-in page, using the same counters. A stranger gets no more tries than at sign-in. The owner's own browser (one that has unlocked the dashboard before) and the computer the agent runs on keep their own allowances, which strangers cannot use up.

The trade-off is that an owner on a browser that has never unlocked the dashboard can be asked to wait, just as on the sign-in page. The constitution allows that kind of cost only for a critical vulnerability, and SEC-135 is rated medium, so that decision is with Justin.

## Original vs Converged

- **Original:** cap the live tickets each caller may hold, and add a separate agent-wide ceiling. A one-tap Telegram button would let the owner approve when paused.
- **Round 1 broke it:**
  - Swapping old tickets for new ones refilled the guesses, so the per-caller cap did nothing.
  - The Telegram tap would let a stranger trick the owner into approving the stranger's own request.
  - Several statements about the code were wrong (`mps_` and device keys are not owner proof here).
- **Rounds 2 and 3** tried an owner-only private ticket in every link the agent sends. It turned into a long-lived, forwardable guessing credential. It also needed a new owner-check route and migration of the agents' written instructions.
- **Round 4 onward:**
  - The design dropped private tickets entirely. Strangers use sign-in's own limits through one shared synchronous verifier.
  - The owner's marked browser and the machine itself keep their own budgets.
  - Their page opens get a separate allowance, protected from eviction, and need a header other websites cannot send.
  - There are no new limits; every number is inherited.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|---|---|---|---|---|
| 1 | codex, security+adversarial, scale+integration, decisions+lessons; SCG 3 flags | 5 + 8 + 9 + 8 (overlapping) | ~10 | redesign v2: source-keyed guesses, shared aggregate, owner link instead of tap |
| 2 | codex, sec/adv/scale, integration/decisions/lessons | 4 + 5 + 7 | 17 | v3: sign-in throttle reuse, owner-delivered tokens in agent links |
| 3 | codex, sec/adv/scale, integration/decisions/lessons; SCG | 3 + 4 + 7 | 14 | v4: private tickets dropped; marked/local exemptions only |
| 4 | codex, all-lens internal | 3 + 1 | 12 | owner-open header, owner mint allowance, verify contract |
| 5 | codex, all-lens internal | 3 + 0 | 6 | owner-open header required for marked too, insecure-connection result, test fixes |
| 6 | codex (internal not re-run) | 2 | 2 | store-outage per-token budget, per-class graduation evidence |

Standards-Conformance Gate: ran every round. After round 5, one flag remains: Security Fixes Keep the Experience Whole, medium vs critical. It was sent to the Chief of Staff for Justin.

## Proportion

Tier 2, security-sensitive; spec about 160 lines; 6 of 6 rounds. ⚠ Heavy for one finding. Most of the cost came from two design directions (the tap fallback, then private tickets) that review correctly rejected. The final design is smaller than the first.

## Left behind

- `PIN_ALERT_ONLY_KEY` double-alert wording for local callers: the builder follows the existing `localGuessing` alert.
- Registry entry fields for `recommended-service-tokens` (`paths` +confirm-stats.json, `maxRecords: 2`) and the new `pin-attempts` row (`freshness`, `paths`, `retention`): applied at build from the registry schema.
- `recordFailures` contract details (remaining counts returned; in-memory fallback): stated in the spec, with exact signatures left to the build.
- Experience wording: Telegram's in-app browser has no marker, so the residual case is common on phones during an attack. This is recorded in the Experience cost section for the decision.

## Full Findings Catalog

The per-round reviewer outputs are kept in this session's review transcripts. The catalog is summarised above by round, because a later version superseded most findings outright: the tap fallback and the private tickets were removed rather than patched.

## Convergence verdict

**Not converged by the skill's rule.** The round cap was reached with two final design findings applied but not confirmed by a quiet round. The operator decides on both:

1. accepting the remaining experience cost for a medium finding, or re-rating SEC-135 critical;
2. authorising one confirming round, or accepting the round-6 fixes as written.

The spec is otherwise ready to build.
