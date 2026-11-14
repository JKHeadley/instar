# Side-Effects Review — Small CLAUDE.md: core rules + on-demand reference files

**Version / slug:** `claude-md-reference-layout`
**Date:** `2026-11-03`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

The CLAUDE.md instar writes for an agent had grown to ~570k characters; Claude Code
warns above 150k and loads all of it into every session. `generateClaudeMd()` still
produces the full awareness document, and a new pure module
(`src/scaffold/claudeMdLayout.ts`) splits it into a small core block written into
CLAUDE.md between two markers (identity, memory, compaction, dispatch, API auth, how to
report issues, self-discovery, core principles, anti-patterns, tone, evidence,
self-diagnosis, the Telegram / iMessage relay and session-continuity rules, the
every-turn rules — gravity wells, feature proactivity, registry first, outbound gate,
cross-agent discipline, stand-down, critical anti-patterns — then a "when X, read Y"
table and a list naming every other capability) and topic files under `.instar/reference/` plus `INDEX.md`.
`PostUpdateMigrator` converts existing agents once (backup first, operator-written
sections kept below the block) and afterwards regenerates only the block and the
reference files. `instar init` applies the layout immediately (`freshInit`). Off
switch: `claudeMd.layout: "full"` in `.instar/config.json`. Files:
`src/scaffold/claudeMdLayout.ts` (new), `src/core/PostUpdateMigrator.ts`,
`src/commands/init.ts`, `src/knowledge/TreeTraversal.ts` (CLAUDE.md section lookup
falls back to the reference files), `src/server/fileRoutes.ts` (`.instar/reference/`
never editable), `src/commands/server.ts` (update checker's `hasTelegram` aligned with
the boot migration), `src/scaffold/templates.ts` (pure reorder of Agent Removal out of
the anti-pattern list), tests (unit / integration / e2e; 9 legacy-chain fixtures pinned
to `layout: "full"`; 2 awareness tests read CLAUDE.md plus the reference files). Tier 2
(fleet-wide migration of an agent-installed file). Spec converged in 6 rounds (the
Tier-2 cap; every round up to the fifth found a real behaviour defect), about 2,100
lines across 14 source/test files.

## Decision-point inventory

- `extractOperatorContent` (instar-owned vs operator-written unit during conversion) —
  add — decides which file text lives in; never blocks or deletes (backup + kept
  section + reference files + differing-lines file). Ambiguity resolves to keep.
- Below-marker cleanup (refresh) — add — moves an older instar's re-appended sections
  out from below the block; only with ≥10 instar sections appended, never an
  `instar:keep` unit, always after a backup.
- `CLAUDE_MD_CORE_HEADINGS` / topic keywords (core vs reference placement) — add —
  fixed allowlist; decides only which file holds text.
- No block/allow surface on messages, sessions or tools.

---

## 1. Over-block

No block/allow surface — over-block not applicable. The nearest analogue is "over-
keep": an older instar section whose wording drifted below the thresholds stays in
CLAUDE.md as if operator-written. Cost is size only; measured on three real agents
the kept text was 19k–26k characters, almost all genuinely agent-written (a few stale
instar sections such as an old "Telegram Relay (MANDATORY)" and "Grok Build framework"),
and the migration report lists every kept title under a REVIEW line.

---

## 2. Under-block

No block/allow surface — under-block not applicable. The analogue is "over-move": a
section that matches instar's text closely (≥60% verbatim lines, or an instar
reference title with ≥40%, heading line not counted) but carries a few operator-added
lines is moved; the current instar text goes to the reference file and the operator's
lines are listed in `.instar/CLAUDE.md.differing-lines.md` (CLAUDE.md points at it) as
well as the full backup. This is the accepted trade-off recorded in the convergence
report: measured differing lines are almost all stale instar wording, so loading them
every session would mislead. Core headings (Who I Am, API Authentication, ...) never
move on a title match — Luna's personalised "Who I Am" (33% template lines) is kept.
Below-marker cleanup: notes holding ten or more near-verbatim instar sections without
`instar:keep` would be moved (backed up).

---

## 3. Level-of-abstraction fit

Right layer. The split is a pure string transform beside the generator; the file I/O
sits in `PostUpdateMigrator`, the one place that already owns CLAUDE.md on update
(Migration Parity). The legacy append chain is reused unchanged as
`patchClaudeMdContent()` to build the canonical document, so no section that a
migration ever added is lost or re-implemented.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic — STOP.

The ownership heuristic decides where text is stored, with a full backup, not whether
anything is allowed.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

