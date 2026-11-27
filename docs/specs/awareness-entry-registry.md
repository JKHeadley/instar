---
title: "Awareness entry registry: a feature adds its agent-awareness text as one new file, not as edits to shared files"
slug: "awareness-entry-registry"
author: "echo"
eli16-overview: "awareness-entry-registry.eli16.md"
status: "approved"
approved: true
approved-by: "echo — operator delegation: Justin approves only constitution changes (my memory note quotes him for Instar 1.x on 2026-10-22 08:58 PDT: 'I should ONLY have to approve constitution changes'; the attribution ledger has no row for it because it predates the ledger). This spec touches no file named in .github/CODEOWNERS."
found-by: "throughput run, topic 130715, 2026-11-14 (CMT-1767)"
parent-principle: "Agent Awareness"
review-convergence: "2026-11-14T17:00:51.287Z"
review-iterations: 6
review-completed-at: "2026-11-14T17:00:51.287Z"
review-report: "docs/specs/reports/awareness-entry-registry-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 9
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Awareness entry registry

## 1. Problem (measured 2026-11-14)

The Agent Awareness Standard requires every feature to add text to the agent's
instruction document. Today that takes edits in four shared places:

1. `src/scaffold/templates.ts` (`generateClaudeMd`): a `content += ...` line or a
   `${X_SECTION(port)}` inside the template, plus an import line.
2. `src/core/PostUpdateMigrator.ts` (`patchClaudeMdContent`): an
   `if (!content.includes(marker)) { content += ...; result.upgraded.push(...) }` block,
   appended after the previous feature's block, plus an edit to a shared import line.
3. `src/core/PostUpdateMigrator.ts` (the Codex/Gemini mirror): a `[marker, render]`
   pair appended to one array.
4. Often a row in a table under a core heading.

Every feature appends at the same positions, so two features that are both correct
conflict in git as soon as one merges. Counted on 2026-11-14:

- 8 different changes, all features, left the Local Verify line on a merge conflict in
  one night; 4 of them conflicted in `src/scaffold/templates.ts` and 1 in
  `PostUpdateMigrator.ts` imports. Each conflict costs a hand merge, a push, a new
  place in line and a 20 to 40 minute run; an operator approval is dismissed by the push.
- Of 83 open non-draft changes, 18 touch `PostUpdateMigrator.ts` and 11 touch
  `templates.ts`. 110 of 789 commits on main since 2026-11-01 touched `templates.ts`.
- The hunks cluster: open changes 3100, 3102, 3103, 3106 and 3114 all edit
  `PostUpdateMigrator.ts` near lines 68, 10000 and 17200.

A second cost of the marker-append mechanism (2): it can add a section but never
revise one. A wording fix today needs a hand-written second marker in the shared file
(for example `PEER_HOMEBASE_AWARENESS_V1_LIMITS`).

Other shared files conflict for other reasons (`src/commands/server.ts` wiring,
`src/server/routes.ts`, `src/data/feature-ladders.json`). They are out of scope here
and stay tracked under CMT-1775. <!-- tracked: CMT-1775 -->

## 2. Goal

A new feature adds its awareness text by adding ONE new file. No edit to
`templates.ts`, to `PostUpdateMigrator.ts`, or to any committed list. Two features
never conflict on awareness wiring. New agents, existing agents, and the Codex/Gemini
copies all receive the text, and a later wording change reaches all of them.

Non-goals: moving the existing sections (they stay where they are, written the old
way); changing the reference layout; changing what agents see for existing features.

## 3. Design

### 3.1 An entry is a data file

A file `src/data/awareness/<id>.md`:

