# Double-send in-flight reservation — Plain-English Overview

> The one-line version: when the server was slow, the same message could go out twice because the "have I already sent this?" check happened before the send was marked done — this reserves the message the instant it starts sending, so a second identical copy can't slip through the gap.

## The problem in one breath

Sometimes users saw the same message from the agent twice. One cause: the agent has a guard that says "if I already sent this exact text to this chat recently, don't send it again." But that guard only wrote down "sent!" AFTER the send finished. When the server was stalled, a send could take 30+ seconds — and if a second identical send started during that gap, the guard hadn't written anything down yet, so both went out.

## What already exists

- **The exact-duplicate guard** — already blocks the identical message from being sent twice, and even remembers across restarts (a small durable store). It works fine *once the first send has finished and been recorded*. The gap was only the in-between window.
- **A separate near-duplicate detector** — notices when two messages are *similar but reworded*. Crucially, this one is only a *hint* fed to the smart safety reviewer; it is deliberately NOT allowed to block on its own, because "80% similar" can mean "a bug repeated itself" OR "the user asked me to say it again," and a dumb similarity score can't tell those apart.

## What this adds

A "reserve" step. The instant the agent decides to send a message, it now *claims* that exact text as in-flight — before the send starts. If a second identical send shows up while the first is still going, it sees the claim and steps aside. When the first send finishes, the claim is upgraded to the normal "already sent" record. If the first send *fails*, the claim is released immediately so the genuine retry can go through. And if something crashes and a claim is never resolved, it auto-expires after a few minutes so it can never permanently block that text.

## The new pieces

- **`tryReserve`** — one atomic step that both checks "already sent or already in flight?" and, if not, claims it. Returns "go ahead" or "stop, it's a duplicate."
- **`releaseReservation`** — undoes the claim when a send fails, so retries aren't punished.
- **Auto-expiry** — a claim that's never resolved disappears on its own after ~3 minutes.

## The safeguards

- It only ever suppresses an **exact** duplicate (same text, same chat) — never a reworded message, never a short "got it" ack, and never anything the caller marked "allow duplicate."
- It is placed AFTER the smart safety reviewer, so a message that reviewer holds for later never gets stuck behind a stale claim.
- It changes nothing about the *reworded* double-send. That's a harder problem that needs a proper design, because catching "similar" messages with a blunt threshold would start blocking legitimate repeats — exactly the mistake instar's "signal vs authority" rule exists to prevent. That work is tracked separately.
- Everything is in memory only — nothing new is written to disk, so rolling this back is a clean one-step revert.

## What you need to decide

This is the principle-compliant half of the double-send fix: it closes the exact-duplicate race safely, with full test coverage (unit tests for the reserve/release/expiry lifecycle, plus a route test that literally holds one send in flight and proves the second is suppressed and that a failed send still lets its retry through). The one thing to be aware of: it does NOT stop *reworded* duplicates — that half is intentionally deferred to a proper spec, because doing it naively would violate a core instar principle. So this ships as a real, safe improvement, with the harder half honestly flagged rather than botched.
