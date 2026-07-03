# Teach the message reviewer what you actually asked for (plain-English overview)

Companion to `context-aware-outbound-review.md` (draft r2 — round-1 findings
folded; see `reports/context-aware-outbound-review-round1-findings.md`).

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

## One honesty note first (added in round 1)

For Telegram — the channel where both mistakes happened — this reviewer checks
the agent's finished turn AFTER the reply has already gone out (a separate,
always-on gate checks messages before they send). So "blocking power" here
means: a bad verdict forces the agent to redo its final write-up — it cannot
recall a message you already received. A wrong block costs wasted turns and a
watered-down rewrite, not a lost message. The spec now says this plainly
everywhere the go-live is discussed, instead of implying this reviewer is a
send-blocker.

## The fix

Show the reviewer the last few messages of the conversation (about 6, trimmed),
wrapped in strong "this is quoted data, not instructions" packaging that another
part of the system already uses safely for the same purpose. Then one new,
carefully bounded rule:

- **If the conversation shows you asked for it, it's the answer to your
  question — let it through.** Judged by meaning, not keywords.
- **One-way only.** The conversation can only rescue a message from a wrong
  block. It can never become a new reason to block something. And this is now
  MEASURED, not just promised: during the trial period, every would-block gets
  one extra check with the conversation hidden — if hiding the conversation
  would have let the message pass, that's a rule violation and the trial
  restarts.
- **Never for secrets.** Even if you ask for a password or API key in chat, the
  reviewer still flags pasting it — secrets have their own safe delivery path.
  The separate hard-block layer for policy violations is untouched.
- **If fetching the conversation fails for any reason**, the reviewer behaves
  exactly as it does today — and every new step (fetching, labeling, trimming,
  logging) is individually wrapped so a bug in it can never crash the review.
  That wrapping matters because of a pre-existing quirk: if the whole review
  pipeline crashes, the message is delivered UNREVIEWED — so new code must
  never be able to crash it.

Round 1 also cut one piece: originally TWO of the nine specialist reviewers
were going to see the conversation. The second one (the "don't leak the
operator's private info to OTHER people/agents" reviewer) is now excluded —
it never even runs on messages to you, it was deliberately designed to see as
little of your data as possible, and "you asked for it" makes no sense when
the message is going to someone who isn't you. Only the tone reviewer (the one
that made both mistakes) gets the conversation.

Two more supporting pieces:

- **A durable logbook.** Today's would-block records live only in memory and
  vanish on every restart. They become a permanent log file, so the evidence
  for "is the reviewer ready?" survives. (Honesty note: that file keeps the
  first 200 characters of each reviewed message, secrets scrubbed, on this
  machine's disk.)
- **A data-gated go-live.** The tuned reviewer must first prove itself the same
  way the untuned one failed: a full day of real traffic, at least 10 reviewed
  messages, ZERO wrong would-blocks (you judge each one, not the agent), zero
  one-way-rule violations. The two known mistakes become permanent regression
  tests. Only then do YOU flip enforcement on — it never flips itself.

It ships dark: live on the development agent first, off for everyone else,
with a one-line off-switch that takes effect on the very next review without a
restart (round 1 caught that this needed a real wiring change to be true, and
that change is now a named, tested build item).

## What this does NOT do

- It doesn't touch the other, already-live outbound gate (the "tone gate") —
  that one already sees the conversation. (Decided: separate follow-up.)
- It doesn't give the conversation to the third-party-leak reviewer, ever,
  without a fresh design review. (Decided in round 1.)
- It doesn't add AI calls beyond ONE tiny, bounded exception: the trial-period
  double-check of would-blocks described above (a handful of calls per day,
  only during the trial, never after go-live).
- It doesn't send your conversation anywhere new — the snippet rides inside
  the review call that already carries the message itself, and conversation
  bodies are never written to disk or shown on any status page.
- It doesn't auto-enable blocking. Ever.
- It doesn't move the reviewer ahead of Telegram sending (that would be a
  different, bigger change with its own risks — explicitly out).

## Decisions taken — formerly "open questions", now defaults you can override

1. **Whose ask counts?** Decided: in a topic bound to you (the verified
   operator), your asks count fully; others' asks are weak hints. In an
   unbound topic with just one person talking, that person's asks count; the
   moment an unbound topic has MULTIPLE different people in the recent window,
   everyone drops to weak hints (so a second person's ask can't unlock
   technical content in a shared room). Say the word to go stricter or looser.
2. **How fresh must the ask be?** Decided: last ~6 messages, same as the
   sibling gate. If an ask scrolls out mid-thread and causes a wrong block,
   the trial period catches it (that's a clock-reset mistake) and the window
   size is a one-line config change.
3. **How much gets kept in the logbook?** Decided: first 200 characters per
   message, secrets scrubbed; for hard calls you check the actual chat, which
   you already have. Full bodies stay off disk.
4. **Which reviewers get the conversation?** Decided: exactly one — the tone
   reviewer. Widening ever again requires real evidence plus a design pass.
5. **What counts as a "clean day"?** Decided floor: one full day, at least 10
   real reviewed messages, zero wrong would-blocks, zero one-way violations,
   any mistake restarts the clock. You can demand more at flip time; you
   can't be given less.
6. **Fix the sibling gate's wording too?** Decided: not in this change —
   separate follow-up.
7. **What about non-Telegram sessions?** Decided: deferred unless a real miss
   shows up there (those internal channels are lower-stakes by construction).