```
---
title: Held replies delivered late
requires: telegram
---
a reply held for review is delivered late and marked ... `curl http://localhost:{{port}}/...` ...
```

- The entry's `id` is its file name without `.md`, matching
  `^[a-z0-9]+(-[a-z0-9]+)*$`. The file system makes ids unique; nothing else has to.
- Front matter has exactly two possible keys: `title` (required, one line) and
  `requires` (optional; the only value is `telegram`). Any other key is an error. It
  is read by a small line parser, not a YAML library: each line is split at its first
  `:`, both sides trimmed, no quoting or escaping. A title may contain a colon; it may
  not contain `**` or an em dash (3.5).
- Files are UTF-8; a byte-order mark is dropped and CRLF is read as LF. `{{port}}` is
  replaced everywhere in the body, inside code fences too.
- In the directory, a file whose name is an id plus `.md` is an entry; `README.md`
  (that exact name) is skipped; any other `.md` file is an error row; anything else
  (other extensions, subdirectories, `.DS_Store`) is ignored.
- The body is text. The only substitution is `{{port}}`; any other `{{...}}` is an
  error. There is no code in an entry, so nothing can throw, depend on the clock, or
  import anything. What an entry may vary by is exactly what `requires` and
  `{{port}}` express; a feature that needs more waits for a change that adds a named
  placeholder for every entry (Frontloaded Decision 7).
- The registry renders an entry as `**${title}** — ${body}` followed by a blank
  line. That is the bold-lead form the layout parser recognises (`BOLD_LEAD_RE` in
  `src/scaffold/claudeMdLayout.ts`), so every entry is exactly one awareness unit and
  its title is what the core's capability list names. Authors never write the lead-in.

### 3.2 How entries are found: read from the package, never built

`src/awareness/registry.ts` reads the directory once per process, synchronously, the
first time it is asked: `new URL('../../src/data/awareness/', import.meta.url)`. That
relative path is the same from `src/awareness/` (tests) and from `dist/awareness/`
(installed), and `src/data` is already in the package's `files` list. Other modules
read `src/data` at run time with the same relative URL today
(`src/messaging/plainNoticeCheck.ts`, `src/server/AgentServer.ts`). Like them, it
assumes the package is not bundled into a single file. So:

- there is no list of entries anywhere: no committed index to conflict on and no
  generated one to wire into builds, lints, test setups and scripts;
- nothing is compiled, so there is no stale build output: a deleted or renamed entry
  is gone from the directory that is read;
- no top-level `await`, and no module of the repo is imported by the registry except
  `claudeMdLayout.ts`, which itself imports only `node:crypto`. The registry is a
  leaf; the existing cycle between `templates.ts` and `PostUpdateMigrator.ts` is
  untouched.

Three earlier designs were rejected. Run-time discovery of COMPILED entry modules:
plain `tsc` never deletes the output of a removed source file, so a stale
`dist/.../x.js` would load silently, and it needs top-level `await`. A build-time
generated index of entry modules: correct, but the generator has to run before every
compile, lint, test setup and script that imports `src`, and each missed path is a
missing-module failure on the test line. A committed list with `merge=union`: it rests
on hosting behaviour nobody here has verified (whether GitHub's mergeability check and
squash merge apply a repository's union rule), and a union merge keeps a stale line
when one branch renames an entry.

If the directory is missing or unreadable, that is one row in the error list (3.5) and
no entries; the unit test over the real directory requires it to exist (with a
`README.md`, which the reader skips, so the directory is tracked while empty).

### 3.3 The registry section, with and without markers

`src/awareness/registry.ts` exports (`ctx` is `{ port: number, hasTelegram: boolean }`):

- `eligibleEntries(ctx)`: the valid entries whose `requires` is satisfied, sorted by id.
  Every consumer goes through it; none filters on its own.
- `renderRegistrySection(ctx)`: `''` when there are no eligible entries, else

  ```
  ## Feature notes

  Notes added by individual features, one per entry.

  **Title A** — body

  **Title B** — body
  ```

  An entry that fails a check of 3.5 is left out and reported; the others still
  render.
- `withRegistry(doc, ctx, { markers })`: removes an existing well-formed block from
  `doc` (3.3.1), then appends the section at the END. With `markers: true` the section
  is wrapped in two marker lines:

  ```
  <!-- instar:awareness-registry:start — rewritten by instar on every update; do not edit -->
  ...section...
  <!-- instar:awareness-registry:end -->
  ```

  With no eligible entries it adds nothing at all (no heading, no blank line) and only
  removes an existing block. Returns `doc` unchanged when the result would be
  byte-identical.

`## Feature notes` is a level-2 heading that is not a core heading, so each entry is a
bold-lead unit under a non-core parent: it lands in a reference file (the layout's
existing title-keyword rule, else the catch-all file) and is named in the core's
capability list. The heading with its one sentence is itself one small unit in the
catch-all file and one name in that list.

