# Model-Tier Escalation — Plain-English Overview

## What is this?

We now have access to a new, much smarter AI model (Claude **Fable 5**) that is great at
hard coding work — but it costs about **twice as much** as the model we normally use
(**Opus 4.8**). A live test we ran proved the obvious thing: on easy or medium tasks the two
models are a tie, so paying double buys you nothing. Fable only pulls ahead on the genuinely
hard, long, big-codebase work.

So the rule we want is simple: **use the cheap model by default, and only reach for the
expensive one when the work is actually hard.** This spec is the machinery that makes that
decision happen *automatically*, baked into the infrastructure — not something the agent has
to remember to do.

## When does it switch to the expensive model?

Only two situations (the operator picked these):

1. **Designing a spec or planning a project** — the deep-thinking work.
2. **Building / running a long autonomous coding job** — the heavy lifting.

Everything else — normal chat, brainstorming, quick questions, routine edits — stays on the
cheap default model. The moment the hard work is done, it goes back to cheap on its own.

## How does it actually work (the important part)?

There are two ways to set a session's model, and the spec leans on the **safe** one:

- **The robust way (most of the time):** when the agent *starts a new session* for a build or
  a long autonomous job, that session is simply *launched* on the expensive model from the
  start. When the job finishes, the session ends — so there's nothing to "switch back," and
  no way to get stuck paying double. This handles the highest-value case cleanly.
- **The careful way (one narrow case):** when you're designing a spec *inside an ongoing
  conversation*, we can't restart the session, so we swap its model mid-stream. This is
  trickier and riskier, so the spec wraps it in a safety check: after swapping, it *verifies*
  the swap actually took effect, and if it can't confirm it, it falls back to the cheap model
  and tells the operator. It won't be turned on at all until we prove the swap works live.

It's also built to be **framework-agnostic**: today it only knows about Claude's two models,
but Codex, Gemini, and Pi can plug in the exact same way the day they release their own
"ultra" model. Until then, nothing changes for them at all — they're completely unaffected.

## What's the catch / what did we have to be careful about?

The expensive model costs real money (and burns your usage quota about twice as fast). So a
lot of this spec is **guardrails**: caps on how much it can spend, limits on how many sessions
can use it at once on one account, a timer that forces it back to cheap if something gets
stuck, and an alert to the operator if a long job blows past its budget. It also stays inside
your normal subscription billing — it never quietly switches to a pay-per-use API that could
run up a surprise bill.

## What changes for you if it ships?

If you're just chatting with the agent: **nothing** — you stay on the normal model. If you ask
it to design something big or run a long build: it quietly uses the smarter model for that
work and switches back when it's done. It ships turned **off** for everyone by default
(turned **on** only for the developer agents that build instar, so we can dogfood it), with a
"dry run" mode that logs what it *would* do before it does anything for real.

## The main tradeoff

Smarter results on hard work, at 2x cost — so the whole design is about spending that 2x
**only** where it actually helps, and never by accident. Cheap by default, expensive on
purpose, with the brakes wired in.

---

*Constitutional anchor: this spec serves the "Structure beats Willpower" article of docs/STANDARDS-REGISTRY.md — the model choice is enforced by launch args, hooks, and a server-side gate, never by an agent remembering a rule.*
