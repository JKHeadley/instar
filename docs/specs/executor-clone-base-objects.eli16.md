# Feedback fixes could not start: the copy of the code was missing the newest commit (plain-English overview)

Governing spec: `docs/specs/feedback-triage-and-execution.md` §4 (unchanged). This is a bug fix.

## What was wrong

To fix a reported problem, the feedback executor makes a private copy of the code at the newest version of main. On 2026-10-23 every copy failed: the copy only brings along the commits that local branches point to, and the newest main commit wasn't on any local branch, so the copy couldn't open it. In one run the executor then went down the queue and tried 8 items in two minutes, all failing the same way. The reason was saved with its text blanked out, so nobody could read why.

## What changes

- When the executor fetches the newest main, it also points a local branch (`feedback-execute/base`) at it, so the copy carries that commit.
- After the first failed setup in a run, the executor stops for that run instead of trying the next item. One machine problem now costs one item, not all of them.
- When a step of the sandbox safety check fails, it now saves the last lines of that step's output, not just "exit 1".
- The failure reason is saved where the status page shows it (`lastPrepareFailure`), and the log records which step failed.

## What you need to decide

Nothing.

## Later addition: waiting for a restart that will never come

The pipeline holds off starting a fix while a newer version of the agent is about to be installed, because installing restarts the agent and would cut the fix off halfway. It used to treat "a newer version exists" as "a restart is coming". When automatic installs are switched off, nothing restarts on its own, so the pipeline waited forever. It now waits only when automatic installs are on and an update is pending, which is the same rule the local test runner already uses.
