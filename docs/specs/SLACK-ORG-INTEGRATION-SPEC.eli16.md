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
- (Housekeeping) While the gate is dark, its `/permissions/*` routes are deliberately kept *internal* — they don't appear in the agent's `/capabilities` self-discovery — until the enforce path is live and it becomes a real, advertised capability.

## Update — Phase 3 ("does this feel like them?") is now built (watch-only, off by default)

The "does this feel like them?" check from item 5 above is now a real thing, not just a plan. In plain English:

- The agent quietly keeps a **shape-only sketch** of how each person normally behaves: which kinds of requests they make, at what risk level, around what time of day, how long their messages tend to be, and whether they usually sound calm or urgent. It stores **none of the actual message text** — just the shape.
- When a request would otherwise be allowed on a **dangerous (floor) action**, the agent compares it to that sketch. If it's wildly out of character — a money transfer from someone who never moves money, fired off at 3am when they only work mornings, urgent when they're normally calm, in a much longer message than usual — the agent raises a flag that *would* ask for a second factor ("let me confirm it's really you on a channel I already know is yours").
- **It only ever makes the bar HIGHER, never lower.** A perfectly in-character request still can't clear a dangerous action without proper authority, and it can't turn a "no" into a "maybe" — a refusal stays a refusal.
- **It's conservative when it doesn't know you yet.** A brand-new person, or someone we've only seen a couple of times, gets *no* out-of-character flag — there's no "character" to be out of yet, so the agent won't invent a challenge. (The hard floor still protects the dangerous action regardless.)
- **It's still watch-only and off by default.** When on, it writes down what it *would* have asked for; it never actually challenges or blocks anyone yet. That's so we can measure how often it would fire (and whether it'd annoy legitimate people) before we ever let it interrupt a real request.
- There's an **optional AI voice-check** that can be layered on top to spot a message that doesn't sound like the person — but it's off by default, and if the AI is unavailable it simply doesn't contribute (it never quietly loosens anything).

Nothing new to decide here — this is the build catching up to the plan, still dark, still watch-only.
