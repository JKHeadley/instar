# Convergence Report — Small CLAUDE.md: core rules + dispatch table, per-feature sections in on-demand reference files

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier external pass ran through the agent's codex CLI in all six rounds
(status `ok` every round). Gemini was not authed on this machine (`gemini-not-authed`),
so the external family was Codex only. The Standards-Conformance Gate ran in round 1
(2 flags, both addressed) and returned `degraded: error` in rounds 2–6 (its model call
failed); it never blocks.

## ELI10 Overview

Every instar agent has a CLAUDE.md file that Claude Code reads in full at the start of
every session. It had grown to about 570,000 characters because each new feature added
its own section, and Claude Code now warns that the file is over its 150,000-character
limit. This change keeps one source (the same template generator) but writes two
outputs: a small CLAUDE.md with everything the agent needs on every turn, plus a list
naming every other capability, and a set of reference files holding the detailed text
that the agent reads when a task needs it.

For users, sessions start much lighter (about 65,000 characters for a new agent instead
of 570,000), and nothing an operator or agent wrote into CLAUDE.md is lost. Existing
agents are converted on their next update, with a backup first, and their own sections
stay in CLAUDE.md. The main trade-off: when an instar section in an old file had been
edited by hand, the current instar text replaces it, and the differing lines are listed
in a review file that CLAUDE.md points to, rather than loaded into every session.

## Original vs Converged

- **What stays always-loaded.** Originally the core held identity, memory and the main
  principles only. Review showed that some rules can't be looked up because they apply at
  the moment of action (traps, proactive triggers, the state-file map, outbound and
  cross-agent rules, stand-down, the context-death self-stop rule, how to reply on
  Telegram). They are now in the core, and the core also names every other capability,
  so the agent always knows each one exists.
- **Protecting the agent's own text.** Originally sections were matched by title, which
  would have replaced Luna's personalised "Who I Am" with the generic line. Now core
  headings never move on a title match; a heading line is not counted as evidence; title
  matches need 40% of their lines verbatim; lines that differ inside moved sections go to
  a review file with a pointer in CLAUDE.md.
- **Old versions putting the big file back.** Review found that a rollback, or another
  machine still on an older version, would re-append the whole old text below the instar
  part forever. Now a fingerprint stamped inside CLAUDE.md lets the next update take
  those sections back out (only when ten or more instar sections appear at once, never a
  section marked `instar:keep`), with one overwritten backup.
- **Keeping sections together.** Sub-sections now stay with their parent section and in
  the same file part; fenced code is parsed correctly; big topics are split into parts
  of about 40k characters.
- **Other readers.** The self-knowledge tree's lookup of a CLAUDE.md section now falls
  back to the reference files; a side effect hidden inside the string chain moved out;
  two code paths that disagreed on "has Telegram" now agree; reference files are written
  before CLAUDE.md points at them.
- **Corrected claims.** The spec now says plainly that a code revert alone does not
  restore every section (the off switch is the rollback), that the off switch is per
  machine, and gives the real 150k limit.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | conformance gate, codex, integration/security, decisions/lessons | 13 | 9 | core expanded, ownership rules, differing-lines file, below-marker cleanup, TreeTraversal fallback, revert claim, parts |
| 2 | codex, adversarial, lessons, scalability | 5 | 4 | heading not evidence, `####` follows parent, fingerprint gate, Critical Anti-Patterns in core, single backup, hasTelegram |
| 3 | codex, adversarial | 3 (+1 repeat accepted) | 1 | preamble lines listed, no part cut before `####`, cleanup no longer writes review file |
| 4 | codex, integration/multi-machine | 3 (+1 repeat accepted) | 3 | fingerprint moved into CLAUDE.md, fences, bold-lead in `####`, title threshold 40%, per-machine off switch |
| 5 | codex, adversarial | 2 (+1 repeat accepted) | 3 | levels 5–6, whole-tail reconsideration on edited notes |
| 6 | codex only (internal: 0) | 1 fixed + 2 accepted at cap | 3 | reference files written before CLAUDE.md |

## Proportion

Tier 2 (fleet-wide migration of an agent-installed file). About 2,100 lines across 14
files (one new module, migrator, init, tree traversal, file routes, server, tests, spec).
Six of six review rounds were used: the cap. Each round up to the fifth found a real
behaviour defect in code, so the rounds were not wording churn; the external reviewer
repeated one accepted trade-off in rounds 3–6.

## Left behind

