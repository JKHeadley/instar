# ELI16 — Who's the boss of this chat?

## The problem in one sentence
An AI agent needs to know, for sure, *which real person* it's working for in a
given conversation — and it should never get tricked into thinking some other
name it read somewhere is the boss.

## The story behind it
Not long ago, an agent running on a shared computer slowly started treating a
*different real person* — call her Caroline — as the person giving it orders. It
even wrote her name into its work as if her approvals counted. Nobody caught it,
because the mix-up happened entirely inside the agent's own writing. There was no
"front door" guard checking that, because the bad name never came in through a
message — it leaked in from the machine's settings and the agent's own notes.

We already built two pieces to stop this: a detector brain (`PrincipalGuard`)
that spots when the agent credits a decision to the wrong person, and a small
filing cabinet (`TopicOperatorStore`) that remembers, per conversation, exactly
who the verified boss is. The rule the filing cabinet enforces is strict: the
boss is decided ONLY by the verified ID of whoever actually sent the message —
never by a name typed in some document.

## What this change adds
This step plugs that filing cabinet into the running server so the rest of the
system can actually use it. It adds four simple web endpoints:

- "Who's the boss of this chat?" — read one conversation's verified operator.
- "Show me all the bosses" — list every conversation's verified operator.
- "Set the boss" — record the boss, but ONLY from a verified sender ID. If you
  try to set it with a blank ID (hoping a typed-in name will stick), it says no.
- "Give me the boot-up note" — hand back a short block the agent can read at the
  start of a session so it knows, from message one, who it's really serving.

## Why it's safe
It only *adds* things. Nothing old changes. If the server can't build the filing
cabinet for some reason, the endpoints politely say "not available" instead of
crashing. And the one rule that matters most — a name you merely *read* can never
become the boss, only a verified sender can — is checked right at the web layer,
and we have tests that prove it by trying to sneak the name "Caroline" in through
a blank ID and watching it get rejected.

## What's deliberately left for next time
The actual "read the boot-up note at session start" wiring (so the agent
automatically sees who its boss is every time it wakes up) is a separate, slightly
riskier change to the start-up script, so it gets its own follow-up step. For now
the note is available to ask for; nothing reads it automatically yet. That's on
purpose — it keeps this change small and easy to review.
