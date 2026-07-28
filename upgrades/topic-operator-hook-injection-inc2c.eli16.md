# ELI16 — Telling the agent who its boss is, the moment it wakes up

## The one-sentence version
When the agent starts a conversation, it now gets handed a little note that says
"the verified boss of this chat is X" — so it knows from the very first message
who it's working for, instead of guessing from names it reads later.

## The backstory
We've been fixing a real problem: an agent on a shared computer slowly started
treating a *different real person* (call her Caroline) as its boss, because the
mix-up lived inside the agent's own writing where nothing was watching. To fix it
we built three pieces:

1. A filing cabinet (`TopicOperatorStore`) that remembers, per conversation, who
   the verified boss is — and the rule is strict: the boss is decided ONLY by the
   verified ID of whoever actually sent the message, never by a name typed in a
   document.
2. Four web endpoints to read and set that binding (shipped last step).
3. **This step:** actually handing the agent that "who's your boss" note at the
   start of every conversation.

## What this change adds
At session start, the agent already gets handed a few notes — the company's rules,
the preferences it has learned about you, and so on. This change adds one more
note to that pile: it quietly asks the server "who's the verified boss of this
chat?" and, if there's an answer, prints a short block telling the agent. The
block also reminds the agent: don't ever swap in some other name you happen to
read — an unfamiliar name in the boss's chair is a question to resolve, not a fact
to accept.

## Why it's safe
- It only **adds** a note; it changes nothing else about how sessions start.
- It's careful: it only runs if there's actually a chat topic and the server is
  reachable. If the server can't answer, or nobody's been set as boss yet, it
  prints nothing and the session goes on exactly as before.
- It can't *make* anyone the boss — it only shows the boss who was already
  verified the safe way. So there's no way for this to repeat the Caroline mix-up.
- Every agent gets it automatically the next time it updates, because this note
  lives in the startup script that always gets refreshed on update.

## What's still coming
Right now a boss gets recorded either by a one-time manual call, or — in the next
step — automatically whenever the verified boss sends a message. After that, a
final step will let the agent's own safety checker USE this binding to catch
itself if it ever credits a decision to the wrong person. This step is the
"agent can SEE its boss" piece; the "agent gets corrected if it forgets" piece
comes next.
