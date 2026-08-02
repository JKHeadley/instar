# Full Decision Visibility — plain-English overview

Justin asked for something simple to say and demanding to build: whenever Instar
makes an important model-backed decision, we should be able to see what choices it
had, what it chose, why it chose it, what the system actually did afterward, and
whether later evidence suggests the choice was good. Those real situations should
then help us improve the prompt, the input, the surrounding context, or the model.

Today we have pieces of that system, but not the full chain. A registry lists 64
decision areas, yet some rows hide several different model calls and some name code
that is not live. Forty-seven rows are still pending. Four live areas record that a
model ran but lose the identity needed to connect the model's answer to later events.
The detailed record also stops saving after daily limits; recent evidence shows that
about one fifth of detailed records were dropped overall, and nearly two fifths were
dropped for the busiest completion check. That makes periodic review biased toward
the early part of each day.

The proposal fixes the foundation before adding another grand architecture. First,
the build system will enumerate actual production model calls, so "all" means a
reproducible set of callsites rather than a hand-maintained component count. Every
call gets one stable identity and one settlement record, even when the provider
fails or returns nothing. Components with several judgments are split into several
identities. Code that bypasses the shared router is either routed, kept honestly
pending, or exempted only when there is no live decision.

Second, every supported decision gets a complete local evidence package. It keeps
the scrubbed prompt and inputs exactly as the model saw them, the alternatives, the
model's answer and explanation, the deterministic safety floors, what the system
actually enacted, the model and routing details, cost, latency, and links to later
outcomes. The package is compressed and deduplicated, but it is not sampled or
dropped because a daily counter was reached. Storage measurements show that keeping
the missing records is cheap compared with the cost of asking the model in the first
place.

If a decision already used an image, or browser automation can safely capture the
same page it is judging, the local package can include that visual evidence. Instar
will not take arbitrary desktop screenshots. Every record says whether a visual was
captured, was irrelevant, was unavailable, was too sensitive, or failed. The
evidence remains protected on the machine that made the call; other machines see
redacted structure and can route outcome updates back to the owner.

Third, the four live-but-ungraded areas receive real joins. Stop decisions connect
to their stop events and operator reviews while preserving the difference between
the model's recommendation and the final enacted action. Topic-intent decisions
connect to zero or many proposals and later explicit agreement or contradiction;
silence is not called correctness. Goal-priority decisions connect to checkpoints,
candidates, and authenticated review. Alignment decisions preserve the historical
snapshot they judged, because reconstructing it from today's state would grade the
wrong situation.

Outcome evidence is labeled honestly. Mechanical proof is strongest. Authenticated
human review is next. Recurrence is only a proxy. A second model remains off until it
has been calibrated against humans and separately approved for the extra data
egress. Missing or conflicting evidence stays unknown; the dashboard never turns
"someone wrote an outcome row" into a flattering accuracy claim.

Finally, periodic review turns real situations into safe benchmark candidates. It
shows whether a result changed because of the prompt, the selected input, the
constructed context, or the model, instead of blending those into one score. It can
prepare a scrubbed case for a benchmark, but a human decides whether to promote it.
Nothing automatically rewrites prompts or switches models in production.

The work is designed as six safe increments: stabilize the current loss and grading
backlog; establish the executable callsite denominator; add the complete local
evidence store; close the 47-row census; add the four outcome joins; then add review,
benchmark, and dashboard surfaces. Partial progress stays useful, but it cannot be
called full visibility until live evidence proves complete call coverage, zero rich
record drops, truthful outcomes, a real benchmark candidate, separate tuning axes,
and correct two-machine behavior.

The most important privacy decision is already explicit: full prompts, responses,
and screenshots remain local and protected. They are not published, copied into git,
or included in normal backups. Sending a captured case to another model is a new
external operation and requires explicit approval; a local one-shot is not allowed
to bypass that governance merely because it leaves the persistent switch unchanged.
