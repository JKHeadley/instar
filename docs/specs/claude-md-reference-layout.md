---
title: "Small CLAUDE.md: core rules + dispatch table, per-feature sections in on-demand reference files"
slug: "claude-md-reference-layout"
author: "echo"
eli16-overview: "claude-md-reference-layout.eli16.md"
status: "approved"
approved: true
approved-by: "echo — operator delegation: only constitution changes need Justin; this spec touches no constitution file (task brief, Echo Bugs topic 10000001426)"
found-by: "topic 135786 (Instar Agent Creation), item D in .instar/vm-test/app-coordination.md; Echo Bugs topic 10000001426"
parent-principle: "Agent Awareness"
review-convergence: "2026-11-03T09:26:59.330Z"
review-iterations: 6
review-completed-at: "2026-11-03T09:26:59.330Z"
review-report: "docs/specs/reports/claude-md-reference-layout-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 8
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Small CLAUDE.md: core rules + dispatch table, reference files on demand

## 1. Problem

The CLAUDE.md that instar writes for an agent is about 570,000 characters. Measured on
2026-11-02 at `main` c54542429:

- `generateClaudeMd()` alone: 496,442 characters.
- After `PostUpdateMigrator.migrateClaudeMd()` runs on that output (what every new agent
  gets at its first server start): 566,252 characters. Real agents: Echo 472k, Groky
  461k, Luna 463k, Cirrus (made 2026-11-02) 570k.

Claude Code loads the whole file into every session, so every session of every agent
spends roughly 120k tokens before it does anything. Claude Code itself warns at session
start: "CLAUDE.md is over the 150.0k-char limit (496.1k chars)" (fresh Ubuntu agent made
by the installer, 2026-11-03, Claude Code 2.1.317). Nothing is duplicated: the file grew
one awareness section per feature, as the Agent Awareness Standard asks (about 300
feature sections; the largest are 10–20k characters each).

The fix must keep agent awareness (the agent knows every capability exists and where to
read about it) and keep every rule the agent applies on every turn in the always-loaded
file, while making that file small.

### Why not an existing on-demand system

Instar already has three on-demand stores: ContextHierarchy (`.instar/context/`), the
Playbook, and the Self-Knowledge Tree. An earlier slim CLAUDE.md
(`generateSeedClaudeMd()`, 2026-03) pointed the agent at `/self-knowledge/search` and was
never wired in. Two lessons from it shape this design:

1. **A second, hand-written slim template drifts.** Every feature PR edits
   `generateClaudeMd()`; nobody edits the seed. So the small file here is *derived* from
   the full document by code, never written by hand, and contributors keep one place to
   add awareness.
2. **A pull-only surface needs the agent to remember to pull** (the reason
   `session-boot-self-knowledge` rejected it). So the always-loaded file still names
   every capability (one short name each) and keeps every rule applied on every turn;
   only the detailed text is pulled. The reference files are plain markdown read with
   the Read tool, so they work with the server down and for any framework.

## 2. Design

### 2.1 Two outputs from one source

`generateClaudeMd()` keeps producing the full awareness document. It remains the single
place contributors add awareness, and the ~120 tests that assert on its text keep
working.

A pure module, `src/scaffold/claudeMdLayout.ts`, splits a full document into:

