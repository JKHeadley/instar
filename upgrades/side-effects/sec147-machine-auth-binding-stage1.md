# Side effects: receivers check an optional binding signature (SEC-147 step one)

In plain words: each machine can now check a second, stronger signature on requests from its other machines. Nothing sends it yet, so nothing an agent does today changes.

Tier 2. Size: 4 source files (`src/core/NonceStore.ts`: a read-only `check()` that `validate()` now calls; `src/server/machineAuth.ts`: the v2 check, the signed rejection, per-sender counts; `src/server/WebSocketManager.ts`: the upgrade refusal keeps the rejection header; `src/server/AgentServer.ts`: passes the machine's signing key to the check), 3 test files.

## What changes
- A request carrying `X-Signature-V2` that does not verify over its method, path and this machine is refused 403 `binding-mismatch`. No sender sets that header in this release, so in practice this only refuses a request that a third party altered.
- A rejection is signed only for a delivery that could still have been admitted (inside the window, nonce unseen, sequence ahead, checked without claiming them) and names that one delivery; an already-run or stale request gets the ordinary anti-replay answer.
- The refusal is checked before the nonce and sequence are claimed, so it never blocks a later correct request, and it does not call `onSignatureInvalid`, so it never feeds identity-recovery evidence.
- A v1-only request follows exactly the old path. The only addition on that path is a per-sender counter increment, in memory, keyed by sender ids that already passed the active-registry check.

## Signal vs authority
The new check has authority only over requests that carry the new header; it never refuses the old form. The counters are signal only.

## Rollback
Revert the commit. Nothing persists: the counters are in memory.

## Tests
- `machine-auth-binding` (new, 14), `nonce-store` (22), `nonce-store-config` (13), `message-router-cross-machine` (23), `machine-auth` (23), `WebSocketManager` (+3), and the unit files that import the changed modules: `HttpLeaseTransport-bootProbe`, `HttpLeaseTransport-mesh`, `desktop-mesh-origin-gate`, `hedge-abort-neutrality`, `hook-events-route`, `lease-renew-unreachable-peers`, `leaseAckAuth`, `messages-cross-machine-relay`, `request-arrival-ratchet`: all pass.
- Not tested in step one: a bound request through the real WebSocket upgrade (only the path helper and the 403 header writer are unit-tested), because no sender sends v2 until step two, which adds that test.
- `multi-machine-http` e2e (+2) and the integration files that import machine auth were not run on the M5, per the machine rule; Local Verify runs them.

## Second-pass review

**Reviewer:** independent Claude reviewer subagent. Verdict: concur after two rounds. Round 1 found that a rejection could be signed for a request already run or outside its window; fixed with a read-only replay check before signing and a rejection bound to one delivery (nonce, body hash, v2 signature hash). Round 2 concurred and set two stage-2 completion items, now in the spec: the sender compares all three fields of a rejection, and a test drives a bound and a mis-bound request through the real WebSocket upgrade.

## Repair after Local Verify (2026-11-23)
The full run failed one unit test, `tests/unit/feature-ladders-coverage.test.ts`: the spec's ladder line said "not applicable (reason)", and the check accepts only "not applicable: reason". The line now uses that form. No code changed, and the branch was brought up to date with main.
