<!-- bump: patch -->
<!-- internal-only -->

## What Changed

The reaper real-tmux integration test no longer fails on a busy machine when it lists processes. It now allows up to 64 MiB of `ps` output instead of node's 1 MiB default, and its error message includes node's own error text. Test-only; no runtime change.

## Evidence

On the Studio, `ps -eo pid,ppid,command` is about 709 KB when idle. Forcing a small buffer reproduces the failure exactly: status null, empty stderr, ENOBUFS, which the old helper printed as `ps failed: ` and nothing else. Three tests failed that way on main (23:07Z) and on the PR #2825 verify.
