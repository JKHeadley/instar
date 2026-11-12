# ELI16 — Giving the integration tests 45 minutes instead of 30

Before any change merges into Instar, the Studio machine runs the whole test suite on it. That check is split into three lanes that run side by side: quick unit tests, integration tests (which start real servers), and end-to-end tests. Each lane has a stopwatch. If a lane is still running when its stopwatch runs out, the whole check is marked as an error and the change cannot merge.

The integration lane's stopwatch was 30 minutes. Since yesterday afternoon the Studio has been busy with a dozen other working sessions, and its integration lane — which on this machine runs as a single process — has been taking 36 to 42 minutes. No test failed. The lane simply could not finish in time, so every change in the line failed and was sent to the back. Two small changes passed late at night when the machine was quiet, which is how we know it's load and not a broken test. We tried running the lane as two processes instead of one; it was still too slow, so we put that setting back.

What changes: the integration lane now gets 45 minutes, the same as the end-to-end lane already has. What does not change: every test still runs, a failing test still fails the check, and the whole check still has its overall two-hour limit. The only cost is that a genuinely stuck test is noticed up to 15 minutes later.

Why this and not something cleverer: a limit that adapts to how busy the machine is would be better, and that idea is filed as a bug report. But the operator asked for the simple fix that unblocks the merge line now, and this is a one-number change that is trivial to undo.
