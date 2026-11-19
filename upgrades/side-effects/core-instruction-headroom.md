# Side-Effects Review — room in the core instruction file again

**Version / slug:** `core-instruction-headroom`
**Date:** `2026-11-18`
**Author:** `echo (scaling session, topic 145097), at the request of the session that runs the test line`
**Second-pass reviewer:** `independent reviewer subagent, 2026-11-18 23:05 PST`

## Summary of the change

The core part of the generated agent instruction file (CLAUDE.md) measured 83,999 characters on `main` after an update, against `CLAUDE_MD_CORE_BUDGET_CHARS = 84_000`. Any change adding a row or an awareness entry title therefore failed `tests/e2e/claude-md-reference-layout-init-lifecycle.test.ts`, which runs only at the end of a full verify. Fourteen open pull requests were affected.

This change shortens 22 long rows of the "Registry First" table and the "Feature Proactivity" list in `src/scaffold/templates.ts`. Each short row keeps its question or trigger, the first lookup and any "never" rule, and ends "(→ Lookup details)". The full original text of every shortened row is kept, word for word, in a new template section, "Lookup details", which the layout routes to `.instar/reference/principles-and-practices.md`. Fourteen further Registry First rows name the route (`GET /jobs`) in place of a full curl command, and the table's intro says that means the agent's own server with the auth header. The core is now 77,990 characters after an update (76,178 after init), 6,010 under the limit. The limit is not changed.

A new unit test, `tests/unit/claude-md-core-headroom.test.ts`, fails when a row under those two headings exceeds 400 characters, when fewer than 2,000 characters remain under the limit, or when a short row has no full copy in the reference section. Two existing unit tests that pinned the old row text are updated. `src/scaffold/claudeMdLayout.ts` changes in a comment only. `src/core/PostUpdateMigrator.ts` is not changed.

## Decision-point inventory

No decision point is added, changed or removed. The change is instruction text and a test. Rows that describe decision points owned elsewhere (who may grant team access, who confirms a learned skill) keep their rules in the short row and their full text in the reference section.

---

## 1. Over-block

No block/allow surface in the product. The new unit test can refuse a change: a row over 400 characters under the two guarded headings, or headroom under 2,000. Both are intended; the failure message says what to do. A legitimate long row is written short with its detail in a reference section, which is what the layout already asks for.

---

## 2. Under-block

The guard watches two headings. A long row added under another core heading is caught only by the 2,000-character headroom floor, not by the row cap. Sections other than these two grew slowly in the measured history, so the floor is the proportionate check. The e2e size test remains the final check.

---

## 3. Level-of-abstraction fit

The right layer. The layout module already separates core from reference by heading; this change uses that split as designed and adds no mechanism. The guard is a unit test, the earliest place the problem can be seen, instead of the end of an e2e lane.

---

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

The unit test is a build-time check on source text with exact numbers, not a runtime gate over messages or actions.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No static rule is added at a competing-signals decision point. The two numbers in the test are size checks on generated text: 400 (the longest guarded row after the trim is 303; 13 rows were over 400 before) and 2,000 (about seven rows of the measured median, enough for several changes to merge before the floor is reached).

---

## 5. Interactions

- **Update path.** On every update `refreshClaudeMdReferenceLayout` rebuilds the core from `buildCanonicalClaudeMd()` (template, then the patch chain, then awareness entries). The patch chain's content-sniffing guards run against the whole canonical document, which still contains every phrase they look for, in Lookup details. The reviewer checked each guard phrase and measured the rebuilt core: no long row returns and each route appears once.
- **Codex and Gemini copies.** A newly built AGENTS.md or GEMINI.md carries the short table and the Lookup details text. Existing copies are unchanged because their markers are already present.
- **Legacy conversions.** Converting a pre-layout CLAUDE.md lists the fourteen old curl rows in `.instar/CLAUDE.md.differing-lines.md` as older wording. That is review noise for those agents, with no behaviour change.
- **A legacy file kept on `layout: "full"`** has no core and no size limit; it keeps its long rows and gets no Lookup details section.
- **Open pull requests** that add a row to the same table may conflict textually in `templates.ts`; the rows they add are short by the new guard's rule or the guard tells them so.

---

## 6. External surfaces

The agent-facing instruction text changes for every agent on its next update: the same instructions, with the long explanations one lookup away. No API, config key, state file or user-visible message changes.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator-facing surface. Not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

No state is introduced. The instruction file is generated on each machine from the same template, so every machine of an agent has the same text after it updates. Not applicable beyond that.

---

## 8. Rollback cost

A revert restores the long rows. Because the core is regenerated on every update, agents return to the old text on their next update with no migration. The only cost of a revert is that the size test fails again for the next change that adds a row.

---

## Conclusion

A wording move that restores 6,010 characters of room in the core instruction file, keeps every instruction (short in the core, full in the reference file), and adds an early, clear check so the file cannot fill up unnoticed again. Tier 1: text regenerated on every update, fully undone by a revert, no runtime code.

---

## Second-pass review

**Reviewer:** independent reviewer subagent (general-purpose, fresh context, read-only), run by the scaling session on 2026-11-18 at about 23:05 PST against the uncommitted change
**Independent read of the artifact: concur**

The reviewer compared every shortened row with its removed line and its copy in Lookup details (all 22 present word for word), checked that the safety clauses stay in the short rows, confirmed the routing of Lookup details to the reference file and its name in the per-capability list, checked each content-sniffing guard in `PostUpdateMigrator.ts` against the canonical document, re-measured the size independently (identical figures), and ran the five unit files (99 of 99 passed). Verdict: **CONCUR**, no must-fix defect.

Its notes, and what was done after the review:

- Three short rows dropped something an agent needs before it would open the reference section: the line a member gets when asking who has access, the memory-privacy trigger, and the duty to tell the owner what sharing changes. All three are restored in the short rows in this commit.
- The intro sentence joined two clauses with a colon. Now two sentences.
- The pointer text was then shortened from "(more in Lookup details)" to "(→ Lookup details)" to keep at least 6,000 characters free after those additions. These edits were made after the reviewer's read; the five unit files and the size measurement were re-run on them (99 of 99; 77,990).
- Two rows of the table still use a full curl command because the update path inserts the same text. Left as is.
- The guard covers two headings only (see Under-block).

Not checked by the reviewer: integration and e2e files, the full unit lane, a real update of an agent holding an on-disk core from `main`, the Telegram-off variant.

---

## Evidence pointers

- Size, generated by a fresh init followed by one update: before 82,187 and 83,999; after 76,178 and 77,990.
- `nice -n 10 npx vitest run` on `claude-md-core-headroom`, `claude-md-reference-layout`, `report-delivery-as-document`, `migrate-context-budget-sentinel-row`, `awareness-entry-registry`: 5 files, 99 tests passed.
- Twenty further unit files that match row text pass unchanged (listed in the PR body).
- `npx tsc --noEmit -p .`: clean.
- To run in a test slot: `tests/e2e/claude-md-reference-layout-init-lifecycle.test.ts`, `tests/integration/claude-md-reference-layout-migration.test.ts`.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect fixed and no self-triggered controller — not applicable. The instruction text was correct; it was too long. The new unit test is the guard against the size returning.
