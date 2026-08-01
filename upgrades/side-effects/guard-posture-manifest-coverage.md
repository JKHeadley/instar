# Side-Effects Review — Complete boot guard-posture coverage

**Version / slug:** `guard-posture-manifest-coverage`
**Date:** `2026-08-01`
**Author:** `Instar Agent (instar-codey)`
**Second-pass reviewer:** `guard_posture_review`

## Summary of the change

The boot-time GuardPostureTripwire previously persisted only the generic config extractor while GET /guards independently unioned that extractor with the 72-entry static guard manifest. On the measured agent this produced 36 watched keys against 90 inventory rows, leaving 54 declared guards outside transition detection. This change adds one shared `buildCompleteGuardPosture` funnel in `guardPosture.ts`, uses it from both the tripwire and `buildGuardInventory`, captures current and default config through the endpoint's existing one-read resolver immediately after `loadConfig` and before any startup migrator can rewrite disk, migrates old narrow snapshots by comparing newly enrolled keys with their resolved defaults, and records coverage arithmetic in snapshots, breadcrumbs, logs, results, and Attention text.

## Decision-point inventory

- `buildCompleteGuardPosture` — **add** — deterministically assembles config-derived keys union manifest keys and resolves each boolean with extractor → manifest config path → manifest default precedence.
- `diffGuardPosture` — **modify** — existing keys still compare boot-to-boot; newly enrolled keys compare against a supplied resolved default posture so an old snapshot cannot silently bless a default-on/config-off guard.
- `runGuardPostureTripwire` — **modify** — remains a signal-only boot detector, but consumes the complete posture, persists denominator metadata, and includes enrollment deviations in its existing aggregated signal surfaces.
- `buildGuardInventory` — **modify** — consumes the shared complete posture instead of independently rebuilding the same union.
- GuardPostureProbe and all guard runtime authorities — **pass-through** — their classification, persistence threshold, episode lifecycle, accept-fallback semantics, and actuation authority are unchanged.

---

## 1. Over-block

No block/allow surface — over-block is not applicable. The tripwire never prevents boot, edits config, re-enables a guard, or constrains an operator action. A deliberately disabled default-on guard can produce a HIGH Attention item, but that item is an observation with an acknowledge path, not a refusal.

The old-snapshot enrollment rule is deliberately narrow: only a boolean mismatch against the resolved default becomes a transition signal. A newly declared key whose current value equals its default is merely enrolled and produces no alert.

---

## 2. Under-block

No block/allow surface — under-block is not applicable. Detection still has two honest boundaries:

1. A guard with neither a manifest entry nor an extractor-visible config key remains invisible to both the tripwire and GET /guards. This change makes the two surfaces equal; it does not claim their union is metaphysically complete. The existing manifest lint remains the class-level mechanism for preventing shipped guard components from falling outside that boundary.
2. First-ever boot with no prior snapshot preserves the existing baseline-without-alert behavior. Default deviations remain visible to GET /guards and its cadenced GuardPostureProbe, while the tripwire begins transition detection from the new complete baseline. The special default comparison applies only when a prior, narrower snapshot proves this is an inventory migration rather than a brand-new installation.

---

## 3. Level-of-abstraction fit

The union belongs in `guardPosture.ts`, the module already documented as the single definition of guard posture. The static manifest has no runtime ordering dependency, and the runtime registry contributes enrichment only after the key set is assembled. Importing the manifest into the shared posture builder removes the producer/consumer split without coupling boot detection to request-time registry state.

Resolved current and default values come from `resolveGuardConfigSnapshot`, the same substrate GET /guards already uses. This is essential for dev-gated guards: on a development agent, an omitted gate defaults on, while an explicit false remains off. Reading only the manifest's fleet default would miss exactly that default-on/config-off case.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change produces a signal consumed by existing operator surfaces.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic — STOP.

The deterministic comparison owns no authority. It writes an audit breadcrumb, logs the observed transition, and may create one aggregated Attention item. It never blocks boot or changes posture. The operator remains the authority who acknowledges a deliberate disable or asks the agent to restore protection.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic is added at a competing-signals judgment point. Boolean posture equality and set union are enumerable invariants. The only new classification—newly enrolled current value differs from its resolved default—is the same mechanical default-deviation fact GET /guards already derives, reused to prevent an inventory migration from erasing evidence.

---

## 5. Interactions

