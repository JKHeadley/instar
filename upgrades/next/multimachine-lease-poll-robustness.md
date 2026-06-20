# Multi-Machine Lease & Poll-Ownership Robustness (Phase 1)

## What Changed

Phase 1 of the permanent fixes for the recurring multi-machine failures (double-handling, total silence, the awake/standby lease flap, the clock-skew-broken cross-machine handshake) from the 2026-06-20 audit. Five tightly-coupled fixes to the fenced-lease + Telegram poll-ownership machinery, all **dev-gated / dark-on-fleet** (live-on-dev, dry-run/observe even there), single-machine no-ops, each with a clean kill-switch:

- **B3 — lease renew timer.** A dedicated renew timer at `clamp(leaseTtlMs×0.5,[5s,60s])` so a held lease is renewed (same epoch) before it lapses, fixing the epoch-climb (default TTL 60s < heartbeat tick 120s → re-acquire every tick). Flag `leaseSelfHeal.resilientRenew`.
- **B4 — skew-immune lease liveness.** The lease's `presumedDeadHolders`/`allPeersPresumedGone` now derive peer liveness from the skew-immune router-observed clock (`routerReceivedAt`) instead of the peer's skew-contaminated `lastSeen` — the flap's root trigger. Plus a `pollingActive` heartbeat field (B5's source). Flag `leaseSelfHeal.skewImmuneLiveness`.
- **B2 — churn breaker.** Implements the previously-dead `leaseSelfHeal.churnDetector`: on >N role flips it latches deterministically to the preferred-awake role (exactly-one-awake resting state) with a hard cap. Observe-only/dry-run.
- **B5 — exactly-one-listener decision.** A three-valued (ok/dual/silence/indeterminate) poller-count decision + pool adapter; a dark peer → indeterminate (never a false alarm), and the Telegram 409 conflict is partition-immune dual-poll evidence. Decision core + `pollingActive` heartbeat propagation (the `/guards` row is a follow-up).
- **B1 — poll-ownership follows the lease.** The server publishes a lease-derived poll-intent file (PID/bootId/ts integrity); the lifeline reconciles its real Telegram poll to it with asymmetric hysteresis (slow-start/instant-stop). Ships dry-run even on dev (changes no ingress); the live flip is gated on the Phase-4 two-host proof + B2/B5 live. Flag `multiMachine.pollFollowsLease`.

No user-facing or fleet behavior changes ship in this PR — every item is dark/dry-run and verified (second-pass, against the live config) unable to disturb the live agent.

## Evidence

- Spec: `docs/specs/multimachine-lease-poll-robustness.md` (converged via /spec-converge, 2 rounds, 6 reviewers + constitution gate; approved). ELI16: `docs/specs/multimachine-lease-poll-robustness.eli16.md`.
- ~48 unit tests across `LeaseCoordinator-resilientRenew`, `leaseLiveness`, `churnBreaker`, `pollerCount`, `pollDecision`, `pollIntent` — all green. `tsc --noEmit` clean; dev-gate-dark + SafeFs containment lints clean.
- Side-effects artifacts (one per increment) in `upgrades/side-effects/mm-lease-poll-robustness-*.md`; each ingress/lease/recovery-touching change had an independent second-pass review (B3's caught + fixed an observe-only-renew edge; B1's lifeline consumer verified dry-run-safe against the live config).
- Tracks CMT-1710 + the 2026-06-20 multi-machine audit.

## What to Tell Your User

Nothing changes for you yet — this PR is dark-shipped infrastructure. Every fix is OFF on the fleet and runs in observe/dry-run mode even on the development agent, so your agent's behaviour is byte-for-byte unchanged. These are the permanent fixes for the multi-machine glitches (two-of-me answering, occasional silence, the "who's awake" role flip-flopping) but they only switch on after a live two-machine test proves them — at which point a separate release will announce it. If your agent runs on a single machine, this is a complete no-op.

## Summary of New Capabilities

No new user-facing capabilities ship enabled in this release. Dark/dev-gated infrastructure added (each with an off-switch, single-machine no-op): a lease renew timer (`leaseSelfHeal.resilientRenew`), skew-immune lease liveness (`leaseSelfHeal.skewImmuneLiveness`), a lease-flap circuit-breaker (`leaseSelfHeal.churnDetector`), an exactly-one-Telegram-listener decision + `pollingActive` heartbeat field, and poll-ownership-follows-the-lease (`multiMachine.pollFollowsLease`, dry-run). These graduate to live (and get their own user-facing announcement) only after the Phase-4 live two-host proof.

### Phase 2 #7 (also in this PR)
Startup config-coherence WARNINGS (never a boot reject): flags `meshTransport.enabled:false` while session transfer is live (the worst-of-both state the 2026-06-20 audit identified) and duplicate/non-positive mesh rope priorities. Logged at boot on multi-machine agents only; single-machine is a no-op. No behaviour change beyond a yellow boot warning.