- **Accepted at cap (design, not safety/data loss):** an instar section an operator
  edited by hand is replaced by instar's current text in the always-loaded file. The
  operator's differing lines are listed in `.instar/CLAUDE.md.differing-lines.md`
  (pointed at from CLAUDE.md) and the whole old file is backed up. Measured differing
  lines on three real agents are almost all stale instar wording, so loading them every
  session would mislead the agent. No version history of past templates exists locally
  for a three-way merge.
- **Accepted at cap:** a line an operator deleted from an instar section comes back
  (instar's section returns whole), consistent with the existing chain re-adding missing
  instar sections.
- **Accepted at cap:** when below-block notes were edited, the whole tail is reconsidered
  under the 10-section threshold; notes holding ten or more near-verbatim instar sections
  without `instar:keep` would be moved (backed up). Judged rare compared with leaving an
  older instar's 300k append in place for good.
- Precision: the reference-file cap is a body target; one unit larger than it stays whole.
- Precision: kept "Who I Am" text follows the block, so the file can show two identity
  statements; the REVIEW line says so.
- Precision: `.instar/` backups appear as untracked files in project-mode repos.
- Precision: a re-conversion keeps the first backup and rewrites the differing-lines file.
- Precision: a section a dropped feature appended stays below the block unless it still
  matches 60%.
- Found problem, triage "everything else": the template's `## Machine self-maintenance`
  heading sits mid-file at `##` level so ~90 later `###` cards read as its children;
  harmless here (routing does not inherit at `###`) — feedback queue.

## Full Findings Catalog

**Round 1** — conformance gate: grep fallback is word-match (→ dispatch text says no hit ≠
absence, check INDEX + /capabilities); similarity treated as proof of ownership (→
differing-lines file, P20 section). Codex: operator edits disappear from active context
(→ differing-lines file + pointer); sub-headings lose parent (→ ancestor rule). Internal
(integration/security): rollback re-append stays forever (→ cleanup); TreeGenerator reads
a CLAUDE.md section (→ fallback); side effects in the string chain (→ moved out);
backups in repos, dashboard edits, hasTelegram churn, kept text position (precision,
noted). Internal (decisions/lessons): every-turn rules moved out (→ six added to core);
Agent Awareness weakened (→ capability-name list); revert claim wrong (→ corrected);
wrong-move cost understated (→ differing-lines); §3 vs §2.4 mismatch (→ rewritten);
existing on-demand systems and the unused seed template not discussed (→ "Why not an
existing on-demand system"); reference file sizes (→ parts); core sections split silently
(→ nestedOutsideCore test); naming (→ development-and-updates.md).

**Round 2** — Codex: heading line counted as evidence (→ excluded); `####` keyword pulls a
child away (→ `####` follows parent). Internal: cleanup removes operator copies every
update (→ fingerprint + 10-section threshold + instar:keep); Context-Death rule outside
core (→ Critical Anti-Patterns in core); backups grow without limit (→ one overwritten);
hasTelegram derivations differ (→ aligned); `instar migrate` applies the switch (→ spec).

**Round 3** — Codex: preamble differing lines unrecorded (→ recorded); parts split a
sub-section (→ no cut before `####`); ownership repeat (accepted). Internal: cleanup grows
the review file with instar's fallback text (→ cleanup no longer writes it).

**Round 4** — Codex: bold-lead inside `####` routed/split away (→ stays); tilde/long
fences (→ CommonMark fence tracking); ownership repeat (threshold raised 25%→40%, rest
accepted). Internal: fingerprint and off switch are machine-local, spec said synced (→
fingerprint moved into CLAUDE.md; off switch documented per machine).

**Round 5** — Codex: levels 5–6 unrecognised (→ `#{2,6}`); identical-output claim
inputs (→ qualified); ownership repeat (accepted). Internal: edited notes + older append
leaves 361k forever (→ whole-tail reconsideration under the same threshold).

**Round 6** — Codex: deletions not reported (accepted); whole-tail reconsideration on
edit (accepted); CLAUDE.md written before reference files (→ order fixed). Internal: 0
design; precision: extra blank line on broken-stamp cleanup (→ fixed), §7 wording (→
fixed), dropped-feature sections stay (→ one sentence in §2.4).

## Convergence verdict

Converged at the round-6 cap. The last internal round found no design issue and verified
every earlier fix with live probes; the last external round's one fixable item was
fixed and its other two are accepted trade-offs recorded above, none of them a safety,
security or data-loss risk (every changed file is backed up first). Spec is ready for
approval.
