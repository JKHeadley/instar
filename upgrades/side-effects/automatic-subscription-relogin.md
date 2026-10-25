# Side-Effects Review — automatic Claude Code and Codex re-login

**Version / slug:** `automatic-subscription-relogin`
**Date:** `2026-09-15`
**Author:** `echo`
**Second-pass reviewer:** `reauth_safety_review`

## Summary of the change

This change completes the bounded subscription re-login controller for the two exact supported pairs: Anthropic/Claude Code and OpenAI/Codex. It adds atomic form submission, provider-owned Google entry, OpenAI device-code handling, exact-identity unattended policy, honest audit attribution, production wiring, migration parity, and agent awareness. The main decision points are repair admission, unattended authorization, closed browser action selection, and success verification.

## Decision-point inventory

- `evaluateSubscriptionReloginAdmission` — modify — admits only exact provider/framework pairs and computes unattended authority from explicit identity and evidence inputs.
- `SubscriptionReloginService.tick` — modify — consumes an admitted unattended candidate without a human click and records the correct authority class.
- `AnthropicReloginBrowserDriver.allowedActions` — modify — adds only closed Google-entry and device-code actions; the supervisor still cannot invent an action.
- `SubscriptionReloginRuntime` — modify — resolves the appropriate direct-or-Google profile and separates Codex device-code completion from Claude paste-back.

## 1. Over-block

A legitimate login is still blocked when its browser profile is missing, ambiguous, outside the jailed agent profile directory, or registered under a non-autonomous login method. A real provider layout whose official origin is not in the exact allowlist also refuses. These are deliberate conservative failures: the operator can repair the mapping or the implementation can add a reviewed origin/layout; the worker must not guess.

An identity with any retained wrong-identity, unexpected-origin, or unmeasured-scope event remains approval-held even if its configurable success/day floors are zero. The policy reads an authoritative SQL aggregate rather than the bounded display list. This is intentional because lowering rollout evidence is not permission to ignore a security event.

## 2. Under-block

Provider markup can change while preserving misleading visible button text. Exact origin checks, closed page classes, independent final identity verification, and authenticated-use proof limit the impact, but a provider could still introduce a new interstitial that initially classifies as `unknown` and consumes the bounded wait budget. It cannot cause success by itself.

The exact identity allowlist is email-based because account IDs differ across machines. A provider-side alias that normalizes to the same canonical email is not distinguished here; the final provider identity oracle remains the authoritative check.

## 3. Level-of-abstraction fit

The deterministic policy owns irreversible authority: provider/framework tuple, source incident, account/profile identity, origin, scope, security terminals, evidence floors, and success proofs. The Tier-1 supervisor receives only a redacted closed snapshot and chooses one member of an already-computed allowed-action list. This uses the existing orchestration, enrollment, browser-profile, identity-oracle, quota, and ledger primitives instead of creating parallel authorities.

## 4. Signal vs authority compliance

- [x] Yes — the blocking logic is an invariant over closed authoritative fields, not a brittle content detector.

DOM phrases only classify a candidate page state. They never authorize an account, origin, scope, secret read, or success. Any unrecognized or conflicting state waits within a bound or refuses, and success requires independent credential identity plus authenticated provider use.

## 4b. Judgment-point check

No new static heuristic decides between competing live signals. Supported provider/framework pairs, exact origins, exact canonical identity, explicit configuration, zero security-event history, and closed challenge classes are enumerable safety invariants. The LLM-backed supervisor remains limited to ordering a closed action set after those floors.

## 5. Interactions

- **Shadowing:** admission runs after the passive login ledger corroborates a real authentication incident; raw missing-credential observations cannot reach this controller.
- **Double-fire:** the store's unique live-cell index, pending-login check, idempotent source-episode key, and in-flight set prevent duplicate repair owners.
- **Races:** every approval boundary revalidates the complete digest; store transitions use optimistic CAS; cancellation aborts the browser and prevents new actions.
- **Feedback loops:** a successful authenticated probe activates the pool and closes the source incident, which removes the candidate. Failure budgets and the existing breaker bound repeated redrive.
- **Provider split:** Codex device-code completion checks the Codex credential witness and never enters Claude's paste-back controller.
- **Chooser ambiguity:** only one exact canonical identity on an actionable chooser leaf may be clicked; missing, duplicate, parent-container, and substring matches refuse.
- **Security response:** post-login identity mismatch quarantines the pool cell before terminal refusal, and wrong identity, unexpected origin/scope, CAPTCHA, and phone confirmation open the account/provider breaker on the first event.

