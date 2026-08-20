# Agent Identity Continuity on Expansion — Plain-English Overview

> The one-line version: when an agent spreads onto a new machine, it should still be the same agent — right now it quietly becomes a second one.

## The problem in one breath

Agents are found by an address, the way a phone number reaches a person. One agent should have one address, whichever of its machines is answering. When an agent expands onto a new machine, the new machine doesn't receive that address — so it makes up its own. Nothing says anything. The agent is now two agents wearing one name.

## The clearest proof it isn't cosmetic

The operator asked whether the feature that stamps Telegram messages as coming from the agent
rather than from him was affected by this. It is, and testing it settled the question.

A plain message was signed on the new machine and shown to all three:

- The machine that signed it said yes, that's genuinely from the agent.
- The laptop said no, bad signature.
- The mini said no, bad signature.

Same message. The two older machines look up the agent and get one identity; the new machine
signs with another, so to them the signature is a forgery.

In practice that feature is switched off on the new machine — nothing signed there can be
confirmed as the agent by the others. It fails in the safe direction (it says "this didn't
check out", not "this was the operator"), but the guarantee it exists to give is simply absent.

## What already exists

- **Expanding onto a new machine** — copies the shared project, gives the new machine its own local settings and its own machine keys, and registers it with the machine it joined. All of that works.
- **A pairing code** — a short code you carry from one machine to the other to prove the two belong together. It already works and you already use it.
- **A fix from July** — when this last caused trouble, the message-sending side was taught to prefer the live address over a dead one. That reduced the damage. It didn't stop the cause.

## What this adds

The identity travels with the expansion, over the pairing exchange that already happens. No new step for you.

- If it can't be carried, the new machine **refuses to invent one** and says so, rather than quietly becoming a twin.
- Machines that are already split get repaired.
- And something notices when a split exists, which nothing does today.

## The new pieces

- **The sealed handover** — the identity is locked so only the joining machine can open it, and stamped with details of that exact exchange, so it can't be lifted and reused elsewhere.
- **The refusal** — a machine that has joined a mesh is no longer permitted to invent an identity at all. That's what makes the fix stick rather than depending on the handover always succeeding.
- **The check** — every machine compares its address with the others and reports what it finds, including when it couldn't reach one, so silence never gets mistaken for agreement.

## The safeguards

**A wrong repair can't take your agent off the network.** Every uncertain case stops and asks rather than guessing. Repairing to the wrong address would be worse than the split.

**Someone impersonating your machine can't hand over a fake identity.** The pairing code you carry is what proves the other end is really yours, and the joining machine checks the identity it receives against a value shown to you.

**A dropped connection doesn't cost you a whole new setup.** The same machine can retry until the code expires; anyone else presenting it is refused.

**A half-written key can't happen.** The identity is written completely or not at all, readable only by its owner, and the old one is kept as a backup first.

## What it does NOT do, and one real cost

The split you already have **cannot be repaired automatically.** The mechanism that decides which address is correct only works for identities created after this ships. Yours predate it, so fixing your machines needs one decision from you — you'll be shown the options in plain terms and pick one, not compare two strings of gibberish.

The stale copies of your agent already registered on the network are **not cleaned up by this.** That needs work on a different component, and I'd rather say so than let you think it's tidier than it is.

And the honest cost: every machine ends up holding the same key, so any one of them can sign as the agent. If a machine is stolen or retired, its copy still works until the identity is replaced everywhere. That's a real weakness, accepted here because the alternative means changing what an agent's address means for everyone who has ever saved one. It's marked as a bridge, not a destination.

## What you actually need to decide

Whether to fix this at the source — so expanding onto a machine carries the identity and refuses to invent one — accepting that your existing split still needs one explicit choice from you afterwards, and that stale registrations stay until separate work clears them.
