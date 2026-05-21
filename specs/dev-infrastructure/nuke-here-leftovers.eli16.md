# What this PR does — in plain English

## The setup

Yesterday's PR (v1.2.8) added a way to uninstall instar from a project
folder in one command. End-to-end testing it on a fresh test project
this morning turned up two pieces it forgot to clean up:

1. The `.gitignore` instar writes during install. After uninstall,
   that file just sat there — an orphan.

2. The `.instar/` folder itself. instar uninstall deletes it, but then
   the very next step in the uninstall — a logging operation — wrote
   a tiny audit-trail file back into `.instar/audit/`, recreating the
   folder. So uninstall finished and left an empty `.instar/` behind
   with a single line of logging in it.

Both bugs were small but they made uninstall NOT actually clean.

## The fix

For the `.gitignore` problem: treat it the same way uninstall already
treats `CLAUDE.md` and `AGENTS.md`. Git is the source of truth — if
the file was committed before instar was installed, keep it (or restore
it from git if instar modified it). If instar created it from scratch,
delete it.

For the audit-trail problem: change the order things happen during
uninstall, and turn off the audit log for the very last step. Now
uninstall first cleans up everything except `.instar/`, then deletes
`.instar/` LAST with logging silenced. After uninstall finishes, there
is nothing for the audit log to write to — and nothing left behind.

## Why it matters

Without these fixes, the install/uninstall/reinstall test loop on a
fresh project (which is what Justin was actually trying to do this
morning) leaves leftovers each cycle. After a few cycles you can't
tell whether you're testing a clean state anymore. The fix makes
uninstall actually mean uninstall.

## What it doesn't change

The uninstall contract for everything else is unchanged. The
identity-shadow files still get the same git-aware treatment. The
secrets backup, the tmux session kill, the auto-start removal, the
registry unregister — all unchanged. This PR only closes the two
specific leaks the end-to-end test surfaced.
