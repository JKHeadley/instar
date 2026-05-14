# Side-effects review — F-8 rest of Tier-2 enforcement

**Spec**: `docs/specs/SELF-HEALING-REMEDIATOR-V2-SPEC.md` (§A3, §A23, §A40, §A42, §A52, §A57 Tier-2 carve-outs)

**Scope**: Wires the security enforcement that the Tier-1 F-8 skeleton (PR #201) deferred — capability-token HMAC on dispatched RemediationContext, probe-source-binding + scope check at dispatch entry, trust-elevation source consult on lifecycle transitions, supervisor-handshake closure (`RegisteredRemediator` implementation + `requestPlannedRestart`), and one smoke-test probe scope export.

---

## 1. What changes about the running system

Nothing observable today. Every new constructor option (`trustSource`, `serverSupervisor`, `probeSourceRegistry`) and every new method (`canTransition`, `requestPlannedRestart`, `getCapabilityLeafKey`, `onRestartComplete`) is OPT-IN. The default `Remediator` shape unchanged for existing Tier-1 / W-1 tests. No production code instantiates a `Remediator` yet; `DegradationReporter.setRemediator()` is still uncalled.

The one structural surface change is on `NormalizedDegradationEvent`: a new optional `source.probeSignature` field is added. This is additive and serializes to `undefined` for every existing emit site.

## 2. Over-block / under-block

**Over-block risk** — when a `probeSourceRegistry` IS wired, every `provenance: 'probe-id'` event must carry a verified envelope inside the declared scope. An emit-site that forgot to sign is silently routed to `no-matching-runbook` with reason `probe-event-unsigned`. The Tier-3 fleet migration is the rollout for this; F-8-rest only wires ONE probe (`LifelineProbe`) and the registry is not constructed at all in production paths yet. So today: zero over-block.

**Under-block risk** — when the registry is UNWIRED, no probe enforcement happens. A malicious or buggy emit-site could mint a `provenance: 'probe-id'` event with no signature and the Tier-1 path would dispatch normally. The spec accepts this for Tier-2 (the registry-wiring step is the Tier-3 fleet rollout — see §A57). The Tier-2 unit tests assert presence of the gate; production wiring is the next-tier work item.

**Capability-token verify under-block** — `NativeModuleHealer.invokeFromRemediator` only enforces when BOTH a `keyVault` is passed AND `ctx.hmac` is set. Existing W-1 callers (test fixtures) pass neither, so they continue to work. Production wiring (a future PR) will always pass both. This is intentional backward compat per the user request "the in-line `openWithHeal` path MUST stay working."

## 3. Level-of-abstraction fit

- `RemediationContext` sign/verify lives in `src/remediation/RemediationContext.ts` — same directory as the consumers, no cross-tree dep.
- The surface-side verify in `NativeModuleHealer` deliberately INLINES the canonical-body byte layout (it does NOT import from `src/remediation/`) so the legacy `openWithHeal` CLI path stays usable on installs without the remediation tree. A small chunk of byte-layout duplication is the explicit price; the test fixture asserts both implementations agree.
- Probe-source binding lives in `src/monitoring/probes/__shared.ts` — co-located with the consumers (probe modules) per A52.
- The `DefaultProbeSourceRegistry` impl + canonical envelope helper live in `Remediator.ts` so the wire format has ONE owner; tests can also stub the interface.

## 4. Signal-vs-authority compliance

- The Remediator REMAINS the authority layer (it makes block / allow decisions).
- Probes are SIGNAL emitters — they sign their envelopes, declare their scope, but the Remediator decides what to do with each event.
- `TrustElevationSource` is the authority for lifecycle transitions; the Remediator delegates without re-interpreting.
- `ServerSupervisor` retains authority over restart sequencing; the Remediator only REQUESTS via HMAC-signed payload — the supervisor's existing fail-closed checks (handshake-version match, staleness window, blast-radius allowlist, HMAC verify) are unchanged.

No new authority migrated to a low-context filter.

## 5. Interactions with existing behavior

- **`openWithHeal` (legacy)** — Unchanged. Doesn't construct `invokeFromRemediator` ctx, so the new verification path is skipped entirely. Verified by `tests/unit/NativeModuleHealer.test.ts` (12 tests pass unchanged).
- **W-1 runbook fixture path** — `invokeFromRemediator(ctx)` without keyVault → §A3 verification skipped → existing behavior. 12 `NativeModuleHealer-invokeFromRemediator` tests pass unchanged.
- **F-4 audit primitives** — No change. The existing `tokenVerifier` injection is still the authoritative gate for audit writes; F-8-rest does not modify the audit pipeline.
- **F-5 TrustElevationSource** — Used through its public `canTransition()` only. The 25 source-side tests pass unchanged.
- **F-6 ServerSupervisor handshake** — The Remediator now CLOSES the loop by implementing `RegisteredRemediator`. The 9 supervisor-handshake tests pass unchanged.
- **F-7 PostUpdateMigrator** — Untouched.

## 6. Rollback cost

Pure additive surfaces. Reverting the PR:
- Drops `signRemediationContext` / `verifyRemediationContext` / `canonicalProbeEnvelopeBody` / `DefaultProbeSourceRegistry`.
- Drops the three optional `RemediatorOptions` fields + the new methods.
- Drops `__verifyScope` from `LifelineProbe` (one const export).
- Drops the `hmac` field on `RemediationContext` (optional, no caller required to set).
- Drops the `source.probeSignature` field on `NormalizedDegradationEvent` (optional, no emit site sets it).
- Drops 21 new tests.

No data-format migrations, no on-disk schema change, no live consumer wired. Rollback cost: low.

## 7. Test plan

- 7 unit tests on `signRemediationContext` / `verifyRemediationContext` round-trip + every tamper / mismatch failure path.
- 10 unit tests on Remediator F-8-rest enforcement (probe-source binding 4 cases, ctx signed by dispatch, trust-source delegation 3 cases, canonical-envelope determinism 2 cases).
- 4 unit tests on NativeModuleHealer §A3 enforcement (valid hmac runs, forged hmac falls back, aborted fallback short-circuits, no-keyVault legacy compat).
- All 57 pre-existing Tier-2 / W-1 / Tier-1 tests in `Remediator.test.ts`, `runbooks/node-abi-mismatch.test.ts`, `NativeModuleHealer-invokeFromRemediator.test.ts`, `NativeModuleHealer.test.ts`, `ServerSupervisor-handshake.test.ts` pass unchanged.
- All 25 `TrustElevationSource.test.ts` + 4 `AuditWriter.test.ts` tests pass unchanged.

Total: 107 / 107 remediation-side tests green.

## Second-pass review

Not required (this PR introduces no new dispatch logic that would change live-system behavior — every change is gated behind opt-in constructor options that are unwired in production).
