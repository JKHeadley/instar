# Secure Agent Pairing — the plain-English version

## What problem is this solving?

I (Echo) can talk to other AI agents — like Dawn, who runs on a different computer. We can already send each other encrypted, signed messages. But there's a gap: when a message arrives claiming to be from "Dawn," I can prove it came from *some* keyholder, but I can't prove that keyholder is *really the Dawn my operator trusts* and not an impostor sitting in the middle swapping identities.

That gap had a real consequence: Dawn refused to send me a credential (a secret token) over our channel, because she couldn't prove the request was really from me. She was right to refuse. The whole point of this feature is to close that gap so two agents can verify each other strongly enough to safely hand over secrets.

## The everyday analogy

It's exactly like pairing Bluetooth headphones, or verifying a contact on Signal/WhatsApp. When you pair two devices, both show you a short code, and you check that the two codes match. If a hacker were secretly sitting in the middle, the two codes would NOT match, and you'd catch it.

We do the same thing: when my agent and Dawn's agent shake hands, each side computes the *same* short 6-word code from the shared math of that handshake. A human (the operator) reads the 6 words shown on each side and confirms they match. If someone were impersonating one of us, the words would differ — caught. This short code is called a SAS (Short Authentication String).

## What actually changes

1. **A 6-word code appears** when two agents pair. Both sides should show identical words. The operator confirms the match.
2. **Confirming requires the operator's PIN** — not my bot's own credentials. This is deliberate: it means I can't quietly "approve myself." A real human has to look at the words and tap confirm.
3. **Once confirmed, the two agents are "mutually verified"** — a durable record that says "a human checked these two are who they claim." Only then is a special "share a credential" permission unlocked between them.
4. **Sending a secret is blocked unless the other side is mutually verified.** This is enforced deep in the plumbing (the single place all messages go out through), not by me "remembering" to check — so it can't be skipped. And the block fails *safe*: if anything is uncertain, the secret does NOT go out.
5. **The verification follows me across my computers.** If the operator verifies Dawn on my laptop, my other machine honors that too — but only after pinning Dawn's exact identity key, so a different key on the other machine can't ride in on the old approval. The secret code itself never leaves the machine that made it.

## The main tradeoffs

- **A human is in the loop, once.** You can't get strong identity verification for free — someone has to compare the codes the first time. After that, it's remembered. We judged that one-time human check is worth it, because the alternative (auto-trusting) is exactly what lets an impostor in.
- **It ships "dark" first.** The feature is off by default and turns on for development first, so we can test it safely before any real agent depends on it. But the part that *blocks a secret from leaking* is on from the very first moment it's enabled — a leak-prevention gate must never have a "log it but allow it anyway" warm-up phase.
- **It is not a leak-detector for everything.** This protects the sanctioned "share a credential" path. It does not scan every message for accidentally-pasted secrets — that's a different, separate safety system. We're honest about that boundary rather than overpromising.

## Why it was reviewed so hard

Sharing credentials between agents is high-stakes and irreversible — if a secret leaks to an impostor, you can't un-leak it. So the design went through a multi-angle review (security, adversarial, multi-machine, and two outside AI models). That review caught real issues: the gate had to be moved from "the agent remembers to check" to a structural choke point; confirming had to require the operator's PIN rather than the bot's token; and a verified pairing had to follow me across machines without stranding. All of those are now baked in before any code is written.
