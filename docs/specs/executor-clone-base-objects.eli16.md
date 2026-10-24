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

## Two follow-up fixes from the independent review

An outside reviewer found two problems in this change. First, when the safety check failed, we saved a short piece of its error output, but we cut it short *before* removing anything that looked like a password. Cutting first can remove the word "password=" while keeping the password itself, and then the cleaner no longer recognises it. Now we keep whole lines, hide the check's own secret test value, clean the text, and only then shorten it. Second, the executor pauses while a software update is about to restart the server. But if an update keeps failing to install, it stays "pending" forever, and the executor would pause forever too. Now that pause only counts for six hours; after that, the executor carries on. A second review pass found that joining the lines together before cleaning could still split a password's label from its value when they sat on different lines, so the cleaning now happens on the complete, untouched output first. A third pass found that hidden terminal colour codes could split a password so the cleaner missed it, and were only removed afterwards; now those codes are removed first, before any cleaning. A fourth pass found that a password with unusual characters is not recognised by the cleaner at all, so now any line that mentions a password, token, key or similar is simply left out of the saved message, along with the line after it.
