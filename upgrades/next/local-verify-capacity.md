# Local Verify: a second machine can run pull-request verifies (peer verifiers)

## What Changed

- New `src/localVerify/peer.ts`; peer and coordinator logic in `LocalVerifyService`; routes `POST /local-verify/peer-run`, `GET /local-verify/peer-status`, `GET /local-verify/peer-result`, `POST /local-verify/peer-cancel`; peer-only build path (no source checkout needed), `makePeerClient`, `wireLocalVerifyPeers`; optional `attempt` field on records. Spec `docs/specs/local-verify-capacity.md` (Part D; Part C batching rejected for v1).
- Settings (read live): `monitoring.localVerify.peer.enabled` on a peer; `monitoring.localVerify.peers` (`[{machineId, url}]`, at most 2) on the coordinator. Both default off.
- Agent awareness: template line + migration.

## What to Tell Your User

Nothing changes for an ordinary agent. For maintainers who run Local Verify: a second machine can now take pull-request test runs from the main one, which roughly doubles how many can be tested at once. It is off until it is switched on for a specific machine.

## Summary of New Capabilities

- Peer verifiers for Local Verify (`monitoring.localVerify.peer.enabled`, `monitoring.localVerify.peers`).

## Evidence

Unit `peerVerifier.test.ts` 27/27 (import rule per reason, dispatch only while busy, intent persisted before send, reserved never started locally, busy backpressure, per-entry bound, version/lease gates, import / reject / error / unknown / lease change / run bound / new head / restart, peer accept/refuse/idempotent/busy/result kept out of the index/crash/cancel/restart/peer-only) — mutation-checked; all `tests/unit/localVerify/` green; integration `local-verify-peer-routes.test.ts` 3/3 (real HTTP, real client); e2e `local-verify-lifecycle.test.ts` 10/10 (peer-only built through the production function, alive over HTTP). Spec converged in 4 Codex rounds.
