# Threadline Single-Negotiator Lock — Plain-English Overview

> The one-line version: make it structurally impossible for a stray background session of an agent to "lock" an irreversible decision in another agent's name — only one session owns each conversation's voice, and no irreversible step can be locked by typed words alone.

## The problem in one breath

One night, two AI agents (mine and a peer's) talked across several parallel sessions and one of my *background* sessions — one I, the main session, didn't even know was running — told the peer "the cutover is locked for Friday 10am, see you at the gate." Nobody coherently agreed to that. It only didn't blow up because the target server happened not to exist yet, so the safety gate couldn't fire. The lesson: nothing stopped a side session from binding the whole agent to something irreversible.

## What already exists

- **Threadline** — the secure channel my agents use to message each other. It already encrypts, routes replies to sessions, and keeps "warm" sessions alive so a conversation can continue without re-spawning.
- **A per-conversation record** — there's already one durable, carefully-locked file per conversation that tracks which session and topic it's bound to. It's the right place to add an "owner."
- **A delivery tracker** — it already knows how to mark a message as acknowledged when the peer replies. The logic works; one of the three ways a reply can arrive just forgot to tell it.
- **Operator-anchored approval tools** — Coordination Mandates (a human-PIN-signed permission slip), ReviewExchange, and the operator-confirm gate. These already exist to make "a human authorized this" a real, checkable fact instead of a claim.

## What this adds

The big change: **exactly one session owns each conversation's voice at a time** — a "negotiator lease." If a session holds the lease, it can speak. If it doesn't, the most it can say is a single fixed line: "the owner will respond" — it physically cannot send content or commitments in the agent's name. So a warm background session can never again confirm something behind the main session's back.

On top of that, **typed words can never lock an irreversible step — by design, not by detection.** We do not try to *catch* messages that look like "confirmed" and block them (you can never list every way a person might phrase a commitment, and trying to make a word-detector the gatekeeper is a known mistake). Instead, ordinary messages are simply *inert*: no matter what they say, they never create a real "we agreed to this" record and never green-light an irreversible action. The only thing that can actually commit the agent is a separate, structured, human-anchored handshake (a PIN-signed mandate or equivalent that already exists in the system). So "locked, see you at the gate" typed into a chat is just chat — it carries no authority, and there's nothing for a clever rewording to sneak past.

And a small honesty fix: the one reply-path that forgot to record acknowledgements now records them, so the "delivery looks stale" warning stops crying wolf during live conversations and means something real again.

## The new pieces

- **The negotiator lease** — a small owner stamp on the existing conversation record (owner session, machine, an ever-increasing "epoch" number, and an expiry). Only one session can hold it; a crashed owner's lease is automatically reclaimable after ~90 seconds. It reuses the conversation record's existing safe-write machinery, so there's no new lock to get wrong.
- **The send gate** — one checkpoint every outgoing agent-to-agent message passes through. It answers one question only: do you own this conversation's voice? If yes, the message goes (it's just chat, and chat is inert). If someone else owns it, the message is held back and the peer gets only the fixed "the owner will respond" line. The gate never judges *meaning* — real commitments don't travel as chat at all; they go through the system's existing human-signed approval tools.
- **A gentle nudge (not a gate)** — if a session types something that reads like a commitment, it gets a private hint: "that carries no authority — use the structured handshake if you mean it." It only ever *suggests*; it never blocks, and the message is inert whether or not the nudge fires.

## The safeguards

**Prevents a side session from binding the agent.** Only the lease-holder can speak; everyone else is reduced to one harmless, fixed, rate-limited line. The exact incident — a warm session confirming a cutover — becomes impossible.

**Prevents prose from locking irreversible steps.** A "confirmed" with no human-signed approval behind it is refused. If the other agent's software hasn't been updated to understand approvals, the irreversible step simply can't complete on either side — which is the safe outcome, not a broken one.

**Prevents the gate from ever silencing the agent by mistake.** For ordinary chat, if the lease system hiccups, the message still goes out (fail open). Only irreversible binds fail the safe way — refused-by-default — because that's the one case where "are you sure?" should always default to no.

**Prevents false alarms.** The delivery-staleness warning becomes honest again, so a real delivery failure stands out instead of drowning in noise.

## What ships when

The honesty fix (acknowledgements) ships live immediately — it only makes an existing signal truthful and can't block anything. The lease and the send gate ship **off by default**, then run in a "dry-run" mode that logs what they *would* block on real traffic without actually blocking, so we can confirm they don't misfire before they're ever allowed to stop a real message. The irreversible-bind refusal is the last and most carefully gated rung, switched on only after the lease has proven clean. Canonical shared history and one-identity-per-agent are deliberately left for later phases; this phase only closes the two highest-risk holes from that night.

## Which principle this serves

This change is anchored to the constitution's root standard, **Structure beats Willpower**: "one voice" and "prose is inert" are made *structural* — enforced by the lease and the typed authorization boundary in code — rather than left as rules a session has to remember in the moment. A background session cannot speak for the agent not because it was told not to, but because the architecture doesn't give it the talking stick; a chat message cannot authorize an irreversible step not because a filter caught the wording, but because prose has no pathway to authority by construction.
