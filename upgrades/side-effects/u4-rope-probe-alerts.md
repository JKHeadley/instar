# Side-Effects Review — U4.3 rope recovery probe + U4.5 rope-health alerts

**Version / slug:** `u4-rope-probe-alerts`
**Date:** `2026-07-02`
**Author:** Echo (autonomous)
**Second-pass reviewer:** not-required (Tier 2; specs converged + approved — codex-cli:gpt-5.5 cross-model review, 4 + 5 iterations; both features dev-gated dark on the fleet)

## Summary of the change

One shared PR for the two converged U4 specs (`docs/specs/u4-3-breaker-recovery-probe.md`,
`docs/specs/u4-5-rope-health-alerts.md`) — they share the `PeerEndpointResolver.snapshot()`
seam (U4.3 builds it, U4.5 consumes it).

**U4.3** fixes hedge-winner-abort starvation of dead mesh ropes:

- `src/core/HttpLeaseTransport.ts` — hedge-abort neutrality (R-r2-1): an
  AbortError caused by the hedge winner's `finish()` records NOTHING (never
  `recordResult(false)`); a real dial failure still records. New exported
  `isAbortShapedError`.
- `src/core/PeerEndpointResolver.ts` — the `snapshot()` read seam (rows are
  copies; kind+counters only, no URLs).
- `src/core/RopeRecoveryProber.ts` (new) — episode-scoped prober riding the
  lease-pull tick; feeds `recordResult` on the ONE health authority; P19
  Eternal-Sentinel floor + escalate-once; dry-run keeps a shadow streak and
  never mutates health.
- `src/core/ropeProbeContract.ts` (new) — the typed G4 canary payload contract +
  the REGISTERED `parseProbeResponse` classifier (captured byte-for-byte
  fixtures).
- `src/core/MultiMachineCoordinator.ts` — `attachLeasePullTickListener` (the
  carrier; error-isolated) + `attachRopeHealthProvider` → `getSyncStatus()`
  serves `ropeHealth` on the authed /health branch only.
- `src/commands/server.ts` — dev-gated wiring (probe client, registry-validated
  target list, feature metrics `rope-recovery-probe`, attention sink).

**U4.5** productizes rope-health alerting:

- `src/monitoring/RopeHealthMonitor.ts` (new) — own bounded 30s loop;
  deterministic classifier (ok / degraded / peer-offline / urgent) with the
  R-r3-1 advancement-since-onset heartbeat discriminator; episode-deduped ONE
  HIGH item; split-brain-item suppression; sustained-clear; transition-only
  durable state (`state/rope-health.json`, registered + retention-declared);
  BOUNDED self-wake grace (P1-A7 hazard documented in-code); detected-not-
  notified retry; content scrub by construction.
- `src/core/tailscaleStatusParser.ts` (new) — REGISTERED parser for the hourly
  bounded `tailscale status --json` exec; only role + KeyExpiry leave it.
- `src/server/routes.ts` — `GET /mesh/rope-health` (503 when dark; `?digest=1`
  records the digest-emission metric).
- `src/scaffold/templates/jobs/instar/rope-health-digest.md` (new) — daily
  tier-1 job, enabled with a 503-silent body (argued divergence from the
  feedback-factory precedent, R-r2-7/R-r3-2); log-only until
  `monitoring.ropeHealth.digestTopicId` is set.
- Config/registry parity: `types.ts` + `ConfigDefaults.ts` (both features'
  knobs; `enabled` OMITTED — dev gate), `devGatedFeatures.ts` (ropeRecoveryProbe
  + ropeHealthAlerts with written justifications), `guardManifest.ts` (both
  loadBearing G3 entries, 30-day soak), `templates.ts` + `PostUpdateMigrator.ts`
  (the "Mesh Rope Health" CLAUDE.md section, migrator + shadow markers),
  `CapabilityIndex.ts` (mesh prefix note), state-coherence registry,
  `upgrades/next/u4-rope-probe-health-alerts.md`, site docs page.

## Decision-point inventory

- **Modified — `HttpLeaseTransport` attempt catch**: the abort-after-winner
  discriminator (`signal.aborted && isAbortShapedError`). Fail direction: an
  ambiguous rejection (aborted signal + abort-shaped error while a winner
  confirmed) records NEUTRALLY — health truth is fed only by REAL dial
  evidence. A real failure (timeout fires the merged signal only) still records.
