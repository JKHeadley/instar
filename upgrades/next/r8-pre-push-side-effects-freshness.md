<!-- bump: patch -->
<!-- internal-only -->

## What Changed

**The pre-push gate refused every push once its review check aged out, even when every
pending change had already been reviewed.** The check asked whether any side-effects
review had been written in the last 24 hours. Release notes accumulate across many
already-reviewed changes until a release folds them away, so a fully-reviewed batch
started failing purely because time passed. It now asks whether a review is at least as
recent as the newest pending change — which never rots on its own.

## Why It Matters

The only way to satisfy the old rule was to write a redundant review for work that
already had one, or re-touch an existing file to reset a clock. The gate's own source
records three prior occasions where someone wrote a placeholder to get past it. A check
whose sole remedy is to produce a junk document trains the wrong habit while pretending
to enforce a standard.

Unreviewed work is still refused: a new note outruns every existing review and the gate
still stops the push.

## Action Required

None. Behaviour is automatic and local to each machine's pre-push hook.
