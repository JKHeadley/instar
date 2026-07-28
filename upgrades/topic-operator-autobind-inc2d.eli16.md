# ELI16 — Automatically remembering who the boss is

## The one-sentence version
When the verified boss sends a message, the agent now automatically writes down
"this is the boss of this chat" — so it no longer has to be told by hand.

## The backstory
We've been fixing a real problem: an agent on a shared computer slowly started
treating a *different real person* (call her Caroline) as its boss, because the
mix-up lived inside the agent's own writing where nothing was watching. To fix it
we built three pieces:

1. A filing cabinet that remembers, per chat, who the verified boss is — and the
   rule is strict: the boss is decided ONLY by the verified ID of whoever actually
   sent the message, never a name typed in a document.
2. A startup note that hands the agent that "who's your boss" info when it wakes
   up (shipped last step).
3. **This step:** actually filling in the filing cabinet automatically.

## What this change adds
Before, the filing cabinet only got filled in by a manual one-time call. Now,
whenever a message comes in through the agent's main message pipe, the system
checks: "is this sender on the allowed list?" If yes, it quietly writes them down
as the verified boss of that chat. If no, it does NOTHING — an outsider in the
group can never become the boss. That "only allowed senders count" rule is the
whole point: it's what stops the Caroline mix-up from happening again. We prove it
with a test that sends a message from an *un*-allowed person literally named
"Caroline" and checks that nobody gets written down.

## Why it's safe
- It only **adds** a step, wrapped so that if anything ever goes wrong, the message
  still gets handled normally — recording the boss can never break the chat.
- It ignores robot-to-robot messages (those get handled earlier), and it ignores
  anyone not on the allowed list.
- Writing the same boss twice is harmless, so a re-delivered message can't cause
  trouble.

## What's deliberately left for next time
This fills in the cabinet on the agent's **main** message pipe (the one the whole
fleet uses). There's a second, simpler pipe (used when the agent talks to Telegram
directly without the relay) that this step doesn't cover yet, because that one's
wiring lives in a harder-to-test startup file. That's tracked as a small follow-up.
Until then, an agent on that simpler setup just doesn't auto-fill the cabinet —
which is safe, because no entry means no false boss. The final step after that
lets the agent's own safety checker USE the binding to catch itself if it ever
credits a decision to the wrong person.
