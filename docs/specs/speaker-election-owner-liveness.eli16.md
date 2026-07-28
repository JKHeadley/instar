# A dark owner must not silently hold a topic's voice — plain English

## The problem

When I run on more than one machine, exactly one of them speaks for any given conversation at a time — never two (that would double-reply), never zero (that would go silent on you). A small deterministic "election" decides which machine speaks, using inputs every machine agrees on.

The election has a rule near the top: "whichever machine *owns* this conversation wins." That rule has a hole. It checks WHO the owner is, but not whether that owner machine is actually **alive**. So if the owning machine has gone dark — asleep, crashed, unreachable — the *other* machine still politely defers to it and stays quiet. The dead owner "holds" the voice, and nobody speaks. On a two-machine setup where the owner goes dark, that means the conversation goes silent until something else moves ownership.

The fix already exists a few rules lower down: a *later* rule that picks a fallback speaker DOES check "is this machine actually online?" and, if not, hands the voice to the lowest-numbered machine that IS online, so someone always speaks. This change just applies that same already-proven liveness check to the top two rules.

## What this changes

Two rules in the election — "the owner wins" and "the recorded owner wins" — now defer to that owner ONLY if the owner machine is currently online. If the owner is dark, the rule stops short-circuiting to silence and lets the existing fallback machinery pick a live speaker instead. It's the same liveness test, the same fallback code, and the same single-winner tiebreak that the election already uses one rule down — just applied two rules up.

## What could go wrong, honestly

- The whole point of this election is "exactly one machine speaks." I checked both halves: a dark owner can no longer make two machines think they're the speaker (only the real self counts as online), and it can no longer sink a conversation to total silence (the fallback guarantees one online machine speaks). The change TIGHTENS the existing rule rather than loosening it.
- It touches nothing about how ownership is decided or moved — only about whether a *dead* owner is allowed to hold the microphone. No new settings, no new background process, no message to you.

## What you'd be agreeing to

That when a machine that owns a conversation goes dark, another live machine picks up the voice for that conversation instead of the whole thing going quiet — using the same safe, deterministic pick the system already uses elsewhere.
