# Mesh Self-Heal Graduation — plain-English overview

## What's the problem?

I can run on more than one machine (right now: an always-on Mac Mini and a Laptop that comes and goes). When one machine goes down, the other should quietly take over your conversations so you never notice a gap — and hand them back when the first machine returns. The code that does this ("self-healing") is already written, but it's been shipping **turned off** ("dark"), because switching it on the careless way could cause a nasty bug: **both machines answering you at once** and doing everything twice (two replies, two git pushes, two deploys). This is the careful plan to turn it on safely.

## The one genuinely hard problem

How does the Mini *know* the Laptop is truly dead, versus just temporarily unreachable on a bad network? If it guesses "dead" while the Laptop is actually alive, both machines serve you — the exact disaster. It turns out you **cannot** perfectly solve this with only two machines and no independent referee; it's a well-known hard problem in computer science. So the design is deliberately honest and cautious:

- The Mini takes over **on its own only when a machine is provably dead** (its heartbeat stopped long enough that even a slow sync would have caught up).
- **Every ambiguous case** (the machine might be alive, just cut off) is **handed to you** — one clear message, your decision — rather than risking a double-answer.
- To make "heartbeat stopped" actually safe, a machine that loses its connection **shuts its own mouth first**: it literally cannot send unless it recently confirmed it's still in charge. So two machines can never both believe they're serving you.

## What review changed

The first draft was a thin to-do list. Six rounds of review — six internal expert reviewers plus an outside AI model (GPT-5.5) catching blind spots the internal ones share — found real holes and fixed every one: the config settings it named didn't actually exist; it would have force-claimed a *live* machine; it re-used the wrong safety numbers; it hadn't planned for a machine that keeps talking to you even though its sync is broken; and it originally claimed a stronger guarantee than two machines can actually provide. The design is now genuinely cautious: when in doubt, it stalls and asks you rather than guessing.

## What it means for you

- **A machine truly dies:** failover is automatic and invisible — the other picks up, no double-answers.
- **A murky split (unclear who's alive):** the affected conversation pauses; you get one honest message ("your message isn't lost, resend once things settle") and a quick decision. It won't silently hang *or* double-reply.
- **Nothing turns on without your explicit go-ahead**, one layer at a time, and only after it proves itself on real recorded evidence — never just "it's been a week."
- **An honest catch:** the final live test needs *both* machines online, and the Laptop is currently off — so that last step waits until it's back.

## The main tradeoff

We chose **"never answer you twice" over "always answer instantly."** In the rare ambiguous cases that means a short wait for your decision instead of a risky auto-takeover. If we ever add a tiny always-on referee in the cloud, those waits disappear — that upgrade is written down as the future path.
