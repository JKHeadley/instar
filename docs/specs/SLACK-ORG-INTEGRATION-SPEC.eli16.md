# Slack Org Permissions — Plain-English Overview (ELI16)

## What this change is, in one breath

When Instar lives in a company's Slack — not just your private Telegram — it has to decide, for every message, **"is the person asking this actually allowed to ask for it?"** There's no "Deploy" button to lock; people just *type things* ("ship it", "wire $40k", "make me an admin"). So the agent itself has to be the bouncer: read the request, figure out what it really is, check who's asking, and either do it, ask a clarifying question, refuse politely, or ask for extra proof it's really them. This change builds the first working slice of that bouncer.

## What already existed (and the problem)

Instar already has a decent Slack adapter (it can read channels, respond when mentioned, handle files). It also already stores a `permissions` list on each user. **But here's the bug we found: nothing ever *checks* that list.** There's literally a `hasPermission()` function in the code that is never called anywhere. Permissions were just shown to the AI as a note and we *hoped* it would behave. That's a wish, not a rule.

## What's new in this slice

1. **Real identity** — we now recognise a Slack user by their verified Slack ID (the thing Slack itself vouches for), not by a name typed in a message. So "Justin said it's fine" written by someone else means nothing.
2. **Roles with ceilings** — guest → member → contributor → operator → admin → owner. Each role can only authorise up to a certain risk level on its own.
3. **A hard floor** — the truly dangerous actions (moving money, deploying to production, touching credentials, deleting data, sending things to outsiders, handing out admin) can **never** be done on someone's say-so alone. They need an explicit, recorded grant. No clever wording gets around it.
4. **A judgement layer** for the fuzzy middle: if a request is ambiguous ("ship it"), the agent asks what you mean instead of guessing.
5. **A "does this feel like them?" check** — if the CEO's account suddenly fires off an urgent money transfer that's totally out of character, the agent doesn't just obey; it asks for a second factor (confirm on a channel we already know is yours, or a second admin). That defeats a hijacked account.
6. **A test harness** — a fixed cast of pretend users (owner, admin, member, outsider, a spoofed CEO) and six scripted situations, so we can *watch* the bouncer make the right call every time, in an automated test that runs on every build.

## The safeguards, in plain terms

- **It's turned OFF by default.** Nothing changes for anyone until someone flips it on in config.
- **Even when on, it currently only WATCHES.** It writes down what it *would* have decided, in a log, and blocks nothing. That lets us check it's making good calls (and not annoyingly refusing legitimate things) before we ever let it actually block.
- **The dangerous-action floor fails safe** — if anything errors out, a money/deploy/credential request is refused, never let through.
- **The "should I jump into a conversation" side fails to silence** — if unsure, it says nothing.
- **It can't break message delivery** — the whole check is wrapped so that if it hiccups, your message still goes through.

## What you actually need to decide

- **Approve the spec** (set `approved: true`) so the code can land through the gate — that's the one thing only you can do. The build is done and tested (38 tests, all green); it's waiting on your review.
- **Later, when you want to demo it for real:** provide a throwaway test Slack workspace + a bot token, and we can show the whole thing happening in a real Slack with real test users. Until then, the automated suite proves the logic.
- Nothing here ships to other agents or users until you say so, and even then it starts in watch-only mode.
