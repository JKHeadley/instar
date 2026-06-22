# ELI16 — what to do when the AI hits a rate limit, in the right order

## The problem in one sentence

When your agent's AI provider says "slow down, you've hit your limit," the agent has to decide
what to do next — and right now it jumps straight to switching AI providers (e.g. from Claude to a
different model), when it should first try gentler options. And if it ever falls back to a dumb
rule-of-thumb instead of real AI, nobody is guaranteed to notice that it's stuck that way.

## What the operator wants

A clear, ordered ladder for handling a rate limit, from gentlest to last-resort:

1. **Back off** — wait a moment and try the SAME provider again (it usually clears in seconds).
   "Slow but correct" beats "fast but switched."
2. **Swap account** — if you have more than one login for the same provider (e.g. two Claude
   accounts), try the other account, staying on the best provider.
3. **Swap framework** — only now switch to a different AI tool (Claude → Codex → Gemini).
4. **Queue it** — if the work can wait (a background check, not something you're waiting on),
   put it in line and retry shortly instead of giving up.
5. **Dumb rule-of-thumb** — only as a true last resort, only for low-stakes calls — and **never
   silently**: if the agent is stuck on a rule-of-thumb, it must say so loudly and keep trying
   until the real AI comes back.

The golden rule: **prefer slowing down over falling back, and never quietly stay broken.**

## What already exists (so this is an extension, not a rebuild)

A lot of this is already built: the agent already switches frameworks on failure (step 3), already
treats the dumb-rule path as a last resort, already has a multi-account pool (for step 2), a queue
(for step 4), and a "something degraded" reporter. The four missing pieces are: the back-off step
(1), wiring the account pool into this exact decision (2), wiring the queue in (4), and — the big
one — making a stuck rule-of-thumb LOUD and self-healing instead of silent.

## What's new

- A real **back-off-and-retry** step before any switching, with sane limits so a call you're
  waiting on never hangs.
- Wiring the **multi-account pool** into the rate-limit decision so it tries another account before
  changing providers.
- Wiring the **queue** in for work that can wait.
- A **"never silently degraded" tracker**: the moment the agent drops to a rule-of-thumb, it opens
  a flagged note; it clears itself automatically the next time a real AI call succeeds; and if it
  stays stuck too long (default 15 minutes) it raises a loud alert. It can't quietly rot.

## What the reader needs to decide

Everything ships **off by default** (and on for the dev agent first), so turning it on is your
call. The only real knobs are the back-off limits (how long to wait before switching) and how long
a stuck fallback can last before it shouts — both have safe defaults you can tune. A consequential
or irreversible decision is **never** handed to a rule-of-thumb; it waits or fails safely instead.
