# Side-Effects Review — Enable-layer coherence (low-risk half)

**Version / slug:** `enable-layer-coherence`
**Date:** `2026-05-25`
**Author:** `echo`
**Second-pass reviewer:** `not required (objective bug-fixes, fail-safe, full guard coverage; spec-driven, approved)`

## Summary of the change

Three objective enable-path fixes (the low-risk half of feature-activation-coherence, approved by Justin): (1) always-construct `TelemetryHeartbeat` so `POST /telemetry/enable` isn't a deadlock (`src/commands/server.ts`); (2) add `dispatches` + `feedback` to the `PATCH /config` allowlist, extracted to an exported `PATCHABLE_CONFIG_KEYS` (`src/server/routes.ts`), fixing two toggles that 400'd; (3) a build-time enableAction-validity guard (`tests/unit/feature-enableaction-validity.test.ts`) that fails the build if any feature's enable/disable action targets a non-patchable surface. Spec: `docs/specs/enable-layer-coherence.md`.

## Decision-point inventory

- `PATCH /config` allowlist — **modify** — add two real config keys (`dispatches`, `feedback`); extract to a module-scope export.
- Telemetry heartbeat construction — **modify** — always construct (was conditional); side-effects unchanged (self-gated internally).
- enableAction-validity guard — **add** — build-time test, no runtime surface.

---

## 1. Over-block

No new block/allow runtime surface that rejects legitimate input. The allowlist change *widens* what `PATCH /config` accepts (adds two keys); it cannot newly reject anything. Telemetry construction has no block surface. "No over-block — the change only widens acceptance + adds a build-time test."

## 2. Under-block

The enableAction-validity guard could miss a malformed action shape it doesn't model (e.g. a future action with a method other than PATCH/POST, or a `/config` body nested differently). It checks top-level body keys for `PATCH /config` and a known-endpoint set otherwise; an exotic future action shape would pass unchecked. Acceptable: it covers every current shape and the failure mode it guards (non-allowlisted config key). Telemetry: a classifier/provider outage means telemetry simply doesn't send (it's off anyway) — no under-block of anything user-facing.

## 3. Level-of-abstraction fit

Right layer. The allowlist is the existing accept-list at the route boundary; extracting it to an export (consumed by both the route and the test) is the correct single-source-of-truth move. The telemetry fix matches the existing always-construct/gate-effects pattern already used by `PrivateViewer`/publishing in the same file. The guard is a build-time unit test — the right place to assert a static invariant about FeatureDefinitions.

## 4. Signal vs authority compliance

**Reference:** docs/signal-vs-authority.md
- [x] No — this change has no new block/allow authority surface (allowlist widening + always-construct + a build-time test).

No brittle logic gains blocking authority. The allowlist is a passive accept-list (unchanged mechanism). Telemetry's authority (consent checker + enabled flag) is untouched.

## 5. Interactions

- **Shadowing:** none. Allowlist check is unchanged in position; telemetry construction moved from conditional to unconditional but `.start()` is still deferred to the same post-scheduler point and still no-ops when disabled.
- **Double-fire:** none. Telemetry record callsites (`recordSessionSpawned`, `setConsentChecker`) now run for an always-constructed heartbeat; when disabled they buffer counters that never submit (bounded, harmless) and set a consent checker only consulted during (gated) submission.
- **Races:** none new. Construction is synchronous at boot; the allowlist is read-only per request.
- **Feedback loops:** none.

## 6. External surfaces

- **Other agents / install base:** ships to all agents on the normal server update. Telemetry stays off unless explicitly enabled (Echo: off). The two toggle fixes only make `dispatches`/`feedback` *enable-able* via API — they don't change any default (both remain whatever the config says; for Echo, `dispatches` absent = off, `feedback` already on).
- **External systems:** no new egress. Telemetry submission remains gated on enabled + consent (both off for Echo). Enabling `dispatches` for a *downstream* agent now also constructs its puller (`AutoDispatcher`, gated on `config.dispatches` existing) — but that only happens if that agent's config has dispatches, which is their choice.
- **Persistent state:** none added. `POST /telemetry/enable` provisions an install id only when actually called (unchanged).
- **Response shape:** unchanged for existing callers (allowlist widening doesn't alter success/empty responses for previously-accepted keys).

## 7. Rollback cost

Pure code + a test. Each fix independently revertable: telemetry → conditional construction (deadlock returns, nothing else); allowlist → drop the two keys (toggles 400 again); guard → delete the test. No persistent state, no migration, no agent-state repair, no user-visible regression during rollback. Fail-safe: a bug in the telemetry change cannot cause egress (start/submit self-gate) — worst case is "behaves like today."

## Conclusion

No design changes from the review. The guard validated itself by catching a real second bug (`feedback`) during implementation — a strong signal the abstraction is right. All three fixes are objective, fail-safe, and independently revertable; telemetry egress is unchanged (off for Echo). Clear to ship. The behavior-reducing dispositions (autonomous-evolution execution retirement, response-review merge) are deliberately excluded — they await Justin's explicit decision in a separate spec.

---

## Second-pass review (if required)

Not required — objective bug-fixes, fail-safe, full guard coverage, spec-driven + approved.

---

## Evidence pointers

- `tests/unit/feature-enableaction-validity.test.ts` — 15/15 green; caught the `feedback` toggle bug during development.
- `tests/unit/TelemetryHeartbeat.test.ts` — "does not start when disabled" / "does not send when disabled" (the property making always-construct safe).
- `tests/unit/telemetry-routes.test.ts` — enable-route behavior with a constructed heartbeat.
- Typecheck clean; touched-area regression sweep 99 passing.