#### 3.3.1 Finding a block

A marker counts only as a whole line that starts with the marker prefix, outside a
code fence. A document is in one of three states:

- no marker line: there is no block;
- exactly one start line followed later by exactly one end line: a well-formed block,
  which is everything from the start line through the end line;
- anything else (a start without an end, an end before a start, more than one of
  either): broken.

For a broken document `withRegistry` changes NOTHING and returns a `broken` result; the
caller reports one degradation. This is exactly what the precedent does
(`findCoreRegion` returning `'broken'` makes `migrateClaudeMd` write nothing and
report), and it is idempotent: a second pass over the same document is the same no-op.

### 3.4 Where it is called (one edit each, made once by this change)

Which document is on disk decides whether markers are used. The layout parser treats
any line that is not a heading or a bold lead as part of the previous unit, so marker
lines must never reach it.

1. `buildCanonicalClaudeMd` (the document that feeds the core and the reference files;
   under the reference layout every `CLAUDE.md` that has core markers, including
   `layout: "full"`, is regenerated from it): as its LAST step, after
   `insertContextDeathClaudeBlock`, `full = withRegistry(full, ctx, { markers: false })`.
   This also strips a marked block that consumers 2 or 3 put in earlier in the same
   build. No marker line reaches `splitAwareness`, the section is last, and so no
   pre-existing unit's parent or file changes.
2. `generateClaudeMd` and `patchClaudeMdContent`: each ends with
   `withRegistry(content, ctx, { markers: true })`. These are the on-disk paths for a
   fresh document and for a legacy `CLAUDE.md` without core markers, where the block
   must be findable on the next update. `patchClaudeMdContent` pushes
   `'CLAUDE.md: feature notes updated'` when the text changed.
3. The Codex/Gemini mirror. Its legacy marker loop must never read registry text, or
   a slice could carry a marker line or part of the section into the copy. So the
   loop's source is prepared first, in both of the mirror's existing branches:
   - when the mirror reads the canonical document (agents with core markers), it asks
     for `buildCanonicalClaudeMd({ registry: false })`: the same build with an empty
     registry passed to both `generateClaudeMd` and `patchClaudeMdContent`, cached
     separately from the normal one. Nothing has to be found and
     removed, because the section was never added;
   - when it reads the on-disk `CLAUDE.md` (agents without core markers), it removes a
     well-formed block from that text first (`withoutRegistryBlock`, the remover
     `withRegistry` already uses). For a broken block nothing can be removed safely,
     so the shared prefix of BOTH marker lines (`<!-- instar:awareness-registry:`) is
     added to the mirror's `boundaryMarkers`: a slice stops at any marker line, start
     or end, orphaned or duplicated.
   The copy itself (`appended`) also has any well-formed block removed BEFORE the
   loops run, because they test `appended.includes(marker)` to decide whether a legacy
   section is already there, and an entry body may quote such a marker. Then, just
   before the mirrored text is written,
   `withRegistry(appended, ctx, { markers: true })`, counting as one mirrored change
   when the text differs. If the COPY's own block is broken, the registry does nothing
   to that copy and the mirror reports it; the legacy loops, which are today's
   behaviour and not the registry's, still run on it with the same marker-line
   boundary. "A broken document is left unchanged" (3.3.1) is a statement about what
   the registry does, and it holds on every path.

