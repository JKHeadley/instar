# Slow-stub tmux test: give its server an empty home folder (plain-English overview)

**What this is.** `tests/integration/tmux-resilience-slow-stub.test.ts` starts a real Instar server and checks that its health, sessions and status pages answer quickly even when tmux is very slow. One check allows only 1 second.

**What went wrong.** The test server used the real home folder of the machine running the tests. At startup and on a timer, the server's token-usage counter reads every recent Claude transcript under `~/.claude/projects`. On the Studio that folder is about 700 MB, with about 1,400 transcripts from the last 30 days. Reading them kept the server busy for about 6 seconds of CPU, and the health page waited behind it: 1.4 to 2.7 seconds per answer. So the 1-second check failed every time on the Studio, on main and on PR #2825 alike. It was measuring the machine's own history, not the routes.

**What changes.** While its server runs, the test points HOME at its own empty temporary folder, then puts it back. Other server tests already do this.

**What does not change.** No product code changes. The 1-second limit and every other limit stay as they were. Nothing is skipped or retried.

**What to decide.** Nothing. A revert of one test file undoes it.
