---
title: "Meeting-transcript analysis as a built-in skill"
slug: "meeting-transcript-analysis-skill"
author: "echo"
parent-principle: "Structure > Willpower"
eli16-overview: "meeting-transcript-analysis-skill.eli16.md"
approved: false
review-convergence: "2026-11-18T01:51:22.514Z"
review-iterations: 6
review-completed-at: "2026-11-18T01:51:22.514Z"
review-report: "docs/specs/reports/meeting-transcript-analysis-skill-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 11
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Meeting-transcript analysis as a built-in skill

## Glossary

- **Luna:** the SageMind agent (`@luna_sagemind_bot`). She wrote and runs this method for client calls, in her skill `.claude/skills/gci-post-call`.
- **The package:** `sagemind/project_sandbox/instar-transcript-skill` on the Studio, sent by Luna on Threadline thread `1f805ef5` on 2026-11-06 and updated after runs on 2026-11-09 and 2026-11-13. It holds the general skill text, the interface, five check scripts, a window splitter, a ledger builder, a shared library and 27 tests (`node --test test/*.test.mjs`: 27/27 pass, run 2026-11-17 PT).
- **Operator:** the human who owns the client relationship and is told the result.
- **Recorder:** whatever captured the call. It produces the transcript and sometimes screenshots, highlights and notes ("marks").
- **Meeting folder:** one folder per meeting run, inside the client workspace, holding every input and output of the run.
- **Ledger:** one row per stretch of transcript lines, with classes, a verbatim quote and the item it supports.
- **Blind readers:** two fresh readers that see only the transcript, each with a different method; their lists are compared with the ledger.
- **Verifier rounds:** fresh readers given the transcript, the marks read and the finished read, asked what is missing or wrong.
- **Hook:** a per-agent script named in the agent's client config that does a client-specific step (fetch the recording, stage changes, tell the operator).
- **Item-changing finding:** a verifier finding that adds, removes or changes an action, owner, ask, decision, priority or referent. **Firmness finding:** one about how firm a yes was, who a remark was addressed to, or a qualifier, that changes none of those.
- **EXO 3.0 Agent Specification:** the eight-property agent spec from *The Organizational Singularity* (Salim Ismail, OS Outline v24/v25). Instar already ships two EXO skills (`agent-readiness`, `agent-passport`).

## Problem statement

Agents that sit in on client calls are asked for a "post-meeting read": what was decided, who does what, what the client still owes. One pass over a long transcript misses things, and the misses are costly: a direct ask to the agent buried in small talk, a "this" whose referent decides the priority, a dropped qualifier that turns "spend little" into "spend none". Luna measured it. On her first full run, seven fresh verifier rounds over a read that already looked complete found 46 more points, 35 of them item-changing or priority wording (ROUNDS.md). On 2026-11-09 the read had about 30 items the recording service's own notes dropped, and the service's notes had 4 errors. On 2026-11-13 the operator's in-call screenshots carried facts the words did not.

Luna built a layered method with scripts that refuse to pass when a line, a keyword hit, a blind-reader item, a mapping or a recorder mark is unaccounted for. Today it exists only in her agent home and the package. Luna relayed (thread 1f805ef5, 2026-11-06) that Justin wants it built into Instar for every agent. Echo has not had that from Justin directly, so this spec goes to him for approval before any build (CMT-1406).

**What the checks prove, and what they don't.** The scripts prove structural facts: every line sits in a row, every keyword hit and blind-reader item is covered on its own line or carries a written verdict, every item maps to something that exists, every quote is verbatim, every mark has a read entry, the run record is consistent with its files. They do not prove the read is right. Correctness comes from the readers and verifiers, and is measured on fixtures with planted misses (Tests) and by misses the operator finds afterwards.

## Proposed design

### 1. One procedure, every framework

- The procedure ships as one built-in skill, `meeting-transcript-analysis`, content in `MEETING_TRANSCRIPT_ANALYSIS_SKILL_CONTENT` (`src/data/builtinSkillContent.ts`). The interface (inputs, outputs, hooks) and the EXO source passage are appendices inside the same SKILL.md, so the single file is the complete procedure; nothing else needs an installer.
- `installBuiltinSkills()` writes `.claude/skills/meeting-transcript-analysis/SKILL.md` (install-if-missing). `migrateBuiltinSkills` writes the canonical `.instar/skills/meeting-transcript-analysis/SKILL.md` and `migrateBuiltinSkillRenderings` renders it for Codex (`.agents/skills/`). The build adds a direct canonical write and Codex rendering to the fresh Codex-only `init` path (today it skips, `init.ts` ~553/960, and `canonicalSkillsRootFor` derives the root from `.claude/skills`), and a test checks the frontmatter survives `normalizeSkillFrontmatter`. Gemini agents have no skill rendering; the awareness entry (fleet step) points them at the canonical file to read.
- Fresh readers (blind readers, verifiers) are started by the shipped helper `fresh-read.mjs` (item 3), which uses the agent's own framework CLI through an adapter table (Claude Code and Codex at ship; a new framework adds one adapter with a tool-less door). On a framework with no adapter, `fresh-read.mjs` refuses with `no-fresh-reader` and the run's status is `blocked` with that reason, never a run with unisolated readers. No framework-specific step lives in the procedure text.

