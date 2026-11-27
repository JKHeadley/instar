# Side-Effects Review — Temporary Routine Sol Account Placement

Date:2026-11-23. Author:echo. Tier1 declared: an optional, finite, owner-configured preference within existing account selection and model-call authority. It adds no default activation, credential write, new paid-work trigger, session movement, vendor permission or job routing. Disabling/removing the block or reverting the commit fully removes the preference. Source touches multiple existing launch/review/update seams to prevent bypasses; this is a narrow behavior, not a new spending controller.

## Summary of the change

New headless routine Sol helpers and shipped Sol source reviews can prefer an ordered list of local Codex accounts until an explicit expiry. Concrete, generic balanced and default model requests share the real resolved model. Existing jobs, resumes, explicit pins, local models, protocol reply workers and interactive sessions are excluded. The shared selector is strict: no eligible named account means refusal. The review lease endpoint starts no model. Shipped review-driver configuration is migrated to known installed default skill copies. Agent awareness ships through the existing generated awareness carrier.

## Decision-point inventory

- Apply the temporary preference only to known Sol models and new routine headless work or the explicit Sol review path: invariant closed framework/model/lifecycle domain, no language or task-priority inference.
- Account ordering: owner-authored ordered IDs, finite expiry; judgment remains with the approving owner/Chief.
- Eligibility: existing active/local identity, offered-window validity and freshness floors; absolute accessible local home, no suspected device limit; a full account cannot be selected even with a bad soft threshold.
- No preferred account: explicit refusal, never ambient or Saturday fallback.
- Launch-time policy/account/home/evidence recheck: deterministic consistency floor. An old selection is not continuing authority.
- Disablement/expiry: ordinary future placement; an already-prepared choice that changes is refused rather than silently swapped.

## 1. Over-block

Unknown/stale quota, an unavailable local server for an enabled review policy, or a changed queued account can refuse useful work even when a different account has room. This deliberately preserves the approved named-account boundary. The second named account is tried during initial selection. Absent/disabled policy returns before review network access, preserving that path when the local server is down. Jobs, manual pins and interactive conversations retain their behavior.

## 2. Under-block

Sampled quota cannot predict a task's cost or prevent simultaneous children from consuming the same remaining allowance. This change is placement, not reservation or a hard quota controller. The independent two-hour watcher remains necessary. It does not control native collaboration tools, custom launchers or sessions already running on Tuesday. No claim is made that all provider usage is governed by this option.

## 3. Level-of-abstraction fit

Selection belongs at existing headless placement and source-review child preparation, not in prompts or a machine-wide default login change. Both paths share the same live selector. Reviews use a read-only local endpoint to obtain the credential-location gate's current home; the provider's existing fail-open account resolver is not used to enforce this preference.

## 4. Signal vs authority compliance

Reference:docs/signal-vs-authority.md. The owner-approved finite ordered policy supplies the authority; existing quota and identity observations supply evidence. There is no brittle natural-language blocker, inferred project priority or autonomous permission promotion. Existing model-task supervision remains in place. The closed model registry is used to classify Sol; no model is asked to spend merely to keep this control alive.

## 5. Interactions

Explicit account pins retain precedence. Headless preparation awaits origin-token work, then rechecks inside the existing cleanup boundary; refused launches revoke origin registration. Preferred helpers force file-backed Codex auth and blank API-key/base override variables. Source reviews carry requiredRoute, exact accountOverride and strictModelPin; both provider transports await the live guard. Lost/changed evidence refuses the child and never changes its account silently. Ordinary source reviews gain no server dependency when the policy is absent/off.

## 6. External surfaces

Adds authenticated GET /subscription-pool/routine-codex-placement?model=gpt-6.2-sol, returning inactive, a current account/home/evidence expiry, or an unavailable/refusal response. It is a local account read with the same existing owner-bearer reach as the pool roster, not an action endpoint. No credential content is returned. The review client uses fixed loopback, authenticated requests, a bounded timeout and no redirects. No new schedule, live account mutation or restart is performed by this commit.

## 7. Multi-machine posture

Account eligibility and credential-home resolution are necessarily local to the execution machine (physical-credential-locality). No credential is replicated. Nonsecret ordered IDs and expiry are ordinary agent configuration, with no new default: guarded activation must apply and verify the same approved block on each participating engine instance through the existing configuration deployment process. This change does not invent config replication or claim unconfigured peers enforce the preference. The review client consults its own authenticated loopback server; a peer roster cannot supply a local executable home. Current pilot activation is limited to explicitly configured machines; the deployment handoff names that limitation.

## 8. Rollback cost

Set enabled:false or remove routineCodexPlacement on configured instances. New selections return to ordinary routing; queued choices are rechecked and may refuse; running work is preserved. A code revert restores the previous preference behavior. No account, quota, job, conversation or credential state migration is needed. Existing shipped script refresh remains idempotent and preserves unrelated custom skill names.

## Verification

Targeted unit, real HTTP and started-server lifecycle tests, including a real stand-in Codex child and both transports refusing a queued policy rollback, are retained with the handoff. Negative cases cover default/Saturday fallback, unavailable local evidence, changed account/home, ordinary paths, expiry and cleanup. Installed default script refresh is verified for canonical/Claude/Codex copies with repeated migration and a protected custom skill. Complete verification is requested through throughput; this artifact does not claim a full-suite pass, live activation or measured quota improvement from the implementation.

## Focused validation and proportion

116 selector/reviewer/migration unit checks and64 provider regression checks passed, as did14 HTTP integration and5 lifecycle checks. Type checking passed. A controlled model-context bypass caused six targeted HTTP assertions to fail; correct source was restored after the completed mutant run, then all14 HTTP cases passed. An initial invalid mutant stopped at type checking and is not counted as a regression proof. An additional provider test caught cancellation ordering; already-cancelled calls now skip the async recheck as before, and all64 provider checks passed after correction.

The behavior crosses helper placement, one-shot reviews, their configuration loader and update parity, so the implementation spans more files than a config-only change. Independent review ran three bounded reads of the design, corrections and cleanup, finding the concrete issues listed below. No source-model review experiment, package install, source push or full author suite was performed.

## Independent review

Reviewer routine_route_review found and required corrections for generic/default model bypass, stale child-boundary selection, an off-path server dependency and origin-registration cleanup. The implementation includes regression cases for each; reviewer routine_route_review concurred with the final cleanup and side-effects artifact, with no remaining material issue. No extra paid model experiment or vendor review was launched by the tests.
