# Side-Effects Review — PR2799 live owner access

**Version / slug:** mobile-slack-holder-live-owner
**Date:** 2026-11-05
**Author:** Echo, Studio
**Second-pass reviewer:** independent security, integration, adversarial, decision and scalability readers; actual outcomes recorded below

## Summary of the change

Focused hardening of merged PR2799 at a8af8bff7. The device authenticator records the exact public-key hash and person/role binding used to verify the signature. New exported mobileOwnerDeviceAdmission returns a deviceId and isCurrent closure that rereads actual device, ledger, named profile and live pairing/native authority. Existing history routing uses it before each actual peer dial and after body formatting, including the route's final emission. The existing route, allowlist, deviceView compatibility, peer destination policy, limits, sends and local MSP grants are unchanged.

## Decision-point inventory

- Signature lookup / mobilePairingRoutes — modify — retain immutable authenticated key/person/role evidence; notification tokens and bearer calls do not get it.
- Owner admission / mobileOwnerDeviceAdmission — add — signed principal, available revocation ledger, live pairing/native gates, active same key/person, current owner and named owner profile qualification.
- History remote branch / mobileSlackRoutes — modify — existing remote owner reads use retained admission; local and other callers retain existing behavior.
- Actual dial / mobileSlackHolderProxy — modify — recheck before every rope fetch.
- Terminal admission / poolPeerFetch — add — pre-network authorization denial stops fallthrough and creates no rope-health failure; retained edge body is canceled.
- Private output / helper and route — modify — recheck after body formatting and before private output.
- Existing URL guard, deviceView contract and local send/MSP behavior — pass-through.
- Awareness migration — modify — existing shared generator section adds one idempotently installed explanation, preserving custom text.

## 1. Over-block

An owner whose key or person binding changes during the request must make a newly signed request. A removed or demoted named profile, unavailable ledger, disabled native/pairing gate or revoked key refuses a remote read even if device.status is still active. Legacy owner phones without a named person still work when authority is available. These are explicit security invariants, not content heuristics.

## 2. Under-block

The existing peer registry and credential destination guard remain the holder trust boundary. This change does not add cryptographic on-behalf-of delegation, validate every peer response field, proxy attachments, or retract bytes already returned before later revocation. Existing holder format/size/deadline limits remain those of PR2799. An already-started fetch may complete after authority is lost; no subsequent dial or private answer is admitted.

## 3. Level-of-abstraction fit

Signature admission owns the initial evidence; the reusable helper owns live owner authority; the existing holder reader owns transport. The terminal admission error tells shared pool transport to stop without confusing authorization with network health. GraphViewer and the separate media owner can reuse this exported helper after its commit; neither is modified or activated here.

## 4. Signal vs authority compliance

Required reference: [Signal versus authority](../../docs/signal-vs-authority.md).
Deterministic security invariants decide access: verified signature identity, current registered person, revocation and feature gates. No brittle semantic detector or role guessed from text can grant private bytes. Transport failure signals feed existing rope health; admission refusal does not.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The existing approved spec's current-owner invariant and the user's explicit 04:18 PST sole-owner assignment enumerate the required security floor. There is no discretionary content-routing judgment.

## 5. Interactions

- Shadowing: device authentication and the existing narrow allowlist still run first. Stronger helper checks affect the remote owner branch only.
- Double-fire: GET only, no send capability or duplicate Slack posts.
- Races: ledger-only revocation, key rotation, person reassignment, named owner deletion/demotion, live pairing/native disable are rechecked after waits and formatting. Signature evidence is captured in the actual verifying key lookup, not at routing time.
- Feedback: terminal authorization denial has no transport-health penalty or fallback retry. An earlier actual failed dial retains its genuine health result.
- Cleanup: retained edge responses are canceled on terminal admission/abort. Existing response byte limits, timeout and concurrency remain unchanged.

## 6. External surfaces

The same phone history route, same signed request and same error family remain. Loss of owner authority during an admitted read returns 403 before exposing holder content. An initially refused owner admission retains the existing wrong-machine path. No new allowlist route, destination URL input, sends, uploads, native app changes, graph live reads or deployment. No durable schema is added; the snapshot is request-local.

## 6b. Operator-surface quality

The existing app ChatView is the phone-completable surface. No new operator action or form. This server change has no new tap targets or labels. Real device use and remote attachment downloads are not proved or claimed by these tests.

## 7. Multi-machine posture

**proxied-on-read** through the existing holder route. The owner phone's current local admission is checked at the entry server before each trusted holder dial and before output. Holder-local alias resolution and compatibility remain unchanged. No new durable state, URL or one-voice notification is introduced. No status, health, capabilities or channels answer changes.

## 8. Rollback cost

Revert the focused code, helper and awareness line in a patch. No database or record migration. Rollback would restore the known access race, so it should not be used as a substitute for fixing a regression. Other feature behavior and remote media work are unaffected.

## Conclusion

Source implementation and five independent reviews are complete. Build, 51 lint steps and 47 focused tests passed. Actual HTTP and full regression acceptance are tracked in the test logs and PR checks; this source review is not deployment or live-graph authorization.

## Second-pass review (if required)

Security, integration, adversarial and decision reviewers independently concurred with this focused source delta; the security second pass concurred with this artifact after correcting the initial-versus-midread status wording. Scalability reviewer also concurred, including terminal admission and retained-edge cleanup. No reviewer ran suites; these reviews do not certify unchanged proxy transport or substitute for pending runtime/full-suite results.

## Evidence pointers

- .instar/state/build/unit-access.log — focused signer/registry/real-ledger and per-rope tests.
- tests/integration/mobile-slack-holder-proxy.test.ts — existing real sockets plus held-response ledger/key/person/profile/gate races.
- tests/e2e/mobile-slack-holder-proxy-alive.test.ts — existing production AgentServer boot path.
- .instar/state/build/plan.md — exact base and sole-owner scope, old duplicate worktree retained.
