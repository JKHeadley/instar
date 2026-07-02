<!-- bump: minor -->

## What Changed

Two mesh-transport reliability features land together (shared health-snapshot seam;
specs `docs/specs/u4-3-breaker-recovery-probe.md` + `docs/specs/u4-5-rope-health-alerts.md`).

**U4.3 — traffic-independent rope recovery probe.** The hedged mesh dialer starves dead
ropes: the healthiest rope wins inside the hedge window and the losers are cancelled, so a
rope marked dead was never re-dialed — and (the second arm) a cancelled recovering dial's
AbortError was recorded as a real failure, letting the winner perpetually reset the loser's
recovery streak. That is how a healed Tailscale rope stayed presumed-dead for a week. The
fix: (1) hedge-abort neutrality in `HttpLeaseTransport` (an abort-after-winner records
nothing; a real dial failure still records), and (2) a `RopeRecoveryProber` riding the
existing ~5s lease-pull tick that re-dials dead ropes with a pinned, signed, bogus-uid
canary (typed-refusal contract — an untyped 2xx never closes a rope) and feeds
`PeerEndpointResolver.recordResult`, the ONE health authority. Episode-scoped probing (no
permanent limbo after a partial recovery, no hot-loop on a slow-but-alive rope), P19
Eternal-Sentinel floor (15 min cap, escalate-once per episode), dry-run-first. Per-(peer,
kind) state serves on the authed `GET /health` → `multiMachine.syncStatus.ropeHealth`.

**U4.5 — rope-health alerts.** A productized in-server `RopeHealthMonitor` (own bounded 30s
loop) classifies each peer from the U4.3 snapshot: `ok` / `degraded` (digest-only) /
`peer-offline` (heartbeat stopped — a lid-close is NEVER urgent) / `urgent` (all ropes down
while the peer's git-synced heartbeat still ADVANCES — advancement-since-onset semantics,
honest 30-90 min confirmation latency, ONE HIGH attention item per episode, split-brain item
wins). Tailscale key expiry warns at 14 days via a bounded hourly `tailscale status --json`
exec (fixture-registered parser; identifying fields never leave it). New `GET
/mesh/rope-health` + a daily `rope-health-digest` built-in job (enabled with a 503-silent
body; delivery only where `monitoring.ropeHealth.digestTopicId` is set). The self-wake
urgent suppression is HARD-BOUNDED (5 min) because SleepWakeDetector emits false wake
events under event-loop stalls (audit finding P1-A7) — a spurious sleep signal can delay a
partition alert, never veto it.

Both ship dev-gated (`multiMachine.meshTransport.recoveryProbeEnabled`,
`monitoring.ropeHealth.enabled` omitted → live on development agents, dark on the fleet);
G3 loadBearing guard-manifest entries with 30-day soak windows; single-machine installs are
strict no-ops.

## Evidence

- Unit: 26 U4.3 tests (episode scoping incl. the limbo case, hedge-abort neutrality both
  sides, typed-contract classifier over captured byte-for-byte /mesh/rpc fixtures, P19
  simulated-day bound in both all-fail and all-succeed arms, dry-run scheduling honesty) +
  29 U4.5 tests (classifier both sides of every boundary incl. the lid-close false-alarm
  arm and the between-heartbeats late upgrade, bounded wake grace with the P1-A7
  spurious-sleep test, episode-key determinism + adjacent grouping, transition-only writes,
  state round-trip, content scrub, captured tailscale fixtures).
- Integration: authed `/health` carries `ropeHealth` while an unauthed caller sees no mesh
  topology; `GET /mesh/rope-health` 503-dark/200-live with episode-deduped counters.
- E2E: production-path gate resolution → prober rides the REAL coordinator lease-pull tick
  (lastProbeAt advances, recordResult reaches the same resolver instance); monitor's own
  30s loop ticks and tears down; dark → zero probes, no timer, route 503.

## What to Tell Your User

When you run me on more than one machine, my machines talk over several network "ropes"
(Tailscale, local network, Cloudflare). Two quiet failure modes are now fixed: a rope that
came back to life used to stay marked dead for days — now I re-check dead ropes myself and
put them back in service within minutes. And when something genuinely goes wrong I tell
you honestly: a broken-but-recoverable rope shows up in a daily one-line digest, a machine
that is simply asleep never triggers an alarm, and only a machine that is provably alive
yet unreachable (a real partition) raises one urgent notice — once, not a flood. These are
still maturing: they run on development agents first and stay off elsewhere.

## Summary of New Capabilities

- `GET /mesh/rope-health` — per-peer rope classification + episode state + daily digest
  text (503 while dark).
- `GET /health` → `multiMachine.syncStatus.ropeHealth` (authed only) — per-(peer, kind)
  rope health + probe scheduling state.
- `rope-health-digest` built-in daily job (log-only until
  `monitoring.ropeHealth.digestTopicId` is set).
- Config: `multiMachine.meshTransport.recoveryProbe*` knobs; `monitoring.ropeHealth.*`.
- CLAUDE.md template section "Mesh Rope Health (recovery probe + partition alerts)"
  (new agents via init, existing agents via migration, Codex/Gemini via shadow markers).
