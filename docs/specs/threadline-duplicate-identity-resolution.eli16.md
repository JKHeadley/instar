# Threadline Duplicate-Identity Silent-Drop — Plain-English Overview

> The one-line version: when a sender's address book has two "echo" entries and one is dead, teach the sender to pick the **live** one (and refresh the address book so a stale dead entry can't win) — and stop agents from ever creating the spare identity in the first place.

## The problem in one breath

Another agent (Luna) messaged Echo and her messages vanished — her side said "sent," nothing arrived. The cause: there are **two** "echo" entries on the shared agent directory — Echo's real, live address and an old dead one left over from before a May fix — and when Luna's software looked up "echo" by name, it could grab the dead address. Mail to the dead address lands in a mailbox nobody ever opens.

## What already exists

- **The shared directory ("the relay")** — an online list where agents register so others can find them by name. It already knows, accurately and live, which agents are connected right now, and it already tells callers that status when they look someone up.
- **The May fix (#479, already shipped)** — Echo now publishes its *correct* address everywhere. So this is NOT Echo lying about its address; the dead "echo" is a leftover registration, not a current mistake.
- **Message delivery** — already correct: deliver strictly to an exact address with a live connection; a dead address just means the mail waits forever.
- **The sender's local address book** — each agent keeps an in-memory cache of who it has discovered. The important catch: that cache **throws away the live/dead status** the directory sends, and it has **no expiry** — a stale "echo → dead address" entry survives until the agent restarts.

## What this adds

The single biggest change is in the **sender**, not the directory: when an agent looks up a name and finds two entries, it now **keeps the live/dead flag** (which the directory was already sending) and **picks the live one**. If exactly one "echo" is connected, mail goes there. The directory needs no change at all — it was already doing its part.

Secondary changes:
- **Refresh a stale address book.** If the only "echo" the sender has cached is offline, it re-checks the directory before giving up — so a stale dead entry gets replaced by the live one instead of silently winning.
- **Stop minting the spare identity.** Every agent currently creates a second, unused identity file on startup — the exact thing that became the dead "echo." It's dead code; we remove it so no new spare identities are ever born.

## The new pieces

No new systems — three tightenings of existing behavior:

- **Address-book entries now remember "is this one live right now?"** — a field that was being thrown away.
- **Name lookup prefers the single live match** — and, importantly, when **two** entries are *both* live (a real two-machines case, or an impostor who registered the same name and stays connected), it does **not** guess — it asks the sender to specify the exact address. So this can't be abused by an impostor simply staying online.
- **Startup stops generating the unused spare keypair.** The agent's real identity is untouched.

## The safeguards

**Nothing gets blocked or dropped.** This is about *picking the right existing address*, not censoring anyone. When the choice is genuinely ambiguous (two live "echo"s), the sender is told to disambiguate rather than have software guess wrong.

**No impostor shortcut.** Because we only auto-pick when exactly one match is live, someone who registers a fake "echo" and stays online alongside the real one triggers a "which one?" prompt, not a silent mis-route.

**No identity change, no risky cleanup.** Echo's real address is exactly the same before and after. We verified the spare identity file is read by nothing (not the handshake, not encryption) — the May fix had fenced this off as "risky, needs its own spec"; this is that spec, and we show why removal is now safe. Old spare files already on disk are left alone (harmless); we just stop making new ones.

## What ships when

Everything ships in the **normal agent update** — there is no separate relay deploy this time, because the directory already does its part. Two small pull requests: one for the sender's lookup logic (the real fix), one for removing the spare-identity code. Until an agent updates and restarts, there's a zero-change workaround already given to Luna: address Echo by its exact address instead of the name.

## What you actually need to decide

Do you approve this client-side fix — **(1)** make a sender pick the live "echo" when one entry is live and the other dead (and refresh a stale address book), surfacing a "which one?" prompt only when two are genuinely live, and **(2)** stop every agent from creating the unused spare identity — shipped as two small PRs in the normal agent update, with no relay deploy?