The legacy-to-reference conversion (`extractOperatorContent(legacy, full,
migratorOnlyText)`) decides what is the operator's by comparing text. A block in a
legacy file was written by whichever version last updated it, so its text need not
match today's render. The markers already say whose text it is: the conversion calls
`withoutRegistryBlock(legacy)` first and passes the result on. A broken block cannot
be removed that way; it goes through the existing text comparison like any other
legacy text and the conversion reports it. Tests: a legacy file whose block was
written by an older, different entry set converts with no kept unit and no
differing-lines entry from the block.

### 3.5 Validation and reporting

An entry is checked when the registry loads it and again as rendered:

- file name and front matter as in 3.1; the title is one non-empty line without `**`
  or an em dash; non-empty body; no placeholder but `{{port}}`;
- a front-matter line with no colon, or a key given twice, is an error;
- titles are unique across entries, ignoring case (both entries of a clashing pair are
  left out and reported); a regression check also requires that no entry's title equals
  the title of a unit in the canonical document built without entries;
- code fences in the body are balanced; the body's first line is prose (it follows the
  lead-in on the same line, so a fence or list there cannot work);
- the rendered entry does not contain the marker prefix `instar:awareness-registry`;
- the rendered entry parses under the real `parseAwarenessUnits` as exactly one unit
  whose title is the entry's title;
- and, for the section as a whole: when wrapped in markers, the block finder of 3.3.1
  sees exactly one well-formed block spanning it.

An entry that fails is left out and recorded as `{ id, reason }`. Because an entry is
data and rendering is a pure function of the file, `port` and `hasTelegram`, the error
list does not depend on when rendering happens. It is reported wherever it is
produced, de-duplicated per process by `id` and reason: at server start through
`DegradationReporter.getInstance().report()` (feature `awareness.entry-registry`), and
by the migrator, which adds each row to its `result.errors` when it renders. The
server does not fail to start over an invalid entry.

Regression checks over the real directory keep a bad entry from merging:

- the directory exists and the error list is empty for both `hasTelegram` values and
  two ports;
- with at least one (fixture) entry: no entry lands in the core body, and every unit of
  the canonical document built without entries has the same text and the same file in
  the canonical document built with them.

### 3.6 A notice for the old way

`scripts/lint-awareness-entry-registry.mjs` (in `lint:parallel`) is ADVISORY: it
always exits 0. When the diff against the merge base adds lines inside
`patchClaudeMdContent` or adds a `content +=` line in `generateClaudeMd`, it prints one
notice naming the line and `src/data/awareness/`. The match is a cheap text signal
with no authority; the PR reviewer and the instar-dev skill text decide. With no merge
base (a shallow lane) it prints "not checked".

## 4. Rollout

One change: `registry.ts`, the `src/data/awareness/` directory with its `README.md`,
the three consumer edits, the advisory lint, the tests, and the text that tells authors where
awareness goes (the instar-dev skill, the Agent Awareness and Migration Parity items
in the repo `CLAUDE.md`, and the matching passage in
`docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md`).

It ships with ZERO real entries, and with zero entries the section is empty,
so every generated document is byte-identical to today's (`renderRegistrySection` is empty and `withRegistry` returns its input). No existing section is
converted: an agent on the full layout, and every Codex/Gemini copy, already holds the
old section outside the block and would then hold it twice. Existing sections stay on
the old path for good; only new awareness uses entries.

The first real entry is the next feature that needs awareness text. To make that soon
rather than eventual, the throughput session offers the conversion to the first open
feature in the Chief of Staff's queue that has not yet merged, as part of bringing it
up to date. <!-- tracked: CMT-1775 -->

Review of whether authors use it: two weeks after merge, read the merged diffs that
touched `patchClaudeMdContent` or `generateClaudeMd` in that period (a `git log -p`
over the two files). Any awareness added the old way means the skill text or the
notice needs work. <!-- tracked: CMT-1775 -->

Announcement: a session note to the Chief of Staff and builder sessions naming the new
path.

## 5. Tests

