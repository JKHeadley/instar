# Fixing the thing that generates the job instructions — Plain-English Overview

> The one-line version: last change fixed the printout; this one fixes the printer, because the printer would have re-printed the broken version.

## The problem in one breath

The previous fix repaired six job instruction files. It turns out those files are **generated** from a master list elsewhere in the code — and that master list was never fixed. Anyone regenerating the files would have quietly undone the repair, and everything would still *look* fine.

That is the same trap this whole family of bugs keeps setting: a change that looks exactly like a real fix until something routine wipes it.

## What already exists

- **The master list** — one place in the code that defines every built-in scheduled job: when it runs, what it checks, and the instructions it follows.
- **The generator** — a small script that turns that master list into the individual instruction files that ship to your agent.
- **The build-time check from last time** — scans the *generated* files for jobs that call a locked door without a key.

## What this adds

**The check now also reads the master list**, not just the files it produces. That's the actual fix: the previous check guarded the output while the input stayed broken.

Along with that:

- **Thirteen jobs** in the master list now carry the key. Twelve were already known. The thirteenth — a job that retries failed feedback delivery — was found *by the new check*, not by me, and confirmed broken.
- **Twelve places** were reading the key from a stored copy on disk instead of the live one. On a machine where the stored copy has gone out of date, that copy is rejected. They now prefer the live one.
- **The reflection job's activity summary was completely empty** — and worse than reported. Its filter looked for two event types that never occur, and it read four field names that don't exist. On top of that, the version in the shipped file had lost some punctuation, which made it not just wrong but a **syntax error** — silenced, so it failed invisibly. Every reflection has been running on a blank page. Now it filters the event types that actually occur, reads the fields that actually exist, and adds a short count summary so the reflection can see how busy things were.

## The safeguards

**The check was caught lying, and fixed.** Its first version passed cleanly against the broken master list — not because the list was fine, but because its pattern didn't match the way text is written there. A check that passes for the wrong reason is worse than no check, because it hands you confidence you didn't earn. It now reads the *actual resolved jobs* rather than pattern-matching source text, and it refuses to report "clean" if it somehow finds no jobs to inspect.

**It immediately proved itself.** The rewritten check found a broken job I didn't know about. That's the difference between a check that describes a fix and one that does work.

**It was proven against the broken version first.** Turn the fix off, and the check reports all thirteen problems. Turn it on, and it reports none.

**Documentation examples aren't punished.** The master list file also contains example commands written for humans to read. Those are deliberately not treated as real jobs, so the check doesn't flag prose.

## What ships when

All together — the master-list fixes, the reflection digest repair, and the widened check.

## What's deliberately left for later

The generated files and the master list have drifted apart over time in other, harmless-looking ways. The **key-and-lock** problem is now closed on both sides, but a full reconciliation of all fourteen generated files is a separate job with its own review. It's written down and tracked rather than quietly forgotten.

## If it goes wrong

Undo the change and ship a patch. Nothing is stored, nothing is migrated. Worst case is a return to quiet jobs that don't do anything — the same benign fallback as before.
