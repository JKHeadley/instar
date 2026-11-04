<!-- bump: patch -->

## What Changed

Feedback executor change sets may now contain up to 5 MiB of valid UTF-8 text, enough to modify the current `server.ts` and `routes.ts` pair with focused tests. Binary or invalid UTF-8 content keeps the former 4 MiB aggregate limit. The 200-file ceiling, credential scan, confined workspace, independent review, and test/CI gates remain.

## What to Tell Your User

The executor can now submit a small fix that touches two large Instar integration files for review. This removes one measured size blocker; a fresh fix still has to pass review and tests before it reaches users.

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| Larger text-only feedback change sets | Automatic for the feedback executor |

## Evidence

On main `0aa1391f`, the two affected source files total 4,356,054 bytes, exceeding the previous 4 MiB ceiling. Boundary tests exercise the measured pair, exact 5 MiB and 5 MiB plus one byte, 201 files, and binary/invalid UTF-8 at the former 4 MiB boundary. The independent review record is `docs/specs/reports/feedback-changeset-byte-cap-calibration-review.md`.
