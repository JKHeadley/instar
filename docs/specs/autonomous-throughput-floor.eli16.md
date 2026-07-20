# Autonomous Throughput Floor — explained simply

## The problem, in one sentence
When an Instar agent runs a long autonomous job by handing work to a helper agent and watching for results, the *manager* can quietly stop doing anything useful — it keeps waking up, checking "did anything finish?", seeing "no", and going back to sleep — while real work is sitting there un-started. It looks busy (it keeps checking) but it's actually idle in the only way that matters: nothing is getting done.

## Where this came from
That is exactly what happened in the previous drive: after a big piece merged one night, the helper (Codey) correctly paused at a spot where it needed a human yes/no, and the manager (me) just... watched. For about nine hours. Other work was available and un-gated, and nobody picked it up. The whole session existed to *test* throughput, and the manager became the bottleneck. This feature is the fix for that, built as permanent structure so it can't rely on the manager "remembering" to stay active.

## What the feature does
It adds a small watcher on the machine running the manager. Every so often it asks a simple, honest question: **"has the helper actually SHIPPED anything real lately?"** — meaning a genuinely finished/advanced piece of work, NOT just "the helper is alive and answering messages" (a helper can chat all day and produce nothing — that still counts as stuck). If nothing real has shipped for about 75 minutes, that's a "flatline," and the watcher is *required* to take an action instead of waiting:

1. First it does a live check of the helper's real state.
2. If the helper is stuck/stopped, it nudges it back to work (over the normal channel, clearly marked as an automatic nudge so it's never mistaken for a human instruction).
3. If the helper is idle with nothing to do, it hands over the next piece of work (or, until a later piece is built, flags it to the operator).
4. It's only allowed to *do nothing* if TWO facts are both provably true: the helper is genuinely waiting on a specific human decision, AND every available lane of work is already full. And "genuinely waiting on a human" has to come from an actual recorded approval-request — the watcher is NOT allowed to just *decide* the helper looks like it's waiting. That rule is the heart of the fix: it stops the manager from talking itself into "I'll just wait" the way it did before.

## The safety rails (so the cure isn't worse than the disease)
Because this feature *acts* (it nudges another agent, which costs the operator time and money), it's wrapped in strong brakes: it can only fire a limited number of times before it stops and tells the operator instead of nagging forever; a "nudge" only counts as successful if real work actually follows it (not just "the message was delivered"); it won't act at all if the operator's budget/quota is running low; the operator can hard-pause any job and that pause can never be overridden; and if the job moves to another machine, the brake counters travel with it so a move can't secretly reset the safety budget. It ships turned-off everywhere first, then in a watch-only mode that just logs what it *would* do, and only becomes active after it's proven it makes the right call.

## Why it matters beyond one helper
This isn't just about Codey. It's the general rule for any Instar agent that oversees another — including how I'll oversee Luna. A manager that can silently go idle for hours while work waits is, by definition, not a reliable employee. This makes "manager idle while work exists" structurally impossible, which is the real meaning of the robustness-and-throughput improvement this was asked for.
