# Stranded-inbound detector — the plain-English version

## What problem is this fixing?

When I run on more than one machine (say a Laptop and a Mac Mini), each of your conversations is "owned" by exactly one machine — that machine is the one that receives and answers your messages for that conversation. Normally that's fine.

But here's the failure that actually bit us on 2026-06-24: a conversation can stay "owned" by a machine that is **switched on but unable to actually serve it** — for example the Mini was still sending its little "I'm alive" heartbeat every few seconds, but its AI account was rate-limited (quota-walled), so it couldn't actually answer anything. Your Telegram messages kept getting routed to that stuck machine and silently went nowhere — while my replies still went out from the healthy Laptop. So from your side it looked like I was ignoring you, even though everything *looked* healthy. It turned out **17 of 25 conversations** were stuck this way, and nobody noticed until you told me your messages weren't arriving.

The scary part: every automated test and code review passed the whole time. The breakage was completely invisible to all of them. The only thing that caught it was *you* getting bitten.

## What does this change actually do?

It adds a small background watcher (a "detector") that, every minute or so, looks at every conversation and asks: *"Is this owned by a machine that's online but can't actually serve it right now?"* If it finds any, it raises **one** clear alert ("these conversations' messages are going to a machine that can't answer them; here's a machine that can").

That's it. **It does not move anything or change anything** — it just makes the invisible problem loud, immediately, instead of waiting hours for a human to notice missing messages.

## Why doesn't it just fix the problem automatically?

That was the original plan — automatically hand the conversation to a healthy machine. But the review process found that doing that *safely* is genuinely hard with the information we have today: the signal we'd use ("this machine can't serve") is the machine's own self-report and can be briefly wrong (a 5-second blip), and we can't yet tell whether a real live answer is mid-flight on the stuck machine. If we got it wrong, we'd yank a live conversation off a machine mid-reply — which is **worse** than the bug we're fixing. So the automatic fix is deliberately deferred until we build the missing pieces (a per-conversation "is something live here?" signal, and proper "wait and confirm" logic). Those are written down as named follow-ups so they don't get lost.

## What changes for you?

Nothing you'll see day-to-day. Behind the scenes, the moment a conversation gets stranded like this, I'll know within about a minute and can fix it (today, by hand; later, automatically) — instead of the problem hiding until you happen to message that conversation and get silence. It's the first, safe half of making "your messages silently vanished" a thing that can't quietly happen again.

## Is it safe?

Yes — by construction. It only ever *reads* state and *raises one alert*. It can't move a conversation, can't kill anything, can't message you directly, and the alert rides the existing limit that stops alert-spam. It's off everywhere except my own development machine until it's been proven out. If it's ever wrong, the worst case is one extra advisory note that a human reads and dismisses.