## 6. External surfaces

- The local browser opens official Anthropic/OpenAI/Google pages in the exact registered machine-local profile.
- Provider-native CLI login may write credentials only into the pre-existing per-account config home.
- Telegram attention copy becomes framework-aware; unattended routine repairs omit the approval notice but still emit terminal/blocker notices.
- Configuration gains `unattendedPolicy.identities`, `minimumSuccessfulRepairs`, and `minimumEvidenceDays`; migration adds only missing defaults and preserves operator values.
- Persistent repair state remains closed metadata only. No password, TOTP seed, public code, returned code, URL, cookie, or email is added to the database or API response.
- Mobile completion remains available in the existing Subscriptions dashboard for approval fallback, cancellation, retry, and operator-only security challenges.

## 6b. Operator-surface quality

No dashboard renderer or markup changes in this patch. The existing phone-width Subscriptions surface remains the fallback for approval, retry, cancellation, and security challenges. Routine exact-identity unattended repair removes an action rather than adding raw operator controls.

## 7. Multi-machine posture

**Machine-local BY DESIGN:** browser cookies, CLI credential slots, pending login processes, browser seat leases, and repair execution are physical truths on one machine. The pool-scoped read continues to merge redacted per-machine episode state, and cross-machine dashboard actions continue to use the existing signed mandate relay. The controller does not replicate credentials, codes, or browser state.

It emits user-facing notices, but only the machine owning the episode enqueues the stable delivery key. Durable repair state stays with that machine and is not stranded by topic ownership movement because execution follows the credential cell, not the conversation owner. No credential-bearing URL is generated or relayed.

## 8. Rollback cost

- **Immediate kill switch:** set `subscriptionPool.assistedRelogin.enabled:false`.
- **Safer degradation:** return `mode` to `approval`; this restores the dashboard tap while preserving browser/Codex correctness fixes.
- **Hot-fix:** revert and ship the next patch.
- **Persistent data:** no destructive migration is needed. New config keys are additive and old binaries ignore them; closed audit rows remain valid.
- **User visibility:** during rollback, expired accounts return to one-click/manual repair rather than losing their existing credentials.

## Conclusion

The review preserved the conservative security boundaries while removing routine approval toil. Two defects found during implementation—fills that did not submit and a missing provider-owned Google entry action—were closed with real-Chrome coverage. The final design supports Claude Code and Codex without crossing their completion paths, attributes unattended authority honestly, remains machine-local, and can be disabled or degraded to approval mode without data repair.

## Second-pass review

**Reviewer:** `reauth_safety_review`
**Independent read of the artifact:** concern raised, corrected, and resubmitted for concurrence.

The first pass found ambiguous chooser matching, unmeasured generic consent, missing post-login credential quarantine/immediate security breaking, bounded policy history, and missing boundary tests. The implementation now uses exact unique chooser leaves, separates provider device approval from generic measured consent, quarantines wrong credentials before refusal, opens security breakers immediately, aggregates all retained evidence in SQL, and covers each negative boundary. Final concurrence is recorded below after the corrected diff was re-read.

**Final independent result:** Concur with the review. Exact unique chooser selection, provider/framework isolation, consent-shadow refusal, wrong-identity quarantine, immediate security breakers, authoritative unattended evidence, bounded redrive, multi-machine locality, and both positive/negative test boundaries are adequately covered.

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable. `defectClass: unbounded-self-action`, `closure: guard`, `guardEvidence: { enforcementType: ratchet, citation: tests/unit/self-action-convergence.test.ts, howCaught: the registered subscription-relogin-redrive model proves that one live cell owner plus fixed attempt/reissue/wall-clock budgets, non-retryable security terminals, a durable breaker, and source-incident closure reach a no-action steady state under sustained provider failure }`. The controller is registered as `subscription-relogin-redrive` in `src/testing/selfActionRegistry.ts`.

## Evidence pointers

- `tests/unit/subscription-relogin-policy.test.ts`
- `tests/unit/anthropic-relogin-browser-driver.test.ts`
- `tests/integration/chrome-cdp-relogin-browser.test.ts`
- `tests/integration/subscription-relogin-runtime.test.ts`
- `tests/e2e/subscription-relogin-lifecycle.test.ts`
- `tests/unit/self-action-convergence.test.ts`