1. **The core block** written into `CLAUDE.md` between two markers:
   `<!-- instar:claude-md-core:start ... -->` and `<!-- instar:claude-md-core:end -->`.
   It holds the sections whose heading is on `CLAUDE_MD_CORE_HEADINGS` (prefix match):
   Who I Am; Identity Files; Operator handoff; Two Memory Systems; Identity Hooks;
   Compaction Survival; Quick Dispatch; Agent-as-Interface Principle; Agent
   Infrastructure (its own text only); Runtime; API Authentication; Reporting Issues &
   Feedback; Self-Discovery; Building New Capabilities; Execution Context; Core
   Principles; Anti-Patterns to Override; Conversational Tone; Evidence Hierarchy;
   Standing Ground; Self-Diagnosis; Telegram Relay; iMessage Relay; Session Continuity;
   Gravity Wells; Feature Proactivity; Registry First; Outbound Message Gate;
   Cross-Agent Communication Discipline; If I am the session standing down; Critical
   Anti-Patterns (it holds the identity-pinned Context-Death Self-Stop rule, which
   applies exactly when the agent is about to stop).
   Gravity Wells through stand-down are rules applied on every turn rather than looked up: traps go
   unnoticed from inside them, proactive triggers fire on what the user says, the
   state-file map answers questions before any search, and the message, cross-agent
   and stand-down rules must be in context at the moment they apply.
   The block ends with **"Instar Reference — read on demand"**: a "when the work
   touches X → read file Y" table, and **"Every capability in the reference files"**,
   one line per topic naming every capability in it by its short name (Agent Awareness:
   the agent sees every capability's name in every session).
2. **Reference files** in `.instar/reference/`, one per topic, plus `INDEX.md` listing
   every section title and the file that holds it. A topic larger than
   `MAX_REFERENCE_FILE_CHARS` (a 40,000-character body target, about 10k tokens) is cut
   at unit boundaries into `name.md`, `name-2.md`, ... — never before a `####` (or
   deeper) heading, so a sub-section stays in the same part as its section. The target
   is not a hard limit: a
   single unit larger than it stays whole in its own part, and each file adds a short
   generated header. The largest file today is about 40.5k characters.

The dispatch text tells the agent: before saying a capability does not exist, or before
using one not used yet in this session, read its section (INDEX.md names the file;
`grep -n '<name>' <file>` finds the line). A grep is word-match only, so "no hit" means
no literal match, not absence: the agent also checks INDEX.md and `GET /capabilities`
before concluding (Recall by Meaning).

### 2.2 How the split works

- The document is parsed into **units**. A unit starts at a `##` to `######` heading or
  at a column-0 bold-lead feature paragraph (`**Name** — ...`, optionally with a
  parenthetical before the dash). Lines inside fenced code blocks (backtick or tilde,
  closed by a fence of the same character at least as long) never start a unit. A
  unit runs to the next unit start. Concatenating the preamble and all units gives back
  the input exactly (tested).
- A heading unit is **core** when its own title is on the core allowlist. A bold-lead
  unit is core when its enclosing heading is core.
- A reference heading unit goes to the first topic whose keywords match its title. A
  heading whose title matches no topic (generic sub-headings like "What It Does",
  "Restrictions") goes to the file of its nearest ancestor heading, so it stays next to
  the section it belongs to; with no ancestor it goes to `other.md`. A `####` (or
  deeper) heading always goes to its parent's file, even when its own title matches
  another topic (a sub-part such as "Permissions and approvals" must not be separated
  from the section it restricts). `###` headings route on their own title because the
  template uses `##` headings as containers for many independent `###` feature cards. A bold-lead unit
  matches on its own title, else follows its enclosing heading's file; inside a `####`
  (or deeper) sub-section it always follows that sub-section, in the same part. Topic order is
  fixed in code, so the result is deterministic.
- **Core sections are never split silently.** A heading nested inside a core section
  (deeper level, no shallower heading in between) that is not itself on the allowlist is
  reported in `nestedOutsideCore`; a unit test asserts the canonical document has none,
  so a contributor who adds a sub-heading inside a core section must either allowlist it
  or move it. "Agent Infrastructure" is the one container heading whose sub-sections are
  classified on their own (the template nests every feature card under it). Nothing is
  pulled into the core by nesting at run time, so an instar section appended at the end
  of the file after a trailing core heading never grows every session.
- Every reference file starts with a generated header saying it is rewritten on every
  update and must not be edited. `.instar/reference/` is on the dashboard file editor's
  never-editable list for the same reason.
- A size budget test asserts the generated `CLAUDE.md` stays under **80,000
  characters**. Measured: 63.6k without Telegram, 65.4k with it (core sections ~58k, the
  dispatch table and capability list ~7k). New awareness added to `generateClaudeMd()`
  lands in a reference file automatically; growing the core requires deliberately
  raising the budget.

One template fix rides along: `### Agent Removal` sat in the middle of the anti-pattern
list, which cut the list in two. It moves to just after the list (pure reorder).

### 2.3 New agents (`instar init`)

Both init paths that write a standalone CLAUDE.md (`initStandalone` and the fresh project
path) write the full document as today and then immediately run the migrator's CLAUDE.md
layout step (2.4) in `freshInit` mode, so the first session already sees the small file.
`freshInit` keeps nothing below the instar block and writes no backup: the file was
generated a moment earlier and holds no operator text. `refreshClaudeMd()` (re-init of an
existing project) and the "append agency principles" path skip when the core markers are
present, so nothing lands outside the block looking like operator text.

### 2.4 Existing agents (`PostUpdateMigrator`, Migration Parity)

- `migrateClaudeMd()` is split into a string transform, `patchClaudeMdContent(content,
  result)` (the existing append chain), and the file read/write around it. The one file
  side effect the chain had (stripping a retired card from AGENTS.md / GEMINI.md) moves
  to `stripRetiredJevCardFromShadows()`, called from `migrateClaudeMd()` on every run, so
  the chain is a pure string transform and its REVIEW lines are never lost.
- **Canonical full document** = `generateClaudeMd(projectName, agentName, port,
  hasTelegram)` → `patchClaudeMdContent()` → the context-death anti-pattern insertion.
  `agentName` is read from `.instar/AGENT.md` (`**Name**: X` or a `# X` title), falling
  back to the project name, so the core says "I am Luna". This is what a new agent ends
  up with today, so an existing agent's reference files carry every section any
  migration ever appended, including ones the template lacks.
- When `CLAUDE.md` **has the core markers**: `migrateClaudeMd()` rebuilds the canonical
  document, rewrites the text between the markers when it differs, rewrites reference
  files whose content differs, and removes reference files that carry the generated
  header but are no longer produced. The legacy append chain does not run against the
  file. Text below the end marker is the operator's (the start marker says so: instar keeps it
  and only takes back out sections an older instar version appended there), with one
  exception: an older instar
  (after a rollback, or another machine of a git-synced agent still on an older version)
  runs its append chain on this file and appends instar sections at the end. The
  evidence used is a fingerprint (length + sha256) of the below-marker text as instar
  last left it, stamped on one comment line inside the instar block just before the end
  marker (`<!-- instar:claude-md-tail length=N sha256=H -->`), so it travels with
  CLAUDE.md to every machine. Only text after an
  unchanged recorded prefix is reconsidered, and only when that new text holds at least
  10 instar-owned sections by the ownership rule (an older chain re-appends dozens at
  once; an operator copying a section or two below the block on purpose is left
  alone). A unit containing an `<!-- instar:keep -->` line is never moved. When the
  cleanup runs, it backs the whole file up to `.instar/CLAUDE.md.before-cleanup.md` (one
  file, overwritten each time, so backups never pile up), removes those sections, keeps
  the rest, re-records the fingerprint, and reports a REVIEW line. It does not write the
  differing-lines file: the removed text is an older instar's own output (its differing
  lines are that version's fallback wording), and the backup holds all of it. With no stamp, or when the operator has
  edited the stamped text since, the whole text below the block is reconsidered under
  the same 10-section threshold and `instar:keep` exemption (an operator's notes
  essentially never hold ten instar sections; an older chain appends about a hundred),
  so an edit cannot leave an older instar's append in place for good. A section an older instar appends that the current
  version has dropped entirely moves out only if it still matches 60% of the current
  text; otherwise it stays below the block as kept text (the ambiguity-keeps floor), and
  the cleanup backup holds the file as it was. In practice every append below the block (an operator's too) is
  reconsidered once, at the next migration after it is made; the 10-section threshold
  and the `instar:keep` line are what protect an operator's notes. The cleanup backup
  holds only the file before the latest cleanup.
- When `CLAUDE.md` **has no markers** (every existing agent today): the legacy chain
  runs as before, then a final step of `migrate()`, `migrateClaudeMdReferenceLayout()`,
  converts the file:
  1. Copy the whole current file to `.instar/CLAUDE.md.before-reference-layout.md`
     (written once; never overwritten).
  2. Decide which units instar wrote (the **ownership rule**). A unit is
     **instar-owned** when at least 60% of its non-empty lines appear verbatim (trimmed)
     in the canonical document — not counting a `#` heading line itself, which is not
     evidence (otherwise an operator section under an instar title would score its own
     title as a match). A heading with no body is instar's only when the canonical
     document has exactly that heading. A unit is also instar-owned when its normalised
     title (or the title before its
     explanation) is a unit title in the canonical document AND at least 40% of its
     lines are verbatim. The title route covers older wording of an instar section
     (measured on Echo, Groky and Luna: drifted instar sections keep 40–57% of their
     lines). It never applies to core headings: "Who I Am" and "API Authentication" are
     personalised (Luna's "Who I Am" shares 33% of lines with the template and is her
     own text), so those move only on the 60% route. Every other unit, and any
     non-template preamble text, is **kept**.
  3. For every moved unit (including instar-owned text before the first heading),
     collect its lines that are not in the canonical document
     (older instar wording, or a hand edit inside an instar section). When any exist,
     write them, grouped by section, to `.instar/CLAUDE.md.differing-lines.md`, and put
     one visible line below the instar block pointing at that file. Measured: 4–14
     sections, about 10k characters per real agent, almost all older instar wording
     (for example a stale `localhost:4040` port) — which is why they are listed for
     review rather than loaded into every session.
  4. Write the reference files first, so CLAUDE.md never points at a file not yet
     written; if they cannot be written, stop and leave CLAUDE.md unchanged. (The
     refresh path also writes reference files before CLAUDE.md.)
  5. Write the new `CLAUDE.md`: the core block, then the pointer line (if any), then the
     kept units in their original order under a comment naming the backup file.
  6. Report: units moved, old and new size, and REVIEW lines naming every kept section
     and the differing-lines file. A kept section with the same title as one in the
     block (a personalised "Who I Am") now follows the block; the REVIEW line says so.
- `migrateContextDeathAntiPattern()` skips CLAUDE.md when the markers are present (the
  block is in the canonical document). `migrateFrameworkShadowCapabilities()` reads the
  canonical document instead of CLAUDE.md when the markers are present, so AGENTS.md /
  GEMINI.md mirroring is unchanged.
- The Self-Knowledge Tree's `file_section` source for `CLAUDE.md` ("Connecting to another
  agent") falls back to the reference files when the section is not in CLAUDE.md
  (`TreeTraversal.readFileSection`). No other runtime code reads CLAUDE.md section text
  (`InstructionsVerifier` matches only the path; `ensureFrameworkIdentityFile` skips
  claude-code).
- Running the migrator twice changes nothing the second time (tested, including on
  copies of Echo's, Groky's and Luna's files).

Measured conversions (copies, real ports): Echo 473k → 93k, Groky 462k → 85k, Luna
464k → 91k characters. Of that, 19–26k is each agent's own kept sections; the rest is
the 65k core.

### 2.5 Off switch and rollback

`.instar/config.json` → `claudeMd.layout`: `"reference"` (default when absent) or
`"full"`.

- `"full"` before conversion: the conversion step does nothing; the legacy chain runs as
  today.
- `"full"` after conversion: the region between the markers is filled with the whole
  canonical document instead of the core block, on the next update, without touching the
  operator's notes.
- Either setting takes effect at the next migration; `instar migrate` applies it
  immediately.
- `config.json` is per machine. On an agent that runs on several machines, set the
  switch on every machine (the same as any other config change today).
- The pre-conversion file is always kept at `.instar/CLAUDE.md.before-reference-layout.md`.

**Code revert** is not a complete rollback on its own, and the documented rollback is
the off switch above. A reverted instar sees a CLAUDE.md without most feature sections;
its content-sniffed chain re-appends every section it has a sniffer for, but some
template-only sections that moved to reference files (Architecture Knowledge, Web Content
Fetching, Serendipity, Playbook, Intent Engineering, Agent Removal, among others) have no
sniffer and would stay only in the reference files and the backup. To roll back fully after a revert: copy
`.instar/CLAUDE.md.before-reference-layout.md` over `CLAUDE.md` (the backup), or set
`claudeMd.layout: "full"` before reverting. When the new code returns, the refresh
removes the re-appended instar sections from below the end marker (2.4).

## 3. Decision points touched

| Decision point | Classification | Justification / floor |
|---|---|---|
| Core vs reference placement of a unit | `invariant` | A fixed heading allowlist in code. It decides only which file holds text; nothing is blocked, deleted, or hidden (every unit is in exactly one place, the core names every capability, INDEX.md lists every title). Deterministic placement is required so every agent of one version has the same core. |
| Topic file for a reference unit | `invariant` | Fixed keyword order plus the ancestor rule. A wrong filing costs one extra INDEX lookup; no information is lost. |
| Instar-owned vs operator-written unit during conversion and refresh | `judgment-candidate` | Predicate: the ownership rule in 2.4 step 2. Floor: the full file is backed up before anything changes; ambiguity resolves to keep; lines of moved units that differ from instar's text are listed in a review file the agent is pointed at; the fallback ladder ends at the deterministic rung "keep it in CLAUDE.md". Exemption from an LLM arbiter, argued: a wrong keep costs size only; a wrong move is bounded by the backup and the differing-lines file; the step runs inside an offline migrator where no model access is guaranteed; and an arbiter cannot tell old instar wording from a hand edit better than the line comparison without older instar versions, which the agent does not have. Keeping every modified instar section in the always-loaded file was rejected: measured on three real agents the differing lines are almost all older instar wording (stale ports, superseded bullets), so loading them every session would put wrong instructions in front of the agent. |
| Below-marker cleanup of an older instar's append | `judgment-candidate` | Evidence: the fingerprint stamp plus the 10-section threshold (2.4). Floor: the whole file is backed up before a cleanup; a unit with an `instar:keep` line never moves; fewer than ten instar sections are never moved; the fallback rung is "leave the text below the block". |

## 4. Symbols and the states they claim (P20)

- **Core markers present in CLAUDE.md** → claims "this file uses the reference layout and
  the region between the markers is instar's". Corroboration: the region's text is
  regenerated from the canonical document on every update, so a hand-copied marker pair
  only ever leads to that region being rewritten. If one marker exists without the other,
  or a marker appears twice (unmeasurable), the migrator treats the file as unknown, does
  not convert or refresh it, and reports a REVIEW line; nothing is rewritten.
- **Title or line match against the canonical document** → claims "instar wrote this
  unit". It can be present while the state is absent (an operator edited an instar
  section; an operator copied instar text into their own section) and absent while the
  state is present (instar wording that drifted below the thresholds). Corroboration and
  bounding: the backup preserves the original either way, the lines that differ from
  instar's current text are listed in the differing-lines file, and every kept title is
  named in the REVIEW output. Unmeasurable (canonical build throws): no conversion or
  refresh runs, the file is left exactly as it was, and the error is reported.
- **Generated header in a reference file** → claims "instar may rewrite or delete this
  file". A file without the header in `.instar/reference/` is never touched.

## 5. Multi-machine posture

- **CLAUDE.md core block and reference files**: `unified` by construction. Each machine
  regenerates both from its instar version and its config. Machines with the same
  generation inputs — instar version, `projectName`, `port`, `config.messaging` (which
  decides `hasTelegram`), the AGENT.md name and identity pins — produce identical text. Nothing new is replicated.
- **`hasTelegram`**: the boot migration, `instar migrate` and the update checker derive
  it the same way (`config.messaging` has a `telegram` entry). The update checker used to
  also require `enabled`; it is aligned in this change, because the core block is now
  regenerated from it and two derivations would flip the relay sections in and out.
- **Mixed versions on a git-synced agent home**: a machine still on an older instar runs
  its legacy chain on the small file and appends instar sections below the end marker;
  the next update on a new-version machine removes them (2.4). This churns only until
  every machine is on the new version, and each cleanup overwrites the same single
  backup file. Two machines with different `hasTelegram` make
  the block differ by the relay sections; that is an existing config divergence, not
  new state, and the block simply follows the machine that last updated.
- **The backups and the differing-lines file**: they sit next to CLAUDE.md in the agent
  directory and travel with it if that directory is synced. They are bounded: one
  conversion backup, one cleanup backup overwritten each time, one review file.
- **The fingerprint** is part of CLAUDE.md (a comment line inside the instar block), so
  it is `unified` with the file: every machine of a synced agent sees the same evidence.
  A machine that receives operator notes through sync sees them as unchanged text after
  the stamp written by the machine that last refreshed, so they are reconsidered once,
  bounded by the 10-section threshold and the `instar:keep` line.
- **The off switch** (`claudeMd.layout` in `.instar/config.json`) is per machine, like
  the rest of `config.json` (gitignored). On an agent that runs on more than one machine
  it must be set on every machine; otherwise the machines rewrite the block in opposite
  directions on each update. §2.5 says so. Project-mode agents whose CLAUDE.md is in a
  git repository will see these files as untracked, as they see CLAUDE.md change on
  every migration today.

## 6. Frontloaded decisions

- Reference location `.instar/reference/` (not `.claude/rules/`, which Claude Code would
  auto-load and defeat the purpose).
- Core size budget 80,000 characters, argued from content: the always-applied rules
  (~58k) plus the dispatch table and capability list (~7k) measure 65.4k; the margin
  leaves ~70k under Claude Code's 150k warning for an agent's own kept sections (real
  agents keep 19–26k).
- Reference file cap 40,000 characters per file (about 10k tokens, one Read call).
- Ownership thresholds: 60% verbatim lines for any unit; 40% for a title match on a
  non-core heading; title matches never move a core heading.
- Default layout `reference`; off switch `claudeMd.layout: "full"` (safeguard default
  on, operator can override).
- Topic set (named in code): principles and practices, mobile app, agent-to-agent,
  messaging, machines, accounts and models, sessions and jobs, autonomy and commitments,
  dashboard and web, safety and monitoring, development and updates, learning and
  memory, other. (`development-and-updates.md` is named so it is not confused with
  Quick Dispatch's `.instar/context/development.md`.)
- Re-conversion (after the markers are removed by hand) keeps the first conversion
  backup as it is (never overwritten) and rewrites the differing-lines file.
- Backups: `.instar/CLAUDE.md.before-reference-layout.md` (once),
  `.instar/CLAUDE.md.before-cleanup.md` (each below-marker cleanup, overwritten),
  `.instar/CLAUDE.md.differing-lines.md` (once, only when lines differ).

## 7. Tests

- Unit (`tests/unit/claude-md-reference-layout.test.ts`): the parser round-trips the
  document exactly; every canonical unit lands in exactly one output; the generated
  CLAUDE.md is under 80,000; the core holds each always-applied section and the dispatch
  table; the core names every reference capability; INDEX lists every reference title and
  every dispatch row points at a written file; big topics are cut into parts under the
  cap; a generic sub-heading follows its parent; no heading in the canonical document is
  nested in a core section without being core; a new template section lands in a
  reference file; `full` layout fills the region; marker validation; ownership (moves
  template sections, moves drifted wording by title, keeps a personalised "Who I Am",
  keeps operator text under an instar title); conversion end to end with backup and
  REVIEW; a `#` heading line is not counted as evidence and a body-less heading is kept
  unless instar has it; a `####` sub-section stays with its parent; second run is a
  no-op; refresh rewrites only the block; stale generated files are removed and others
  are not; below-marker cleanup of an older instar's append with backup, stable
  afterwards; an operator's copied section below the block, edited below-block text with fewer than
  10 instar sections, and an `instar:keep` unit are all left alone; edited notes plus an
  older instar's append are cleaned and the edit is kept;
  hand-added lines inside a moved section reach the differing-lines file and the pointer;
  `full` before and after conversion; half marker pair left alone; `freshInit` keeps
  nothing and writes no backup and uses the AGENT.md name; context-death step with
  markers.
- Unit (`tests/unit/TreeTraversal.test.ts`): a `file_section` on CLAUDE.md finds a
  section that moved to a reference file.
- Existing migrator tests that assert the legacy append chain's text inside CLAUDE.md pin
  `claudeMd.layout: "full"` in their fixture (the chain still runs for that setting and
  still builds the canonical document). Tests that assert a feature's awareness reaches an
  agent read CLAUDE.md plus the reference files.
- Integration (`tests/integration/claude-md-reference-layout-migration.test.ts`): a full
  `migrate()` over a legacy ~500k CLAUDE.md with an operator section produces the small
  file, the backup, the reference files (including migration-only sections) and the kept
  section; AGENTS.md mirroring still gets its sections; a second `migrate()` changes
  nothing.
- E2E (`tests/e2e/claude-md-reference-layout-init-lifecycle.test.ts`): `instar init
  --standalone` produces a CLAUDE.md under the budget with the dispatch table, INDEX.md and
  the feature sections in reference files; the first `migrate()` after it (with
  Telegram) keeps it small and adds the relay rules to the core.

## Maturation plan

- **test-agent-live:** the unit, integration and e2e tests run the real `instar init`
  and `PostUpdateMigrator.migrate()` paths; dry runs on copies of three real agents' files
  (Echo, Groky, Luna, with their real ports and AGENT.md) convert cleanly, keep each
  agent's own sections, and change nothing on a second run.
- **dev-agent-live:** live on the development agent (Echo) from the release that carries
  it. After its update, check that CLAUDE.md is under the 80k budget, that Claude Code no
  longer prints the over-limit warning at session start, and read the REVIEW lines and
  `.instar/CLAUDE.md.differing-lines.md`.
- **fleet:** the same release, on by default (`claudeMd.layout` absent = reference).
  Every agent's file is backed up before conversion, and `claudeMd.layout: "full"` brings
  the whole document back on the next update.
- **graduation criterion:** on the development agent and one fresh `instar init` agent,
  CLAUDE.md under 80k after the update, no Claude Code size warning, no lost operator
  section (every kept title listed in the REVIEW line is present), and a second migrate
  that changes nothing.
- **dark-window:** none. Every session of every agent pays the 570k load today, and
  Claude Code already warns about it; shipping dark would keep that cost.

## 8. Open questions

*(none)*
