<!-- bump: patch -->

## What Changed

The lifeline no longer restarts a healthy server when its tmux check gets no answer. Only tmux saying the session is missing counts as gone; any other failure is logged, and the health checks decide. A write to a closed pipe no longer crashes the server, and a fatal crash line now includes the stack.

## What to Tell Your User

Your agent should restart less often for no clear reason. Before, a brief hiccup on the machine could make the agent's watcher restart a server that was working, which dropped work in progress. Nothing for you to do.

## Summary of New Capabilities

None. This is a reliability fix.

## Evidence

On 2026-11-06 the Studio's Echo server crashed twice on `write EPIPE`, and the lifeline logged the session as gone five times while the server log kept running. The released build reproduces the crash line with a stdin write to a child that closed its stdin; the patched build stays up. Unit and e2e tests cover both sides.
