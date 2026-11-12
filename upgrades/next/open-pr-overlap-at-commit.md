<!-- internal-only -->

## What Changed
- **Every commit in the instar repo now shows other open PRs that change the same files.** The instar-dev commit hook (`scripts/instar-dev-precommit.js`) compares the staged files with the files of every other open pull request on GitHub, and prints a boxed notice naming each overlapping PR, its branch and the shared files, so a session on one machine sees another machine's work without remembering to run `instar dev:claim-check` (Echo Bugs topic 10000002588: two machines changed the same reply-delivery code on 11 Nov without knowing). PRs idle for 14 days are skipped, files changed by 6+ active PRs are summarised in one line, release bookkeeping never counts, and the session's own PR is excluded. Signal only: it never blocks, and when GitHub can't be reached it says overlap is unknown and carries on. Off-switch: `INSTAR_PR_OVERLAP_CHECK=off`. No agent runtime change.

## Evidence
- `tests/unit/open-pr-overlap.test.ts` (19 tests) covers the overlap match, own-branch exclusion, the stale and busy-file rules, fail-open, the skip paths and the hook wiring.
- Live replay with PR 3082's real file list: flagged against 3 open PRs (#3102 shares 5 files) in about 2.5 s.
