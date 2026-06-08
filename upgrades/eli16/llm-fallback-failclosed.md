# Fail-Closed for LLM Safety Gates — Plain-English Overview

> The one-line version: two safety gates that asked an AI for a yes/no were quietly saying "yes, go ahead" whenever the AI was unavailable — now they say "wait for approval" instead.

## The problem in one breath

When an AI model makes a safety decision and the model is rate-limited or down, the worst possible answer is to silently fall back to a permissive default — it looks protected but isn't. Two of our gates did exactly that: on an AI failure they returned the *go-ahead* answer.

## What already exists

- **The operations safety-gate** — checks risky external operations (sending email, deleting things) and decides: proceed, show-a-plan-first, or block. It was built after an agent autonomously deleted 200 emails.
- **The outbound-leak gate** — checks content an agent is about to send to another agent for leaks (secrets, system prompts, private data) and decides: safe, sensitive, or blocked.

## What this adds

Both gates now **fail closed** when the AI can't answer:

- The operations gate, on AI failure, returns **"show a plan first"** (require approval) instead of **"proceed"**. A risky operation the AI would have escalated can no longer slip through silently while the AI is down.
- The outbound-leak gate, on AI failure (unparseable reply OR error), returns **"sensitive"** instead of **"safe"**, so unverifiable content is held instead of silently shipped to a peer.

It also lands the **"No Silent Degradation to Brittle Fallback"** standard (when an AI gates a real action, swap providers or fail closed — never silently degrade to a weak check) and the **"Iterative Audit to Convergence"** standard (audit → fix → re-audit until a pass finds nothing new).

## The safeguards

**Prevents fake-safety.** A gate that silently downgrades to a permissive default is more dangerous than no gate, because it looks like it's protecting you. Failing closed removes that illusion.

**No behavior change when the AI is healthy.** A complete, parseable AI verdict behaves exactly as before — these changes only affect the failure path.

**Honest tradeoff.** During a heavy AI rate-limit, more operations will pause for approval instead of silently proceeding. That's the safe direction, and the planned provider-swap (try another AI before failing) will shrink how often it happens.

## What ships when

This PR is the two gate-flips + the standard. Next: a shared provider-swap so gates try another AI provider before failing closed, a lint that flags new silent-fallbacks in gating paths, a re-audit to convergence, and a throwaway sandbox agent for adversarial behavioral testing.
