# Benchmark Application (S1/S2/S5) — ELI16

## The backstory

We ran a big benchmark (INSTAR-Bench v3) that tested every AI model behind
every "door" (a door = the tool we call the model through — a raw API, the
Claude Code CLI, the codex CLI, etc.). It found something surprising: the SAME
model can be great or terrible depending only on which door you use. The
loudest example — Opus 4.8, one of the strongest models — scores 99% when
asked a yes/no judging question through a clean API, but only 82% through the
Claude Code CLI door. On the emergency-stop check it dropped to 73% — it
literally missed "STOP" commands. Why? The Claude Code door wraps every
question in ~20,000 words of "you are a helpful coding assistant" framing,
which turns a sharp skeptical judge into a credulous yes-man.

So the benchmark produced a hard rule: never send a bounded yes/no verdict
(the kind that gates a real action) through the Claude Code CLI door on Opus.

This change applies three low-risk pieces of that finding. It does NOT change
which model your live conversations run on — that's a bigger, separately
reviewed decision.

## What actually changed

**1. A safety clamp (the important one).** When one of our background gates
fails on its normal provider, it "swaps" to a backup. One backup path could,
in a rare corner, land on exactly the banned route: Opus via the Claude Code
CLI. Now, whenever a bounded/gating swap lands on the Claude Code door, we
automatically step the model DOWN from Opus to Sonnet (which scores 99.5% on
that same door and resists trick inputs). It only ever makes the fallback
SAFER — it can never make a call worse, and it never blocks anything. A new
lint keeps this clamp from being deleted by accident and refuses any config
that would route a gate to Opus-via-CLI.

**2. A freshness lint + a nature map.** We already require every AI-powered
component to be benchmarked. Now we also require every one to have a row in the
human routing-registry doc (a lint fails the build if a component is missing),
and we record each benched component's "task nature" (is it a quick sort? a
careful judgment? a background digest?) so a future change can route by nature.

**3. A monthly refresh job.** A scheduled, OFF-by-default job that re-runs the
benchmark, checks nothing drifted, and — if a routing default looks stale —
raises ONE note for the operator to review. It never changes routing on its
own; a human always decides.

## Why it's safe

Everything here is dark or reversible. The clamp only narrows a dangerous
fallback in the safe direction. The lints only catch real gaps. The job ships
off and no-ops on every machine that isn't the benchmarking machine. No live
routing default moves. Rolling back is a plain revert with no cleanup.

## What changes for users

Nothing visible. Under the hood, a rare bad-fallback route is now structurally
impossible, and the benchmark discipline is a little tighter. If a maintainer
turns the monthly job on, they'll occasionally get a "here's a routing change
to consider" note — never an automatic change.
