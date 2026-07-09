# Non-Gating Failure-Swap — ELI16

## What is this?

Your agent runs a lot of small "background brain" checks — things like figuring out what a
Telegram topic is about, or classifying whether a message is asking to move work between
machines. To keep those cheap checks off your main Claude account, the agent already routes
most of them to a different AI tool (Codex, on a small fast model). That's the "provider-fallback
default policy" that shipped earlier.

There are two kinds of these background calls: **gating** calls (a safety check that BLOCKS an
action — e.g. the check that runs before a message goes out) and **non-gating** calls (a
best-effort background helper that nobody is waiting on — e.g. "what is this topic about?").

When a gating call's AI tool has a hiccup — the command fails to launch, times out, or comes
back empty — the agent already tries the NEXT available tool (Codex → Pi → Gemini → Claude) so
the check still gets an answer. That "try the next door" behavior is called the failure-swap.

The problem: non-gating calls did NOT get that second chance. If Codex hiccuped on a non-gating
call, the call just errored out — even though a perfectly healthy backup tool (Pi) was sitting
right there. In real numbers: one non-gating helper (the topic classifier) was erroring **28% of
the time** because of these Codex launch hiccups, while the gating calls next to it — which DO
swap — errored around 1.5%. Same hiccup, wildly different outcome, only because one kind of call
got a fallback and the other didn't.

## How does it fix it?

This gives non-gating calls a **smaller, safer version of the same "try the next door" move.**
When a non-gating call's primary tool fails to actually run — the launch failed, it timed out, or
it produced nothing at all (zero output) — the agent tries ONE backup tool before giving up. If
the backup answers, the call succeeds instead of erroring. If the backup is also down, the agent
gives up exactly like it does today (falls back to its simple built-in guess).

Three deliberate limits keep it safe and cheap:

1. **Only on a real "it didn't run" failure.** If the tool actually ran and produced output but
   the output was garbled, the agent does NOT retry on another tool — retrying would just burn
   more money on the same bad request, and that garbled-output case is already handled elsewhere.
   The agent tells the difference by watching whether the failed call produced any tokens (real
   work) at all.

2. **At most ONE backup, never onto Claude.** Non-gating background calls must never all pile onto
   your main Claude account at once (that's the "herd" the original design carefully avoided). So
   the non-gating swap takes just one step onto another off-Claude tool (Pi/Gemini) and is flatly
   forbidden from landing on Claude. Gating calls — the small, important set — keep their full
   fallback all the way to Claude, unchanged.

3. **Bounded by the same timeout.** A slow backup is abandoned at the existing per-attempt cap
   (default 5 seconds), so this never adds a long wait.

Everything is still counted honestly: the failed first tool keeps its error record, and the backup
tool that actually answered is credited for its own usage — no double-counting, no blind spots.

## Why not just let non-gating calls swap the whole chain like gating calls do?

Because the original design excluded them ON PURPOSE, to stop a flood of background traffic from
herding onto Claude during a bad night. This fix respects that exactly — it gives non-gating calls
a version of the swap that is *strictly more careful* than the gating one (one step, never onto
Claude), so it fixes the 28% error rate without ever recreating the herd the exclusion was
protecting against.

## What do you need to decide?

Nothing — it ships ON by default because it strictly reduces errors and the one-step,
never-onto-Claude bound keeps cost and load flat. If you ever want the old behavior back, the
agent can turn the feature off for you (it's a single switch), and non-gating calls go back to
erroring straight through with no backup. On an agent with only Claude installed (no backup tools),
it does nothing at all.

## Open questions

None. This is a bounded bug fix on top of an already-approved mechanism; the tier, the
herd-safety bound, and the honest-metrics behavior are all settled.
