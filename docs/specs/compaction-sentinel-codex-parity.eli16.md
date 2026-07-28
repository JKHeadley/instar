# CompactionSentinel codex parity — explained simply

## The recovery nurse who couldn't read codex's chart

When an AI session gets "compacted" (its memory summarized to free up space), there's a
brief moment where it has to re-find its footing. Instar has a recovery nurse
(CompactionSentinel) who watches for a session that DIDN'T come back cleanly: she gently
re-hands it its instructions, then checks whether it started working again by watching its
"logbook" (transcript) grow. If it doesn't grow, she re-hands the instructions again, up to
3 times, then flags a failure.

The problem: the nurse only knew where CLAUDE sessions keep their logbook. For a CODEX
session (like Codey), she looked in the wrong place, found nothing, and concluded "still not
working" — EVERY time. So after every codex compaction she'd re-hand the instructions 3
times (stacking confusing "you're restarting" prompts on top of the user's real message —
a known disruptive loop) and then wrongly flag a failure. The session had actually
recovered fine; she just couldn't see it.

## The fix

This is the exact same fix we already shipped + had independently reviewed for the
rate-limit nurse (#33): teach `readJsonlBaseline` to read codex's actual logbook. An OpenAI
rate situation is account-wide, so "is codex working again?" is the same as "did codex's
newest logbook just grow?" — which a small, fast helper (already in the codebase) checks.
No fragile per-session id. Claude's path is completely untouched (we proved it — all 22 of
the nurse's existing tests still pass).

## Safety

The worst this can do for codex is what it already does today (find nothing, return
"unknown"). Everywhere it CAN see the codex logbook, it can only turn a broken check into a
correct one. So it can't make anything worse — and it's switched ON (not dark) precisely
because the broken behavior (the 3× re-hand + false failure) is happening right now on
every codex compaction.

## The one honest caveat (same as #33)

Because the signal is the whole codex account's newest logbook (not one specific session's),
if TWO codex sessions are recovering at the exact same moment, one's output could make the
nurse think both recovered. But that just means she stops re-handing instructions one beat
early — gentler than the redundant re-handing she does now — and a later check re-triggers
if needed. Codey runs one codex session at a time, so this can't bite today. Closing it
fully (per-session logbooks) is tracked alongside #33's same caveat.

## Why it matters

Codey gets compacted on long runs. Right now every one of those triggers a confusing
re-prompt storm and a false "recovery failed." After this, codex sessions get the same
clean, correct compaction-recovery that Claude sessions already get.
