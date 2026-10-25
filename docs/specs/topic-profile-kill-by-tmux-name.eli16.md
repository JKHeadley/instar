# ELI16 — The framework switch that never switched anything

## The one-sentence version

When you told your agent "run this conversation on Codex instead of Claude," it
said "done" — and then kept running on Claude. This fixes that, and makes the
same lie impossible to tell again.

## What you would have seen

You pin a Telegram topic to a different framework. The agent replies:

> Topic profile — was: defaults → now: framework: codex-cli. Applying shortly
> (waiting for an idle moment).

A few seconds later you get a handoff notice, the conversation carries on, and
everything looks like it worked. It didn't. The session is still the old
framework. Ask it directly — "are you on codex now?" — and the honest answer is
no.

The tell was hiding in plain sight in that handoff notice. It said which
framework it had landed on, and it said **Claude**. The system was reporting the
truth in one place and "applied" in another, and nobody was comparing the two.

## What actually goes wrong

To switch frameworks you cannot just change a setting — the framework is the
program the session is running. So the switch has three steps:

1. **Kill** the running session.
2. **Spawn** a new one, which reads the new pin and launches the right program.
3. **Record** that the pin was applied.

Step 1 was silently doing nothing.

Sessions have two names: a UUID (the internal id) and a tmux name (the
human-ish one, like `echo-session-trust-dialog-bug`). The kill function takes
the **UUID**. The code that calls it was handing it the **tmux name**. So the
kill looked up a session that did not exist under that key, found nothing,
returned `false`, and killed nothing.

That `false` was thrown away. Nobody checked it.

So step 2 ran against a session that was still alive. The spawn logic sees a
live session for that topic and, sensibly, does not start a second one — it just
hands the existing session a message. The old session, still running the old
framework, picked up the conversation. Step 3 then wrote `respawn-applied` into
the audit log.

Result: the pin is set, the audit says applied, and the actual behaviour never
changed. A silent, self-congratulating no-op.

## What already exists

This exact bug has been caught here before, in a different feature. The codebase
already carries the fix: a helper called `killSessionByTmuxName`, whose own
comment names the failure mode "the stop that does not stop" and explains it
exists so that name-to-id resolution lives in exactly one place.

The topic-profile code was written without using it. The medicine was already in
the cabinet; this change takes it.

## What is new

Three things, in increasing order of how much they matter:

**1. Use the right function.** Both kill points in the framework-switch path now
call `killSessionByTmuxName`. One more call site elsewhere — the "restart
sessions" command you can type at the agent — had the identical bug and told you
it had "cleaned up" sessions it never touched. Fixed in the same pass, because
shipping one of two identical bugs is how the second one gets forgotten.

**2. Believe the answer.** The kill returns true or false, and that answer is now
read. A failed kill aborts the switch instead of barrelling into a spawn that
cannot work. The abort also undoes the preparation it had already done, so the
session that survived is not left worse off than before the attempt.

**3. Check the claim against reality.** After the spawn, the code compares the
framework it *asked for* against the framework the spawn *reports landing on*.
If they differ, it records a mismatch instead of writing "applied." This is the
part that would have caught the original bug on day one, without anyone knowing
the cause.

## The safeguards, in plain terms

- **Nothing new gets the power to block.** The mismatch check does not stop,
  delay, or rewrite anything. It writes a different line in a log. That is
  deliberate: this codebase separates things that *notice* from things that
  *decide*, and a truthfulness check belongs firmly in the noticing half.
- **A failed kill now fails safely.** Before, a failed kill led to a confusing
  half-state. Now it stops and puts things back, and the switch is retried on the
  next quiet moment rather than being falsely marked done.
- **The user-facing message was always honest** and is unchanged. You were
  already being told the real framework; only the internal bookkeeping lied.
- **Nothing here changes when a session is allowed to be killed.** Protected
  sessions, busy sessions, and the "waiting for an idle moment" behaviour are all
  untouched. This change is only about the kill actually happening once the
  existing rules have already said yes.

## What this does not fix

If a spawn genuinely lands on a different framework for a legitimate reason —
say the pinned CLI is not installed on this machine and the system falls back —
that now shows up as a mismatch in the audit log. That is the correct record
(the pin was in fact not applied), but it means "mismatch" in the log is a
prompt to look, not proof of a bug.

## What you need to decide

Nothing, if you just want the switch to work. It restores intended behaviour and
adds no new setting, no new flag, and no new thing that can block your work.

The one judgement call worth your attention: a repeatedly-failing kill will now
keep retrying on each idle window rather than proceeding to a fake success. If
you would rather it give up loudly after N attempts instead, that is a different
design and worth saying so — it is a small change on top of this one.
