# Robust Load Assessment — plain-English overview

## What's the problem?

Your agent needs to know "is this machine actually busy, or is it free to do heavy work?" Recently it
got this wrong — twice. It looked at a number called the "load average" (what the `uptime` command
shows) and saw ~40, decided the machine was overloaded, and held off on work. But the machine was
actually ~60% idle. The high number was just macOS quietly re-indexing the hard drive (Spotlight)
after a reboot — nothing to do with the agent.

Why did the agent get fooled? Because "load average" is a bad ruler for this:
- The 1-minute version jumps around wildly second to second (a spike, not a trend).
- On Macs it counts programs *waiting on the disk*, not just programs *using the processor*. So a disk
  that's busy indexing makes the number look scary even when the CPU is mostly asleep.

## What are we changing?

Three small things, so this mistake can't happen again — and so it's fixed for *every* agent, not just
this one:

1. **One go-to command.** A script, `load-assess.sh`, becomes the standard way to check load. It looks
   at the RIGHT things — the real percentage of the CPU that's idle, the agent's own CPU use averaged
   over the last hour, and *what* is actually using the CPU (so "my work" is told apart from background
   stuff like Spotlight). It prints a plain verdict: OK, ELEVATED, or SATURATED. It still shows the old
   load-average number, but clearly labelled "context only — don't trust this for the decision."

2. **It survives memory compression.** Agents periodically compress their memory of a long conversation
   ("compaction"). A reminder that only shows up when a session first starts would get lost when that
   happens. So we put the "use load-assess.sh, never trust load average" reminder into the startup hook
   that *also* runs right after compaction — guaranteeing the agent is re-reminded every time its memory
   is compressed, not just at the very beginning.

3. **Every agent gets it automatically.** The script and the reminder ship as built-in templates, and
   the update process installs them on every existing agent the next time it updates — not just the one
   agent where this was first built.

## What changes for users?

Nothing visible, and nothing risky. This is a read-only diagnostic — it measures and reports, it never
changes anything, never sends a message, never touches an outside system. The only real effect is that
the agent stops mistaking a quiet-but-indexing machine for an overloaded one, so it doesn't
unnecessarily hold off on work. The main tradeoff considered was simplicity vs. generality: rather than
rebuild the whole "what the agent knows about itself survives compaction" system, we ship the specific
load-assessment reminder as a simple fixed block that can't fail — and note the broader generalization
as separate future work.
