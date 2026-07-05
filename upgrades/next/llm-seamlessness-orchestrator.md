## What Changed

Adds a lease-gated background loop that ANTICIPATES which of an agent's working-set files a conversation
will need next and PROPOSES a bounded, side-effect-free preload — so on a multi-machine setup the right
files are already warm when a conversation moves, instead of being fetched on-demand. It is deliberately
**propose-only**: the LLM never moves a conversation itself (placement stays with the existing deterministic
planner); it only ranks preload candidates and, when a cheap deterministic ranking already has a clear
winner, it doesn't spend an LLM call at all. It ships **dark** on the fleet (a dev-agent gate resolves it
off) and **dry-run-first** even on a development agent — the loop logs what it WOULD preload and actuates
nothing until an operator flips it live, one increment at a time.

## What to Tell Your User

⚗️ Experimental and off by default — nothing changes until you turn it on, and even then it starts in a
dry-run mode where it only observes and never acts. When eventually enabled on a multi-machine setup, it
quietly pre-warms the files a conversation is likely to need next so a move between your machines feels
seamless. It can never move a conversation on its own — that decision stays with the deterministic system
you already have — and it runs on only one machine at a time, backs off under load, caps itself hard
(at most a few suggestions per cycle, a long cooldown per conversation, and it blacklists anything that
starts thrashing), and has a strict spending cap on the AI calls. On a single-machine setup it does nothing.

## Summary of New Capabilities

- New `SeamlessOrchestratorEngine` (pure, lease-gated, deterministic-first ranking with the LLM as an
  A/B-lift-gated residual on a low-priority queue lane) + `OrchestratorActuator` (guarded, propose-only,
  audit-before-actuate, dry-run actuates nothing) + `OrchestratorPoller` (15-min cadence, idle-backoff,
  error-breaker) + `OscillationBreaker` (blacklists a thrashing conversation).
- `POST /intelligence/seamless-orchestrator/tick` (a manual soak tick) + `GET /intelligence/seamless-orchestrator/audit`
  (the audit tail + last-tick surface); both 503 when the feature is dark.
- `multiMachine.seamlessOrchestrator` config block (dry-run-first; the dev-agent gate resolves `enabled`),
  delivered to existing agents on update via config-defaults deep-merge.

## Evidence

- 36 tests green (engine, actuator, poller, oscillation-breaker unit tests + the HTTP route integration test).
- `tsc --noEmit` clean; all four constitutional-enforcement ratchets green locally (dark-gate, write-domain,
  no-silent-fallbacks, compaction-parity).
- Dark-ship verified: the dev-agent gate resolves the feature off on the fleet (never constructed); the
  dry-run default actuates nothing even on a development agent. The four live-flip prerequisites are tracked.
