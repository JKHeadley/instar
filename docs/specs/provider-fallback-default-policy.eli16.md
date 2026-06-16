# Provider-Fallback Default Policy — plain-English overview

## The one-line version

Your agent does a lot of small "thinking" in the background — safety gates, sentinels,
the check that decides whether an outgoing message sounds right. Today *all* of that runs
on Claude. So when Claude has a bad night (rate limits, a slow API), that background
thinking slows down too — and one night it slowed down so much that the agent couldn't
get its own messages out for an hour. This change makes that background thinking run on a
*different* AI provider by default (Codex first), with an automatic fallback chain, so one
provider having a bad night can't strangle the whole agent again. Claude becomes the
*last* resort for background work, not the first.

## What actually changes

There's already an engine inside the agent that can fall back from one AI provider to
another when a call fails — it was built earlier and it works. The problem was just that it
shipped turned *off*: with no configuration, everything defaulted to Claude. This change
turns it *on* out of the box, in a smart way:

- It picks the **first AI provider you actually have installed**, in a preference order
  (Codex → PI → Gemini → Claude). If you only have Claude, nothing changes at all — the
  whole thing becomes a no-op, so an agent with no other provider is never made worse.
- It applies only to the **lightweight internal helpers** (sentinels, gates, reflectors).
  Heavier scheduled *jobs* are deliberately left alone, so the agent doesn't quietly start
  spending money on a different provider for a big job you didn't ask it to move.
- **You're always in charge.** If you set your own routing, yours wins, completely. Want
  everything back on Claude? Set the routing to empty (`{}`) and it's exactly like before.

## The tricky part the review caught

A longer fallback chain has a hidden danger: if you try Codex, then PI, then Gemini, then
Claude — and each one is *slow* (not broken, just slow) — you could end up waiting on all
four in a row and recreate the very stall you were trying to fix. So the change adds a tight
per-attempt timer (about 5 seconds): if a provider is dragging, the agent stops waiting and
moves to the next one. Four rounds of review hardened this — including catching that an early
draft of the timer could have *crashed the server*, and that a simpler, already-proven
pattern in the codebase (the same one another part of the agent already uses safely) avoids
that entirely. The final design reuses tools the agent already ships rather than inventing
new machinery.

## What it means for you

If your agent has Codex (or another non-Claude CLI) installed, its background safety checks
quietly move off Claude — which means a Claude outage or a maxed-out weekly quota can no
longer freeze your agent's sentinels, gates, or message delivery. You'll be able to *see*
this happening (the dashboard shows which provider is actually serving each check), and you
can override or fully revert it any time. If you only run Claude, you won't notice a thing —
by design. The main tradeoff is that there's now more than one AI provider involved in the
agent's internal decisions, so the agent's behavior depends a little on which CLIs you have
installed; the design is honest about that (it's "machine-local" — each machine uses what it
has) and never silently degrades a safety decision: if every provider is down, a safety gate
still fails *closed* rather than guessing.

**Constitutional anchor:** *No Silent Degradation to Brittle Fallback* — the agent swaps to
another provider before it would ever quietly fall back to a brittle guess, and a safety net
that could quietly switch itself off (a maxed-out Claude account strangling every gate) is
exactly the failure this closes.
