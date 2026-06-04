# Secret Drop sliding window — plain-English overview

## What this is

"Secret Drop" is how I collect a password or API key from you: I send you a one-time
link, you paste the secret into a little web form, and it comes straight to my server
— never through chat, never written to a file. This change fixes a way that
mechanism was failing you.

## What was broken

When you submitted a secret, my server only held onto it for **5 minutes**, then
threw it away on a timer — *even if I was right in the middle of using it*. And
reading the secret didn't reset that timer. So on a multi-step job (like logging into
Bitwarden and then grabbing a GitHub token), the 5 minutes would run out mid-task and
the secret would vanish — forcing you to paste it again. On 2026-06-02 that happened
about six times in a row. Worse: the "mark this secret as used" step was a separate
action I could trigger, and twice I triggered it *after a step that had actually
failed* — destroying the secret when it should have been kept for a retry.

## What's new

Two changes, both aimed at "you submit once, and it's never dropped":

1. **A sliding window.** Every time I read the secret, its expiry timer resets. So a
   secret that's actively being used can't expire underneath me. There's still a hard
   **30-minute** ceiling so a secret never lingers in memory forever — but within
   that, activity keeps it alive. The idle timeout also went from 5 to 15 minutes.

2. **Use-and-consume in one step.** A new mode runs the command that needs the secret
   and only marks the secret "used" if that command actually *succeeds*. If it fails,
   the secret stays put for a retry. This makes the mistake I made — discarding a
   secret after a failed step — structurally impossible, instead of relying on me to
   remember not to do it.

## What stays exactly the same (the safeguards)

- The secret still lives **only in memory** — never written to disk.
- It's still **one-time submission**, CSRF-protected, and the form is unchanged.
- Sender-verification (the signed sealed-handoff path) is untouched.
- The 30-minute cap means the change can't make a secret live *longer* than a tight,
  bounded window.

## What you need to decide

Whether this is the right fix for "submit once, never dropped." The one thing it
deliberately does **not** do is survive a full server restart — if my server bounces,
an unconsumed secret is still lost (because it's memory-only, which is the security
guarantee). Making it survive a restart would mean storing it encrypted-on-disk, which
changes a core promise and is tracked separately for its own review. Everything else
in your requirement — never expire while in use, never drop on a failure — is covered
here.
