---
title: How does a machine prove something about itself that it can't see?
slug: machine-self-assertion
parent-principle: "Know Your Principal — An Unverified Identity Is a Guess"
audience: decider
---

# How does a machine prove something about itself that it can't see?

## The one-sentence version

Twice in one week a machine needed to tell the others something true about itself —
"here's my new key", "here's the address that actually reaches me" — and had no way to
prove it; this design lets the mesh accept the truth automatically when the evidence backs
it, and asks you for one tap only when the evidence can't tell recovery from takeover.

## The two things that happened

**The lost key.** The Studio's identity files went missing on the 27th. Its keys were
regenerated. The other machines still held the old key, so every message the Studio sent
was rejected as forged — nearly eleven thousand rejections per connection — and the mesh
ran one-way for two days. Fixing it took a human writing files onto each machine by hand.

**The invisible address.** One machine runs its agent inside WSL, a Linux box nested
inside Windows. The address everyone reaches it on belongs to the Windows side, which the
agent literally cannot see. So it announces an address that works from nowhere, and can
never announce the right one.

## Why "just let it announce itself" was rejected

Your directive was the least human effort possible, and the first draft said: fully
automatic — a machine announces its new key, proves it holds that key, done. Eight
independent reviews (including two non-Anthropic models) all found the same hole: *anyone*
who just created a key can prove they hold it. That proof filters out nobody. Combined
with the shared machine password, a fully automatic accept would mean anyone who stole
that password could become one of your machines — and the only trace would be one
notification into a queue that provably buried the last critical alert for two days.

## The design that keeps it zero-touch anyway

The later security review found an important correction: rotation notes, signature
refusals, and familiar addresses are useful evidence, but someone holding the shared
machine password can manufacture all three. They cannot safely authorize a new identity.

Instead, pairing creates a separate **recovery root** whose private half is kept in the
operating system keychain, outside the folder whose loss caused the incident. If the normal
signing key disappears, the machine signs the exact replacement identity and generation
with that recovery root. Peers already pin its public half, so they can verify continuity
without the old signing key and without a human tap. The incident from the 27th would have
healed itself in minutes.

The recovery root cannot be installed or replaced by the shared machine password. Initial
setup uses the one-time pairing ceremony; later replacement requires a grant signed by the
already trusted root. If the proof is absent, stale, conflicting, or comes from a machine
without genuine keychain escrow, the claim is parked and the dashboard presents one
approve/deny action bound to that exact claim. Ambiguity never becomes automatic trust.

Every identity change also lands in a permanent ledger that keeps resurfacing until you
acknowledge it — so even a change you didn't approve can't slip past unseen, no matter how
noisy the notification queue is that day.

## The address half

For the machine that can't see its own address, peers now record where authenticated
traffic actually arrived from and keep any route that is demonstrably working. The new
observation is deliberately telemetry in this release, not identity authority: a private
address shape and a successful dial-back do not cryptographically prove which Tailscale
node owns it. That avoids silently turning shared-egress evidence into a redirect. The WSL
machine remains reachable because proven routes are retained, while future promotion has
a clean evidence stream to bind to a machine-to-node proof.

## Safety rails, briefly

Announcements carry a strictly increasing generation number, one-use challenge, exact
recipient, expiry, and replacement-key proof, so an old capture cannot be replayed or sent
to another peer. Attempts are persisted before network I/O and widen from one minute to
six hours, with a 72-hour terminal horizon and a one-per-peer/day governor floor.
Everything ships switched off for the fleet and in rehearsal mode on development machines
first, and the file-editing hole that made all this possible is closed in the same change
that opens the proper door.

## What you need to decide

Nothing new — this is your least-human-effort directive, made survivable: zero taps for
every legitimate case, one tap reserved for the case where the evidence itself says
"this could be theft."

## One correction the review forced (worth knowing)

The recovery-key idea only works if the recovery key is stored somewhere that survives the
very failure it's for. On Macs it is — the system keychain outlives a folder getting deleted.
On a plain Linux/Windows-WSL machine, the vault's own key lives *in the folder that
disappeared*, so stashing the recovery key there would vanish right alongside everything else.
So: machines with a real system keychain get the fully-automatic recovery; machines without
one honestly say "no auto-recovery here — I'll ask for one tap if the rare double-failure
ever hits," instead of pretending to be protected. That's safer than a guarantee that
evaporates exactly when you need it.
