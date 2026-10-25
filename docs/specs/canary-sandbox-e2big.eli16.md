# Plain-English overview: the sealed workspace's shell could not start

## What this change is

When the feedback pipeline is about to write a fix, it first runs a safety rehearsal (the "canary"). It opens a sealed copy of the code and checks two things: the session inside can do its job (write files, run git), and it cannot reach anything it shouldn't (secrets, other folders, the network).

Since about noon on 2026-10-25 that rehearsal failed on one check: the session's shell could not write a file in its own workspace. The reason was not a permission at all. The shell never started. Each work folder on the machine got its own "do not read, do not edit" rule, and those rules are handed to the shell when it launches. This machine has 2,279 work folders, so the list grew to 4,891 rules and over a megabyte. That is more than the operating system accepts when starting a program. Every shell command failed before it ran, the rehearsal failed eight times, and the pipeline paused itself for a day.

## What already exists

The sealed workspace is protected in two other ways that do not depend on that list. First, the sandbox blocks reading the whole home folder and lets back in only the attempt's own folders. Second, the session runs in a mode where any file the rules don't explicitly allow is refused. The long per-folder list was a third layer on top.

## What is new

- The per-folder list is gone for the work-folders directory. The few top-level entries of the agent's home are still listed one by one; that list does not grow with use.
- The rehearsal gains new checks: a secret file is placed in a neighbouring work folder, and the shell, the file-reading tool, the file-writing tool and the search tool must all fail to reach it, both directly and through a shortcut link placed inside the workspace. So the protection the list used to add is now tested every time, instead of assumed. An independent review asked for the shortcut-link and search cases; a real session was run against them and every one was refused.
- A check that said "git works" when the shell had never started now fails in that case.
- The day-long pause records which version of the rehearsal caused it. When an update changes the rehearsal, a pause from the old version stops counting, so a fix clears its own pause on install instead of waiting out the day.
- A test-only collision is fixed: two copies of the pipeline on one machine could pick the same scratch folder and delete each other's files. Each copy now gets its own. This was making the pipeline's tests fail about half the time.

## Safeguards

Nothing the rehearsal checks was weakened. Every "must fail" check still runs, and the new one covers exactly the folders the removed list covered. If the sandbox ever lets a neighbouring folder be read, the rehearsal fails and nothing runs. Undoing the change is a plain revert.

## What you need to decide

Nothing. This is an internal fix that brings the feedback pipeline back online.
