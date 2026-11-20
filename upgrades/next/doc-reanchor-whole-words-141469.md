# Reworded passages show whole words on the document page

## What Changed

Instar Documents re-finds each comment's passage when a document gets a new version. When the passage was reworded, the closest match by letters could start or end inside a word. For example, a comment on "first business day of each month" showed "Now reads: econd business day of each month" after the agent changed "first" to "second", because "econd" is fewer letter-edits away from "first" than "second" is. `src/documents/anchor.ts` now widens a reworded match to whole words, but only on an edge where the original selection was also on a word edge, and by at most 64 characters. A selection that began mid-word is left as it was. Placement stays deterministic, so every machine places the comment the same way.

The live proof runner (`scripts/documents-live-proof.ts`) is brought up to date with two earlier page changes: a touchscreen phone browser now gets "Open in the Instar app" instead of a link code (#3216), so the 390×844 computer window is a narrow mouse window and a new scenario checks the phone offer. The deleted-passage heading is now "Not in this version" (#3462). The phone-to-standby check, BLOCKED until now, runs: a phone paired with the standby sends, the standby answers 503 owner-unavailable with the message saved once and never dispatched there, a retry is the same message, and a Send's signed send row reaches the other machine.

## What to Tell Your User

None for most users: documents are switched on only for development agents. If they use documents: when the agent rewords a passage you commented on, the comment's "Now reads" line shows the new wording in whole words.

## Summary of New Capabilities

None. This is a correctness fix to existing behaviour.

## Evidence

- `tests/unit/documents-anchor.test.ts`: 4 new cases. The first-word case fails on main ("econd business day of each month") and passes with the fix. All 234 tests in `tests/unit/documents-*.test.ts` pass.
- Live browser proof (`npx tsx scripts/documents-live-proof.ts`, two throwaway machines, real page in Chromium at 390×844 and 1280×728) on main d9117905 plus this change, 2026-11-20 12:31 PST: PASS 31, FAIL 0, BLOCKED 4 (iOS app, real phone, real named tunnel, APNs push). On main without this change the same run had 8 failures, all from the out-of-date runner, and the edited-passage check showed the "econd" wording.
