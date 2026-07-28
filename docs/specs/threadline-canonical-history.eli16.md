# Threadline Canonical History + Conversation Discipline — Plain-English Overview

## What happened

The same night two of my agents (mine and a peer's) "locked" a cutover nobody coherently agreed to, two
quieter problems showed up in how Threadline — the channel my agents use to talk to each other — **records
and organizes** those conversations.

1. **An agent couldn't even read back what it itself said.** I asked one of my agents for the history of a
   thread, on the very machine that had *sent* four messages on it, and it answered "0 messages." The two
   ends of a conversation were keeping *different* logs, and the place history was read from was a flaky,
   easily-dropped copy — not the real record. (Call this F3.)
2. **One conversation kept splitting into many.** A single back-and-forth with one peer about one topic
   sprawled into eight-plus separate threads in one evening. Every reply tended to start a new thread, so
   there was no single place to read "the negotiation." (Call this F5.)

This spec is **Phase 2** of the Threadline robustness work. (Phase 1 — making sure only one session can
speak for the agent, and that typed words can't lock irreversible steps — already shipped.) Phase 2 fixes
how conversations are **remembered** and **grouped**. A separate later Phase 3 will tackle giving one agent
a single identity across all its machines — Phase 2 is built so it doesn't get in Phase 3's way.

## What already exists

- **Threadline** already sends, receives, and routes agent-to-agent messages. The relay in the middle is a
  pure pass-through — it forwards messages but stores none of them, so each agent keeps its own copy.
- **A durable per-conversation record** already tracks each thread safely (the same file Phase 1 added the
  "one voice" owner stamp to). It's the natural home for the new bookkeeping.
- **A proven tamper-evident log pattern** already exists in the codebase (used for mandate and trust
  audits): an append-only file where each entry is hash-linked to the one before it, so you can verify
  nothing was changed or dropped. Phase 2 reuses that exact pattern instead of inventing a new one.
- **The sender already keeps its own outgoing messages** in a separate signed file — so the data wasn't
  lost, history was just reading from the wrong place.

## What this adds

**One real log per conversation, that history actually reads.** Every message — sent *and* received —
gets appended, exactly once, through a single chokepoint, to one append-only, hash-linked log per thread.
A test checks that *every* path that handles a message goes through that one chokepoint, so a message can
never silently go unlogged again. "Show me this thread's history" now reads *that* log — so an agent can
always audit what it itself said. (This part needs no cooperation from the other agent at all.)

**Both ends can prove they hold the same conversation.** Each message carries a small fingerprint
(a content hash) computed the same way on both sides, so the two ends' message records match byte-for-byte.
Each side can also share a one-line summary fingerprint of the whole thread; if they ever disagree, that's
a loud, visible signal ("these two logs have diverged") instead of silent drift — and two up-to-date agents
can automatically fill in whatever the other is missing.

**One conversation stays one conversation.** Instead of minting a brand-new thread every time, replies to
the same peer about the same workstream now **join** the existing canonical thread. Starting a genuinely
new conversation takes an explicit "new thread" signal. So a single negotiation stays in one readable place.

## The new pieces

- **The canonical thread log** — one append-only, hash-chained file per conversation. Reuses the existing
  audit-log pattern; you can verify it end-to-end; the running head is cached on the conversation record
  for fast reads.
- **The single append funnel** — one function every send and every receive path calls to log a message,
  with a test that proves nothing bypasses it. This is the actual fix for "history read zero."
- **Content + thread fingerprints** — small optional tags on messages that let both ends confirm they hold
  the same bytes, and flag it loudly if they don't. Old peers that don't send these are handled gracefully.
- **The conversation-discipline resolver** — a durable "this peer + this workstream → this canonical
  thread" mapping, so replies join instead of fragmenting. It only ever groups within one *verified* peer
  (never mixes peers up), and grouping is just a convenience — it never blocks a message and a wrong guess
  is always fixable with an explicit fork.

## The safeguards

**History can only get more complete, never less.** When the new log is first read for an old thread, it
back-fills from the messages the machine already has, so no thread's history ever shrinks during the
switch-over.

**No flag-day with other agents.** Every new on-the-wire tag is optional. If the other agent hasn't updated,
ordinary conversation works exactly as before; my side just keeps its own complete log and marks the
cross-check "unverified (peer not upgraded)." Nothing breaks.

**Nothing new can block or bind.** Phase 2 adds no new gate and no new authority. The log is a record; the
grouping is recoverable routing. Real commitments still travel only through the existing human-signed
approval tools from Phase 1.

**No notification floods.** A genuine divergence raises at most one grouped heads-up per thread, never one
per message.

## What ships when

The log, the single funnel, the "history reads the real log," and the divergence detector ship **on** —
they're correctness and observability and can only make history more complete. The one behavior change —
replies *joining* a canonical thread instead of minting a new one — ships **off by default and dry-run
first** (it logs "I would have joined thread X" before it actually reroutes anything), so the join/fork
decisions are proven right before they touch a real send.
