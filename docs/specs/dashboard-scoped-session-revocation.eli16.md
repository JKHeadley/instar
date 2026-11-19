# Dashboard scoped-session revocation — plain-English overview

## What this is

When you unlock your agent's dashboard with your PIN, the browser gets a **scoped session token** (a short-lived pass, not the permanent master key). That feature shipped recently but is still **switched off everywhere** — it's dark, waiting on a full live test before it's ever turned on. This change fixes two bugs in the *revocation* side of it — the part that's supposed to let you **end** a session — before it's ever flipped on. Nothing changes for anyone today; this makes the dark feature actually keep its promise when the day comes to enable it.

## What already exists

The scoped-token feature already groups every pass from one unlock into a "family," gives each pass a short expiry, caps how long a family can live, and lets a pass be refreshed into a fresh one. It already *has* the machinery to revoke a whole family and to revoke everything — but two wires were never connected.

## The two bugs (both in the switched-off code)

1. **Rotating your PIN didn't end active dashboard sessions.** Changing your PIN ends the "a human is here" proofs on the operator and phone paths — but it never told the scoped-session store to clear out. So a stolen browser pass would survive a PIN change. The "end everyone's session" button existed in the code but nothing ever pressed it.

2. **Once a thief refreshed a stolen pass, you couldn't kick them out.** Refreshing a pass *consumes* the old one and hands back a new one, with no memory that the old one ever existed. So if someone stole your pass and refreshed it once, your own "log out" — which looks the session up by the pass you're holding — found nothing and quietly did nothing, while the thief's refreshed pass kept working. You had no way to evict them short of restarting the server.

## What changes

- **A new PIN now ends every scoped dashboard session**, the same way it already ends the other "human is here" proofs.
- **Reusing an already-spent pass is treated as theft.** The store now remembers which passes have been spent. If a spent pass is ever presented again — the tell-tale sign that two parties are holding copies of the same session — the whole family is ended and a fresh PIN unlock is required. This is the standard, proven way (the same "refresh-token rotation" model banks and identity providers use) to catch a stolen-then-forked session fast. The one tradeoff: on the rare occasion your own browser's refresh succeeds but its reply gets lost on the network and it retries, you'll be asked to re-enter your PIN — a small, infrequent price for closing the theft hole, and far better than the alternative (a tempting "just hand back the pass" shortcut was rejected because it would quietly let a thief ride along on your session).
- **A clear "sign out all dashboard sessions on this agent" control** (`POST /dashboard/session/revoke-all`) so you can end every session in one tap without rotating your PIN. It's gated behind a PIN step-up, so a plain stolen pass can't call it, and it's invisible (returns 404) while the feature is off.

## The safeguards, in plain terms

- **Fail-safe direction:** when a spent pass is reused, we end the *whole* family rather than guess which holder is the real you. Worst case for the honest owner: one extra PIN unlock. Worst case avoided: a thief staying logged in.
- **No memory blow-up:** the "recently spent" memory is tied to a family's lifetime and cleared when the family ends, so it can't grow without bound, and a flood of refreshes can't exhaust memory.
- **Your reliable eviction paths never depend on that short-lived memory:** rotating your PIN and the explicit "sign out" control both just end every family outright.
- **Per machine, by design:** each of your machines runs its own dashboard with its own PIN unlock; a pass from one machine can't be used against another. So ending sessions is correctly scoped to the machine whose dashboard you're on — there's no hidden cross-machine session to miss.

## What you need to decide

Nothing yet — this ships switched off, like the feature it completes. It's a correctness fix to dark code, fully reversible by a revert. The only later decision is the separate, already-tracked one: when to actually flip the scoped-session feature on, after its full live dashboard test.

