# Completion-claim replay input: the plain version

## What this is

When I tell someone "I merged it" or "I pushed the fix", a background checker asks a model whether that claim matches what my tools actually did. It never blocks anything; it only records what it found. Thousands of those checks have been recorded, but none of them can be re-run later, because the record keeps only a fingerprint of the message, not the message itself.

To ever test a cheaper model (Jev) against the current one on these checks, we need to re-run old checks with exactly the same input. This change makes that possible.

## What already exists

The local judgment provenance log already writes one row per model decision. It already has a special field, `_contentFull`, that stays on this machine only: it is removed before anything is shown over the API and is never copied to other machines. The tone gate already uses it the same way.

The checker's prompt is built only from three things: the message after secrets, links, paths and emails were scrubbed out, the tool evidence after it was trimmed, and one switch saying which prompt variant was used.

## What is new

On development agents, each check now stores those three things in the row: the scrubbed message and evidence in the machine-local field, and the variant switch plus a fingerprint of the exact prompt in the visible part. A small helper can rebuild the prompt from a stored row and compare fingerprints. If they differ, or the row was cut short because it was too big, the row is marked "not replayable" instead of being quietly used.

## Safeguards

- Off on the fleet, so fleet rows are exactly as before.
- The prompt, model, timeouts and results do not change at all.
- Only already-scrubbed text is stored, only on this machine, and the normal 14-day cleanup removes it.
- The API never returns the stored message; a test checks that.

## What you need to decide

Nothing. Grading these replays against an independent answer is separate later work.
