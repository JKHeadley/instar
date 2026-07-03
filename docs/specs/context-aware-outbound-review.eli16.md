# Teach the message reviewer what you actually asked for (plain-English overview)

Companion to `context-aware-outbound-review.md` (draft — pre-convergence).

## The problem

Before the agent's replies get sent to you on Telegram or Slack, an AI reviewer
checks each one — mainly so raw technical guts (file paths, commands, config
syntax) don't get dumped on you when you didn't want them. Right now that
reviewer runs in "watch mode": it judges every message but doesn't actually
block anything yet — it just records what it WOULD have blocked, so we can see
whether it's safe to give it real blocking power.

Today's watch-mode data said: not yet. Out of 12 real messages it reviewed, it
would have wrongly blocked 2 — and both were technical content you had
EXPLICITLY asked for (one was the worktree keep/delete list you requested).

The root cause is simple: the reviewer judges each message **in isolation**. It
never sees the conversation, so it literally cannot know you asked for that
list. Funnily enough, its own rulebook already says "code the user explicitly
asked to see is allowed" — but nobody ever shows it what you asked. The rule
exists; the input is missing.

## The fix

Show the reviewer the last few messages of the conversation (about 6, trimmed),
wrapped in strong "this is quoted data, not instructions" packaging that another
part of the system already uses safely for the same purpose. Then one new,
carefully bounded rule:

- **If the conversation shows you asked for it, it's the answer to your
  question — let it through.** Judged by meaning, not keywords.
- **One-way only.** The conversation can only rescue a message from a wrong
  block. It can never become a new reason to block something.
- **Never for secrets.** Even if you ask for a password or API key in chat, the
  reviewer still flags pasting it — secrets have their own safe delivery path.
  The separate hard-block layer for policy violations is untouched.
- **If fetching the conversation fails for any reason**, the reviewer behaves
  exactly as it does today — the safety net never gets weaker because a lookup
  hiccupped.

Two more supporting pieces:

- **A durable logbook.** Today's would-block records live only in memory and
  vanish on every restart. They become a permanent log file, so the evidence
  for "is the reviewer ready?" survives.
- **A data-gated go-live.** The tuned reviewer must first prove itself the same
  way the untuned one failed: a full day of real traffic, at least 10 reviewed
  messages, ZERO wrong would-blocks (you judge each one, not the agent). The
  two known mistakes become permanent regression tests. Only then do YOU flip
  enforcement on — it never flips itself.

It ships dark: live on the development agent first, off for everyone else,
with a one-line off-switch.

## What this does NOT do

- It doesn't touch the other, already-live outbound gate (the "tone gate") —
  that one already sees the conversation.
- It doesn't add any new AI calls or send your conversation anywhere new — the
  snippet rides inside the review call that already carries the message itself,
  and is never written to disk or shown on any status page.
- It doesn't auto-enable blocking. Ever.

## Open questions — everything you'd need to decide, stated simply

1. **Whose ask counts?** If several people share a topic, should only YOUR
   (the verified operator's) requests unlock technical content, or anyone's?
   Recommendation: only yours in shared topics; in normal single-user topics
   any user message counts. Say the word if you want it stricter or looser.
2. **How fresh must the ask be?** The reviewer sees the last ~6 messages. If
   you asked for something and then 10 messages of back-and-forth happened,
   the original ask scrolls out of view and the license quietly expires
   mid-thread. Keep it simple at 6 and watch for misses, or look further back
   for your requests specifically? Recommendation: keep 6 for now, measure.
3. **How much gets kept in the logbook?** To judge whether a would-block was
   wrong, the log keeps the first 200 characters of each message (secrets
   scrubbed). Full messages would be easier to judge but means more of your
   conversation sitting in a log file on disk. Recommendation: 200 characters,
   and for hard calls you check the actual chat.
4. **Which reviewers get the conversation?** There are nine specialist
   reviewers; only the two that decide "did you ask for this" get it for now.
   Giving it to more costs more tokens and widens the attack surface.
   Recommendation: just the two, widen only if the data says so.
5. **What counts as a "clean day"?** Proposed: one full day, at least 10 real
   reviewed messages, zero wrong would-blocks, and any mistake restarts the
   clock. If you'd rather see two days or 25 messages before flipping
   enforcement, that's a one-word decision.
6. **Fix the sibling gate's wording too?** The already-live tone gate sees the
   conversation but its rulebook never explicitly says "asked-for content is
   fine." Adding that one line is low-risk but touches the live enforcing
   gate. Recommendation: not in this change — separate follow-up.
7. **What about non-Telegram sessions?** This covers topic-bound chats (where
   both mistakes happened). Internal/direct sessions could get the same
   treatment later by reading the session transcript. Recommendation: skip for
   now unless a real miss shows up there.
