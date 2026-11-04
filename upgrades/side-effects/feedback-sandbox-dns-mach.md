# Side-Effects Review — feedback sandbox DNS configuration on macOS

**Version / slug:** `feedback-sandbox-dns-mach`
**Date:** 2026-11-04
**Author:** Echo
**Second-pass reviewer:** independent `feedback_dns_second_pass` reviewer; concurred after correction

## Summary of the change

`buildSandboxRuntimeSettings()` now permits one macOS Mach lookup, `com.apple.SystemConfiguration.DNSConfiguration`, in the feedback executor's confined commands. `buildClaudeSandboxSettings()` uses that same network policy for worker Bash commands. Node's `dns` module needs this local resolver configuration service during initialization; without it, the executor's base test hangs before the worker-produced fix can be reviewed. The network domain allowlist remains empty, local binding remains false, and all filesystem restrictions remain as before. The canary version advances so cached full-gate results cannot mask the policy change. Unit, real macOS integration, and production-path E2E tests cover the new boundary.

## Decision-point inventory

- `src/feedback-factory/execute/executePolicy.ts:buildSandboxRuntimeSettings` — modify — permits the exact local DNS configuration service only on macOS, with no outbound network grant.
- `src/feedback-factory/execute/executePolicy.ts:buildClaudeSandboxSettings` — modify — applies the same narrow service permission to worker Bash commands.
- `src/feedback-factory/execute/executePolicy.ts:CANARY_VERSION` — modify — invalidates the previous full-gate canary stamp and safety latch.
- Sandbox runtime's existing macOS profile generator — pass-through — turns `allowMachLookup` into an exact `mach-lookup` rule. No change to that dependency.

## 1. Over-block

No new rejection. A macOS test that needs another XPC service remains confined and may still fail; the finding supports only this exact DNS configuration service.

## 2. Under-block

The added service lets a confined process read resolver configuration. It does not permit a network connection by itself, but a future sandbox runtime regression could change that interpretation. The unit and integration tests pin an empty domain allowlist and disabled local binding. The real canary still checks denied writes and network operations.

## 3. Level-of-abstraction fit

The executor builds runner settings in one helper used by the canary and all confined verification commands. Claude Code builds separate worker settings; those now share the same network policy. The change belongs in these settings builders, not in each test command or in a machine-wide sandbox setting. It uses the sandbox runtime's existing exact Mach service allowlist.

## 4. Signal vs authority compliance

The observed timeout is evidence of a missing local permission, not authority to turn network access on. A discriminating probe ran the same Node DNS import outside the sandbox, inside the current settings, and inside settings with only the exact Mach service added. Only the last confined probe returned promptly. The production network and filesystem authority remains unchanged.

## 4b. Judgment-point check (Judgment Within Floors standard)

No model judgment is added. The platform check is deterministic: macOS receives one named local service; Linux and Windows receive none. The executor's independent review and merge decisions are unchanged.

## 5. Interactions

The permission applies to the worker canary, worker Bash commands, base-failure test, fixed-head test, related tests, lint and native rebuild. It is independent of the test-runner suite semaphore and the rerouted session capacity gate. The timed-out attempt must be retried after the new release; changing source does not alter settings already handed to a child.

## 6. External surfaces

No new API, message, credential or network endpoint. The affected external process is the sandbox runtime CLI on macOS. `allowMachLookup` names only `com.apple.SystemConfiguration.DNSConfiguration`; it does not use a wildcard, Apple Events, or weaker network isolation.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No new operator UI. A test timeout should remain visible as a failed executor attempt if the local service is unavailable; it must not be reported as a successful PR or merged fix.

## 7. Multi-machine posture (Cross-Machine Coherence)

The setting is generated per executor run. On non-macOS hosts no Mach service permission is emitted. A macOS Echo instance obtains it after package update and restart; current sessions retain their already-written settings. No replicated data format or cross-machine protocol changes.

## 8. Rollback cost

Reverting the single permission restores the earlier sandbox policy and can reproduce the macOS DNS initialization hang. The change has no durable data migration. An already-created PR or fix remains subject to independent review and exact-head tests.

## Conclusion

This is the narrowest observed repair for the macOS confined verification hang. It keeps the feedback executor's network block and review gates intact. Ship only after all three test tiers and independent second-pass review pass.

## Second-pass review (if required)

The reviewer found that the first draft applied the service to runner commands but omitted Claude Code's worker Bash profile. The revised change derives Claude's network policy from the same runtime settings and advances the canary version. On the exact revised diff, the reviewer concurred: sandbox-runtime 0.0.77 renders the literal service as an exact Mach lookup, with the network and filesystem limits intact. The integration test runs Claude's generated profile through sandbox-runtime; it does not launch Claude Code. The live canary remains the final worker-path check after deployment.

## Evidence pointers

- Live process sample, 2026-11-04 11:50Z: base-check Vitest main thread stuck in `node::cares_wrap::ChannelWrap::Setup` → `ares_init_options` → macOS SystemConfiguration DNS XPC.
- Controlled probes: outside sandbox `dns-ok`; exact sandbox settings timeout after 6 s; same settings with `allowedDomains=[localhost]` still timeout; exact `allowMachLookup` service returns `dns-ok` in about 12 ms.
- Build and lint: passed after the second-pass correction. Focused unit: 54/54 passed. Real macOS integration: 1/1 passed under both generated profiles. Production lifecycle E2E: 2/2 passed, checking the worker settings handed to confined spawn. Full unit suite: 3,139 files and 57,423 tests passed, zero failures (2 files and 15 tests skipped).

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.
