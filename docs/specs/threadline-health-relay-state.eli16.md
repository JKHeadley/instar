# Make the relay health check tell the truth — Plain-English Overview

> The one-line version: the check that answers "is my agent-to-agent line working?" replied "fine" as a fixed, hardcoded answer, so it said fine for nearly seven hours while the line was completely dead.

## The problem in one breath

I have a health check for the connection I use to talk to other agents. It reported healthy. It always reported healthy — the word "ok" was written into the code as a constant, and the handler never looked at the connection at all. It could not have reported anything else.

At 04:56 this morning that connection was taken over by another machine using my own identity, which switches off reconnection permanently for the life of the process. I was completely unable to send or receive for six hours and forty-five minutes. Throughout, the health check said fine. One hundred and thirty-one messages piled up unsent behind it, including work I believed I had handed to a teammate.

## The part that stings

Everything needed to tell the truth was already in the building. A separate piece of the system had recorded the takeover, with the reason and a flag marking it as unrecoverable, and had deliberately exposed that record so a status surface could read it. Nothing ever read it. A different diagnostic command was reporting "line not connected" at the very same moment the health check said fine.

So this was not a missing capability. It was a wire that was built, documented, and never connected.

## What already exists

- **The recorder** — already notices when the connection drops, already distinguishes an ordinary drop (which retries by itself) from a takeover (which never recovers without a restart), and already writes both to a durable log. Unchanged here.
- **The live connection state** — the client already knows whether it is attached right now, and another part of the system already reads it. Unchanged here.
- **The health check** — read neither. That is what changes.

## What this adds

The health check now looks at both and reports what it finds. It gained a small section describing the relay, and its overall verdict now moves off "fine" when the relay is genuinely down.

Why both sources rather than one: the live state tells you up or down but cannot tell you whether a drop will heal itself. A takeover looks identical to an ordinary blip if you only read the live state — and treating a permanent outage as a passing blip is precisely the failure being fixed. The recorder supplies that distinction, so the check now says whether the problem is self-healing or needs a restart.

## The safeguards

- **A relay that is switched off is not a fault.** Plenty of agents run with no relay at all, or hand the connection to a separate background process. In those cases the answer stays "fine", because "not applicable" is not "broken". Reporting a fault there would train everyone to ignore this check, which is how you end up back where we started.
- **A live connection always wins over an old record.** If the connection is up right now, it is reported as up even if an older takeover is still on file. The safe direction for a status surface is refusing to cry wolf.
- **Other agents cannot be made to drop me.** Other agents look me up through this same check. They decide whether I exist by whether the request succeeds and whether my identity is present — never by the verdict word. Both are deliberately left exactly as they were, and there is a test that fails if a degraded relay ever changes them. Getting that wrong would have been far worse than the bug: peers would quietly delete me from their address books.
- **Nothing sensitive is exposed.** This check answers without requiring a password, so the raw reason text from the takeover — which is partly written by whoever connected — is deliberately not included. Only a fixed set of words chosen in our own code, a yes/no, and a timestamp.
- **A broken probe cannot break the check.** If reading the relay state throws an error, the check falls back to "fine, not applicable" rather than failing. The endpoint other agents depend on has to keep answering.

## What you actually need to decide

Whether "degraded" and "error" are the right words for a retrying drop versus a permanent takeover. That is the only judgement here; everything else follows from it.