- **Added — probe eligibility (RopeRecoveryProber episodes)**: opens on dead,
  survives fail-after-partial-recovery (the limbo fix), closes only on
  lastKnownGood reclaim; cadence owned by the probe layer in BOTH modes (never
  the resolver's trivially-true 5s). Bounded by the P19 floor in dry-run too.
- **Added — probe success classifier (`parseProbeResponse`)**: success is the
  EXACT typed contract (403 not-router / 200 sender-rejected ack); an untyped
  2xx, malformed body, auth rejection, or unexpected ACCEPTANCE records as
  failure — any-2xx can never close a rope.
- **Added — urgent classifier (RopeHealthMonitor)**: urgent requires all-down +
  post-onset heartbeat + time-pinned debounce + ≥2 observations; every ambiguous
  arm (absent rows, unreadable heartbeat, registry-offline, pre-onset beat)
  fails toward NOT-urgent (peer-offline/unknown). The wake-grace suppressor is
  HARD-BOUNDED (wakeGraceMaxMs, default 5 min) so the known-false SleepWakeDetector
  wake events (P1-A7) can delay but never veto a partition alert.
- **Added — split-brain suppression**: an active split-brain state suppresses the
  monitor's item (one episode, one ask). Fail direction of an unreadable check:
  raise (a possible duplicate ask, never a silent partition).

## Roll-up across the seven review dimensions

1. **Over-block**: none. Nothing gates user messages. The tone/coherence gates
   are untouched. The only "block"-shaped behavior is the probe refusing to
   count an untyped 2xx as recovery — the conservative direction for a healer.
2. **Under-block**: the hedge-abort neutrality REMOVES failure records for
   winner-cancelled dials. Bounded: the neutrality branch requires the hedge
   controller's signal aborted AND an abort-shaped error; a rope that is
   genuinely failing still accumulates failures from its own real dial errors,
   and the prober now guarantees dead ropes are re-verified (strictly more
   evidence flows than before).
3. **Level-of-abstraction fit**: health truth stays in the ONE authority
   (PeerEndpointResolver.HealthRecord); the prober holds SCHEDULING state only;
   the monitor holds CLASSIFICATION state only; the parser owns the scrub
   boundary. No second state machine (spec Decision 1).
4. **Signal-vs-authority compliance**: both features are SIGNALS. The probe
   feeds evidence into the existing health machinery; the monitor only raises
   attention items (episode-deduped, split-brain-suppressed) and serves reads.
   Every error path fails toward silence/no-emit; no silent try/catch (each
   carries `@silent-fallback-ok` with the fail direction named).
5. **Interactions**: the probe rides the lease-pull tick via an error-isolated
   listener (a throwing scan never breaks the pull — e2e-tested); the monitor
   subscribes to SleepWakeDetector 'wake' (read-only); both read the machine
   registry/heartbeat read-only. The digest job reads one route. No shared
   mutable state beyond the resolver's own recordResult funnel.
6. **External surfaces**: the probe dials peers' OWN registry-validated mesh
   URLs (resolver.resolve output — URL-shape + LAN-gate validated) with a
   signed, deliberately-unresolvable canary the peer answers with a typed
   refusal; it never rides the router-forward funnel, so no user-facing
   sender-rejection notice can fire. The tailscale exec is local, bounded (5s
   timeout), absent-CLI-tolerant. Alerts are content-scrubbed (kind + nickname
   only). Both features dark on the fleet (dev gate); probe additionally
   dry-run (sends probes, never mutates health).
7. **Rollback cost**: low. `recoveryProbeEnabled:false` → zero probes, no orphan
   state (the HealthRecord is the same store traffic feeds);
   `monitoring.ropeHealth.enabled:false` → monitor inert, route 503s, the state
   file is inert data. The transport neutrality fix is a one-hunk revert.

## Evidence pointers

- `npx tsc --noEmit` — clean.
- Unit: `RopeRecoveryProber` 14/14, `hedge-abort-neutrality` 3/3,
  `ropeProbeContract` 5/5 (captured fixtures), `peer-endpoint-resolver-snapshot`
  4/4, `RopeHealthMonitor` 22/22, `tailscaleStatusParser` 7/7 (captured
  fixtures).
- Integration: `mesh-rope-health-route` 7/7 (authed /health ropeHealth +
  unauthed exclusion; route dark/live; digest metric; episode-dedup counters).
- E2E: `rope-recovery-probe-alive` 3/3 (real coordinator lease-pull carrier;
  recordResult reaches the SAME resolver; dark = zero probes),
  `rope-health-alerts-lifecycle` 5/5 (production gate path; own 30s loop ticks
  + tears down; dark = 503 + no timer; real heartbeat file drives the
  discriminator).
- Ratchets green: full `npm run lint` battery (incl. dark-gate golden map
  hand-updated, guard-manifest, scrape-fixture realness, state registry +
  retention), `feature-delivery-completeness` 111/111, docs-coverage ≥
  thresholds.
