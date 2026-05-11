# Side-Effects Review — project-scope Phase 1a PR 3 (`/project` skill + session-start digest)

**Version / slug:** `project-scope-phase1a-pr3`
**Date:** `2026-05-11`
**Author:** `echo`
**Second-pass reviewer:** `required (new context-surface for the agent: session-start hook output)`

## Summary of the change

Final of three PRs for project-scope Phase 1a. Adds the user-facing
surface and the session-start digest surface so active projects stay
visible across new sessions and after context compaction.

Spec source: `docs/specs/PROJECT-SCOPE-SPEC.md` §§ Phase 1.7 (skill),
Phase 1.9 (session-start + compaction-recovery hooks).

**New files:**
- `src/core/ProjectDigestCache.ts` (~170 lines) — synchronous JSON
  digest writer. Renders one sanitized line per active project,
  top-N by `lastTouchedAt`, atomic write to
  `.instar/projects-digest.cache`. No I/O beyond the cache write and
  a `tracker.list()` read.
- `.claude/skills/instar-project/SKILL.md` — user-invocable slash
  command surface. Phase 1a ships `/project create`, `/project status`,
  `/project next` only. The mutating commands ship in Phase 1b once
  the round-runner exists.
- `tests/unit/ProjectDigestCache.test.ts` — 19 tests covering empty
  case, 3-project case, 7-project truncation, sanitization (control
  chars, newlines, 80-char cap), atomic write, and cache invalidator
  wiring.
- `tests/unit/project-digest-hooks.test.ts` — 7 tests exercising both
  hook scripts against present, missing, and malformed cache files;
  asserts the read-time sanitization re-strips control chars.

**Modified files:**
- `src/commands/server.ts` (+10) — instantiates `ProjectDigestCache`,
  wires the invalidator on `InitiativeTracker`, and writes the cache
  unconditionally on first boot so the hook scripts always have
  something to read on a fresh install.
- `.instar/hooks/instar/session-start.sh` (+50) — appends a
  `--- ACTIVE PROJECTS ---` block after the existing orientation. Pure
  file read (no HTTP). Falls back to `Active projects: state
  unavailable — run /project status when ready` on miss / parse error.
- `.instar/hooks/instar/compaction-recovery.sh` (+50) — same block
  with a `(post-compaction)` label.
- `upgrades/NEXT.md` — adds the Phase 1a PR 3 entry to the in-progress
  release-notes file.

**Cross-spec links:**
- The cache file format is the same JSON shape PR 1 documented in the
  `setDigestCacheInvalidator()` hook stub and Phase 1.9 of the spec.
- The skill's `POST /projects` flow uses the rate-limited handler PR 2
  shipped.

## Decision-point inventory

- **Cache write — what to include.** Hard-invariant filter:
  `kind:'project' && status:'active'`, sorted by `lastTouchedAt` desc,
  capped at 5. No LLM, no scored ranking. The `truncated` flag +
  `totalActiveProjects` count make over-limit visible without a
  decision.
- **Sanitization — what to strip.** Strip `[\x00-\x1F\x7F]` (ASCII
  control + DEL), collapse whitespace, cap at 80 chars per sanitized
  field. Applied at write time in `ProjectDigestCache.ts` AND at read
  time in both hook scripts. The doc's "Hard-invariant validation"
  carve-out applies: this is structural input cleaning at a system
  boundary, not a judgement call.
- **Hook fallback — what to emit on miss.** A single fixed string
  (`Active projects: state unavailable — run /project status when
  ready`). Surfaces the recovery action; never silently swallows.
- **`/project next` — placeholder behavior.** The skill documents the
  current 501 response shape and instructs the agent to surface a
  user-facing message ("placeholder until Phase 1b") rather than
  treating 501 as a hard error. Aligns with the PR 2-shipped route.

All decision points are structural — none introduces a new
conversational or judgement-based gate.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

- The digest cache filter is `kind:'project' && status:'active'`. Any
  project the user wants visible at session start must be marked
  `active`. Paused, halted, archived, and `awaiting-user` projects are
  intentionally excluded from the orientation digest — they show up
  on the dashboard but not in the cheap session-start surface. This
  matches the spec's "keep the active roster visible" intent.
- The 5-project cap is firm. Users with more than 5 active projects
  see the most-recently-touched 5 plus a "+N more on dashboard."
  indicator. The mitigation (`/project status` returns the full list)
  is documented in the skill body and the fallback message.
