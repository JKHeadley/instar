# Side-Effects Review — credential probe refuses subscription tokens

**Version / slug:** `headless-probe-api-key-only`
**Date:** `2026-11-03`
**Author:** `echo`
**Second-pass reviewer:** `not required` (no gate/sentinel/watchdog, no messaging, session lifecycle or dispatch decision)

## Summary of the change

`AnthropicHeadlessAuthCredentialInjection.probe()` (src/providers/adapters/anthropic-headless/control/authCredentialInjection.ts) sent `POST api.anthropic.com/v1/messages` with either an API key or a Claude subscription OAuth token as a Bearer header. It now sends that request only for an API key. For `oauth-subscription` it runs `validate()` (format check) and then throws `AuthError` without a network request. The API-key request now carries only `x-api-key`. Tests added in tests/unit/pinned-model-callsites.test.ts.

Reason: Anthropic's Claude Code legal page (read 2026-11-03) says OAuth sign-in supports ordinary use of Claude Code and native Anthropic apps, and that products built on Claude should use API keys. A direct AI request from Instar on a subscription token is outside that. Account compliance loop gap G3.

Tier 1 (declared). 2 source/test files, about 46 added / 7 removed lines. Effort: no spec rounds; one test-first cycle. A revert fully undoes it.

## Decision-point inventory

- `probe()` credential-kind branch: now refuses `oauth-subscription`. This is a capability removal on an uncalled method, not a gate on agent behavior or information flow.

## 1. Over-block

A future caller that wanted to verify a subscription token by a live request now gets an `AuthError`. That is the intended outcome; such a caller should rely on Claude Code's own use of the login. No current caller exists (search of origin/main ab7d4c5c0 for `.probe(` found only unrelated probes: swapWorkGate, DirectDesktopAccess, ReapGuard, DesktopHelperPermissionNotice). No issue identified for live code.

## 2. Under-block

Other direct subscription-token traffic remains and is tracked in the compliance ledger, not in this change: OAuthRefresher token refresh (POST /v1/oauth/token), usage/profile reads (GET /api/oauth/usage, /api/oauth/profile). Those are read-only or token-writing, not AI requests, and Justin chose the usage read design in June; they need their own review.

## 3. Level-of-abstraction fit

Right layer: the refusal sits in the one method that builds and sends the request. The interactive-pool adapter's `probe()` already never makes a request; the Codex adapter's is a no-op. This brings the headless adapter in line.

## 4. Signal vs authority compliance

Does not add blocking authority over agent behavior. It narrows what one helper will do with a credential. No brittle detector gains a veto.

## 4b. Judgment-point check

No competing-signals decision point. The credential kind is a typed, exact field.

## 5. Interactions

`validate()` still runs first, so a malformed subscription token still fails on format (tested). Conformance runner `runAuthCredentialInjectionConformance` only asserts `probe` exists; still true. `credentialProbeModel` config still applies to API-key probes (existing tests pass).

## 6. External surfaces

One fewer possible outbound request to api.anthropic.com. Error text for a subscription probe changes. No user-visible change, no route, no config, no migration.

## 6b. Operator-surface quality

No operator surface touched.

## 7. Multi-machine posture

Machine-local by design: a pure function of the credential passed in; no state, no notices, no URLs. Every machine gets it through the normal update.

## 8. Rollback cost

Revert the commit and ship a patch. No data, state or migration to repair.

## Conclusion

Safe to ship. Removes an unused path that could send an AI request on a subscription login, with no automation loss because nothing called it.

## Second-pass review (if required)

Not required.

## Evidence pointers

- New test "refuses a subscription token without sending any request" fails on the old code (1 request sent) and passes on the new.
- `tsc --noEmit` clean; tests/unit/pinned-model-callsites.test.ts 18/18.
- Ledger: .instar/state/account-compliance/ledger.md in the echo agent home (gap G3).

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. No self-triggered controller added or changed.
