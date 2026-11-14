# Side-Effects Review — Feedback GitHub runtime

**Version / slug:** feedback-github-runtime
**Date:** 2026-11-06
**Author:** Echo
**Second-pass reviewer:** feedback_auth_review (independent Codex subagent)

## Summary of the change
Tier 2 credential-boundary repair, three runtime files plus regression coverage. Feedback calls use the existing authenticated GitHub runtime instead of a saved machine-global login: triage merged-fix lookup, executor reads/publication/disarm, trusted fetch/push/release lookup, and safe-merge child. One review round planned; no spec-design change. Parent approved specs: feedback-triage-and-execution and throughput-github-runtime-repair.

## Decision-point inventory
- Explicit per-agent identity — pass-through to the existing githubRuntime resolver; fail before network if no identity.
- Executor availability — unchanged policy, now receives authenticated facts.
- PR independence, review, protected paths, confinement, owner epoch and pinned merge — unchanged authorities.

## 1. Over-block
A host with only a machine-global gh login and no per-agent token now refuses feedback GitHub calls. This is the approved explicit-identity invariant. Ordinary feedback without credentials still sorts with merged-PR evidence unknown; no invented empty list. Existing GITHUB_TOKEN precedence and five-minute refresh are unchanged.

## 2. Under-block
An explicit GITHUB_TOKEN can still name the wrong principal; existing independence, fork, author and repository gates remain mandatory. This change does not expand scopes or choose a new account. A revoked credential stays unavailable until repaired; cache bounds rotation visibility to five minutes. No token enters arguments or diagnostics.

## 3. Level-of-abstraction fit
Use the existing core/githubRuntime boundary for identity, executable and environment. No new credential store, retry ladder, or decision authority. Network git alone receives the runtime; clone creation and confined sessions retain their current credential isolation.

## 4. Signal vs authority compliance
Required reference: docs/signal-vs-authority.md. Explicit identity is an enumerable security invariant, not a contextual heuristic. Existing executor policy retains all action authority. No competing-signal rule is added.

## 4b. Judgment-point check
No new static heuristic at a competing-signals decision point. Auth presence and executable availability reuse the existing deterministic floor.

## 5. Interactions
The executor shares one bounded resolver between its gateway and trusted git. Normal and triage-disabled disarm both use vault identity. safe-merge receives the same credential environment and absolute gh directory. Git resets credential helpers and uses the resolved executable; existing hooks/fsmonitor/config hardening remains. No duplicate timers or persistent-state writes are added. The shared runtime cache can lag a rotation for at most five minutes.

## 6. External surfaces
GitHub reads and existing approved mutations now authenticate as the agent. No HTTP schema, new endpoint, money, credential rotation or operator-facing action is added. Existing PIN and code-owner approval surfaces remain intact. Missing GitHub evidence stays unknown. No credential is printed or embedded in a URL or argument.

## 6b. Operator-surface quality
No operator surface changes.

## 7. Multi-machine posture
Machine-local runtime BY DESIGN, per-agent canonical vault and executable on the operated host. Existing SecretSync transports the credential through its approved path; this change sends no secrets between machines and does not change ownership fencing. A new owner resolves its own credential.

## 8. Rollback cost
Code revert only, no data/config migration. Rollback restores the incident (ambient/saved CLI identity) but leaves all execution rows and attempts readable.

## Validation
New gateway tests failed four of four on the original code. Updated gateway, trusted git and production HTTP/lifecycle tests cover stale ambient identity, missing explicit auth, bounded rotation, safe-merge subprocess and actual AgentServer reconstruction. Build and full lint passed. Independent reviewer reran the six runtime unit checks successfully and requested default-triage consumer coverage; that coverage was added for both working and missing credentials. Full required suite and production restart proof are queued under the host suite limiter. HTTP/lifecycle proofs wait for the accepted tick to finish before teardown, asserting both admission and its durable outcome.

## Independent second pass
feedback_auth_review: Concur with the side-effects review; no blocking findings. Independently exercised executable shell quoting with an apostrophe and reran runtime unit tests 6/6. Requested default merged-PR consumer coverage, then concurred with the added valid/missing-credential assertions and agent-ID headers. Full-suite and E2E results remain required.
