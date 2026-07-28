# ELI16 — Why "0 machines awake" was a lie, and how we fixed it

**Parent spec:** `docs/specs/machine-coherence-guard.md` §5b (this implements it).

## The problem, in one picture

You run one agent across two computers: a Laptop and a Mac Mini. At any moment,
exactly ONE of them is "awake" (in charge of answering you) — decided by a
lease, which is like a numbered "I'm in charge" badge that gets passed back and
forth. The other computer is "standby."

On 2026-07-04 the Mini correctly held the badge, both computers were online, and
they could talk to each other over two of their three network "ropes"
(Tailscale + local network were fine; only the Cloudflare rope was down). And yet
the health page said **`awakeMachineCount: 0`** — zero computers awake — while at
the same time correctly saying **`leaseHolder: Mini`**. Zero machines awake, but
one machine holds the "I'm awake" badge? That's a contradiction. It scared the
operator into thinking the mesh was broken.

## Why it happened

The health page computed "how many are awake?" the LAZY way: it counted rows in a
shared address book (the machine registry) that had the word `"awake"` next to
them. But that address book is updated slowly and separately from the actual
badge. Each machine writes its OWN "awake" note into the book and then has to git-
sync it to the other machine. If that sync lagged — or the machine reading the
book just hadn't received the peer's note yet — the reader saw NO "awake" notes
and printed 0. Meanwhile the badge (the lease) had ALREADY told it the Mini was
in charge, over a perfectly healthy rope. The page was reading a stale sticky note
instead of the real badge.

Important: the dead Cloudflare rope was NOT the cause. The other two ropes carried
the badge fine (that's why `leaseHolder` was right). The count just looked at the
wrong thing.

## The fix

Count "awake" from the BADGE, not the sticky note. The new rule:

- **You** are awake if you hold the badge → +1.
- **A peer** is awake if the last time you actually heard from it, it showed you
  ITS OWN live badge. Three checks, so we never over- or under-count:
  - **Fresh** — you heard from it recently (within 3 heartbeat intervals), not
    minutes ago.
  - **Live** — the badge it showed hasn't expired.
  - **Its own** — the badge names THAT peer as the holder (if a peer relays a
    badge belonging to some THIRD machine, that's gossip, not the peer's own
    claim, so it doesn't count).

So a healthy mesh with the Mini holding the badge now reads **`1`** — and it's
tagged **`lease-live`** so you know it came from the real badge. A genuine
"both think they're in charge" split-brain still reads **`> 1`**. If we truly
can't read the badge, we say **`null` / `unavailable`** — never a fake 0.

Old-style git-only meshes (no live badge-pull) fall back to the sticky-note count,
now honestly tagged **`registry-roles`** so you know it might lag.

## What this does NOT do

It's a READ-ONLY honesty fix for a number. It never moves the badge, never demotes
a machine, never blocks a message. Deciding who's in charge is still the lease's
job (and the operator's for a stuck split-brain). We only fixed the number that
kept lying about it. `instar doctor` now also prints this live number and warns if
the old sticky-note count disagrees with it.
