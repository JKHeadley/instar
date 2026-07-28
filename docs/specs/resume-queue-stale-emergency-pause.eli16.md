# Plain-English overview: stale emergency-stop pause must not strand revival

## What broke (a real thing that happened today)

Echo runs long "autonomous" sessions. To stay healthy, each terminal process is
recycled when it gets old — killed and restarted, with no work lost. There's a
safety net called the **resume queue** whose whole job is to bring a recycled
autonomous run back automatically, so you never have to notice the recycle.

That net has an off switch. When someone sends an "emergency stop" message
("stop everything"), the system **pauses the entire resume queue** so nothing it
killed gets resurrected against your wishes. Good idea — for the moment of the stop.

The problem: that pause never turns back off. There is no expiry, no auto re-arm,
and the only way back on is a manual command almost nobody remembers exists. So on
2026-06-14, an emergency stop from the *previous day* (about a *different* topic)
left the net switched off for ~18 hours. When Echo's real autonomous run got
recycled, the net correctly caught it and put it in line to come back — but the
line was frozen. The run sat dead for ~4 hours until Justin sent a message. That's
the "why do my sessions keep dying?" feeling, made concrete.

## What already exists (so we don't rebuild it)

- The recycle itself is fine and loses no work.
- Two earlier fixes already shipped: honest wording ("recycled, picking back up")
  instead of a fake "died" message, and a rule that puts a recycled *active* run
  into the resume queue.
- Crucially, there is a SECOND, finer protection: when the operator stops a topic,
  that topic gets a per-topic "stopped" record, and the queue refuses to revive it
  on its own. That per-topic record — not the global pause — is what actually keeps
  a stopped session from coming back.

## What's new (this change)

Two small additions, both inside the part of the code that runs every ~60 seconds:

1. **Tell you when the net is off and work is waiting.** If the queue is paused and
   sessions are stuck in line, raise ONE calm notice ("revival queue is paused,
   N sessions waiting, resume it here") instead of staying silent. This alone means
   the 4-hour silence can never happen again.

2. **Turn the net back on by itself when the pause is clearly stale.** If the pause
   came from an emergency stop, and a *new* active autonomous run has since been
   recycled and queued (more than an hour after the stop), then the stop obviously
   wasn't about this newer work — so auto-resume the queue and let it bring the run
   back. The agent does the remembering, not you.

## The safeguards, in plain terms

- A FRESH emergency stop is never undone — only a clearly stale one (work queued
  well after the stop) auto-resumes. A real "kill everything" you just sent stays.
- Any topic you actually stopped stays stopped: the per-topic "stopped" record keeps
  blocking its revival even after the queue turns back on.
- On the wider fleet (where the queue only watches, never acts) nothing changes:
  both additions are inert unless the queue is genuinely live.
- One off-switch turns the auto-resume back off (`autoResumeStalePause: false`); the
  notice has no risk and stays on. Reverting the change restores the old behavior
  exactly, with no leftover state.

## What you actually need to decide

Whether auto-resume (item 2) should be ON by default. Recommendation: yes — it's a
bug fix for a permanent silent strand, and the per-topic stop record plus the
1-hour staleness window make it safe. If you'd rather it only *alert* and wait for
your tap, we ship item 1 on and item 2 off — say the word.
