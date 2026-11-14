## What Changed

A feedback executor session that cannot reproduce a report because an earlier commit already fixed it can now name that commit in its result file (`fixedByCommit`). Trusted code checks that the commit exists in the source checkout, is contained in the attempt's base, and was committed after the item's first report. When it is, the item is held `already-fixed` after that one attempt instead of being given a second session. When the check fails, the attempt counts as plain `not-reproducible`, as before. New reports still bring a held item back.

## Evidence

On the operated Studio, 2026-11-11 to 11-12, items 8e65c09f, 9b2640d2 and f581686e each ended `not-reproducible` two or three times in a row. Their session transcripts name the earlier fix every time: commit 024bfde34 (#2957) for the Bitwarden argv report, #2740/#2911 for the updater rebuild report, c825f2075 (#3039) for the usage-wall report. That cost 7 sessions out of a 12-per-day start limit to learn 3 facts. After (unit level): a verified claim holds the item `already-fixed` with one attempt (tests/unit/feedback-factory/execute-service.test.ts); an unverified claim keeps the old retry; `commitInBase` resolves a short SHA only when the base contains it, checked against a real git repository (execute-github-runtime.test.ts).

## What to Tell Your User

Automated fixing wasted effort on reports that had already been fixed: each one was tried twice. Now, when a worker shows which earlier change fixed it and that change is really there, the report is set aside after one try.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Already-fixed reports set aside after one attempt | Automatic |
