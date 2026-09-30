# Measuring a "you're going in circles" nudge, without sending one — plain English

## The background

Sometimes an agent gets stuck: it changes some code, runs the tests, sees the
same failure, changes the code the same way again, and repeats. Justin's rule is
that after about three tries like that, you should stop patching and step back.
Nothing watches for this today.

On 30 September we tested whether Jev, a small fast model from TypeSafe, can
spot this from a short slice of an agent's recent activity. We gave it 656 real
slices from our own sessions. It caught about 8 in 10 real loops and raised a
false alarm on about 1 in 20 normal slices. It almost never confused an agent
patiently waiting on something (checking a build, polling a status) with a loop.
Each check takes about a tenth of a second and costs about a hundredth of a cent.

## What this change does

It turns that test into a quiet, always-on measurement on the development
agent. Every five actions in a Claude Code session, the server looks at that
session's last fifteen actions, removes anything that looks like a secret, and
asks Jev the same question the test asked. It writes down only the answer: which
label, how sure, and whether a nudge *would* have been sent. It never sends one.
After a nudge would have fired, it pretends to wait 30 minutes before counting
another for that session, so the log shows how often a real nudge would appear.

One small change makes this possible. The existing hook that reports each tool
use now also passes along where that session's own transcript file is. We had
to do this because, as we checked live, a failed command never reaches that
hook at all — and failures are exactly what a loop looks like.

A new read-only page, `/jev-circles/summary`, shows how many checks ran, how
many would have nudged, and the counts per session.

## The safeguards, plainly

- Nothing is ever shown to any agent, user or topic.
- Secrets are stripped before anything leaves the machine, and if stripping
  fails, nothing is sent.
- It is on only for a development agent and needs a key only that agent has.
  Other agents get the code but it stays off.
- Turning it off is one setting, and it takes effect on the next action.
- A daily limit on checks (about 20 cents a day at most), a short timeout, and
  at most two checks at once.
- It only ever reads a session's own transcript file; any other path is
  refused.

## What it cannot do

It looks at about five minutes of work at a time, so it sees the quick
edit-test-fail loop, not the slower loop of repeated review rounds over hours.
It also struggles when an agent keeps sending the same message into the same
guard. The log will show that honestly.

## What you need to decide

Nothing now. After about a week, the question is whether the would-nudge rate
is low enough, and the would-nudges accurate enough, to justify building a real
nudge. That is a separate change and would come back for a decision.
