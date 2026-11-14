# Two safety checks now keep a record each time they run — plain-English overview

## What this change is

Instar has two safety checks for agents that run on more than one machine. Both are switched on in "practice mode" on development agents: they decide what they would do and do nothing for real, so we can watch them before trusting them.

- The **lease hand-back** check: after the "in charge" role (the serving lease) moves to a backup machine, it hands that role back to the machine the operator chose as the main one, once that machine has been healthy for a while.
- The **identity divergence** check: every two minutes it compares what each machine believes about every other machine's signing keys, and flags it if two machines disagree about the same key version.

The weekly review that decides whether practice-mode checks are ready found no record that either one had ever run. The hand-back check only counted things in memory (lost at every restart), and on the main machine it never has anything to hand back, so its counts were always empty. The identity check saved only its latest result and told the safety-status page nothing, so that page graded it "not instrumented".

Now each check writes one line to its own log file every time it does something meaningful:

- `logs/lease-handback.jsonl`: one line when its state changes, when it would hand back or actually offers, claims, steps down or fails, and otherwise one line an hour, so even the main machine shows the check is alive and why it has nothing to do.
- `logs/identity-divergence-monitor.jsonl`: one line per completed comparison: how many machines answered, how many identities were compared, any disagreements, whether each was raised for real or only in practice mode, and which disagreements went away.

Both checks also report their last run time to the safety-status page (`GET /guards`), so it can grade them from evidence instead of "not instrumented".

## What already exists

The checks themselves, their practice-mode settings and their decisions are unchanged. The hand-back check's status route and the identity check's saved state file stay as they were.

## Safeguards

- Writing a record can never change a decision: every write failure is swallowed, and a test proves a broken record writer leaves the lease decision unchanged.
- The hand-back check runs every ~5 seconds, so it does not write a line per run; a test proves 100 unchanged runs write nothing extra.
- Each log is capped at about 5 MB, with one older copy kept, so it cannot fill the disk.
- Nothing is written while the hand-back feature is switched off.
- New tests stage the situations the main machine never sees: the lease held by a non-main machine (it records a practice-mode "would hand back") and two machines disagreeing about a key (it records the disagreement once, then its clearing).

## What a reader needs to decide

Nothing. This adds records and status; it does not change what either check does.
