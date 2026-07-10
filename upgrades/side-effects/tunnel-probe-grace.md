# Side-Effects Review — Tunnel reachability-probe grace window

**Version / slug:** `tunnel-probe-grace`
**Date:** `2026-07-09`
**Author:** `Instar Agent (echo)`
**Second-pass reviewer:** `not required` (no messaging block/allow, no session lifecycle, no sentinel/guard/gate/watchdog surface — the change tightens an existing tunnel-internal detector's evidence window)

## Summary of the change

`TunnelManager.probeReachability` was a single-shot HTTP probe: one non-ok response (or one fetch error) was enough to declare a freshly-started tunnel unreachable, tear it down, and record `reachability-failed`. For Cloudflare named tunnels the edge routinely serves 530 for a few seconds after the connector registers ("edge propagation"), so the single immediate probe raced that window, killed healthy tunnels, fell through to quick tunnels (which can be rate-limited, error 1015), and stranded the lifecycle in `exhausted` — where the 15-minute post-exhausted retry replays the identical race indefinitely. Observed live on instar-codey 2026-07-09: the manager kept declaring `reachability-failed` while a manually-started connector on the same config served HTTP 200 within ~6 seconds. The change makes `probeReachability` retry across a bounded grace window (default delays 2s/4s/6s → up to 4 attempts, ~12s of waiting plus per-attempt 8s timeouts worst-case), bailing immediately when the manager is stopping. The single-shot probe moves to `probeReachabilityOnce`, unchanged. A new `TunnelManagerInjections.reachabilityRetryDelaysMs` test seam lets tests run the loop with 1ms delays. Files: `src/tunnel/TunnelManager.ts`, `tests/unit/tunnel-manager-rewrite.test.ts` (2 new regression tests), `tests/unit/TunnelManager.test.ts` + `tests/unit/tunnel-consent-state-machine.test.ts` (fast-delay injections so failing-probe paths don't sleep real seconds).

## Decision-point inventory

- `TunnelManager.probeReachability` (all three call sites: `driveTier1`, `runSelfHealCheck`, consent-grant relay start) — **modify** — the reachable/unreachable verdict now requires the full grace window of failures before reading "unreachable"; a single success still reads "reachable" immediately.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

No issue identified. The change is strictly in the permissive direction: everything that previously passed the probe still passes on the first attempt with identical latency; nothing new is rejected.

---

## 2. Under-block

**What failure modes does this still miss?**

A tunnel that is genuinely dead now takes up to ~12s of retry delays (plus up to 8s per-attempt timeout) longer to be declared failed on each provider attempt. That slightly delays fallback to the next provider (quick tunnel / Tier-2 relay) and lengthens `start()`'s failure path at boot. This is bounded and deliberate — the cost of not killing healthy tunnels. An edge that takes LONGER than the ~20s window to propagate would still be misread as unreachable; the window covers the observed single-digit-seconds propagation with margin, and the post-exhausted retry (15 min) remains the backstop for pathological cases — with the crucial difference that each retry now also carries the grace window, so it can actually succeed instead of replaying the race.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The probe is a detector inside TunnelManager; the lifecycle state machine is the authority that acts on its verdict. The fix widens the detector's evidence window rather than adding any new authority or a parallel check. No higher-level gate exists for tunnel reachability that this should feed instead; the lifecycle IS that gate and is unchanged.

---

## 4. Signal vs authority compliance

**Does this hold blocking authority with brittle logic, or does it produce a signal that feeds a smart gate?**

Compliant. The probe produces a boolean signal consumed by the existing lifecycle authority. The change makes the signal LESS brittle (multiple observations before a negative verdict) and adds no blocking authority anywhere. Reference: `docs/signal-vs-authority.md`.

---

## 5. Interactions

**Does it shadow another check, get shadowed by one, double-fire, race with adjacent cleanup?**

- `runSelfHealCheck` (100s cadence while relay-active) now holds its probe up to ~20s longer on a failing Tier-1 attempt. The check is async and single-flight (`_switchingBack` guard unchanged); a slower negative verdict cannot double-fire or overlap the next tick's decision because the self-heal counter reset happens after the probe returns, same as before.
- The `_stopped` bail inside the retry loop means shutdown does not wait out the grace window — `stop()`/`forceStop()` interactions are unchanged.
- The consent-grant path holds the pending-consent nonce cleared BEFORE the probe (unchanged), so the longer probe cannot be raced by a replayed grant.
- No other component reads probe timing; the lifecycle transitions and `recordAttempt` calls are byte-identical in ordering.

---

## 6. External surfaces

**Does it change anything visible to other agents, other users, other systems?**

Boot/`start()` latency on the genuinely-unreachable path grows by the grace window (bounded, seconds). The probe still targets only the tunnel's own `/health` — up to 3 additional HTTP GETs per failed attempt against the agent's own public hostname; no new external calls. No API shape, config schema, or persisted-state change (the new injection field is a constructor-only test seam, not config).

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN.** A tunnel is a per-machine process fronting that machine's own port; its reachability verdict is meaningful only on the machine running the connector. Nothing here replicates or needs a merged read. The existing tunnel-lifecycle attention/notifier surfaces are unchanged. No user-facing notice text changes, no durable state that could strand on topic transfer, no generated URLs.

---

## 8. Rollback cost

**If this turns out wrong in production, what's the back-out?**

Revert the commit and release — the change is a pure code-path change with no data migration, no config schema change, no persisted-state format change. Worst plausible failure mode is the longer failure path at boot (seconds), which is inconvenient, not damaging. No agent state repair needed.