### 2. Changes to the method (from the reviews and from Luna's own later runs)

- **Neutral verifier question.** Verifiers are not told the read is incomplete. They are asked: "List anything missing, misattributed (speaker, owner, referent), misquoted or overstated, with line numbers and quotes. An empty list is a valid answer; say what you checked." (The package's verifiers were told the read was incomplete; no finding was ever rejected and no round came back clean.)
- **Two lists, one counts.** Verifiers return item-changing findings and firmness findings separately. Only item-changing findings keep the loop going; firmness findings are applied when they hold up and shown in the report, but do not hold the loop open (the package's 2026-11-09 lesson 4). A firmness finding that turns out to change an action's existence, owner or priority is item-changing.
- **Reversals are judged, not refused.** When a finding reverses an earlier round's finding about the same item and field, the agent checks the quotes. If a quote settles it, the agent applies the settled reading and records both readings and the quote. If no quote settles it, the item and field are recorded as a dispute: both readings stay in the read, every action, staged change and project-file change that depends on the disputed field is held, and the operator gets one question with both quotes (the package's 2026-11-13 lesson 6, without refusing correct fixes).
- **When the loop stops, and what it is called** (judgment within a floor; Decision points touched): at least two verifier rounds always run. Three honest statuses: `converged` only after a round with zero findings of either kind (Iterative Audit to Convergence); `items-settled` after a round with zero item-changing findings while firmness findings remain (they are listed; the agent may stop here, and the report says plainly it did not converge); `INCOMPLETE` when the run stops on quota shedding or the spend ceiling with item-changing findings left (listed). The agent judges whether another round is worth it while firmness findings remain; the operator can order more rounds.
- **2a. Status table** (one table; `run-check` computes it from the last round and the run record):

  Run status precedence: any blocking failure gives `blocked`; otherwise any dispute, open `INCOMPLETE` finding or non-blocking hook failure gives `ready-with-disputes`; otherwise `ready`. Verification limits are always listed in the report, whatever the status. The analysis status comes from the last round and from what verification was available: `converged` needs a zero-finding last round with every applicable check available; a zero-finding last round with some verification unavailable (no marks fetched, no image-capable reader) is `settled-with-limits`, and the limits are listed.

  | Analysis status (last round) | Disputes | Hooks and checks | Run status | May stage? |
  |---|---|---|---|---|
  | `converged` (zero findings, nothing unavailable) | none | all pass | `ready` | yes |
  | `settled-with-limits` | none | all pass | `ready` (limits listed) | yes |
  | `converged`, `items-settled` or `settled-with-limits` | some | all pass | `ready-with-disputes` | yes, except changes depending on a disputed field (held) |
  | `items-settled` (zero item-changing; firmness listed; any verification limits also listed) | none | all pass | `ready` (report says not converged) | yes |
  | `INCOMPLETE` (quota or ceiling; item-changing left) | any | all pass | `ready-with-disputes`, with every open finding treated as a dispute | only changes no open finding touches |
  | any | any | a non-blocking hook failed (`updateProjectFiles`, `recorderNotes`, `drafts`, `notifyOperator` after retry) | `ready-with-disputes`, the failure listed | yes, except what the failed hook feeds |
  | any | any | a check failed, live surface not unchanged, sync or lock wrong, `no-fresh-reader`, `fetchTranscript` or `recorderExtras` or `stageChanges` failed | `blocked` | no |

- **Quotes in the read are checked too.** The meeting read's own quotes go through the same verbatim check as the ledger's (one misquote escaped all seven verifiers in ROUNDS.md).
- **Coverage on the hit's own line.** A keyword hit or a blind-reader item counts as covered only by a row whose quote lies on that hit's line(s), or by a written verdict for that hit. One big row over a window no longer settles everything under it.
- **Dismissals are visible.** Every sweep verdict, reconcile decision, `info` mapping and rejected verifier finding is listed in a "What was set aside" section of the report with counts, so the operator sees what the agent decided was nothing.
- **Regression set split.** Misses the operator catches in a meeting are added to that meeting's `regressionSet` (with `recordingId`), and a re-run must catch them. Misses from past meetings become the agent's own fixture cases (transcript excerpt + expected item) that `eval.mjs` replays; they are not demanded of unrelated meetings.
- **Several recordings.** Every row, item, mark, extraction entry and regression entry carries `recordingId`; ids are namespaced (`P1:I12`). One ledger per recording, one item graph and one read per meeting; `run-check` checks across recordings.
- **Order of work** (one dependency order, replacing the package's numbering where it conflicted):
  1. `run-check --preflight`, before anything is fetched or written: the gate is on, the skill's `helperVersion` matches the scripts, the meeting folder will be inside `clientWorkspace`, its repository and remote match the declared `sync`, the local branch is pulled to the remote head, and the meeting lock is taken (item 4). The run then copies the helper scripts into `<attempt folder>/.helpers/` (git-ignored, never committed) and uses only those copies, so an update mid-run cannot mix versions.
  2. Fetch → blind readers started → ledger and item graph → coverage, sweeps, reconcile and marks checks → meeting read → verifier rounds, each fix followed by a rebuild.
  3. Planned mapping check (against open items plus the planned staged set) → project-file updates and staging → actual mapping check against what was staged.
  4. Report written, then everything to be committed is staged.
  5. `run-check --final` on that exact staged snapshot: re-runs every deterministic check itself (no reliance on earlier passes), checks the run record, and scans every staged file for credentials.
  6. That snapshot committed (LOCK still held) → pushed → `run-check --after-push` confirms the remote has that exact commit → notify (keyed `meetingId/revision`, receipt recorded) → a last small commit marks the LOCK `released` with the outcome and pushes it (`run-check --after-push` checks that this commit changes only the LOCK file) → the local lock is removed. Delivery receipts are written outside the checked snapshot. On any failure the local lock is removed and the git LOCK stays held with the failure recorded. A transient failure (a fetch or push that failed on the network) is retried once by the agent; anything else is reported, and the next run takes the LOCK over under the rule in item 4.

### 3. Scripts (built-in helpers)

The package's scripts (`windows.mjs`, `build-ledger.mjs`, `coverage-check.mjs`, `sweeps.mjs`, `diff-extractions.mjs`, `mapping-check.mjs`, `marks-check.mjs`, shared `lib.mjs`) plus three new ones (`run-check.mjs`, `fresh-read.mjs`, `eval.mjs`) become templates in `src/templates/scripts/meeting-transcript/`, installed to `.instar/scripts/meeting-transcript/` by `installMeetingTranscriptScripts(projectDir)` in `init.ts`, which iterates an explicit name list (mirroring `installBrowserScripts`) and is called from both `init` paths, `refreshScripts()` and `PostUpdateMigrator.migrateScripts()`. Always overwritten. Changes from the package:

- **No executed input.** The ledger source is JSON (`ledger-src.json`), read with `JSON.parse` and validated against a schema. Nothing the agent writes is imported or run.
- **Entry guard fixed.** The package's `import.meta.url === file://argv[1]` guard fails on a symlinked path or a path with a space, so the script prints nothing and exits 0. Every script runs its main when invoked directly by comparing `fileURLToPath(import.meta.url)` with `realpathSync(process.argv[1])`; a test runs each script through a symlink and a spaced path.
- **Exit codes.** 0 = check passed; 1 = check failed (with the list); 64 = bad input or usage (unreadable file, malformed transcript line, missing argument). Report-only modes (sweep listing, diff without `--ledger`) exit 0 and print `REPORT ONLY: not a check`; the skill never uses them as gates.
- **Paths stay in the meeting folder.** Every script takes `--root <meeting folder>` and refuses (64) an input or output path that resolves outside it, except the transcript and picture folder named in the client config. Hook paths in the config must resolve inside the agent home.
- **`marks-check` is a format check.** It checks that each mark has an entry with lines, items and a description in the reader's own words. Whether the description matches the picture is checked by a verifier given the pictures as image attachments (the adapters above). If the agent's framework has no image-capable adapter, the report says "screenshot facts were checked by the main reader only" and the best status is `settled-with-limits`. The package's 60-character minimum becomes "a description, or `nothing` with a reason".
- **`run-check.mjs` (new).** Three modes (`--preflight`, `--final`, `--after-push`, see the order of work). In `--final` it re-runs every deterministic check itself and reads `run.json` and the run's files, and fails unless: each blind extraction and each verifier round file has a matching `fresh-read` receipt (prompt and reply hashes; for rounds, the prompt hash covers the read version reviewed) and carries the transcript's sha256 (receipts make a skipped reader visible; they cannot make fabrication impossible for an agent that writes both); each verifier round file has the schema (`finding, recordingId, lines, quote, kind: item-changing|firmness, held: bool, reason, reverses?`); the reported status matches the status table (item 2a) as computed from the LAST round; any finding whose final kind differs from the verifier's own label is listed as a downgrade in the set-aside section; every dispute is listed and its dependent changes held; each hook has a status (`ran`, `skipped-unconfigured`, `verified-absent`, `failed`); when staging ran, `liveUnchanged` is `true` from the hook's `verifyLive` before/after read (a hook-attested observation, not prevention; anything else makes the run `blocked`); the mandatory artifact set for the configured capabilities (item 5's matrix) is present; no staged file matches the credential patterns of Instar's durable secret scrub, copied into the template with a parity test against `DURABLE_SECRET_PATTERNS` and scanned in chunks so large vendor JSON is covered (a hit holds the push; this is the same deterministic floor as Instar's live-credential wall on outbound messages, because a pushed credential cannot be taken back; the agent then removes the value or, for a false match, records why in `run.json`, and the report lists it); when staging ran, the raw before/after digests the hook returned are recorded in `run.json` and compared by `run-check` itself; the skill's `helperVersion` matches the scripts' version; and the meeting folder's git repository and remote match the client config's declared `sync` (Client data, item 5).
- **`fresh-read.mjs` (new).** Starts a fresh, tool-less reader: the prompt goes in on stdin, the reply comes back as JSON to a file in the meeting folder. On Claude Code it runs `claude -p --tools ""` with an empty allowed-tools list, `--strict-mcp-config`, a scratch working folder and an allowlisted environment, with pictures sent as image blocks over `--input-format stream-json`. On Codex it runs `codex exec -s read-only` from a scratch folder with `--disable shell_tool --disable unified_exec --disable apps --disable browser_use --disable computer_use -c mcp_servers={}` (the no-local-tools set Instar already uses in `CodexCliIntelligenceProvider.ts`), with pictures passed by `-i` (placed before the other arguments, the image list ended with `--`, so the stdin prompt is not read as an image path). The Claude stream-json call also needs `--output-format stream-json --verbose`. Both adapters carry the full argument and environment sets of Instar's existing tool-less providers, not only the no-tools flags: for Codex also `--skip-git-repo-check` and `-c project_doc_max_bytes=0` (without the first, `codex exec` refuses a scratch folder that is not a git repository); for Claude also `--setting-sources user` and `--allowedTools ''`, with an environment allowlist that keeps `CLAUDE_CONFIG_DIR` and the XDG folders and adds the configured sign-in key the way `applyClaudeChildAuth` does, so the reader runs signed in. The sets are carried in the template itself (an installed `.mjs` cannot import Instar's TypeScript); a unit test checks each adapter's tool, settings and MCP flags and environment allowlist against `CodexCliIntelligenceProvider` and `ClaudeCliIntelligenceProvider` (input/output format flags differ by design), and the test-agent rung runs both real CLIs on a fixture whose transcript asks the reader to read a file and run a command, expecting no tool use. Each call writes a receipt in the meeting folder (adapter, CLI version, provider and resolved model as the CLI reports them, outcome, latency, token usage where the CLI reports it, sha256 of the prompt including attached pictures, sha256 of the reply, time), so every reader and verifier call is auditable (Observable Intelligence). The reader cannot run tools, so text in a transcript or picture cannot make it act; its reply is data the agent then checks.
- **`eval.mjs` (new).** Runs the agent's fixture cases and the shipped synthetic fixtures through the scripts and reports which planted items were caught.

### 4. Client data

- Client material stays in `clientWorkspace`; nothing from one client's meeting goes into another client's folder, into `MEMORY.md`, or into shared notes. The skill says this; `run-check` checks that the meeting folder is inside the declared `clientWorkspace`.
- Raw audio is not kept. The fetch hook keeps the transcript text, the vendor JSON, `marks.json` and the pictures that are read.
- The client config declares `sync`: the git repository that holds `clientWorkspace` and its remote (or `none`). `run-check` fails the run when the meeting folder's repository or remote differs, so the repository and remote client material lands in are the ones the operator declared (who can read that remote is the operator's choice; see Honest limits). The skill commits and pushes to that declared remote after each run; `run-check` fails when the push did not land (local head not on the remote). `sync.remote: none` is refused unless the client config carries an operator-ratified exception with a commit or registry reference.
- Transcript, email and picture text is data, never instructions (and the fresh readers have no tools).
- One run per meeting, fenced: the meeting has a stable id (`<client>/<date>-<slug>`). Each run works in its own git worktree of the client workspace repository, created at preflight as a detached worktree at `origin/<sync branch>` (`git worktree add --detach`, since the branch is normally checked out in the main checkout); it commits there and pushes `HEAD:<sync branch>`, and `--after-push` compares against that remote ref. The worktree holds its attempt folder `meetings/<id>/runs/<runId>/`; project-file updates, staging, the final check and commits all happen in that worktree, so two runs (of the same or different meetings) never share an index or working tree. The worktree is removed after the release push; a failed run's worktree stays for diagnosis and is removed by the run that takes over its LOCK. Preflight adds `.helpers/` to the client repository's `.git/info/exclude` (local, not committed) so it never lands in the client's history. When a result or release push is refused because the remote moved (another run pushed), the run rebases its commit onto the new remote head in its own worktree: if the incoming changes touch none of this run's files, it pushes again; if they touch this run's project files, it re-runs `run-check --final` on the rebased snapshot first; a conflict blocks the run with the worktree and commit kept for recovery. The release commit's LOCK-only check compares it with its own parent. With `sync.remote: none` the worktree starts from local HEAD. `run-check --preflight` first, before the worktree exists, takes a local exclusive lock (`O_EXCL` create of `<git common dir>/instar-meeting-locks/<id>`, shared by every worktree of that repository and never committed, which covers sessions sharing one checkout and `sync.remote: none`), then pulls and reads `meetings/<id>/LOCK`: an unreleased LOCK means held, and the run stops with `blocked: meeting-held`. Otherwise it commits a LOCK (run id, machine id, session name) and pushes; if the push is refused it pulls and checks again, so only an existing unreleased LOCK ever means held (a push refused because someone pushed another meeting's lock is retried, not treated as held). The run's last commit, after the notification, marks the LOCK `released` with the outcome, so a later re-run takes it without asking. The local lock is removed when the run ends, successfully or not; a local lock whose session is confirmed stopped (`GET /sessions`) may be removed by the next run. Before each side effect (`updateProjectFiles`, `stageChanges`, `notifyOperator`) the skill re-reads the remote LOCK and stops with `blocked: lock-lost` if it is no longer this run's. Staged changes are keyed `meetingId/itemId` and the notification `meetingId/revision` (the revision rises by one per completed run of that meeting), so a retry updates rather than duplicates and a re-run is announced as a new revision. A LOCK left by a run that never finished is taken over by the agent itself once the holding session is confirmed stopped (`GET /sessions` on its machine shows it gone, read from that machine); the takeover is recorded in `run.json` and listed in the report. If the holding machine cannot be read, the run stays blocked and the operator is asked once; no clock decides it.
- Nothing goes to the client: drafts only through the `drafts` hook; changes to client-visible surfaces only staged through `stageChanges`, whose independent live read must show no change (`run-check`); publishing waits for the operator's word; one message to the operator through `notifyOperator`, keyed by `meetingId/revision` so a retry does not send twice.

### 5. Hooks

One versioned hook contract in the appendix: `fetchTranscript`, `recorderExtras`, `recorderNotes`, `gatherContext`, `updateProjectFiles`, `stageChanges` (must also implement `verifyLive`), `notifyOperator`, `drafts`. Each has inputs, outputs and failure behaviour. Required for status `ready`: `fetchTranscript`. Any other hook may be unconfigured: it is skipped and named in the report, and the parts that depend on it are listed as not done (for example, without `stageChanges` nothing is staged and mapping to cards checks only against `openItems`). A failed fetch is `failed`, never "no marks"; `recorderExtras` writes `{fetched: true, marks: []}` only after checking the recorder, and `marks-check` refuses a bare `[]` or a missing file. Instar ships no hook implementations.

What each hook's presence means for the checks (the matrix `run-check` uses):

| Hook | Configured and ran | Configured, found nothing | Configured, failed | Not configured |
|---|---|---|---|---|
| `fetchTranscript` (required) | checks run | — | `blocked` | `blocked` |
| `recorderExtras` | `marks-check` required | `{fetched:true, marks:[]}`; `marks-check` passes | `blocked` | marks not checked; best status `settled-with-limits` |
| `recorderNotes` | comparison written | noted | listed as not done | listed as not done |
| `gatherContext` | prep/agenda/open items checked | noted | listed as not done | mapping to cards checks only planned items |
| `updateProjectFiles` | files and versions listed | noted | `ready-with-disputes`, failure listed | listed as not done |
| `stageChanges` + `verifyLive` | live digests compared | nothing staged | `blocked` | nothing staged; live check not applicable |
| `notifyOperator` | receipt recorded | — | left to the agent's normal outbound retry (keyed, so no duplicate), then listed | report only in the meeting folder; listed |
| `drafts` | drafts listed | — | listed | no client drafts made |

`sync.remote: none` (operator-ratified exception only) skips the pull, lock push and after-push check, and the report says the meeting is on one machine.

### 6. Rollout, versions and cost

- **Gate.** `meetingTranscript.enabled` in config, omitted = the development-agent gate (the standard dark-on-fleet pattern, added by `migrateConfig` as an absent key). When off, neither the skill nor the scripts are installed and nothing is written; `run-check --preflight` also refuses, so a leftover copy cannot run. The gate is checked on every install path: the four `installBuiltinSkills` call sites (which gain a config argument), `migrateBuiltinSkills`, `migrateBuiltinSkillRenderings`, `refreshScripts` and `migrateScripts`; the integration test covers each, and the gate gets a `DEV_GATED_FEATURES` entry whose justification says it gates only the install of an agent-invoked skill (nothing runs or spends on its own). Luna's agent sets it to `true` as the first real user (her operator is Justin; his approval of this spec covers that).
- **Awareness.** The skill's description is what an agent sees at the dev rung. The awareness entry (`src/data/awareness/meeting-transcript-analysis.md`) ships with the fleet step, in the small PR that flips the default, so the fleet is not told about a feature it does not have.
- **Versions.** SKILL.md declares `helperVersion`; every script prints its version with `--version`; `run-check` fails on a mismatch. A later change to the skill text ships with a migration for the built-in allowlist (Migration Parity item 5); scripts change only with a version bump.
- **Luna's copy.** Her `gci-post-call` keeps her client hooks and calls the shipped scripts; her own script copies retire. That change is in her agent home: Echo sends the change list on thread 1f805ef5 as part of dev-agent-live and checks her next run uses `.instar/scripts/meeting-transcript/` (run.json records the script path and version).
- **Cost.** A run is 2 blind readers plus at least 2 and usually 4-7 verifier rounds, each reading the full transcript and read: about 0.4M tokens for a two-hour call at four rounds and up to about 0.8M at the default ceiling, on the agent's configured model (cost scales with that model's price). Verifier rounds run one after another. The run stops with `INCOMPLETE (quota)` when the quota tracker is shedding load, and stops at the client config's `verifier.spendCeilingRounds` (default 7) with `INCOMPLETE (ceiling)`.

## Decision points touched

| Decision point | Classification | Floor / justification |
|---|---|---|
| Each script's pass/fail (line outside every row, unprocessed window, non-verbatim quote in ledger or read, keyword hit or reader item not covered on its own line and without a verdict, owner mismatch, unmapped item, mark without an entry, inconsistent run record, path outside the meeting folder) | `invariant`; basis: enumerable-domain; evidence: each check is a finite predicate over the run's own files (every line, every hit, every item, every mark is enumerable) | A failure only stops that run's next step; nothing outside the skill is blocked. |
| `run-check` status `blocked` when the live surface read is not `unchanged`, the sync target differs, or hashes are stale | `invariant`; basis: irreversible-consequence; evidence: a client-visible change or client material pushed to an unchosen remote cannot be taken back | Unknown counts as not unchanged. |
| Whether a verifier finding holds up, and whether it is item-changing or firmness | `judgment-candidate` | Floor: when unsure, item-changing (keeps the loop going); every rejected finding is listed with its reason. Arbiter: the operator, who sees both lists and the set-aside section. |
| Sweep verdicts, reconcile decisions, `info` mappings | `judgment-candidate` | Floor: each must be written and is listed with counts in the report. Arbiter: the operator. |
| A reversal between rounds | `judgment-candidate` | Floor: applied only when a quote settles it; otherwise a dispute that holds every dependent change. Arbiter: the operator. Last rung: hold. |
| When the verifier loop stops | `judgment-candidate` | Floor: at least two rounds (basis: external-constraint; evidence: a single verifier is one sample, and the recorded runs' findings rose again after falling, 4 then 5 in ROUNDS.md, so one quiet round is not evidence of a settled read); continue while item-changing findings remain; stop early only on quota shedding (`/quota` reporting shedding; `not_configured` is not shedding) or the spend ceiling (`verifier.spendCeilingRounds` in the client config, default 7, a judgment the operator sets: each round is a full-transcript model call of about 60-90k tokens on a two-hour call), always reported as `INCOMPLETE` with findings. Arbiter: the operator, who sets the ceiling and can order more rounds. |
| Whether to use the skill for a call | `judgment-candidate` | Floor: a recorded client call with an operator-requested read uses it; otherwise the agent decides. Arbiter: the operator. |
| Side effects only by the run holding the meeting lock | `invariant`; basis: irreversible-consequence; evidence: a duplicate staged change or second operator message cannot be taken back | Lock unreadable, including an unreachable remote, counts as lost. |
| Retrying a failed fetch or push | `judgment-candidate` | Floor: one retry for a network failure only; the LOCK stays held and the failure is reported; anything else is not retried. Arbiter: the operator. |
| Taking over a meeting lock | `judgment-candidate` | Floor: only when the holding session is confirmed stopped on its own machine; recorded and reported. If that machine cannot be read, wait and ask the operator once. Arbiter: the operator. Last rung: wait. |
| Graduation numbers (two consecutive clean meetings; fleet step dropped after three escapes) | `judgment-candidate` | Floor: no fleet flip without two clean operator-reviewed meetings and the held-out results; arbiter: the operator, who can raise either number. |
| `STATUS: ready / ready-with-disputes / blocked` | `invariant`; basis: enumerable-domain; evidence: derived by `run-check` from hook statuses, disputes and checks | |

## Maturation plan

- **Held-out fixtures.** Besides the shipped fixtures, the build writes a small held-out set (at least three transcripts) whose expected items (owner, referent, qualifier, screenshot fact) are annotated through Codex on a GPT-family model, and evaluated with a non-GPT reader (the Claude adapter), so the annotator and the evaluated reader are different model families, from the transcript and its screenshots (recording which source supports each expected item), before the skill text is final, and are never shown to the skill text, its prompts or the person tuning them. `eval.mjs` compares the read's item graph from a full skill run with those annotations. The set is small; its size is part of the fleet decision.
- **test-agent-live:** a throwaway agent with the gate on runs the full skill on the shipped synthetic fixtures and the held-out set: two-speaker and multi-recording transcripts with planted misses (a direct ask inside small talk, a "this" whose referent sets the priority, a dropped qualifier, a screenshot-only fact, an owner bait) and corrupted artifacts (one big row per window, a stale extraction, a wrong-transcript hash, a hook that reports `liveUnchanged` with no live read). Pass: every planted item appears in the read with the right owner and referent, every corrupted artifact fails the named script, and a prompt-injection line in the transcript causes no tool call.
- **dev-agent-live:** development agents (gate default) and Luna (explicit flag). Luna's next recorded client call after the release runs through the shipped scripts and her hooks.
- **graduation criterion:** two consecutive real meetings by the dev rung where all checks and `run-check` pass, the operator's review of each read finds no missing or wrong action, owner, decision or priority (operator-found escapes = 0, recorded in `run.json` from the operator's reply), and the verifier result is recorded as a figure (rounds, item-changing counts per round). The count is by meetings, not days, because the dev rung's call schedule is not ours to set.
- **fail branch:** any operator-found escape resets the count, is added to that meeting's regression set and the agent's fixture cases, and is filed as a fix to the method (feedback queue) before the next count starts. After three escapes without graduating, the fleet step is dropped and the operator is told the method is staying at the dev rung, with the escapes listed.
- **fleet:** a separate small PR after graduation flips the default and adds the awareness entry.
- **dark-window:** dark on the fleet until graduation (the gate defaults to the development-agent gate); live on development agents and on Luna by explicit flag from the release. The fleet step is the only way out of the window, and the fail branch can close it for good.
- **ladder:** meetingTranscript

## Multi-machine posture

- Skill, scripts, awareness entry: shipped content, identical on every machine via the update path.
- Hooks and client configs live in the agent home. A fetch hook usually depends on a recorder login on one machine: machine-local-justification: physical-credential-locality (a recorder or meeting-platform sign-in lives on one machine's disk); on a machine without it, the hook returns `failed` and the run is `blocked` there, never a partial run.
- Meeting folders: unified. The replication path is the client workspace's git repository and its declared remote (`sync` in the client config), pulled before every run (preflight) and pushed at the end of every run; `run-check` refuses a run whose folder is not in that repository or whose push did not land. Raw audio is not kept, so no machine-local evidence remains.
- A run belongs to one session and holds the meeting lock (item 4); a second run of the same meeting, on any machine or in the same checkout, finds the lock held at preflight and stops before writing anything. Every run starts from the remote head (preflight pull) and ends with a push the after-push check confirms.
- `fresh-read.mjs` scratch folders are deleted after each read and hold nothing that must survive.

## Honest limits (accepted)

- The main agent reads the same client text with its ordinary tools; only the fresh readers are tool-less. Sandboxing the main session per task is a separate, larger Instar change (filed to the feedback queue); here the defences are the tool-less readers, the instruction that client text is data, preflight checks before processing, the lock re-read before each designated hook, and the final snapshot checks after staging and before push.
- `verifyLive` is the hook's own observation of the live surface. `run-check` compares its digests, but cannot prove a hook did not publish and revert.
- A matching repository and remote prove where client material goes, not who can read that remote; the operator chooses `sync` for that reason.
- A key shown in a screenshot is not caught by the text credential scan.
- Between the remote LOCK re-read and a hook's mutation there is a short window in which an operator-approved takeover could land; takeover requires the holding session to be stopped first, which closes it in practice.
- Receipts make a skipped or invented reader visible; an agent that writes both the receipt and the file could still fabricate both. Operator-found escapes are the backstop measure.

## Alternatives considered

- **Leave it in Luna's home.** Every other agent re-learns the misses, and fixes never reach copies.
- **A server route that runs the method.** The method is mostly reading and judgment; scripts the agent calls keep the mechanical part simple and inspectable, and a route would need its own model calls and spend controls.
- **Recorder converters as built-in hooks.** They depend on vendor pages and each operator's accounts; the hook contract says what a converter must output.
- **A fixed round cap as the stop rule (the package's 7).** Rejected: both recorded runs reached it without a clean round, so a fixed cap ends runs as `INCOMPLETE` for spend reasons while hiding that as a method rule. The ceiling stays, named as a spend ceiling.

## Side effects and rollback

- Agents with the gate on gain one skill (and its canonical and Codex copies) and eleven files under `.instar/scripts/meeting-transcript/`.
- Rollback: set `meetingTranscript.enabled: false` and revert the release. Already-installed files stay on disk and the skill may still be listed, but `run-check --preflight` refuses a run while the gate is off, and no awareness entry points at them; meeting folders are client data and are never touched.

## Tests

- Unit: the 27 package tests ported to vitest; two meetings sharing one client repository run concurrently through preflight, result push (one refused and rebased), notification and release; the entry guard through a symlink and a spaced path; exit codes 0/1/64 and `REPORT ONLY` for each script; JSON ledger source with schema errors refused and no import path; `--root` refusals; coverage on the hit's own line (one big row no longer settles a hit); read-quote verbatim check; `marks-check` refuses `[]` and a missing file; `run-check` on each failure listed in item 3; `fresh-read.mjs` builds a tool-less command for each framework (stubbed CLIs) and refuses to start without a scratch folder; skill frontmatter survives `normalizeSkillFrontmatter`; skill text contains the neutral verifier question and no "incomplete" assertion; no shipped file contains a client name from the package's scan list, a machine path or a money amount.
- Integration: `PostUpdateMigrator.migrate()` with the gate on installs the skill, its canonical and Codex copies, and the scripts; with it off, installs nothing.
- E2E: a fresh `init` with the gate on produces the skill and scripts, and `eval.mjs` runs the synthetic fixtures through the installed scripts with the expected catches and failures.

## Frontloaded Decisions

- **Script location:** `.instar/scripts/meeting-transcript/`, framework-neutral.
- **Overwrite policy:** scripts always overwritten; SKILL.md install-if-missing, later changes by migration.
- **Ledger source format:** JSON only; Luna's earlier `.mjs` sources are past runs and are not re-run.
- **Hooks ship empty;** the contract ships.
- **Gate:** dev-agent gate default; Luna by explicit flag; fleet flip in a later PR after graduation.
- **Raw audio:** not kept.
- **Meeting lock:** a LOCK file pushed to the client workspace repository (git's own push refusal is the fence); no pool registry needed.
- **Graduation:** two consecutive clean real meetings; three escapes without graduating ends the fleet step.
- **Reader flags:** copied into the template with a parity test against the Instar source sets (no runtime import of Instar's TypeScript).
- **Stop rule and statuses:** at least two rounds; `converged` (zero findings), `items-settled` (zero item-changing, firmness listed), `INCOMPLETE` (quota or spend ceiling, default 7 rounds); always reported.
- **Frameworks without a tool-less reader:** the run is `blocked: no-fresh-reader`, never run with unisolated readers.
- **Sync:** pushing to the declared remote is required; `none` needs an operator-ratified exception.

## Open questions

*(none)*
