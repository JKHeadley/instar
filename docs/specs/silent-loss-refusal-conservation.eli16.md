# Silent-Loss Eradication — Plain-English Overview

> The one-line version: when the agent's own machinery refuses a message, that refusal must stay visible at every step and the user must be told — never again a "delivered successfully" log while your message evaporates.

## The problem in one breath

On July 1st, every message Justin sent the agent silently vanished for most of a day. A test three weeks earlier had overwritten the file that lists real users, so when the two-machine mesh double-checked "is this sender allowed?", it rejected the real operator — and the code that forwards messages translated that rejection into "forwarded, acknowledged, all good." Both machines' logs looked green. Nobody was told anything.

## What already exists

- **The mesh forwarding pipe** — when a message arrives on one machine but the conversation lives on the other, a signed hand-off delivers it across, and the receiving side re-checks the sender against its own user list (that re-check is what fired).
- **The message queue's honest half** — one delivery path already records "sender rejected" as a terminal reason; but the LIVE forwarding path masks it as success, and neither path tells the user.
- **The user registry** — the file of real users. Nothing stops test data from being written into it, and nothing checks it is sane before the mesh starts trusting it to reject senders.

## What this adds

The big change: a rejection now travels as a REJECTION through every layer — a first-class outcome the code cannot mistake for delivery, a log line that always shows it, and a permanent trace written on the machine that made the decision. On top of that:

- **You get told.** If a message of yours is terminally dropped, the topic receives one plain notice saying delivery is blocked and why — sent through the simplest, most reliable path (never through an AI filter that can itself fail), and deduplicated so replay storms produce one notice, not three.
- **The sanity gate.** The sender re-check now refuses to even arm itself against a genuinely-empty user registry — because an empty registry rejects EVERYONE, which protects nothing and silences the operator. The subtle part: a brand-new install and a maliciously-emptied one look byte-for-byte identical on disk (both an empty list), so the agent keeps a tiny durable "this registry has held a real user before" mark to tell them apart — a never-populated registry fails toward delivery (a fresh install must let the operator's first message through), but one emptied by deleting its last real user keeps rejecting and shouts loudly (that's not a fresh install, it's a problem). A corrupted-but-previously-populated registry also fails safe by rejecting, not by opening the doors. And it double-checks the verified operator actually resolves — if the machine that owns the conversation can't find its own operator, it declines to arm and raises an alarm instead of silently locking everyone out.
- **The registry defends itself.** Known test identities are refused at the write layer — the same class of clobber can't happen again, with a narrow escape hatch that only isolated test environments use.
- **A permanent tripwire.** A build-breaking test asserts that no future code change can ever map a rejection back into a success shape. This lesson is now load-bearing, not remembered.

## The safeguards

Real deauthorization still works: a healthy registry that genuinely doesn't recognize a sender still rejects them — the fail-open only applies to degenerate registry states, and even then identity is checked against the second store, everything is loudly logged, and the mesh's outer wall (cryptographically signed peer-to-peer calls, router-only permission to deliver) still stands. Nothing here loosens who may talk to the mesh; it fixes what happens when the mesh's own paperwork is broken.

## Open questions

None left open — the operator pre-approved this project's decisions (topic 29836), and every reviewer-contested choice was resolved in the spec itself: the notice wording is fixed text, the guards are always-on (they only fire where today's behavior is silent loss), and the full ack-vocabulary split is explicitly deferred with a tracked marker rather than half-done.
