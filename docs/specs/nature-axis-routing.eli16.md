# Nature-Axis Routing — plain-English overview

## The one-sentence version
Right now, when a background part of the agent needs to ask an AI a question, it picks *which AI
service* to use based on a rough label ("this is a sentinel"). We benchmarked reality and found that
the label is the wrong thing to pick on — what matters is the **nature of the task**. This change
makes the agent pick the right AI *and the right model* based on task nature, safely, and only when
we turn it on.

## Why this matters (the finding that forced it)
We ran a big benchmark (~2,200 real calls) and found something surprising: the *exact same* AI model
(Opus 4.8) scores **99%** when you talk to it through a clean API, but only **82%** — and as low as
**35%** on judgment tasks — when you talk to it through the "coding assistant" door (the Claude Code
CLI). The coding-assistant door wraps every question in ~20,000 words of "you are a helpful coding
agent" framing, which turns a careful judge into a gullible yes-man. Even weirder: that same gullible
door is the *best* choice for open-ended *writing*. Same model, same door, opposite result — depending
purely on what kind of task you send it. So you can't route by model, and you can't route by a coarse
label. You have to route by **task nature**.

## The four task natures and their "chains"
- **A — quick bounded checks** (is this an emergency stop? triage this): speed matters → FAST/SORT chains.
- **B — careful judgment** (is this reply safe to send? did the task actually finish?): being *right*
  matters most → the JUDGE chain, and NEVER the gullible coding-assistant door.
- **D — background bulk work** (digests, summaries): cheap and steady → SORT chain.
- **E — deep reasoning** (rare): JUDGE chain.

Each nature has a **chain**: a ranked list of "try this AI first, then this one, then this one." If the
first choice is unavailable (no key, rate-limited, out of budget), the agent walks down to the next.

## What we decided (operator's calls, baked in)
1. **GPT-5.5 work goes through `pi` first** (it won the benchmark: 100% and fastest), with codex and
   OpenRouter as backups. We do **not** have — and will **not** require — a direct OpenAI key.
2. **Gemini work uses the metered Gemini key** we already hold, with the existing "stop when the budget
   runs out" money guard so it can never overspend. Turning on paid routing is not something the agent
   can do to itself — the agent proposes a spending cap, and you approve it with your dashboard PIN. On a
   multi-machine setup, paid routing stays off until there's a shared spend counter, so two machines can
   never each spend a full budget.
3. **Judgment/safety work never rides the *gullible* coding-assistant route** — specifically, the big
   Opus model through the Claude Code door (that's the 82%-vs-99% trap). Clean doors are always tried
   first. There is ONE permitted Claude-door position for judgment work: the Sonnet-4.6 CLI as a
   last-resort reserve (it scored 99.5% — it does NOT have the gullibility problem), used only when every
   cleaner door is down at once, because a safety gate limping on the sanctioned reserve beats failing
   the gate entirely. The precise rule is "never the *Opus* model via the Claude door for bounded
   judgment," enforced by an allowlist in code, not just documentation.
4. **The everyday Claude model is Opus, not Fable.** Fable is only for deliberate high-level escalation.
5. **Auto vs ask:** the agent may auto-apply better routing for *low-stakes* parts, but any change to a
   *critical safety gate* raises exactly one "please review" notice to the operator — never silent.

## Safety and reversibility
This ships **dark**: with the config unset, the agent behaves like today — with **one deliberate
exception**, a standalone safety fix that closes a pre-existing hole where a fallback could send a safety
judgment to the gullible Opus route; that fix is always on, because it makes things safer even before the
feature is enabled. When you first turn it on, it runs in **dry-run** (it logs what it *would* do without doing it).
A single config removal reverts everything instantly, no restart. A build-time lint makes it
*structurally impossible* to accidentally route a safety judgment onto the banned gullible door. Every
routing decision is logged. The only new operator notice fires *after* the agent has already self-healed
(walked to a working backup) and only if a door stays broken for a while — never on a momentary blip.

## How a request flows (the decision tree)

```
a background part needs an AI answer
        │
        ▼
what KIND of task is this? (looked up in a fixed table — never guessed)
        │
        ├─ quick check / emergency-stop ─────▶ FAST/SORT list: fast cheap doors first
        ├─ careful safety judgment ──────────▶ JUDGE list: clean GPT-5.5 doors first,
        │                                       NEVER the gullible Opus-via-Claude route,
        │                                       Sonnet-CLI only as a last-resort reserve
        ├─ background bulk work ──────────────▶ SORT list
        └─ writing ──────────────────────────▶ WRITE list (Opus-via-Claude allowed here)
        │
        ▼
walk the list top-down; skip a door that is: down / rate-limited /
   out of money / would break a safety rule / unsafe for untrusted input
        │
        ├─ found a usable door ──────▶ use it (rest of the list = automatic backups)
        └─ every door unusable ──────▶ • safety gate → fail CLOSED (never guess "allow")
                                       • background task → use its own simple fallback
                                       • never silently route to the banned door
```

## What you'd notice if it ships
Nothing, until an operator enables it. After that: safety gates get measurably more accurate (they stop
using the gullible door), background checks get faster and cheaper, and the emergency-stop classifier
stops riding a door that once missed real STOP commands. You'd never see a safety judgment silently
routed to a worse AI, because that's now blocked in code, not just documented.