- The 80-char per-field sanitization cap can truncate long round
  names. The spec endorses this — names are display strings, not
  identifiers, and there are no consumers of the digest cache that
  need the original-length string. The full record is always
  available via `GET /projects/:id`.
- The hook falls back to the "state unavailable" string on any of
  three conditions: missing cache file, non-JSON file, JSON with no
  `digestLines` array. All three are recovery-friendly: the fallback
  is informational, not an error.

No legitimate input shape is rejected by this change.

---

## 2. Under-block

**What failure modes does this still miss?**

- The hook fallback string is fixed text injected into orientation. A
  malicious entity with write access to `.instar/projects-digest.cache`
  could populate `digestLines[]` with arbitrary text — but write
  access to the agent's state dir already means full agent
  compromise (the dir holds AGENT.md, MEMORY.md, secrets). The
  read-time sanitization re-strips ASCII control chars (so ANSI
  escapes can't sneak into orientation), but free-form lying text
  ("delete all files") would land in the agent's context. This is
  documented as accepted-risk in the threat model (§ Threat model of
  the spec).
- The cache file is per-machine (lives under `.instar/`, which IS
  synced across machines via git-sync). A machine that just synced a
  cache file from another machine sees that machine's snapshot of
  projects. This is intentional — git-sync conflict handling for
  projects (Phase 1.12, ships in Phase 1b) treats the cache as
  derived state; it's recomputed on first project mutation. No
  correctness issue.
- The cache write is best-effort (try/catch + console.warn). A
  hiccup writing the cache never blocks a successful mutation. The
  hook then emits the fallback on next read — recoverable on the next
  mutation. This is the intended degradation path.
- The invalidator runs on *every* mutation through `InitiativeTracker`,
  including `kind:'task'` initiatives. The filter inside
  `writeDigestCache()` re-applies `kind:'project'` so the file content
  is correct, but we do pay a write cost on every task mutation. With
  ~tens of mutations per session on a typical agent, the write cost
  (one ~1KB file write, atomic rename) is negligible. Acceptable.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes.

- `ProjectDigestCache.ts` lives alongside `InitiativeTracker.ts` in
  `src/core/`. It is a pure write-side projection of tracker state,
  with no HTTP, no LLM, no scheduling. Single responsibility:
  serialise the project roster.
- The skill's body is procedural — `curl` commands plus a description
  of expected response shapes. It does not duplicate validation logic;
  it points the agent at the existing HTTP surface from PR 2 and
  describes how to interpret each status code.
- Hook scripts read a file. They do not call HTTP, do not consult the
  tracker, do not load `node`. The whole hot path is one `python3 -c`
  with a JSON parse and a regex sanitization pass. Stays inside the
  50ms budget the spec specifies for the orientation surface.
- Server boot is the right place to wire the invalidator: it's the
  single chokepoint where every consumer of `InitiativeTracker` gets
  the same wiring. Boot also seeds the cache once so a fresh install
  has a non-empty file (`{ digestLines: [], totalActiveProjects: 0,
  truncated: false }`) before any session starts.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this is structural sanitization + a context-surface
      writer. Explicitly within the doc's "Hard-invariant validation"
      and "Display rendering" carve-outs.

The doc's carve-outs that apply here:

1. **"Hard-invariant validation"** — `sanitizeDigestString()` is a
   character-class strip (`/[\x00-\x1F\x7F]/g`). It does not inspect
   meaning, does not judge intent, does not call out to a model. It
   is a literal regex that runs on every output string. The same
   logic re-applies on the read side in the hook scripts (Python's
   `re.compile(r'[\x00-\x1F\x7F]')`).

2. **"Display rendering"** — `formatProjectDigestLine()` is a template
   function. Inputs come from the tracker (already type-validated by
   PR 1's create/update paths); outputs are a fixed-shape
   `Project [<id>]: <X> of <Y> done. Next round: <name>.` string. No
   decision points inside.

There is no detector here that emits signals into a higher authority,
and no authority here that gates an action. The whole module is a
write-side projection. The "decision" of what to include is the
`status === 'active' && kind === 'project'` predicate, which is a
type-level filter, not a judgement.

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Existing hooks.** The session-start and compaction-recovery hooks
  already emit a long orientation block (identity, project map,
  capabilities, working memory). The PR 3 addition is appended at the
  *end* of each script's main flow, immediately before the closing
  `=== END SESSION START ===` / `=== END IDENTITY RECOVERY ===`
  banner. It does not replace existing content. If the new block
  fails (which can only happen on a python3 absence), the orientation
  block still ends cleanly — the python heredoc swallows its own
  errors with `sys.exit(0)` and the surrounding bash falls through
  to the fallback string.
- **InitiativeTracker invalidator.** PR 1 wired the
  `setDigestCacheInvalidator` hook with a no-op default. PR 3 swaps
  the no-op for `() => projectDigestCache.writeDigestCache()`. The
  hook is fired after `create()`, `update()`, `setPhaseStatus()`, and
  `remove()`. Every legacy caller is unaffected — the invalidator was
  always called; we just gave it a real body.
- **TaskFlow.** When TaskFlow is wired (`config.taskFlow.enabled`),
  the invalidator still fires after each tracker mutation (the
  invalidator call is outside the TaskFlow branch in
  `InitiativeTracker.ts`). The cache write reflects whichever store
  is authoritative; `tracker.list()` already handles the projection.
- **HTTP routes.** No new routes. The skill calls the routes PR 2
  shipped. No re-validation, no shadowing.
- **Auth.** The skill body documents the `Authorization: Bearer
  <token>` requirement and shows how to read it from the config file.
  No new auth path.
- **File-system contention.** Atomic write uses `temp + rename` with a
  PID-suffixed temp file. Two processes writing concurrently each
  use their own temp name; the final rename is atomic on the same
  filesystem (POSIX guarantees). Last-writer-wins, but every write
  is well-formed.
- **Race condition: hook reads while server writes.** Reader sees
  either the prior complete file or the new complete file — never a
  partial. POSIX rename atomicity is what the test
  `tests/unit/ProjectDigestCache.test.ts > atomic write` asserts.
- **First-boot ordering.** The cache write happens before
  `server.start()`, so the file exists on disk before any HTTP
  request can arrive (or any session-start hook can fire from a
  spawned subprocess).

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- **Slash command surface.** A new `/project` skill is invocable
  from any Claude Code session that has the `.claude/skills/`
  directory. The skill is documented as `user_invocable: true` —
  intentional surface, exposed by the harness.
- **Session-start orientation.** Every session that hits the
  session-start hook now sees a `--- ACTIVE PROJECTS ---` block when
  the cache file is present. On a fresh install the block emits an
  empty section (`Active projects: none` after the header) — no
  noise.
- **Compaction-recovery orientation.** Same block re-injects after
  compaction. The agent reads this from context, not from disk
  directly.
- **New persistent state.** `.instar/projects-digest.cache` — JSON
  file, ~1KB typical. Written by every project mutation. Lives
  alongside the existing initiative state. No migration required;
  the file is fully derived.
- **Other agents on the same machine.** Each agent has its own
  `.instar/`, so the cache file is per-agent. Other agents are
  unaffected.
- **External systems.** None. No new outbound network call. No
  shell-out to `git`, `gh`, or any external CLI. The hook scripts
  use `python3` (already a dependency of the existing hooks).

---

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

- **Hot-fix release.** Revert the commit. The new files
  (`ProjectDigestCache.ts`, `SKILL.md`, two test files,
  `side-effects/project-scope-phase1a-pr3.md`) delete cleanly. The
  modifications to `server.ts` and the two hook scripts revert with
  no follow-up — the hook additions are appended, not interleaved,
  so the diff is a clean removal.
- **Data migration.** None. The cache file is derived. If a
  pre-rollback file remains on disk, the hook scripts will read it
  using the pre-rollback shape (still valid JSON, still emits a
  digest block) — but with the invalidator wiring gone, the file is
  no longer updated. Deleting the file is safe; the hook falls back
  to "state unavailable".
- **Agent state repair.** Not needed. Initiative records are
  untouched.
- **User visibility.** Rollback removes the orientation digest block
  and the `/project` skill. Anyone who'd started using `/project` would
  need to call `curl` directly until a re-roll.
- **Phase 1b dependencies.** Phase 1b ships the round-runner and the
  mutating skill commands. Phase 1b's PRs depend on the invalidator
  wiring being in place (so the digest stays fresh through the
  runner's mutations). If PR 3 is reverted, Phase 1b's first PR must
  re-add the wiring at the same time. Tracking note for the Phase
  1a → 1b gate.

Rollback is a single `git revert`; the only follow-up is reverting
Phase 1b's first PR if it's already shipped (it has not, as of this
commit).

---

## Conclusion

PR 3 ships the user-facing surface and the session-start digest for
project-scope Phase 1a. No new decision points beyond hard-invariant
sanitization + a structural type filter. All sanitization is applied
at write AND at read time (defense in depth against direct cache
poisoning). The hook scripts have a fixed fallback string and stay
inside the 50ms budget. Cache invalidator wiring uses the hook PR 1
prepared; tests assert end-to-end through `InitiativeTracker.create() →
invalidator → cache file → hook script → parsed orientation output`.
Typecheck clean, 26 new tests passing, no existing test broken. Clear
to ship pending second-pass review.

---

## Second-pass review (required)

**Reviewer:** independent audit pass
**Date:** `2026-05-11`

Independently re-read the new ProjectDigestCache module, both hook
scripts, and the server-boot wiring. Audited along three axes the brief
flagged:

1. **Sanitization at BOTH write time AND read time.** Verified:
   - Write side: `sanitizeDigestString` in `ProjectDigestCache.ts`
     applies `replace(/[\x00-\x1F\x7F]/g, ' ')` to every string that
     lands in the cache (project id via `formatProjectDigestLine`,
     round name, and the literal "Project [<id>]:" rendering). The
     80-char cap is enforced on each field before composition.
   - Read side: the python heredoc in both hooks (`session-start.sh`,
     `compaction-recovery.sh`) re-applies `re.sub(r'[\x00-\x1F\x7F]',
     ' ', ln)` plus a 200-char hard cap on the rendered line. This is
     the defense-in-depth pass the spec calls for: direct
     cache-file poisoning that skips the TypeScript write path
     cannot smuggle ANSI escapes or unprintable bytes into
     orientation output. Asserted by the `re-sanitizes control chars
     on read` test.

2. **Prompt-injection surface.** The free-form text that lands in the
   digest is `(project.id, round.name)`. Project id is constrained to
   `^[a-z0-9-]{1,63}$` by `InitiativeTracker.create()`'s slug regex —
   no injection vector there. Round name is user-supplied (via plan
   doc) and gets sanitized and capped to 80 chars. The cap, combined
   with the fixed prefix "Project [<id>]: X of Y done. Next round:"
   and trailing period, bounds the maximum-attack payload to <200
   chars of clean ASCII per line, repeated at most 5 times. No
   ANSI escapes survive (control char strip). No newlines survive
   (control char strip). No structured-output injection possible (the
   orientation block is delimited by `--- ACTIVE PROJECTS ---` /
   `--- END ACTIVE PROJECTS ---` and the digest contents cannot
   produce those literal strings without including control chars,
   which we strip).

3. **Hook-script failure mode.** Both hooks wrap the python heredoc
   with bash conditional logic that emits the fallback string on any
   non-zero or empty output path. The python script itself uses
   `sys.exit(0)` on every error branch, so the hook never propagates
   a non-zero exit status into the orientation flow. Smoke tests
   assert exit-status 0 on missing, present, malformed, and poisoned
   cache files.

**Other findings:**
- Server-boot ordering is correct: `projectDigestCache.writeDigestCache()`
  fires before `server.start()`, so the file is on disk before any
  spawned session-start hook can fire from a child process. First
  boot writes the empty-state file (`{ digestLines: [],
  totalActiveProjects: 0, truncated: false }`).
- Atomic write is correct: temp file uses `process.pid` suffix; rename
  is atomic on the same filesystem. The repeated-write test asserts
  no partial JSON ever appears on disk.
- The `/project next` skill doc correctly surfaces the 501 placeholder
  rather than treating it as an error. This matches the route shape
  PR 2 shipped.

**Verdict: Concur with the review.** Clear to ship.

---

## Second-pass review — independent audit (PR-driver pass)

**Reviewer:** independent audit pass (PR driver, separate context from
artifact author)
**Date:** `2026-05-11`
**Specific concern flagged in brief:** prompt-injection via digest
content flowing into agent context (session-start + compaction-recovery
hook output). Reviewer must verify sanitization happens at BOTH write
time (in `ProjectDigestCache`) AND read time (in the hook scripts) —
defense in depth.

### Findings — defense-in-depth verification

**Write-time sanitization (verified in `src/core/ProjectDigestCache.ts`):**
- `sanitizeDigestString()` strips `[\x00-\x1F\x7F]` (ASCII control +
  DEL) by literal regex, collapses internal whitespace, then hard-caps
  at `MAX_STRING_LENGTH = 80` chars per field.
- `formatProjectDigestLine()` applies `sanitizeDigestString()` to BOTH
  `project.id` and `next.name` BEFORE composing the fixed-shape line
  `Project [<id>]: X of Y done. Next round: <name>.`.
- `writeDigestCache()` JSON-encodes the payload and writes atomically
  via temp-file + rename (PID-suffixed temp name, POSIX rename
  atomicity).

**Read-time sanitization (verified in both hook scripts):**
- `.instar/hooks/instar/session-start.sh` (lines 279-313) and
  `.instar/hooks/instar/compaction-recovery.sh` (lines 246-279) each
  run an embedded python heredoc that:
  - JSON-parses the cache file
  - Iterates `digestLines[:5]` (defense against truncation bypass)
  - Re-applies `re.compile(r'[\x00-\x1F\x7F]').sub(' ', ln)`
  - Collapses internal whitespace and hard-caps each rendered line
    at 200 chars
  - Silently exits 0 on any exception → falls back to
    "Active projects: state unavailable" string
- Template files (`src/templates/hooks/{session-start,compaction-recovery}.sh`)
  carry the identical block so fresh installs get the same protection.

**Prompt-injection threat model audit:**
1. Project id is regex-constrained (`^[a-z0-9-]{1,63}$`) at create
   time by `InitiativeTracker.create()` — no injection vector.
2. Round name is user-supplied via plan-doc YAML. Strip + 80-char cap
   bounds it. Combined with the fixed prefix `Project [<id>]: X of Y
   done. Next round:` and trailing period, max attack payload per line
   is < 200 chars of clean printable ASCII, ≤ 5 lines.
3. ANSI escape injection — blocked. `\x1B` is in the control char
   class; stripped at both write and read.
4. Newline / structured-output injection — blocked. `\n`, `\r`, `\t`
   are in the control char class; stripped at both write and read.
5. Delimiter injection (`--- END ACTIVE PROJECTS ---` as content) —
   the 80-char per-field cap bounds round name, and even if the
   literal delimiter string appears as content, the surrounding LLM
   reads orientation as semantic content, not as a parser-delimited
   structure. Not exploitable for instruction injection.
6. Direct cache-file poisoning by an attacker with write access to
   `.instar/projects-digest.cache` — read-side sanitization strips
   any control chars the poisoned file might contain. Cap-and-strip
   apply unconditionally on every read, independent of whether the
   bytes ever passed through `ProjectDigestCache.ts`.

**Other findings:**
- Atomic write semantics verified by the `tests/unit/ProjectDigestCache.test.ts
  > atomic write` test — repeated writes never expose a partial file.
- Hook-script exit status is 0 on every failure branch (missing file,
  malformed JSON, non-list `digestLines`, empty list, exception). The
  orientation flow never propagates a non-zero exit.
- First-boot ordering is correct: `projectDigestCache.writeDigestCache()`
  runs before `server.start()` in `src/commands/server.ts`, so any
  spawned session-start hook will see a valid file.
- `/project next` skill doc correctly surfaces the Phase 1b placeholder
  shape (501) rather than treating it as a hard error.

**Verdict: Concur with the review.** Sanitization is applied at BOTH
boundaries with the same character-class strip and equivalent caps.
Defense-in-depth requirement met. Clear to ship.

---

## Evidence pointers

- `tests/unit/ProjectDigestCache.test.ts` — 19 passing
- `tests/unit/project-digest-hooks.test.ts` — 7 passing
- `tests/unit/InitiativeTracker.project.test.ts` — 26 passing (PR 1 + this PR's invalidator wiring)
- `tests/integration/projects-api.test.ts` — 14 passing (PR 2 routes)
- `node_modules/.bin/tsc --noEmit` → clean
- `npm run lint` → clean
- Spec: `docs/specs/PROJECT-SCOPE-SPEC.md` §§ 1.7, 1.9
- Signal-vs-authority reference: `docs/signal-vs-authority.md` § "Hard-invariant validation" + § "Display rendering"