- Unit (fixtures are entry files in a temporary directory given to
  `createRegistry(dirUrl)`; the real directory through the default registry): each
  rule of 3.1 and 3.5 on both sides (unknown front-matter key, missing title, unknown
  placeholder, unbalanced fence, marker prefix, a body containing a heading or a
  second bold lead); an invalid fixture yields an error row while valid ones still
  render; a missing directory yields one error row and no entries; `eligibleEntries`
  filters `requires` for both `hasTelegram` values; `renderRegistrySection` is empty
  for zero entries; `withRegistry` is idempotent, replaces an older block, moves a
  block that is not last to the end, appends when none exists, adds nothing for an
  empty registry, ignores a marker quoted in prose or inside a code fence, and for
  each broken case returns the document unchanged on a first and a second pass. The
  consumers take the registry as an optional parameter that defaults to the real one,
  so tests pass a fixture registry: `generateClaudeMd` and `patchClaudeMdContent`
  contain a fixture entry exactly once and a second pass changes nothing; the
  canonical document contains no marker line and ENDS with the section (this test is
  the guard on "last step": a later step added after it fails here);
  `buildCanonicalClaudeMd({ registry: false })` contains no entry. Mirror, both
  branches: with a canonical source and with an on-disk source that has no core
  markers and whose last mirrored section sits directly before the block, the copy
  holds exactly one start line and the block once; an entry requiring Telegram is
  absent when `hasTelegram` is false; a fixture entry that quotes a legacy marker
  neither produces a slice nor stops that legacy section being mirrored into a copy
  that lacks it. Reporting: errors reach the degradation reporter once per process
  and the migrator's `result.errors`. Packaging: the packed file list contains
  `src/data/awareness/README.md`. The lint (notice and exit 0 for an added old-way line,
  silence for an unrelated edit, "not checked" without a merge base).
- Integration: the existing reference-layout migration test, extended with a fixture
  entry: it lands in a reference file, is named in the core list, and an edited body
  replaces the old text on the next migration.
- E2E: the existing init-lifecycle test, extended: on the production start path the
  error list is empty, a fresh agent's files are unchanged from today's when there are
  no entries, and a second update changes nothing.

## 6. Known remainder

- Rows under core headings still edit `templates.ts`. <!-- tracked: CMT-1775 -->
- The other shared files in section 1 are untouched. <!-- tracked: CMT-1775 -->
- Each entry's title is named in the core's capability list, which counts toward
  `CLAUDE_MD_CORE_BUDGET_CHARS`, exactly as a section added the old way does.

## 7. Side effects and risks

- The marked block is instar's: text an operator types between the two marker lines is
  replaced on the next update. The start marker says so, as the core region's does.
- In a legacy `CLAUDE.md` without core markers and in the Codex/Gemini copies, text an
  operator added AFTER the block ends up before it on the next update, because the
  block is re-appended last. The text is kept; only its position changes.
- A broken block is left alone by the registry and reported (3.3.1). Its entries then go stale in that
  one file until someone repairs the markers; the degradation says which file.
- Removing or reverting an entry removes its text everywhere on the next update.
  Reverting the whole mechanism leaves the last written block in legacy marker-less
  `CLAUDE.md` files and in Codex/Gemini copies; the revert PR must add one removal
  step for a well-formed block. Reference-layout agents need nothing: their files are
  rebuilt from the canonical document.
- Multi-machine: stateless. Each machine renders from its own installed package with
  its own `hasTelegram`, so two machines on different versions or with different
  Telegram settings can differ, exactly as the rest of the document does today.

## Decision points touched

