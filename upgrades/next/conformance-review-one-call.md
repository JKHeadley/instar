# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The built-in constitution check asks its two questions in one model call when a spec names the principle it serves: which standards the spec may break, and whether the spec plainly fits that principle. Before, the fit question was a second call that re-sent the whole spec. If the combined reply has no usable fit answer, the fit question is still asked on its own, so the check is never looser than before.

## What to Tell Your User

Nothing changes in what the constitution check reports. It finishes sooner and uses fewer tokens when a spec names its principle.

## Summary of New Capabilities

One model call per constitution check for a spec with a named principle, instead of two.

## Evidence

Studio usage ledger, 7 days to 2026-11-27: 566 separate fit calls, 12.2M tokens. Unit, integration and lifecycle tests cover the one-call path, the fit fallback after a cut-off or failed reply, and that weak and none fit verdicts still come back unchanged through the route.
