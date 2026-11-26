# The memory-guard test counted the wrong thing

## What this is

A few hours earlier a test was added to prove that Instar refuses to start a scheduled job when the computer is short of memory. The test closes the memory guard on purpose, asks for a job, and checks that the job was refused and that nothing was started.

## What went wrong

To check that nothing was started, the test looked at a log kept by a stand-in program that plays the part of the AI tool, and required that the log hold exactly one "launched" line: the one from an earlier step of the same test. But the stand-in writes a line for every call it receives, whoever makes it. On a busy machine one extra call from the earlier job arrived, the log held two lines, and the test failed although the refused job had started nothing. It failed the full test run of an unrelated feature on 2026-11-16 and cost that feature a 35-minute re-run.

## What changes

Only the test. Instead of counting every line in that shared log, it now asks the terminal manager directly whether a session exists that carries the refused job's own name. That question has one answer no matter what else is happening on the machine. The rest of the test is untouched: it still checks that the request was refused, that the refusal was recorded as a memory refusal exactly once, and that no run was recorded for the job.

## What keeps it safe

The product is not changed, and the test still proves the same thing: a job refused for memory starts nothing. The new check is narrower, not weaker: it looks for the refused job specifically. If the guard ever stopped working and the job did start, a session with its name would exist and the test would fail.

## What you need to decide

Nothing. This corrects a mistake in a test written earlier the same night.
