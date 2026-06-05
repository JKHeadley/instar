# Side-Effects Review — per-entry decision-audit files (task #80)

**Version / slug:** `decisions-per-entry`
**Date:** `2026-06-05`
**Author:** `echo`
**Second-pass reviewer:** `self-review under the Tier-1 lite lane; the audit-continuity question (does the trail survive the format change?) addressed below`

## Summary of the change

`writeDecisionAudit` in the pre-commit gate writes each decision as its own file `.instar/instar-dev-decisions/<ts>-<slug>.json` (staged immediately, preserving #814's ride-the-commit property) instead of appending one line to the shared `.instar/instar-dev-decisions.jsonl`. Distinct paths per PR cannot merge-conflict — including GitHub's server-side merge, which does not honor custom merge drivers. The legacy JSONL freezes in place as history.

## Decision-point inventory

- `writeDecisionAudit` — modified — per-entry file write + stage; same payload fields (ts/slug/tiers/riskFloor/reasons/belowFloor/files/loc); collision-suffix counter for same-ms-same-slug; returns the entry path (used by the belowFloor console message).
- `DECISIONS_LOG` const — removed (legacy path noted in comment); `DECISIONS_DIR` added.
- Tests — `instar-dev-precommit-audit-staging.test.ts` re-pinned to the per-entry contract + a NEW conflict-immunity test (two evaluations → two distinct paths) + asserts the legacy JSONL is NOT created; `instar-dev-precommit-deferrals.test.ts` audit-shape test re-pinned.

## 1. Direction-of-failure analysis

- **Old failure (live, PR #824):** CI-green PR fails admin-merge on the audit file tail — recurring at parallel-PR cadence, blocks every second merge, requires manual union resolution each time.
- **New worst case:** the writer remains best-effort (try/catch, never blocks the gate) — an audit I/O failure loses ONE entry, exactly as before. Filename collision (same ms + same slug) is suffix-countered, pinned by test.
- **Audit continuity:** the legacy file is untouched history; new entries are chronologically sortable by filename (`ls` order = time order). Readers: only tests read the trail today (grep-verified); both updated.
- **In-flight PRs written under the old scheme:** once main's shared file stops growing, their single appended line vs main's unchanged tail merges CLEANLY — landing this fix un-jams the conflict class for already-open PRs too (the conflict needed BOTH sides appending).

## 2. Over-permit

None — the gate's blocking logic is untouched; only where the audit record lands.

## 3. Scope deliberately NOT taken

- No migration of legacy JSONL lines into per-entry files — history stays where it was written; a reader that wants the full trail reads both (documented in the script comment).
- No `.gitattributes merge=union` belt for the legacy file — GitHub's server-side merge ignores it, and with the file frozen the local-rebase benefit is moot.

## 4. Migration parity

None needed — the gate script lives in the repo (`scripts/`), not in agent-installed files; every checkout gets it with the commit. `.instar/instar-dev-decisions/` is created on demand by the writer.

## 5. Token/cost impact

None — same write volume, one file create vs one append per gated commit.

## 6. Rollback

Revert the commit; the writer returns to appending the shared JSONL (and the conflict class returns with it).
