# Why your agent stops doing scheduled work on a perfectly healthy machine

## The short version

Your agent has a safety rule: don't start new background work when the machine is running low on memory. Sensible.

The problem is that the rule only has two settings — **go** and **stop** — and it flips to "stop" much earlier than the machine actually needs. Right now, on a machine the operating system itself describes as merely "getting busy" and whose processor is **57% idle**, the agent has refused **47** pieces of scheduled work in ninety minutes. Jobs that should run every few minutes have backed off to once an hour.

Nothing is wrong with the machine. The agent is just being far more cautious than the situation calls for, and it has no way to be *partly* cautious.

## What's actually happening

Memory usage gets sorted into four bands: low, moderate, high, critical.

Today, "high" and "critical" do **exactly the same thing** — refuse everything. So the distinction between "getting busy" and "genuinely out of memory" exists in the labels and then gets thrown away at the moment it would be useful.

Meanwhile the operating system has its own opinion, and it's saying *warning*, not *critical*. The two disagree, and the agent acts on the more alarming one.

## What this changes

A middle setting. Three responses instead of two:

- **Plenty of memory** → work normally, no change.
- **Getting busy** → **keep working, but carefully**: start one job at a time instead of several at once, hold the number of concurrent jobs right down, and let low-priority work wait. This is the new part.
- **Genuinely out of memory** → refuse, exactly as today. Unchanged.

The idea is that a busy machine should do *less* work more carefully, not *no* work at all.

## What it deliberately does not change

- **The thresholds stay exactly where they are.** Not one number moves. It would be easy to "fix" this by simply declaring that high memory starts later — that's the tempting shortcut, and it's the wrong one, because it makes the agent less safe on a machine that really is struggling. This changes what the agent *does* at each level, not where the levels sit.
- **The refusal at critical stays.** The agent can still say no, with exactly the same force, when it genuinely should.
- **No new power.** This only ever *widens* what gets allowed, at one specific level. It cannot cause the agent to block something it previously permitted.

## What already exists

The four-band measurement is already there and was corrected in June — it used to misread how much memory a Mac actually has free, which made it think a healthy machine was full. That fix was about *reading* the number correctly. This is about *responding* to it sensibly, which is a separate problem that the earlier fix didn't touch.

## The safeguards, in plain terms

It ships **switched off**. With the switch off, behaviour is identical to today, byte for byte. It gets turned on for one agent first, watched through one real busy period, and only then considered for everyone.

The tests have to prove both directions: that busy-but-fine machines now get work through, **and** that genuinely-full machines still get refused. A change that just made the agent say yes to everything would pass the first test and fail the second, which is exactly why the second is there.

## What you actually need to decide

Whether a machine at "getting busy" should do reduced work or no work.

The case for reduced: right now real scheduled work is being dropped on a machine that is fine, and the operating system agrees it's fine. The case for caution: memory pressure can escalate quickly, and starting work during it can make things worse.

The middle setting is proposed precisely because both concerns are legitimate — it neither ignores the pressure nor treats a warning as an emergency.

One genuinely open question is flagged in the spec rather than decided: there's a second operating mode where the agent already responds to pressure by falling back to a lighter kind of session rather than refusing outright. That may already be graceful enough, in which case this change should not apply there. The spec proposes leaving that mode alone and asks the reviewer to confirm.