The ownership decision is classified `judgment-candidate` with a deterministic floor in
the spec (§3): backup before any change, ambiguity → keep, final rung "keep it in
CLAUDE.md". The LLM-arbiter exemption is argued there (offline migrator, one-time,
bounded cost of either error). Placement and topic filing are invariants (fixed lists;
deterministic so every agent of one version has the same core).

---

## 5. Interactions

- **Other readers:** `TreeTraversal.readFileSection` (Self-Knowledge Tree
  `capabilities.agent_connect`) falls back to the reference files; no other runtime code
  reads CLAUDE.md section text.
- **Shadowing:** `migrateContextDeathAntiPattern()` skips CLAUDE.md once markers exist
  (the block is in the canonical document); `migrateFrameworkShadowCapabilities()`
  mirrors AGENTS.md / GEMINI.md from the canonical document instead of the small file
  (integration-tested). `refreshClaudeMd()` and the agency-principles append in init
  skip when markers exist, so nothing lands outside the block as fake operator text.
- **Double-fire:** the conversion runs last in `migrate()`, after every step that
  patches CLAUDE.md. A second run is a no-op (tested on three real agents' files and
  in unit / integration tests).
- **Races:** the migrator is the only writer of the block and the reference files; it
  already runs single-instance per update.
- **Feedback loops:** none; the canonical document is built from the template, not from
  the file being rewritten.

---

## 6. External surfaces

- Every agent on update: CLAUDE.md shrinks (≈465k → 85–93k measured; new agents ≈65k),
  new `.instar/reference/` directory (~22 files, ~560k total), one backup file, possibly
  one differing-lines review file.
- Agents whose home is a git checkout (e.g. Echo's) see CLAUDE.md change in the
  working tree, the same as every previous CLAUDE.md migration.
- No network, no messaging, no operator-facing action. No operator surface — 6b not
  applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

`unified` by construction: each machine regenerates the block and the reference files
from the same generation inputs (version, project name, port, messaging config, AGENT.md
name), so they produce identical text; nothing new is replicated. The below-block
fingerprint is stamped inside CLAUDE.md, so it travels with the file. The off switch
lives in `config.json`, which is per machine: on a multi-machine agent it must be set on
every machine (stated in the spec and the release note). Mixed versions on a synced home
churn (old machine re-appends, new machine cleans, one overwritten backup) until all
machines update. No user-facing notices, no URLs.

---

## 8. Rollback cost

- Per agent: `claudeMd.layout: "full"` puts the whole document back inside the markers
  on the next update (`instar migrate` now); operator notes untouched. This is the
  documented rollback.
- Code revert alone is partial: the reverted migrator's content-sniffed chain re-appends
  every section it has a sniffer for, but some template-only sections (Architecture
  Knowledge, Web Content Fetching, Serendipity, Playbook, Intent Engineering, Agent
  Removal, among others) have no sniffer and stay only in the reference files and the
  backup; restoring `.instar/CLAUDE.md.before-reference-layout.md` completes it. When the
  new code returns, its cleanup removes the re-appended sections.
- No data migration, no user-visible regression beyond sessions loading the full file
  again.

---

## Conclusion

Clear to ship once the full suite is green. The six review rounds changed the design
substantially: every-turn rules and a capability-name list in the core (budget 80k,
measured 66k); ownership that never moves a personalised core section, ignores heading
lines and needs 40% for a title match; a differing-lines review file; the below-block
cleanup with an in-file fingerprint, a 10-section threshold and `instar:keep`;
sub-sections kept with their parent; reference files written before CLAUDE.md; the
TreeTraversal fallback; and corrected rollback and multi-machine statements.

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagents (six rounds) plus Codex gpt-6-astra
**Independent read of the artifact: concur**

The final internal round verified every fix with live probes (conversion, a simulated
older-instar append cleaned from 361k back to 66.6k with operator notes kept, stable
repeat runs, nine copied sections and `instar:keep` sections left alone) and raised no
design issue. Remaining external points are the accepted trade-offs listed in
`docs/specs/reports/claude-md-reference-layout-convergence.md`.

---

## Evidence pointers

- Real-agent dry runs (copies, not live files, real ports): Echo 473,484 → 92,567;
  Groky 462,492 → 85,219; Luna 463,785 → 91,355 characters; second run changes nothing.
- Canonical core on current main: 64,468 characters without Telegram, 66,280 with.
- Tests: `tests/unit/claude-md-reference-layout.test.ts`,
  `tests/integration/claude-md-reference-layout-migration.test.ts`,
  `tests/e2e/claude-md-reference-layout-init-lifecycle.test.ts`.
