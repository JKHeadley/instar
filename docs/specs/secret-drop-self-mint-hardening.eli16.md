# Secret Drop self-mint hardening — plain-English overview

## What this is

Your agent has a small, deliberately unlocked door on its own machine. A helper program
the agent runs uses it to say "please make a secure page where someone can paste a
password." The door opens only from the same computer.

The problem: the door treated "this request came from this computer" as if it meant
"the agent asked for this." It doesn't. Other programs on the machine could knock, and in
some cases so could a website the owner visited. Words the knocker supplied could end up
in front of the agent, and the server could even start a new, fully trusted agent session
to deliver them.

In short: untrusted text, and the power to start a trusted agent, sat behind a door
guarded only by "you're on this machine."

## What changes

1. **Requests that look like they come from a web browser are refused.** A website can no
   longer knock.
2. **Only a request carrying the agent's real key can reach a conversation**: deliver a
   "secret received" message, or start a session. The agent's helper now sends the key, so
   that message keeps working.
3. **A request without the key still gets a normal, working paste page**, including phone
   links and agent-to-agent transfers. This is safe because what gets pasted can only be
   read back with the agent's key.
4. **Keyless requests are clearly marked "unverified".** Their wording is shown to the
   agent only as quoted, untrusted text, and only if it goes looking. The page warns the
   person filling it in. Nothing is deleted automatically.
5. **Supplied text is treated as untrusted everywhere the agent reads it**, and the paste
   page is properly encoded.
6. **A leftover notice file moves into a private folder.**

## What you would notice

- Normally: nothing. Pages, phone links, transfers and notices all work as today.
- In a session that was already running when the update landed, until it restarts: its
  new requests won't produce the "secret received" message and show as "unverified". The
  page and the secret still work, and the agent is told why.
- A few malformed names are refused with a plain reason. Normal names, in any language,
  still work.
- With the dashboard's new (not yet turned on) phone sign-in mode: reading a pasted secret
  asks for the PIN, as the pending list already does.

## What you need to decide

Whether to ship it. It is a fix to existing behaviour, not a new feature, and a revert
fully undoes it.
