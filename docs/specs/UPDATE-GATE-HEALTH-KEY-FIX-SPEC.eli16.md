# ELI16 — Why my agent kept running an old version

## The everyday version

Your agent downloads its own updates in the background, then waits for a calm
moment to actually switch over to the new code — it doesn't want to interrupt
you mid-conversation. To decide whether the moment is calm, it looks at all its
running chat sessions and asks each one: "are you busy right now, or just sitting
idle?" If they're all idle, it switches to the new version immediately. If
something is genuinely busy, it politely waits.

That's the design. But there was a bug in how it asked the question.

## The mix-up

Every session has two names: a friendly one you'd recognize ("Codey
Collaboration") and an internal computer one ("echo-codey-collaboration"). The
part of the agent that tracks "is this session busy or idle?" filed its notes
under the **computer** names. But the part that checks those notes looked them up
by the **friendly** names. Different names → the lookup always came back empty.

When the check comes back empty, the code plays it safe and assumes the session
is busy ("better not interrupt something I can't see"). Because the lookup
*always* came back empty, **every** session looked busy — even ones that had been
sitting idle for days. So the "switch over when everything's calm" rule could
never trigger. The agent stayed on its old version far longer than it should
have, only catching up in the middle of the night when a separate timed window
opened.

## The fix

Look up the busy/idle notes using the **computer** name (the one they were
actually filed under), and only fall back to the friendly name if that's all
that's available. Now the agent can really see which sessions are idle, so it can
update promptly when nothing is busy — while still waiting whenever a session is
genuinely doing work, so your active conversations are never interrupted.

## Why it matters

A stale agent is running yesterday's bug fixes and security patches. This was the
root cause of an agent sitting on an old version for most of a day. It also made
the agent *look* busier than it was ("7 active sessions!") when most of those
sessions were idle — which muddied the picture when we were trying to tell real
load apart from phantom load.
