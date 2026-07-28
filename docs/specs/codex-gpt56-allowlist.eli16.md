# Adding GPT-5.6 to the Codex Model Allowlist — Plain-English Overview

This is the plain-English companion to this change. Read this first.

## What we're changing

OpenAI released a new family of models — GPT-5.6, in three sizes: `gpt-5.6-sol` (the big flagship), `gpt-5.6-terra` (a mid-size one), and `gpt-5.6-luna` (a small, cheap one). They went GA and work right now on the Codex subscription we already pay for.

But instar didn't know about them yet. Instar keeps a short, deliberate list of the exact Codex model names it will accept — a safety measure so a typo or a made-up model name in a config can never quietly reach a real command line. That list stopped at `gpt-5.5`. So even though the operator had already set his config to escalate heavy work onto `gpt-5.6-sol`, instar was ignoring it (correctly — it wasn't on the approved list, and the design fails closed on anything it doesn't recognize).

This change simply ADDS the three new names to that approved list, in the two places the list lives: the model-tier-escalation resolver (which decides when to run a session on a bigger model) and the session-spawn validator (which checks the model name when a new session is launched). The topic-profile validator reads the same list, so it picks up the new names for free. Nothing else changes — the safety design that rejects unknown names is exactly the same; we only taught it three more real names.

## What you'll see day to day

For almost everyone: nothing. If you never touch Codex models, this is invisible.

If you use Codex (`codex-cli`) as a framework:
- You can now pin a topic or a session to `gpt-5.6-sol`, `gpt-5.6-terra`, or `gpt-5.6-luna`, and instar accepts it instead of rejecting it as unknown.
- The operator's existing config (escalate heavy work onto `gpt-5.6-sol`) becomes live the moment this ships.
- One catch: your Codex CLI must be version 0.144.0 or newer. Older CLIs reject these models with a "requires a newer version" 400 error. If you see that, update the Codex CLI.

## What we deliberately did NOT do

- The `-pro` variants of GPT-5.6 are NOT added. They're likely plan-gated and pricier, so they stay off the list for now (a tracked follow-up).
- We did NOT change which model instar PICKS for a given tier. The "capable" tier still resolves to `gpt-5.5`. New models earn a spot in the routing lanes through benchmarks, not just by existing. This change only makes the new names ACCEPTABLE if you choose them — it does not promote them to the default or the frontier pin.

## Why it's safe

Adding a name to an allowlist can't break anyone who wasn't already asking for that name. Every existing model keeps working. A made-up name like `gpt-9.9-fake` is still rejected, exactly as before. The change is purely additive and fails closed on anything it doesn't recognize.
