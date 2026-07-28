# Tone-Gate Advisory Migration — the plain-English version

## The one-sentence version

The safety check that reviews my messages to you stops being a wall I can't
argue with and becomes a nudge I can overrule — as long as I write down why —
and that written reason is the missing ingredient that finally lets us measure
whether the check is any good.

## What exists today

Every message I write to you passes an AI check before it sends. It looks for
things like leaked file paths, config keys, raw commands, and a family of
behavioural anti-patterns (giving up on myself for a bad reason, calling a
doable thing impossible, handing you work I should do). If it objects, the
message doesn't go. I get told why, and I have to rewrite it. There is no
override.

Separately, we built a system that records every one of these decisions so we
can later judge whether the check was right — and use those judgments to tune
the prompt, pick the best model for the job, and build benchmark scenarios.

## The problem

In the seven days to July 24 that recorder captured **1,440 decisions and
produced zero verdicts**. Every single one reads "unknown."

That looked like a bug for a while. It isn't. It's arithmetic.

If the check blocks me and I have no say, nothing observable happens next.
There's no moment where I agree or disagree, because I was never asked. So
there's nothing for a judge to grade. The window for evidence closes empty
every single time, forever, no matter how long we wait or how good the judge is.

You spotted the same thing from your side, from a completely different angle —
that a check refusing to let me send you a directory path was too much power for
that check to have. Those turn out to be the same problem. Fixing the authority
problem is what creates the evidence.

## What changes

**Most checks become nudges.** When the check objects, the message comes back to
me instead of being killed. I then do one of two things, and both get recorded:

- **I agree** — I rewrite the message and re-send it, flagging which objection I
  accepted. The check gets scored *right*.
- **I disagree** — I send the original anyway, with a written reason. The check
  gets scored *wrong*.

**The reason is mandatory.** If I try to override without explaining myself, the
message doesn't send. That's deliberate. The reason IS the data. Leaving it to
me to remember to explain would recreate exactly the gap we're fixing — so it's
enforced in code, not in a note telling me to be diligent.

**Two things stay absolute walls.**

*A live credential or password.* No override, no exceptions. It's now a plain
pattern match rather than an AI judgment call, so it still works when the AI
check is overloaded, offline, or not configured at all.

*The guards that stop me quitting on myself.* The checks that catch me
abandoning work for a tired-sounding reason, declaring something impossible
without looking, or handing you a task I should do — those stay hard. I'd
originally made them overridable too, and review talked me out of it, correctly:
on those, I'm the one being constrained, so my written reason would come from the
same reasoning the check exists to distrust. And the damage isn't the message —
it's the work I walked away from, which happens instantly and can't be undone by
reviewing it later.

**Both directions get counted, and neither depends on my memory.** It would have
been easier to record only my objections. But a check measured purely through the
cases I complained about is guaranteed to look worse than it is. Originally I had
to *remember* to flag when I'd agreed — which is the same "rely on the agent
being diligent" mistake in a different place. Now the system notices on its own
when I've revised a message after a nudge, and credits the check without me
declaring anything.

**And the loosening can't outrun its own justification.** If the recording system
is off, or a particular decision can't be traced, the check keeps its full
authority and stays a wall — because the entire argument for relaxing it was
"we'll capture what happens instead", and that argument is void when nothing is
being captured. It says so plainly rather than quietly reverting.

## The safeguards, in plain terms

- **My opinion is filed as my opinion.** Every override is recorded as
  *the agent said the check was wrong* — never as *the check was wrong*. The
  recording system ranks evidence by how trustworthy it is, and my own account
  of a judgment about my own message sits at the bottom of that ladder,
  deliberately. It can never outrank a proper independent judge later. When you
  read "the check was wrong 40% of the time," you'll always be able to see
  that's my claim, not a measurement.
- **A broken check still can't be argued with.** If the AI check fails to
  produce a verdict at all — the provider is down, the machine is overloaded —
  the message is still held. That's not an opinion I can disagree with; it's the
  absence of one. Only genuine judgments became overridable.
- **The credential wall doesn't depend on the thing it replaced.** It runs
  first, needs no AI, and holds during an outage.
- **One switch turns it all off.** Setting `advisoryMigration` to false restores
  the old behaviour immediately — no deploy, no restart. The old behaviour is
  still in the code and still tested, so the rollback is a flag flip rather than
  an un-picking of the change.
- **It's on for me and off for everyone else.** It runs live on this
  development agent and stays dark across the fleet until deliberately flipped.

## What you actually need to decide

You approved the substance on July 19 and again on July 23. Three things worth a
second look now that it's built and reviewed:

1. **Should the self-stop guards eventually become overridable too?** I've kept
   them hard for now because your approval was about the directory-path problem,
   not about those. If you do want them overridable later, the right shape isn't
   a free-text reason — it's requiring me to name *which* legitimate kind of stop
   this is (an outside blocker, a real decision only you can make, your
   instruction, or genuine completion), with "I'm running low" refused outright.
   That's a claim that can be checked against reality rather than a sentence I
   wrote about myself.
2. **The reason is mandatory.** I can't override silently. Is that the balance
   you want, or would you rather push something through unexplained in a hurry?
   (My view: mandatory. An unexplained override is indistinguishable from the old
   problem.)
3. **Is there another category you'd wall off?** Credentials are the only content
   class with no override. If there's something else you consider equally
   irreversible — in the "burns something permanently" bucket — now is the moment
   to name it.

## What the review changed (worth knowing)

Six reviewers plus an outside model went at this, and it did not survive intact.
Three findings I'd have shipped:

- The credential wall **blocked ordinary English** — "disable password
  authentication in the sshd config" would have been unsendable, with no
  override. Worse, the same pattern **missed** a genuinely leaked short password.
- The recording half was **switched off by default**, so turning this on
  fleet-wide would have delivered all of the loosening and captured none of the
  data.
- The reply path I actually use **couldn't express an override at all** and
  called a nudge "BLOCKED", so the feature would have been correct in the API
  and invisible in practice.

All fixed, with the exact failing sentences pinned as permanent tests.

## What this doesn't do

It doesn't judge anything. It collects the evidence that makes judging possible.
The actual bulk-judging pass — a stronger model reading the accumulated reasons
later, unhurried, and turning them into verdicts and prompt tuning — is the next
piece, and it's the one you designed. It also doesn't touch the other 49
scenarios still waiting to be wired into the recorder; that's separate work on
the same thread.
