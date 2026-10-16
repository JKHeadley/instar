# Per-agent tmux socket — removing the shared-parent single point of failure

Status: proposal. Nothing implemented. Raised 2026-10-15 after the 2026-10-14 laptop outage.

## The problem, measured

On Justin's laptop every agent server runs inside **one** tmux server, pid 3034, started Mon Oct 12 19:39 by Dawn's `dawn-interface` session with a cwd under `~/Documents/Projects/the-portal`. That daemon now holds **79 sessions** across five agents (50 `dawn*`, plus sagemind, codey, indra, inspec and echo).

On 2026-10-14 at 16:00:05 PDT macOS withdrew `~/Documents` access from that process tree. 28,382 denials followed in 22 minutes. inspec and instar-codey both died in the same second on EPERM writing their own state files. Access returned around 16:14 and they self-recovered. The agents' own launchd lifelines were untouched, because launchd starts them directly rather than inside the shared daemon.

One daemon, five agents, a single revocable grant.

## Why every agent lands on the same daemon

Instar's tmux calls pass no socket argument:

- `dist/lifeline/ServerSupervisor.js:996`
- `dist/core/SessionManager.js:3171`, `:3505`, `:5666`, `:6201`

A tmux client with no `-L` or `-S` uses `/private/tmp/tmux-501/default`. Whoever starts that server first owns every session created afterwards. Here that was Dawn's interface on Oct 12. Confirmed again after today's reloads: the freshly started codey and inspec servers are children of 3034 once more (`50908 → 3034`, `91583 → 3034`).

A side effect worth naming: the daemon's global environment carries `DAWN_PROJECT_DIR=/Users/justin/Documents/Projects/the-portal`, which every new pane inherits — including agents that have no relationship to Dawn.

## Why the TCC attribution follows the daemon, not the agent

A tmux server daemonises, so its parent becomes pid 1 and its *responsible process* is fixed at first start. Every session inside it inherits that attribution.

Supporting measurement, from inspec's own `.claude/scripts/watchdog-launcher.cjs` (test run 2026-09-04): a launchd job whose program was `/bin/bash` got `Operation not permitted` on Documents (exit 126), while a launchd job whose program was the workspace's `.instar/bin/node` could read it, *"AND via a spawned bash child, which inherits the grant by responsible-process attribution."* TCC charges a process tree to whatever started it.

**Honest limit:** that a *fresh* daemon started by an agent's own lifeline would be charged to that lifeline is an inference, not a measurement. `launchctl procinfo 3034` needs root, and unified-log TCC content is not readable by this user. The inference is consistent with the 09-04 note but has not been demonstrated.

## What this buys, stated conservatively

The data has already moved out of `~/Documents`, so the specific 10-14 failure is addressed by the move plus the boot-wrapper fix. The remaining argument for separation is **blast radius**, not this one bug: today a single daemon can take down ~80 sessions across five agents, for any reason it dies or loses a grant — not only TCC.

This is a resilience change, not a fix for an open fault. It should be judged on that.

## The change

1. **A single chokepoint for every tmux invocation.** Today the calls are spread across `ServerSupervisor`, `TelegramLifeline` and `SessionManager`. Route all of them — `new-session`, `has-session`, `kill-session`, `send-keys`, `capture-pane`, `list-panes`, `list-sessions` — through one helper that supplies `-L instar-<agent>`.

   One missed callsite silently targets the *wrong* daemon, which is worse than not doing this at all: a `kill-session` aimed at the default socket could kill another agent's server. So the chokepoint needs a ratchet test that fails the build on any direct `tmux` invocation outside it.

   Remember the trailing-colon rule: `=session:` for pane-level commands. Adding a socket argument must not disturb that.

2. **Rollout, one agent at a time**, using the bootout/bootstrap procedure already proven on codey and inspec today. The new supervisor starts a daemon on the new socket. The old `<agent>-server` session on 3034 must be killed by the new supervisor or by hand, or two servers will fight over the port.

3. **Leave 3034 alone.** It is Dawn's. Moving it is Dawn's decision and would take ~50 of her sessions with it.

4. **Operator impact, which is the part that needs a human answer.** Attaching changes: `tmux attach -t <session>` becomes `tmux -L instar-<agent> attach -t <session>`. Anyone's muscle memory, scripts or aliases that attach to agent sessions break on the day this ships.

### The smaller lever, and why it is not obviously better

Setting `TMUX_TMPDIR` in the lifeline's environment makes every child tmux call resolve a different default socket, with no code change to the callsites. But it is environment-dependent rather than explicit, it silently moves interactive agent sessions spawned by `SessionManager` as well, and it fails open: a process that loses the variable quietly rejoins the shared daemon. The explicit socket is the honest version.

## The decision for the operator

Only one part is genuinely a human call: **attaching to agent tmux sessions changes**. Everything else is ordinary engineering under standing approval.

If that cost is acceptable, this proceeds as a normal build with the ratchet test and a per-agent rollout.

## Open questions

- Whether a lifeline-started daemon genuinely gets its own TCC attribution — stated above as inference, and worth one measurement before the work is justified on TCC grounds rather than blast-radius grounds.
- Whether `instar doctor` should report "this agent's server is sharing a tmux daemon with N sessions it does not own" so the condition is visible rather than discovered during an outage.
