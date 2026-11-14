# Side-Effects Review — setup asks before accepting a provider's terms

**Tier 1.** Prompt text plus tests and one spec sentence. Spec: `docs/specs/recommended-services.md`. Dark: setup only runs on a throwaway or development agent that lists a recipe under `recommendedServices.provingRecipes`. Size: 2 runtime-adjacent files (one brief line, one spec sentence) plus a new unit test file of 4 tests; with the release note, side-effects and ELI16, 7 files. Effort: one design pass, no spec review rounds.

## Summary

- One new line in the shared rules every setup brief gets (`RULES` in `src/recommended/recipes.ts`): a yes to a service is not a yes to the provider's terms. Before ticking, clicking or signing anything that accepts terms of service, an agreement or a contract, the session stops and asks in its topic, says in plain words what it is and what stands out (binding arbitration, giving up class actions, auto-renewal, a minimum term, charges after a trial), and asks for a yes or no. A "not now" uses the existing hold route from PR 2772. A cookie-preference banner is excluded.
- `RULES` is exported so a test can show the rule is shared, not Jev-only.
- The spec's "Decisions" sentence names accepting terms as a decision the person makes.
- Cause: on 2026-11-04 a live setup session ticked TypeSafe's agreement, which includes binding arbitration, and told no one. The stop rule covered charges and grants only.

## 1. Over-block

A session may now ask about something trivial that looks like an agreement, such as a "by continuing you agree" footer on a sign-up page. That costs the person one yes. Asking too often is the cheaper failure than accepting arbitration silently. The cookie-banner carve-out removes the most common false case.

## 2. Under-block

The rule is prompt text. Nothing checks browser clicks, the same as the existing charge/grant rule, so a session can still miss it. A provider that binds you by "use of the service" with no checkbox has no moment to stop at; the session should still mention it under "what stands out" when it reads the terms, but nothing enforces that. A structural check of browser clicks would be a new subsystem, which this change deliberately does not add.

## 3. Level-of-abstraction fit

Right layer: the shared rules are where the existing stop-before-charges rule lives, and every recipe gets them. The decision belongs to the person, recorded through their reply in the session's own topic, as payments already are.

## 4. Signal vs authority compliance

No new decision point in code. The rule only makes a session ask more; it grants nothing and blocks nothing in the system. Reference: `docs/signal-vs-authority.md`.

## 5. Interactions

Uses the existing hold route (`POST /recommended-services/:id/hold`) and the existing "not now" rule; no change to either. The brief text changes, which changes nothing persisted: briefs are built per session start and are not hashed into the offer.

## 6. External surfaces

Only the setup brief a proving session reads. No route, config or person-visible change on real agents.

## 6b. Operator-surface quality

No page or control changes. The person may get one more plain question during setup on a proving agent.

## 7. Multi-machine posture

Machine-local by design, as setup is: `machine-local-justification: physical-credential-locality`. The brief is static text built where the setup session runs.

## 8. Rollback cost

A revert removes one line of brief text and the tests. No state or migration.
