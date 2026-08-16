# Upgrade Guide — vNEXT

<!-- bump: minor -->

## What Changed

This release adds the foundation layer for the token-burn-detection and auto-heal system. Phase 1 of six: it lays the structural pieces the next phases build on. There is no user-visible behavior change in this release — no new alerts, no automatic throttling, no new dashboard surface. The system is in observation-mode-only until Phase 3 ships the burn detector.

What lands today:

- A new attribution column on the token ledger that lets future phases say which component made each LLM call.
- A rate-gate primitive that the auto-throttle in a later phase will use. It ships as always-on (no calls are throttled).
- A new helper that turns a component name plus a prompt into a stable identifier the detector can use.
- A new lint rule that catches direct LLM HTTP calls outside the central provider module, blocking future bugs of the same shape that caused the 2026-05-15 incident.

The token ledger and intelligence-provider interfaces gain optional fields so existing callers keep working unchanged.

## What to Tell Your User

Your agent picked up the first piece of a new self-watch system. It does not change anything about how your agent behaves today. The piece that lands now is the plumbing that lets the agent notice, in a future release, when one of its own components is using an outsized share of its token budget — and either alert you or quietly slow that piece down until you decide.

For now: nothing to do. You will see this come to life over the next few releases as the remaining phases ship.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Attribution column on token ledger | Automatic on agent startup. The next phase fills it in. |
| Rate-gate primitive | Internal — no surface yet. |
| Direct-LLM-HTTP lint rule | Automatic on every push; catches new violations. |

## Evidence

The Phase 1 deliverables are tested by twenty-one unit tests in `tests/unit/burn-detection-phase-1.test.ts`. All pass green. The existing token-ledger unit suite (sixteen tests) and selectIntelligenceProvider suite (fourteen tests) still pass — no regression on the parts not touched by this phase.

Side-effects review for this phase is in `upgrades/side-effects/token-burn-detection-phase-1.md`. The reviewer identified zero blocking concerns; Phase 1 ships observability infrastructure with no runtime decision authority, so second-pass review is not required per the instar-dev skill criteria. Phases 3 through 5 will require second-pass review.

The umbrella spec at `docs/specs/token-burn-detection-and-self-heal.md` passed iteration 1 of spec-converge on 2026-05-15 with four internal reviewers; about fourteen critical and high findings were addressed in the rewrite. The convergence report is at `docs/specs/reports/token-burn-detection-and-self-heal-convergence.md`. Justin approved the umbrella on 2026-05-15 via Telegram.
