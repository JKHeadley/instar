# Side-Effects Review — Reports for a person are delivered as a document

**Version / slug:** `report-delivery-as-document`
**Date:** `2026-11-18`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (not required for this tier; run for the bug brief)`

## Summary of the change

Tier 1, instruction text only. 4 source files plus 1 test file, about 110 lines. A session delivered a research report as a repo markdown file and a GitHub link (fb-3bc8a879-2c7) because the always-loaded Feature Proactivity rows sent research to Telegraph or the Private Viewer only, and the Private Viewer refuses while documents serve. The rows in `src/scaffold/templates.ts` become document-first exported constants (`DOC_DELIVERY_ROW_USER`, `DOC_DELIVERY_ROW_PRODUCE`); identity-template principles 6 and 9 and the Private Viewing closing line say the same; a new `migrateAgentMdReportDelivery` replaces the retired principle wording in existing AGENT.md files; `migrateClaudeMd` in `src/core/PostUpdateMigrator.ts` replaces each retired row verbatim for existing agents; `src/data/awareness/instar-documents.md` names the GitHub-link case. Effort: one review round (standards conformance check, 100 standards, 0 findings, parent fit "Agent Awareness"), plus an independent reviewer.

## Decision-point inventory

No decision-point surface. Nothing gates, holds, filters or blocks. The tone gate's existing B24_OLD_VIEW_LINK check is untouched (pass-through).

---

## 1. Over-block

No block/allow surface — over-block not applicable.

## 2. Under-block

No block/allow surface — under-block not applicable. Residual behavioral gap: an agent can still choose a GitHub link against its instructions. That choice is judgment, held by the agent; a link-shape check cannot tell a report from a pull request the person is asked to review (see section 3).

## 3. Level-of-abstraction fit

Right layer. The failure was a wrong instruction feeding the agent's judgment of where a report goes. An outbound link check would sit at the wrong layer: GitHub links to pull requests are legitimate and frequent, so a pattern rule would either hold good messages or need a meaning judgment that the agent already makes. The fix corrects the input to that judgment.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

Instruction text only; no detector, no authority.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point.

## 5. Interactions

- B24_OLD_VIEW_LINK (tone gate) already hands back old `/view/` links; the new rows now point to the same document route it points to, so instructions and gate agree.
- `POST /view` answers `409 documents-replace-views` while documents serve; the rows keep the Private Viewer only for `503 documents-off` and Slack, matching the awareness entry.
- The reference CLAUDE.md layout rebuilds core rows from the template, so it gets the new rows without the migration; the full layout uses the migration. Both are tested.
- No double-fire: the migration replaces only the exact retired text, once.

## 6. External surfaces

Changes the text of every agent's CLAUDE.md (two rows and one sentence) and AGENT.md (principles 6 and 9, where still in shipped wording) on update. No route, config, hook or message changes. On fleet agents where documents are off, the rows still direct to the Private Viewer, so behavior there is unchanged.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN: CLAUDE.md is written per machine by each machine's own update run, and every machine runs the same migration, so all machines converge on the same text. No user-facing notices, no durable state, no generated URLs. No status surfaces changed.

## 8. Rollback cost

Revert the commit and release. New agents get the old rows back. Existing agents that migrated keep the new rows, which remain correct. No data repair.

## Conclusion

Safe to ship as Tier 1. The change makes the always-loaded instructions match the shipped Documents feature (constitution #84 Agent Awareness; Rule 4, a document may not assert what it cannot keep current).

## Evidence pointers

- `tests/unit/report-delivery-as-document.test.ts` (7 tests): new-agent rows, identity principles, awareness entry, migration in full and reference layouts with idempotency, edited row untouched. The full-layout migration test fails with the migration loop disabled (checked).
- `tests/unit/documents-claudemd-migration.test.ts`, `tests/unit/awareness-entry-registry.test.ts`: green.
- `POST /spec/conformance-check` on `docs/specs/report-delivery-as-document.md`: 100 standards, 0 findings, fit.

## Second-pass review

Independent reviewer subagent read the diff, the Documents awareness entry, the migrator, docs/signal-vs-authority.md and the full instar-2 docs/00-the-purpose.md and docs/01-the-rules.md. Correctness (exact rows, function replacer so `$` is inert, CRLF-safe single lines, idempotent, edited rows untouched) and accuracy against the Documents feature were confirmed; no rule conflict. Concern raised: AGENT.md principles 6 and 9 changed for new agents only (existing agents kept the Private-Viewer-only wording, Migration Parity), and the always-loaded "Use private views for sensitive content" line said nothing about documents. Both fixed in this change: `migrateAgentMdReportDelivery` plus `PRIVATE_VIEWS_SENTENCE` (CLAUDE.md and AGENT.md), covered by a new AGENT.md test. Remaining Private Viewer mentions (the capability table row, the "rendered that as a page" example, ContextHierarchy's reporting block) describe the viewer, which still serves where documents are off; none points reports at GitHub. Concur with the review after fixes.