- An entry that fails validation is left out of the rendered section and reported as a degradation; the server starts — invariant; basis: enumerable-domain; evidence: an entry is a data file that either satisfies the rules of 3.1 and 3.5 or does not, and nothing is weighed; rendering an invalid entry would break the one-unit guarantee the layout depends on, and refusing to start would trade a missing paragraph for an unreachable agent.
- Whether a document already has the block — invariant; basis: enumerable-domain; evidence: 3.3.1 lists the three states (none, well-formed, broken) with one fixed action each; the action for the doubtful state changes nothing and is idempotent, the same as the core region's.
- Whether an entry applies to this agent (`requires`) — invariant; basis: enumerable-domain; evidence: the value is absent or `'telegram'`, compared with the agent's configured `hasTelegram`; an unknown value fails validation.
- The old-way notice (3.6) — judgment-candidate; floor: advisory only, always exits 0, reads only added lines in two named functions, prints "not checked" without a merge base; arbiter: the PR reviewer and the author, who read the notice in context.

## Multi-machine posture

Unified. The registry holds no state: entries are data files in the package and each machine renders them from its installed version with its own `hasTelegram`. Nothing is stored, so nothing is replicated or stranded; it adds no notices and no URLs. The degradation report of 3.5 is per machine, like every other degradation today.

## Verify the state, not its symbol

- Symbol: the pair of block markers in a document. State claimed: instar's registry text is present and current. Corroboration: none is needed because the block is not trusted, it is rebuilt: on every update the text between the markers is replaced with a fresh render, so a present-but-stale or hand-edited block is corrected, and an absent block is added. Symbol present while state absent (a marker quoted in prose does not count: only whole lines outside code fences do; a truncated or duplicated block): the broken state of 3.3.1, which changes nothing and reports. Unmeasurable (the document cannot be read): the existing migration error path applies; no block is written.
- Symbol: an added line in two functions (the notice). It proves nothing and decides nothing; see 3.6.

## Maturation plan

- **test-agent-live:** the e2e init-lifecycle test builds a throwaway agent on the production start path, first with no entries (files identical to today's) and then with a fixture entry (it lands in a reference file and a second update changes nothing).
- **dev-agent-live:** Echo installs the release that carries the mechanism; `CLAUDE.md` and the reference files are compared before and after and must be identical while the folder is empty. When the first real entry ships, Echo's reference files are read to confirm the text is present once, on the Studio and on the M5.
- **fleet:** no switch and no staged rollout: the mechanism ships to everyone and changes nothing until an entry exists, and each entry then ships with its own feature under that feature's rollout.
- **graduation criterion:** the first three features that add awareness text after this merges do it with an entry file and none of them leaves the test line on a conflict in `templates.ts` or `PostUpdateMigrator.ts` awareness wiring; counted from the test log and the merged diffs.
- **dark-window:** none: there is nothing to keep dark, because with no entries every generated document is byte-identical to today's.
- **ladder:** not applicable: a build mechanism with no switch and no staged rollout, a revert undoes it.

## Frontloaded Decisions

1. Entries are data files read from the package at run time; no index of any kind, committed or generated (3.1, 3.2, with the three rejected designs and why).
2. A bad entry is left out and reported; the tests are what stop it merging (3.5).
3. One section rebuilt on every update instead of per-entry markers; marker lines only in documents that are patched in place, never in the canonical document (3.3, 3.4).
4. No conversion of existing sections, ever (section 4).
5. Ships with zero entries and is byte-identical to today until the first entry lands.
6. The notice is advisory and never fails (3.6).
7. An entry can vary only by `requires: telegram` and `{{port}}`. An entry that needs more waits for a later change that adds a named placeholder for all entries.
8. The block's heading is `## Feature notes`; entries carry no topic field and rely on the layout's existing placement rule.
9. Broken markers: change nothing and report (3.3.1).

## Open questions

*(none)*

## Carriers

The commitment the tracked markers above point to, as recorded in the registry (ledger: `docs/specs/carriers/awareness-entry-registry.json`):

> **CMT-1775** — "After the awareness entry registry merges: (1) offer and make the conversion of the first open feature that needs awareness text to an entry file, with the Chief of Staff; (2) two weeks after merge, read the merged diffs that touched patchClaudeMdContent or generateClaudeMd and fix the skill text or the notice if any awareness was added the old way; (3) give rows under core headings (Registry Firs"

It covers the four items marked above: the first conversion, the two-week adoption review, rows under core headings, and the other shared files.
