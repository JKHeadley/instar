## What Changed

Spec clarification for the (unshipped, dark) cross-machine capability registry: `scanState` and row
presence are INDEPENDENT. A machine with a model manifest and no doorway scan-state now returns
`scanState: "never-observed"` **together with** its manifest-derived rows at status `unknown`,
instead of zero rows.

The earlier wording ("`200` with `scanState: never-observed` and empty entries when no observation
exists") was ambiguous, and the ambiguity produced a real defect: the Increment-2 route derived ten
rows from the real manifest and served none of them, because "no observation" was read as "no scan".
Manifest rows ARE observations — the record admits them with `sourceDetail: doorway-manifest`, and
the status matrix gives `manifest-only` evidence the status `unknown` precisely so documented
existence is reportable without ever implying reachability.

The rule now carries its failing input: on a machine with a manifest and no scan-state the route
MUST return rows with status `unknown`; a change that makes it return zero rows must fail a test.

## Evidence

Found by running the Increment-2 route's local-projection path against a real agent state dir rather
than reading the diff: `durable projection ABSENT / fallback readDoorwaySources entries = 10 /
scanState = never-observed`, and then observing that `classifyProjection` early-returned a single
`no-data-yet` row, discarding all ten.

## What to Tell Your User

Nothing. This is a design-document correction for a feature that is switched off everywhere, so
there is no user-visible change to announce. If a user asks why a capability list looked empty on a
machine that had never run a scan, the honest answer is that it was a specification ambiguity: the
catalog rows existed and were being discarded, and the corrected rule serves them marked as
unverified rather than hiding them.

## Summary of New Capabilities

None. This amendment adds no capability — it removes an ambiguity that was silently costing one
(the ability to see what a machine's catalog claims before anything has probed it).

## Audience

Agent-only, maturity experimental. No user-visible behavior: the feature is dark everywhere, no
route ships enabled by this change, and the amendment is spec text only.
