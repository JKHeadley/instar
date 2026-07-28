# Slack connection storms after laptop sleep — the websocket leak fix

## What you saw

On 2026-06-12 the echo agent's Slack connection went into a silent storm: Slack kicked it off 5,075 times in 73 minutes (~70 times a minute) with the reason "too many websockets," while Slack's API rate-limited the reconnect calls. Messages mostly still flowed between churns, so nobody noticed for over an hour. Only a full server restart cleared it.

## Why it happened

The agent holds one live "phone line" (a websocket) to Slack. After the laptop sleeps and wakes, the agent deliberately hangs up and redials — that part is correct. The bug: when you hang up a websocket, the "line is now closed" notification arrives a moment LATER, not instantly. The old code tried to handle that with a synchronous flag — set a "don't react" flag, hang up, clear the flag — but because the notification arrives after the flag is already cleared, the protection never actually protected anything.

So every redial went like this: hang up the old line, dial a new one... then the OLD line's late "closed!" notification arrives, and the code — thinking the CURRENT line just died — throws away its handle to the NEW line (which stays open, now untracked) and dials a THIRD one. Each sleep/wake leaked one live, invisible connection. Slack allows about 10 per app. The laptop registered 33 wake events that day — short 10-second naps every few minutes each count — so the cap blew within two hours, and from then on every redial was immediately rejected with "too many websockets," forever, until a restart dropped all the leaked lines at once.

A second, rarer race made it worse: if a retry timer was already sleeping when an explicit redial came in, the timer would later wake up and dial yet another line on top of the one the redial had just opened.

## The fix

Two structural changes inside the Slack socket client, no behavior changes anywhere else:

1. **Each line knows whether it's still "the" line.** Every notification handler is bound to its own specific socket and first checks "am I still the connection the client is tracking?" A late "closed!" from an already-replaced line is recognized as stale and ignored — it can no longer orphan the new line or trigger an extra dial.
2. **An epoch counter supersedes in-flight work.** Every deliberate hang-up bumps a counter; any sleeping retry timer or in-progress dial remembers the counter from when it started and quietly stands down if it changed. Two dialing paths can never run to completion on top of each other.

The net invariant: the client tracks at most ONE live connection, ever, no matter how reconnect triggers interleave.

## What proved it

Five behavioral tests with a fake Slack websocket reproduce the exact failure first (three failed on the old code — one path opened FOUR connections), then pass on the fix: the late-close leak, the stale-retry race, the "too many websockets" handling, plus regression guards proving normal disconnects still reconnect and a deliberate shutdown stays shut down.

## What you'll notice

Nothing — that's the point. Sleep/wake cycles no longer accumulate leaked Slack connections, so the storms (and the rate-limiting, and the restart-to-fix ritual) are gone. No configuration, no API change, no migration.

## What this does NOT fix

The wake detector itself fires on ~10-second gaps every few minutes (453 wake events in one day), which makes the agent redial Slack and restart its tunnel far more often than real sleeps justify. With the leak fixed those redials are now harmless, but the trigger-happiness is a separate issue tracked in JKHeadley/instar#1077.
