# RateLimitSentinel codex parity — explained simply

## The lifeguard who only watches blue caps

Instar has a lifeguard whose job is: when an AI session gets temporarily blocked by its
provider ("you're going too fast, slow down"), the lifeguard notices, tells you "hang on,
I'm backing off, I haven't lost you," waits, gently re-pokes the session, and checks
whether it started working again. If it never recovers, it raises a flag instead of
leaving you stuck forever.

The catch: this lifeguard only watched **blue-cap** swimmers (Claude sessions). **Red-cap**
swimmers (codex sessions, like Codey) were invisible — it couldn't see them get stuck, and
even if it could, it didn't know how to tell whether they'd recovered. So a codex session
that hit an OpenAI rate limit could just hang, with nobody helping it back up.

(An earlier attempt at this fix had a bug: it looked for the codex session's "logbook" using
an ID that only Claude sessions ever have, so for codex it always came up empty. The review
caught it. This is the rewrite.)

## The fix

Two parts:

1. **Confirming recovery.** Here's the clever bit: an OpenAI rate limit applies to the whole
   **account**, not one session. So "did the limit clear?" is the same as "is the codex
   account producing ANY output again?" — which we can check by asking "did the newest codex
   logbook just grow?". We added a small, fast helper that finds the newest codex logbook (no
   slow scanning of thousands of files) and checks if it's growing. No fragile per-session ID
   needed.

2. **Seeing them get stuck.** We added a quiet poll that reads codex's own "am I rate-limited?"
   report. When codex says yes, we tell the lifeguard about the stuck codex sessions, and it
   runs its normal backoff-and-recover routine. The messages even use the right words now
   ("OpenAI" / status.openai.com instead of "Anthropic").

## Safety belts

- **Blue caps are untouched.** Claude's exact behavior and exact wording don't change at all —
  we proved it with the existing tests.
- **The "seeing them stuck" poll ships switched OFF.** Nothing changes for codex until someone
  deliberately turns it on, and turning it back off is instant.

## The one honest caveat (turn-on blocker)

Because we watch the *account's* newest logbook (not one specific session's), there's a corner
case: if **two** codex sessions are stuck at the same time and one of them recovers, the
lifeguard might think BOTH recovered — including one that's actually still stuck. That can't
happen today (only one codex session runs at a time) and can't happen while the poll is off.
But before anyone flips the poll on for a machine that runs two codex sessions at once, we must
make recovery track each session's own logbook. It's written down as a must-fix-before-enable,
and the independent reviewer signed off on shipping it switched-off with that note.

## Why it matters

Codey runs on a shared, rate-limited account. When it freezes on a limit, nothing helps it
back up right now. This gives codex sessions the same calm, automatic "backing off, hang
tight, here we go again" recovery that Claude sessions already get — once it's turned on and
the corner case is closed.
