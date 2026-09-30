# Test runs and repair paths no longer kill processes they did not start: plain-English overview

## What happened

On 2026-09-29 and 30, six `claude -p` builder processes on the Mac Studio died
with exit 137. That means something sent them SIGKILL. Each one was waiting on
its own long test run. The live agent server's audit logs showed nothing for
those times. At the same times, leftover tmux sessions named
`instar-test-<random>-job-fast-test-<id>` kept appearing on the machine. They
come from an integration test that starts a real SessionManager in a
throwaway folder. So the first suspicion was that a test instance was killing
processes it did not own.

## What the investigation found

We read every kill path a SessionManager or a test fixture can reach:

- Zombie cleanup, dead-job-pane cleanup, triage respawn and the age limit.
- The orphan reaper, the session watchdog, the external-hog sentinel and the
  test-runner limiter.
- The fixtures under `tests/integration` and `tests/e2e`, and `test-as-self`.

Each one picks its targets from its own records. It uses the tmux sessions it
spawned and named with its own unique folder name, or it walks the process
tree down from its own panes. The fixtures that kill the whole tmux server use
a private socket. The macOS kernel log shows no memory-pressure kill in the
03:15-03:50 window. A live repro, in which a `claude`-shaped process sat
beside a full run of the test, left that process untouched.

So no test-instance path explains those deaths. The search did turn up three
real problems, and this change fixes all three:

1. **The leaked sessions.** `scheduler-basic` tried to clean up sessions whose
   names started with `akit-sched-`. The SessionManager actually names them
   after the project folder, so every run left one dead session behind.
   Thirteen had built up. Now the shared test helper's `cleanup()` removes the
   sessions named after its own unique folder. That covers every test that
   uses it.
2. **`instar lifeline restart`'s fallback.** When `launchctl` fails, it ran
   `pkill -KILL -f '<agent>.*lifeline'`. That pattern matches any command line
   that contains both words. A builder whose prompt names
   `/agents/echo/...` and mentions the lifeline would be SIGKILLed. Now it
   signals only the lifeline's own recorded pids: the process holding the
   lifeline lock and the one in its startup marker. It checks that each is
   still a lifeline process first.
3. **Threadline pipe sessions.** On timeout or shutdown, the code
   SIGKILLed the whole process group of the recorded pane pid, even after the
   pane had gone away. A process ID can be reused, and this machine goes
   through its IDs about every half hour, so a stranger's process group could
   be killed. Now the group kill happens only while that pid is still the
   session's pane. Every tmux target in that file is also now an exact match.

## What stays the same

Nothing else about sessions, jobs, or cleanup changes. The live server's
reaping behaviour is untouched. Every change only narrows what may be
signalled.

## What to decide

Nothing. This is a safety tightening with a regression test. If the builder
deaths continue, the cause is outside these paths. The next step is to record
the dead builder's own PID and command, which the builder charter's "Exit 137"
step now asks for.
