# Changing the Maturation Path rule, in plain words

## What you're being asked

To approve new wording in the constitution's Maturation Path article. It's the one part of this work that needs you. Everything else is built and doesn't depend on this.

## What the article says today

Features ship switched off, then walk from test agents, to development agents, to everyone. "Ships dark" is a starting point, never a finished state. But it names no final step, has no measured thresholds, and three of its four promises have no check behind them.

## The new wording, in full

**Rule, added:**

> Default-on for the fleet is the last rung of every staged feature, unless a recorded user-preference decision keeps it off. Every rung has machine-checkable thresholds against the feature's own logged behaviour, and when they are met the feature is raised to the recurring review, whose model must decide. A threshold met is a floor, never an instruction: structure measures and raises, and the mind decides. A fleet default stays a reviewed code change, which the review opens itself once two independent readings agree that the feature should move (a different model family, or on a single-provider agent a fresh context of the same provider, disclosed as such).

**In practice, added:**

> (e) The ladder is the machine form of the plan. `src/data/feature-ladders.json` holds every staged feature's thresholds. A flag the code reports as switched off (`src/monitoring/maturationUniverse.ts`) with no entry fails the build. (f) The rung is derived from what ships, never written by hand. (g) A user-preference final is a recorded decision, with a named decider, reason, date and reference, each one visible on the board. The decider is the operator, or the review's two independent readings agreeing that the choice belongs to each user, in a named class: opt-in cost, a personal account, or personal taste. A preference final closes only the step to default-on: the feature still earns its lower rungs, stays available to any user who turns it on, and keeps its thresholds. It says nothing about a critical path that depends on it, which stays with *A Dark Feature Guards Nothing*.

The article's "unenforced" note narrows to the two promises that still have no check. It also says what isn't certified: that a logged record is true, that a threshold is any good, or that a decision was recorded on the day it was made.

## The two things worth your eye

1. **A number never flips a feature on by itself.** Your directive says thresholds show when a feature can mature. I read that as "raises it for a decision", because the constitution's Body and the Mind article says structure informs and the mind decides, and every reviewer pushed the same way. If you wanted a met number to move a feature directly, say so and I'll change it.
2. **Who can keep a feature off for good.** The wording lets you decide, or lets the review decide when two independent readings agree that the choice belongs to each user, as a matter of cost, a personal account, or taste. Each one shows on the board, and the feature still has to prove itself on the lower rungs. An outside reviewer argued only an explicit user decision should count. If you'd rather be the only one who decides, I'll change it. 13 features are named as candidates today; none has been kept off.

## One gap to know about

The 2.0 rule book is the master constitution. Its rule 72, Maturation Path, says every feature graduates and has no preference exit. This change doesn't touch it. If you want the two to match, that's a small separate edit.
