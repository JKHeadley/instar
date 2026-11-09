# Plain-English overview: long conversations that stop re-reading everything

## The problem in one breath

Each of my long-running conversations keeps its entire history in working
memory. The history grows until it is close to a million tokens, and then
Claude Code squeezes it with its own generic summary. Until that squeeze, every
single turn re-reads almost the whole thing. One machine burned about 4.4
billion tokens in a day, mostly re-reading. And when the squeeze finally comes,
it is not ours: it does not know which of Justin's words matter, and the step
that was supposed to put our own briefing back afterwards has never actually
run (it checks for a signal Claude Code does not send).

## What Justin asked for

Not a hard cap. Something intelligent: shrink at natural milestones in the work,
not when a meter hits a number. Keep ongoing summaries at three distances
(what we just did, the current phase, the whole story). Keep an anchor of what
the topic was for, with any deliberate changes to that purpose written down.
And treat his words differently from mine: he writes a little and it is the
ground truth; I and my tools generate most of the bulk, and that is scaffolding.

Measured on the biggest transcript on this machine: Justin's text is under 8%
of the context, tool output is 64%, and my own commands and prose make up most
of the rest.

## How the new design works

**Layers, always maintained.** Every topic keeps: an Anchor (the original
purpose in Justin's words, plus a dated list of intentional changes to it, each
marked "Justin said so" or "we learned this"); three summaries at three
distances; a decisions list that quotes Justin exactly; short summaries of each
finished stretch of work; Justin's messages kept whole; and the full searchable
history underneath. These exist whether or not anything shrinks, and they are
what a session gets at start and after any compaction.

**Folding at milestones, written by the session itself.** When a stretch of
work finishes (a PR merges, a build settles, a phase ends), the session that did
the work is asked, at a quiet moment, to write its own handoff: what finished,
what it still needs word for word, what is open. A small check compares that
against the Anchor and the decisions. Then the working memory is rebuilt from
the layers plus everything the handoff said to keep, and the removed detail is
archived so it can still be looked up. The session can also declare a
milestone, pin something as still needed, or say no. How full the memory is,
and whether a fold would even pay for itself given how caching works, only
changes how readily the system asks. Nothing fires mid-task. Two hard stops
remain and are named as such: a request to reach a checkpoint when memory nears
the limit, and Claude Code's own safety net, set far out, with our instructions
attached.

**Justin's words last.** Folding takes tool output first, then my commands,
then my narration. Justin's messages stay whole until they alone would be
larger than a comfortable working memory, and even then the oldest are kept as
quotes, never paraphrased. The decisions list and the Anchor are never
summarized.

**A real check after every fold.** Before the fold, the rebuilt memory is
checked mechanically against the stored layers (the Anchor is byte-identical,
every quoted decision is present). After it, the session is quizzed on things
the folded stretch contained: constraints, open threads, approaches that were
rejected. Anything lost is corrected once; a second miss undoes the fold, which
is a real undo: the old session is snapshotted first and resumed. Drift becomes
a number instead of a feeling.

**Look things up instead of carrying them.** Older detail stays one query
away: search the history, read the summary of a finished stretch, or pull the
exact messages around a point.

## What happens first

Fix the bug that stops compaction recovery from running. Measure three things
Claude Code has never told us: how much text a rebuilt memory can actually
carry, what a reset really loses, and what one fold costs against what it
saves. Build the layers for every topic, including a one-time backfill of the
Anchor for existing topics that Justin confirms in one line each. Run folding
in shadow mode, recording what it would have done and how the quiz would have
gone. Then turn it on for one topic, then everywhere, each step with a single
switch back.

## Fable 5.2's part

Justin asked for Fable 5.2 in both design and review. This draft went through a
Fable 5.2 design pass before he saw it. It found thirteen flaws in the previous
version, among them that the old drift check only tested whether the session
could repeat what it had just been handed, that there was no real undo, and
that the detail most often needed after a fold (tool output) was not stored
anywhere searchable. All of its findings were adopted; what changed is listed
in the spec's Appendix A. In review, Fable 5.2 reads every round alongside the GPT
and Gemini reviewers.

## What Justin decides

Which topic goes first; whether a rolled-back fold is mentioned in the topic or
only on the dashboard; how a "we learned this" change to the purpose gets
confirmed; whether to set Claude Code's safety-net window early, as a separate
step; and whether the starting judgments for "comfortable" and "critical"
working sizes are reasonable to tune from.
