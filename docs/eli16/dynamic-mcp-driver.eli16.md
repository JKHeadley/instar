# Dynamic MCP — the load/offload driver (ELI16 overview)

## What this is

This is the "doer" for the dynamic-MCP feature. The earlier pieces just *decide*
things (which helpers to start with, whether an idle one is droppable). This piece
actually carries out a change: "add the browser helper" or "drop the browser
helper," which — because there's no live add/remove button — means saving a new
helper list and restarting the session so it picks it up.

Restarting a live session is real, so this code is careful. It does NOT touch the
computer directly — every risky action (saving state, restarting, finding/cleaning
up processes, checking permission) is handed in from outside, which means we can
test the whole decision flow with fakes and be sure it behaves.

## What it does, step by step

1. **Work out the new list.** From what's currently loaded, apply "add X" or "drop
   X." If nothing actually changes (already loaded, or not loaded, or asking for a
   helper that doesn't exist), stop — no restart.

2. **Check permission — for real.** If the session is preapproved (an autonomous
   run is), go ahead. Otherwise we do NOT just trust a flag — the server hands out
   a one-time code, and only the operator's genuine yes (carrying that code) counts.
   The agent can't wave its own request through.

3. **(Drop only) Make sure it's not mid-task.** If the session is — or might be —
   using its tools right now, abort. Better to keep an idle helper than to yank a
   tool out mid-action.

4. **(Drop only) Remember the old helper's process id first.** Here's the subtle
   bit the review caught: restarting the session does NOT automatically kill the
   old browser — it keeps running, orphaned. So we note its process id *before* the
   restart, and clean it up *after* the new session is confirmed running. Otherwise
   every "drop" would actually leak a browser and make things worse.

5. **Save-then-restart, safely.** Save the new list as "not final yet," restart,
   and only mark it "final" once the restart actually succeeds. If the restart
   fails (rate-limited, etc.), roll back — the live session keeps its old list, and
   no half-applied change is left lying around. Two changes to the same session also
   can't run at once and trip over each other.

## Why it's safe

It's pure orchestration over injected helpers — it starts nothing, kills nothing,
writes nothing by itself. Sixteen tests pin every branch: the no-ops, the
permission gate (including "a wrong code is rejected"), the save-then-restart with
rollback on failure, the capture-then-clean-up ordering for drops, the mid-task
abort, and the "two requests don't interleave" guarantee. It isn't wired into
anything live yet — that comes with the routes, behind the dark flag.
