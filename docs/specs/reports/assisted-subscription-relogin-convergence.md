# Assisted subscription re-login — convergence report

## Outcome

The first-release design converged on approval-gated autonomous repair: one verified operator click scopes one exact incident, followed by a crash-safe bounded controller. Unattended repair, new providers, broader scopes, and real operator-owned canaries remain outside this authority.

## Review rounds

1. Architecture/threat review established the authority boundaries, durable state machine, identity and authenticated-use proofs, secret non-persistence, retry taxonomy, rollout brakes, machine-local posture, migration parity, and three-tier testing obligations.
2. Cross-model review (`codex-cli:gpt-5.5`) returned **MINOR ISSUES**, no major issues. It requested a clearer LLM necessity/boundary, concrete profile ambiguity rules, provider anti-abuse brakes, and an acceptance matrix. All were added.
3. The second cross-model round again returned **MINOR ISSUES**, no major issues. It requested explicit cancellation teardown, a closed/redacted supervisor input contract, alternatives considered, concrete provider-path stop conditions, and clearer release evidence. All material design findings were incorporated.
4. The available clean-door Anthropic reviewer attempted to run but degraded with an execution error. This is disclosed, not treated as a successful opinion.

## Material decisions now closed

- Ordinary bearer credentials cannot approve; only a PIN or short-lived dashboard operator proof can.
- Provider/account/profile selection is exact and ambiguity refuses.
- The LLM has no identity, origin, scope, secret, retry, or success authority.
- Password/TOTP values never cross into durable state, model context, logs, screenshots, APIs, or messages.
- Cancellation and restart behavior are defined at active browser and CLI boundaries.
- Provider risk challenges stop the path instead of being retried through.
- Success requires multiple independent live-state witnesses.
- Fleet defaults remain dark/dry-run-first; unattended remains dark.

## Remaining authority boundary

The operator must approve this reviewed V1 boundary before release. A later live canary may use only a disposable/test identity unless the operator separately authorizes a real account.
