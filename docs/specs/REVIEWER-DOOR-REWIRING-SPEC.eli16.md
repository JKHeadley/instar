# Reviewer-Door Rewiring — the plain-English version

## What's the problem?

Before any code change lands in Instar, the design gets reviewed by a panel of AI reviewers — some running inside my own coding environment, and two "outside opinions" running on other companies' models (GPT and Gemini). Our benchmark project discovered something surprising: **the same AI model gives noticeably worse answers depending on which "door" you talk to it through.** Talking to Anthropic's top models through the coding-tool door scored 81.7% on our tests; talking to the same family through a clean, direct door scored 99.1%. That's a 17-point difference from the doorway alone.

Right now the review panel's doors are whatever history left us. Worst of all: **Anthropic's strongest model (Fable 5) never reviews specs at all** — there's no Anthropic seat on the outside-reviewer bench, and the only way we use Anthropic models for review is through the penalized door.

## What does this plan change?

Three provider-by-provider decisions, made deliberately instead of by accident:

1. **Anthropic — the big win.** Add a new reviewer seat that talks to **Fable 5 through a clean, direct door** we already have built (no new infrastructure). It ships switched OFF everywhere except my development setup until Justin says otherwise. One honesty rule: because I'm a Claude-family agent myself, this new Claude reviewer **never counts as an "outside opinion"** — the report books it in its own separate column, so we can't accidentally grade our own homework and call it external review.
2. **OpenAI — leave it alone.** The GPT reviewer already reaches gpt-5.5 through a direct subscription door. The door penalty was measured on the *Anthropic* coding door, not this one — and rerouting through a middleman service (OpenRouter) would mean sending our design documents through a third company's servers for no measured benefit. Declined, with a written condition for when we'd reconsider.
3. **Google — mostly done already.** The Gemini reviewer was quietly bumped to the newest model (gemini-3.1-pro-preview) last week. Its real problem is that it keeps timing out — so first we give reviews a bigger time budget (free), and only if it *still* chronically times out do we consider paying for a direct Google API door. That decision has a concrete trip-wire (3 failed convergences in a row) instead of a vague "later."

The six inside reviewers keep their tools (they need to read the actual code to check a spec's claims) — they already get the strongest model automatically when my session is escalated to Fable 5.

## What are the risks and costs?

Very low. Nothing changes on anyone's machine until a config switch is flipped (flipping it back is the entire rollback). The new reviewer costs one extra Fable 5 call per review round on the existing subscription — no new API keys, no new bills, no new companies seeing our documents. The main design risk — the new Claude reviewer masquerading as an independent outside opinion — is closed in code, not by promises.
