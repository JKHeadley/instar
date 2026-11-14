# Reaper tmux test: read the whole process list (plain-English overview)

**What this is.** One of our integration tests checks how the session reaper sees processes inside a real tmux pane. To confirm what it is testing, the test asks the computer for a list of every running process, using the `ps` command.

**What went wrong.** Node only keeps up to 1 MiB of a command's output unless told otherwise. On a busy machine the process list is bigger than that. The Studio's list is about 709 KB even when idle and grows during a full test run. When the list goes over the limit, node stops the command and reports "buffer full". The test only printed the command's own error text, which was empty, so the failure read "ps failed:" with nothing after it. Three tests failed that way, on main and on PR #2825. People had called it a flake.

**What changes.** The test now allows up to 64 MiB of output and includes node's own error text in its message. If it ever fails again, the message will say why.

**What does not change.** No product code changes. The reaper itself, timeouts and retries are untouched, and no test is skipped. The other test that failed in the same run, tmux-resilience-slow-stub, is a separate matter: it never reads the process list, and this change does not touch it.

**A related finding.** The server's own process checks have the same 1 MiB default. They fail safe (they keep sessions rather than end them), but on a very busy machine the reaper can stop seeing idle sessions. That is filed separately so it gets its own review.

**What to decide.** Nothing. This is a small test repair that a revert fully undoes.