- **Shadowing:** the tripwire still runs at boot before the SystemReviewer probes. Its complete snapshot improves later disk-versus-boot divergence for manifest-only keys; it does not suppress probe classification.
- **Double-fire:** the existing architecture intentionally has complementary transition-at-boot and persistent-steady-state tracks. On the first upgraded boot, an already-persistent default deviation may create one enrollment Attention item and later remain eligible for the probe's separately episode-deduped persistent anomaly item. This is bounded to the migration boot on the tripwire side because the complete snapshot is written before emission and the same posture cannot fire again. Within each track aggregation remains one item, never one item per guard.
- **Races:** the resolved substrate is captured immediately after `loadConfig`, before PostUpdateMigrator or another startup writer can change config.json. The later tripwire therefore records what this process booted from, while a migration-time disk change remains visible to GET /guards as pending restart. Snapshot persistence remains first within the detector: even if breadcrumb or Attention emission fails, the complete baseline advances and the next boot does not replay the same transition. GET /guards reads either the old snapshot (missing keys honestly report snapshot-unavailable) or the completed JSON file after the synchronous write; no partial in-memory state is shared.
- **Feedback loops:** neither logs, breadcrumbs, nor Attention acknowledgement feed a value back into posture extraction. The accepted-fallback system affects only the separate load-bearing-gap classification and is unchanged.
- **Compatibility:** coverage metadata is optional when reading old snapshots. Existing consumers continue to read `ts` and `posture`; new breadcrumb fields are additive JSON members.

---

## 6. External surfaces

Operators may see more accurate boot Attention items for guards that were previously outside the tripwire, and every boot/transition log now names the watched denominator. The local snapshot gains an optional `coverage` object; transition JSONL rows gain `coverage`, `previousWatched`, and newly-tracked key lists. There is no API schema change to GET /guards, no new route, no external network call, and no new operator action.

The snapshot remains machine-local operational state. Rollback code ignores additive JSON fields. Attention content continues to use the existing queue and can be completed from the phone-visible dashboard/Telegram surfaces; no laptop-only workflow is introduced.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No dashboard renderer, approval form, grant surface, or destructive control changes. The touched operator surface is text-only Attention/log output. It leads with the actionable fact (“N of M watched guards disabled”), uses human-readable denominator language, keeps raw guard keys as supporting identifiers, and introduces no destructive action. Existing Attention items already render at phone width.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN.** Each machine's boot tripwire observes that machine's resolved config and its own previous boot snapshot. A cross-machine union would be incorrect because guard enablement, development-agent defaults, and boot transitions can legitimately differ by machine. Pool-wide posture remains served by the existing heartbeat and GET /guards scope machinery; this change does not alter it.

The tripwire can emit a user-facing notice from each machine, as it already could for config-extracted guards. Attention IDs remain machine-local through each agent server's queue; no new one-voice election is added because the fact is specifically “this machine's boot posture changed,” not a pool-global judgment. State is machine-local and should not follow topic transfer. No URLs are generated.

---

## 8. Rollback cost

Rollback is a code-only patch revert. Old code will ignore the additive `coverage` member in the snapshot and additive fields in historical JSONL rows. It will resume watching only the narrow extractor set on subsequent boots; no database migration, state rewrite, operator reset, or credential rotation is needed. Reverting would restore the visibility defect, so rollback should be followed by a corrected patch rather than treated as a safe steady state.

---

## Conclusion

The change closes the measured producer/consumer coverage gap at the shared inventory layer, preserves signal-only authority, makes migration semantics explicit, and makes coverage auditable everywhere the tripwire reports. The remaining discovery limit is stated rather than hidden. The independent review caught and caused two material corrections before ship: moving boot evidence capture ahead of startup migration, and separating enrollment-deviation wording from real boot-to-boot transitions. Focused tests cover the exact two default-on/config-off multi-machine guards, legacy-snapshot enrollment, denominator propagation, no-repeat behavior, endpoint compatibility, and build/lint health. The revised change is clear to ship.

---

## Second-pass review (required: guard-related change)

**Reviewer:** `guard_posture_review`
**Independent read of the artifact:** Concur. The resolved posture is captured immediately after `loadConfig` and before any startup config writer, preserving restart-divergence truth; existing transitions and newly enrolled default deviations use distinct operator wording; the shared union builder gives the tripwire and GET /guards identical keys; and old-snapshot compatibility, dev-gated defaults, denominator arithmetic, one-fire migration behavior, signal-only authority, and machine-local posture remain intact. The reviewer ran 61 focused tests plus typecheck and the guard-manifest lint.

---

## Evidence pointers

- Unit and E2E tripwire lifecycle, including boot-capture ordering and enrollment wording: `tests/unit/monitoring/GuardPostureTripwire.test.ts`, `tests/unit/guardPosture-modelTier.test.ts`, `tests/e2e/guard-posture-tripwire-lifecycle.test.ts`
- GET /guards and load-bearing compatibility: `tests/e2e/guards-endpoint-lifecycle.test.ts`, `tests/e2e/guards-loadbearing-lifecycle.test.ts`, `tests/integration/guards-route.test.ts`, `tests/integration/guards-accept-fallback-route.test.ts`
- Static/build: `npm run lint`, `npm run build`, and `npx tsc --noEmit` pass.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect and no self-triggered actuation controller change — not applicable. This repairs runtime inventory composition in a signal-only detector. The recurrence guard is the shared `buildCompleteGuardPosture` funnel consumed by both the tripwire and GET /guards, pinned by the focused union and server-wiring lifecycle tests.
