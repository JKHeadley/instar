# The resume heartbeat reads every session's pane with one tmux call

<!-- bump: patch -->

## What Changed

`TopicResumeMap.refreshResumeMappings()` runs every 60 seconds. To decide which topic sessions have a live pane it ran one synchronous `tmux display-message -t =<name>: -p '#{pane_id}||#{pane_dead}'` per session on the server's main thread. It now runs one `tmux list-sessions -F '#{session_name}||#{pane_id}||#{pane_dead}'` and looks each session up by its exact name (`readLivePanes()`).

The separator is the printable `||` the per-session probe used, not a tab: a tmux client with neither `TMUX` nor a UTF-8 locale in its environment replaces non-printable characters in its output with `_`, which would have made every session read as not live with no error (found in review; reproduced with `env -i`). Lines are read from the right, so a `||` inside a session name is harmless. If tmux answers with lines none of which can be read, the server says so once in its log.

The liveness rule is unchanged: a session counts when its active pane exists and is not dead. A failed call (no tmux server, a timeout, a non-zero exit) reads as no live panes, so that tick writes nothing and every mapping is kept.

## What to Tell Your User

Nothing changes that you will see. The agent's server asks one question a minute about its open conversations where it used to ask one per conversation, which leaves it less likely to stop answering when the machine is very busy.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|------------|
| Resume heartbeat liveness read in one tmux call | Automatic |

## Evidence

Studio, 2026-11-13, a 300-second caller-attributed CPU profile of the live server under test load: the largest synchronous `spawn` share was `refreshResumeMappings <- runResumeHeartbeatTick` (1.5% of wall time), ahead of the session monitor's liveness checks (1.1%). A near-freeze capture the same night (`logs/server-freeze/freeze-20261113T105518Z.txt`, three failed health checks) put 49.7% of the server's self time in `spawn`.

Measured on the Studio with 40 live sessions (tmux 3.7c), three rounds: the per-session calls took 163, 166 and 169 ms in total; the single call took 4, 5 and 4 ms. With the format as shipped, the single call and the per-session calls agreed on pane id and dead flag for all 40 sessions live at the time (36 live, 4 dead), in a full environment, with `PATH` only, with `LC_ALL=C`, and under `env -i`. On a throwaway tmux server, a session with three windows whose current window has two panes read the same in both forms (the active pane of the current window).

Tests: `tests/unit/topic-resume-map-no-guess.test.ts` (16, against 9 before: a session missing from the list, which replaces the old empty-fields case; a listed session with no pane id and unreadable lines; a non-zero exit with readable output; an empty dead flag; a session name containing the separator; one warning when the output cannot be read; 44 sessions cost one call and only the live ones are recorded; exact-name matching), with the existing live, dead and failed-call cases moved to the new output format. `tests/e2e/resume-follows-account-dead-pane-e2e.test.ts` (real tmux) repeats its live and dead pane check through a wrapper with a bare environment (`env -i`, keeping only `PATH` and the lane's `TMUX_TMPDIR`). The shared fake tmux (`tests/helpers/codexArchiveFixture.ts`) and the e2e fakes now answer `list-sessions` for named live sessions, and the shared fake requires the names, which makes it harder for a heartbeat test to pass by skipping every session (an empty or mistyped list still would).
