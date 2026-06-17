# AutonomousProgressHeartbeat — liveness backstop for a silent-to-user autonomous run

## What Changed

A new background watcher (sibling to the silently-stopped trio) that posts ONE honest, observational line when an autonomous run has gone quiet to the user past a threshold **AND** the terminal shows genuinely fresh output. It covers the *"busy-but-silent"* failure mode — a heads-down build emitting no heartbeat for an hour, indistinguishable to the user from a stall.

- Hedged, movement-gated wording — never a bare timer, never a false "still working" claim on a frozen screen.
- Real per-run cooldown/backoff (not the inert duplicate-suppressor); content scrubbed for secrets/paths; cross-machine-move guard.
- Read-only status at `GET /autonomous-heartbeat`.
- Ships **dark on the fleet, dryRun-first on dev** (the dev-agent gate). Off everywhere by config until a deliberate flip; signal-only, never blocks or rewrites a message.

## Summary of New Capabilities

- A timer-backed safety net that makes a long autonomous run *legible*: if the agent goes heads-down and silent past a threshold while still genuinely working, it surfaces one hedged "here's where I was" line instead of leaving the user staring at silence.
- `GET /autonomous-heartbeat` — read-only status (active runs, per-run cooldown/backoff, last-emitted).

## What to Tell Your User

If you're running a long autonomous job and the agent goes quiet, it will now occasionally drop a brief, honest note about what it was last doing — so you can tell "busy" from "stuck." It never claims to be working when it isn't, never spams (it backs off), and never talks over a real reply. It's off by default and only runs in observe-mode on a development agent first.

## Evidence

- **Reproduction (observed, 2026-06-16):** during a 24-hour autonomous run (topic 12476), the agent went heads-down fixing a multi-step CI failure for ~60 minutes and emitted zero user-facing messages. From the user's side this was indistinguishable from a stall; the user asked "did the session stall?" The existing silent-freeze watchdog correctly stayed quiet (the terminal WAS changing), and the promise-beacon's liveness line is tuned to once-per-60m — too slow.
- **Before:** "report every ~30m" was a prompt instruction (willpower); a heads-down task blew past it with no structural backstop → an hour of silence.
- **After:** the heartbeat fires on genuine fresh output + user-silence past the threshold, capped by cooldown/backoff → a long run produces a handful of honest liveness lines, not silence and not spam. Verified by 6 e2e "feature is alive" cases (emits when silent+moving; suppressed when mid-move / frozen / dryRun) + 25 unit + 2 integration tests (33 green).
