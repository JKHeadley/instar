# Automatic kills now need proof of ownership: plain-English overview

## What happened

On 2026-09-29 and 30, six `claude -p` builder processes on the Mac Studio died
with exit 137. That means something sent them SIGKILL. Each one was waiting on
its own long test run. The live agent server's audit logs showed nothing for
those times. At the same times, leftover tmux sessions named
`instar-test-<random>-job-fast-test-<id>` kept appearing on the machine. They
come from integration tests that start a real SessionManager in a throwaway
folder. So the first suspicion was that a test instance was killing processes
it did not own.

## What we know, and what we do not

We still do not know what killed those six builders. A live repro, with a
`claude`-shaped process running beside a full scheduler test, left that
process alone. The macOS kernel log shows no memory-pressure kill in the
03:15-03:50 window. Neither of those proves that no instar path did it.

What the search and a review did find: several automatic kill paths chose
their target by a NAME, a keyword or a bare process ID. None of those is
proof that this instance started the target. A process ID can be handed to a
new process after the old one exits, and this machine goes through its IDs
about every half hour. A tmux session name can be recreated by anyone. This
change makes every one of those paths prove ownership first. When it cannot
prove ownership, it does not signal anything. It logs or reports instead.

## The rule, and the one small check behind it

A process is "ours" only if its process ID AND its start time match what we
recorded when we started it. A tmux session is "ours" only if it carries the
exact identity we recorded: the session ID that instar sets inside every
session it spawns, or tmux's own unique session number. A matching name or a
keyword in the command line is no longer enough.

## What changed, path by path

1. **`instar lifeline restart` fallback.** This runs only when `launchctl`
   fails. The lifeline lock file and startup marker now record the lifeline's
   start time. The fallback signals a recorded process ID only while the
   process at that ID still has that start time. That check runs again before
   the delayed SIGKILL. A record with no start time (written by an older
   version) is never signalled.
2. **Lifeline startup takeover.** When a new lifeline finds a lock held by a
   process that looks stuck, it terminates that process only if it is proven
   to be the old lifeline. If the process at that ID started after the lock was
   written, the ID has been reused: the new lifeline takes the lock without
   signalling anyone. If ownership is unclear, it leaves the lock alone.
3. **Threadline pipe sessions.** The spawner records tmux's unique session
   number and the pane's process ID. At timeout or shutdown, it kills only that
   exact session. It no longer kills a newer session that reuses the name, or
   a process group whose pane has gone. If a `pipe-<thread>` session it did
   not start already exists, it refuses to spawn rather than killing that
   session.
4. **Triage sessions.** The name comes from the project folder's basename,
   and another project can share that basename. A triage spawn now replaces an
   existing session only if that session carries the ID of one of this
   agent's own session records. Otherwise it refuses.
5. **Orphan reaper.** Automatic orphan cleanup used to trust a session name
   that the agent had ever recorded. Now it also requires the live session to
   carry this agent's own recorded session ID. A process in a session that only
   reuses such a name is reported and never killed. The delayed SIGKILL after
   SIGTERM checks the start time again, and so does the operator-requested
   kill.
6. **Test fixtures.** Two old integration tests cleaned up by broad name
   prefixes (`akit-integ-`, `akit-sched-`). Those prefixes could match sessions
   they never made. Those calls are removed. The shared helper's `cleanup()`
   removes only the sessions named after its own unique temp folder. The
   scheduler test now waits for any job spawn still in progress before it
   cleans up. Before, a spawn that finished after cleanup left a dead
   `instar-test-*-job-fast-test-*` session behind.

## What stays the same

Cleanup of sessions this agent can prove it started still happens. The tests
show that the orphan pass still reaps an owned orphan, that pipe cleanup
still kills the spawner's own session, and that triage still replaces its own
session. Nothing new runs on a schedule. Nothing is migrated.

## What to decide

Nothing. This change only narrows what gets signalled. If builders keep
dying, the cause is outside these paths. The next step is to capture the dead
builder's own PID and command at the time, which the builder charter's
"Exit 137" step now asks for.
