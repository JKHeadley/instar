# ELI16 — Why the agent goes silent to you under load, and the fix

## The problem in plain terms

Before a message goes out, it passes through safety gates (a "tone gate" that blocks leaks like passwords or raw commands; a deeper "coherence" review). Normally those gates produce a verdict: send, or block.

But sometimes a gate can't get a verdict at all — the machine is busy and the gate's helper times out, or the AI provider is briefly unavailable. The gate then has to guess: when in doubt, *deliver* or *hold*?

Right now the two outbound gates guess in OPPOSITE wrong directions:
- The **tone gate** holds (blocks) on a timeout — for EVERY recipient. So under load, the agent's status replies **to its own operator** get silently held. That's literally been happening this session: replies to you were held with "did not produce a verdict within the budget," which is why I've been reaching you on a direct backup channel.
- The **coherence reviewer** does the opposite — on an error it quietly returns "looks fine, send it," even for **external** recipients. That risks delivering an *unreviewed* message (a possible leak) to a third party.

## The insight

The right answer depends on WHO the message is going to:
- **To your operator** (you): a momentary gate failure should **deliver**. Worst case is a status note reaching the person who already controls the agent — near-zero risk. Sealing you out of your own agent is the real harm.
- **To anyone external** (other users, the public, another agent): a gate failure should **hold**. A leak to a third party is the real harm.

A genuine *verdict* — a real "this leaks, block it" — always blocks, for everyone. This only changes what happens when the gate **can't decide** (an availability failure), not when it actually decides.

## The fix

One shared helper decides the fail direction from the recipient: operator → deliver, external → hold. Both outbound gates use it. "Who is the operator" comes from the verified, authenticated operator binding — never from a name typed in a message (you can't talk your way into being treated as the operator).

## Safety

- A real block verdict (leak detected, a banned self-stop) still blocks regardless of recipient — unchanged.
- The external direction stays fail-CLOSED (no new leak risk to third parties).
- "Operator" is the cryptographically-verified bound operator of the conversation, not content. A topic with no verified operator defaults to "external" (the safe, fail-closed side).
- Ships behind config knobs (tri-state: always-hold / tiered / never), defaulting to the new tiered behavior, with dry-run first; fully revertible to today's behavior.
- This is the outbound twin of the "Operator Channel Is Sacred" fix that already shipped for *inbound* messages (#1274).
