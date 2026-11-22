# Side-Effects Review — Scheduled jobs on short job-mode instructions

**Version / slug:** `job-mode-instructions`
**Date:** `2026-11-21`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (session lifecycle: spawn argv)`

## Summary of the change

Tier 2 (it changes the instruction text that unattended sessions receive); 14 files, about 1,100 lines including tests; the spec took 6 review rounds, which is high, driven mostly by the self-verification design. `JobScheduler.spawnJobSession` resolves each job's instructions mode (`src/scheduler/jobModeInstructions.ts`). For job-mode it renders a ~3 KB text in memory and passes `spawnSession({ jobMode })`. `SessionManager` skips job-mode on restricted spawns (`src/scheduler/jobModeLaunch.ts`) and otherwise has `claudeHeadlessExtraFlags` (`src/core/frameworkSessionLaunch.ts`) add `--settings {claudeMdExcludes, autoMemoryEnabled:false} --append-system-prompt <text> --session-id <uuid>` on both lanes. After the run, the scheduler judges the transcript once per version pair. Per-job, locked, generation-stamped state lives in `src/scheduler/jobModeCheckStore.ts`, gated by a one-time positive control (`src/scheduler/jobModePositiveControl.ts`). Four CLAUDE.md clauses moved into shared constants (`src/scaffold/templates.ts`; the CLAUDE.md output is byte-identical). There are two routes, migration carry-over in `src/commands/jobMigrate.ts`, an awareness entry, and the rollout switch `scheduler.jobModeInstructions` (dev agent only by default).

## Decision-point inventory

- Job instructions-mode resolution (`resolveInstructionsMode`) — add — chooses which instruction text a job session loads; it blocks nothing.
- Restricted-spawn skip (`jobModeRestriction`) — add — keeps today's launch for confined, auth-stripped or session-pinned spawns.
- Post-run transcript verdict and local suppression (`JobModeCheckStore.recordResult`) — add — a fail switches that job's next launches on this machine back to full instructions.
- Rollout gate `scheduler.jobModeInstructions` — add — dev-agent gate.

## 1. Over-block

Nothing is blocked. The closest equivalent: a job switched to job-mode that actually needed CLAUDE.md content. That is mitigated because only explicit overrides, the jobs.json field, or reviewed shipped jobs (none in this release) switch, and the job-mode text says where the full files are. A false fail in the transcript check makes a job run full: more tokens, nothing lost.

## 2. Under-block

If a Claude Code version silently stops honouring `claudeMdExcludes` and also stops writing `instructions` records, the transcript check could pass wrongly. The positive control catches that: it requires every source to be visible when loaded before any pass counts. If Claude Code ignores `autoMemoryEnabled` but still records the memory load, the check fails and reverts to full. A job's later reads of CLAUDE.md on demand are allowed by design and are not counted.

## 3. Level-of-abstraction fit

The launch flags sit in the one shared flag helper used by both lanes, so no lane can drift. Mode resolution is in the scheduler, the only component that knows the job definition. The session manager is told explicitly and never infers from a job slug. The transcript check reuses the completion path the scheduler already owns.

## 4. Signal vs authority compliance

No blocking authority is added. The transcript verdict is a deterministic reading of a closed fact (whether a file path is listed, whether a marker is present), and its only effect is the conservative direction: back to full instructions. A single unknown result does not change the mode; three for one account, launch path and launched Claude Code version for the current version pair return the job to full instructions on this machine.

## 4b. Judgment-point check (Judgment Within Floors standard)

The resolution and verdict points are classified invariant in the spec, with an enumerable-domain or irreversible-consequence basis. The judgment candidates (text size around 6 KB, the 256 KB read bound, three unknown retries) have floors and arbiters recorded in the spec's decision table.

## 5. Interactions

- Confinement and EVO-008 confined tools: these are skipped, so there is never a second `--settings`. Tested.
- Rerouted interactive lane with A2A `--session-id`: the reroute skips job-mode when a session id is pinned or resumed.
- Script-runner jobs: skipped (no Claude session).
- Spawn error text: `redactSpawnError` already drops the argv, so the inline text never lands in error records. Session records carry only the marker version and the byte length.
- `spawnJobSession` now awaits a small async step before `spawnSession`: the version probe (cached by the CLI version reader) plus one per-job state read and write. The active-job state is written before it, as today.

## 6. External surfaces

The new routes `GET /jobs/:slug/job-mode` and `DELETE /jobs/:slug/job-mode-check` are bearer-authenticated and validate the slug. The positive control runs three tiny Haiku `claude -p` probes once per Claude Code version per account (config home), in a temp directory, then cleans up its temp files. That is a small, bounded spend. The check depends on Claude Code's transcript format. Outcomes, in order (the check reads only records before the first assistant record, within the 256 KB bound): an excluded file listed in that window is a fail, even if the window has no snapshot or the read reaches no reply (the job falls back at once); loads recorded after the first reply are outside the check, which is why the positive control verifies that this client records loads before the reply; otherwise, if the read reaches no first reply, unknown (retried, never a pass), even when a snapshot is present; otherwise a missing or unrecognised snapshot (no `systemPrompt` list) is unknown, and a snapshot whose `systemPrompt` list does not contain the marker is a fail (the last snapshot before the reply decides) (the marker counts only inside the system prompt Claude Code sent, never elsewhere in the snapshot); otherwise pass. Other records it does not recognise, including malformed lines, are ignored, so an instruction-load record written in an unrecognised shape would not be seen: that case is the stated limit in section 6a, covered only by the per-version, per-account positive control.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface. Not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

- The job-mode text is unified by generation: it is rendered in memory from the running version, with no per-machine values, and Instar stores no copy of it. Claude Code itself records the system prompt it sent, including the appended job-mode text, in the job session's own transcript (the `prompt_snapshot` the check reads), as it does for any session's system prompt; the text holds no secrets (it names the server URL and token only as environment-variable names).
- The override map and the jobs.json field are replicated through the existing config and job sync.
- `.instar/state/job-mode-checks/` and the positive-control record are machine-local BY DESIGN (physical-credential-locality): they record how this machine's Claude Code binary and login honoured the flags.
- There are no user-facing notices, apart from degradation reports through the existing reporter. No URLs.

## 6a. Stated limit of the transcript check

A job's transcript passes when it shows the job-mode marker before the first reply and lists no excluded file. When
nothing is loaded, Claude Code writes no `instructions` record at all, so a pass rests on absence. Absence is trusted
only because the positive control, run per Claude Code version and per account, showed that this client version
records instruction loads before the first reply when they happen. The residual risk, accepted and stated: a single
job transcript on the same client version and account that omitted a load record it should have written would pass.
The check cannot prove a negative from one transcript; it relies on the record format being a property of the client
version, which the control verifies. The control does not rest on load records alone: its sentinel files are padded (about 8,000
characters, ~4,950 tokens each, measured), and it passes only if the token counts account for every excluded file, checked for consistency WITHIN the same run
(`judgeControl`): the exclusions-off probe loads three padded files, the CLAUDE.md-only probe two (the AGENTS.md
fallback and the memory index), the full-settings probe none, so (off − CLAUDE.md-only) measures one file's size f in
that run, and (off − full) must reach 0.85 × 3f and (CLAUDE.md-only − full) 0.85 × 2f (`RATIO_TOLERANCE`), with f at
least 3,500 tokens (`PER_FILE_MIN_TOKENS`). If one excluded file loaded without a record under full settings, those
drops become 2f and f, a whole file short, so the control fails whatever the absolute counts. This rests on the
sentinels being the same size, which the control itself writes. Two consistency guards: the measured f must lie within
0.75 to 1.35 times the measured size of one sentinel (`EXPECTED_FILE_TOKENS`, about 4,950 tokens), and neither drop may
exceed its expected multiple of f by more than the tolerance; otherwise other prompt content varied between the probes
and the result is not trusted (not visible). Stated limit: the counts come from three separate sessions, so hooks or
other content that vary between them by a whole file's worth in a coordinated way could still mislead the comparison;
it is strong corroboration of the load records, not proof. A further stated limit: the probes run headless in a temporary project with the account's
settings, not in the agent's own project, so project-level settings or hooks that change how loads are recorded are
not exercised by the control. The job check's own token-free evidence (the marker in the system prompt, no excluded
file listed) still applies to every real run, and the paired replay compares outcomes in the real project. The load records are checked exactly too: the exclusions-off probe must list CLAUDE.md,
.claude/CLAUDE.md and the memory index, and not AGENTS.md; the CLAUDE.md-only probe exactly the AGENTS.md fallback and the memory index
(nothing it excluded); the full-settings probe nothing. The full-settings probe also passes `--append-system-prompt` (a short fixed text,
`PROBE_APPENDED_PROMPT`), so it exercises the same flag pairing as a real job-mode launch. Run live on the
Studio (Claude Code 2.1.330, 2026-11-22): visible, with off 21,507, CLAUDE.md-only 16,393, full 6,666 input tokens. A second stated limit: the control runs as a headless `claude -p` probe only. For jobs on
the rerouted interactive launch path, the same Claude Code binary is assumed to record instruction loads the same way;
if that path systematically omitted load records, its job checks would pass on absence without detection. That lane's
passes are recorded separately (per account and path), so the assumption is visible in the check state, and it is the
first thing to re-verify if the rerouted path's transcript format ever changes.

## 6a-bis. A run whose exclusions fail

The job-mode text tells the session that the full instruction files and the memory index were not loaded. If Claude
Code ignored the exclusion settings on a run, that session receives both the full files and that statement, which
conflict. The check runs after the run completes, so its fallback protects only later launches; the affected run
proceeds with whatever loaded plus the short text: if Claude Code honoured only some of the settings, that run had partly reduced context and an inaccurate sentence about what loaded; the check catches any one excluded source and falls back for later launches.

## 6a-ter. Checked while live

After a pass, runs on the same key (job, version pair, account, launch path, launched version) are re-checked on a
sample: every 20th run (`JOB_MODE_RECHECK_EVERY`; the count is persisted in the job's check state and resets only when the sampled check's verdict is recorded, so a
restart neither resets the count nor loses a due sample; a due sample stays due until a verdict lands). A sampled run
that fails returns the job to full instructions like any failure. Between samples, a change in behaviour without a
version change would go unnoticed for up to 19 completed runs, plus any runs that launch while a sampled check or its
verdict is still pending (the check runs after completion and is not awaited); this is a sampling cadence, not a cap
on affected sessions. An unknown result revokes that key's pass, so after an unknown
every following run is checked until a pass, or until three unknowns return the job to full instructions.

## 6a-quater. Which version keys the state

The check state (passes, fallback, recovery) is keyed to the instar version and the version of the CONFIGURED Claude
Code binary (`claudePath`), read before spawn. The version of the binary a run actually launched is recorded after spawn
and used only to judge that run's transcript. Throughout this review, "an update" that resets a job's state and offers a
recovery probe means an update of instar or of that configured binary; if a different launched binary (for example a
retained one) changes on its own, the state is not reset by it, though its runs' transcripts are judged against its
own version.

## 6a-quinquies. Overrides carried by a job migration

When `instar jobs migrate` moves a jobs.json entry carrying `"instructions"` into the new job layout, it carries that
choice into `scheduler.instructionsOverrides` (an existing override for the same key wins and is left alone; and if the job's legacy `user:<slug>` override exists (under its ORIGINAL slug, also when the migration renames the job),
that override, which beat the field before the move, is what gets carried, so an explicit `full` is never lost to a
field of `job-mode`; a valid legacy override is carried even when the job has no field, and an invalid one, which
resolved to full, carries `full`: the moved job resolves as before, UNLESS an override already exists under its new
key, which wins because someone set it for that key deliberately; if that override differs from what the job resolved to
before, the job's mode changes, as that override intends), recording
each override it creates in `jobs/.instructions-overrides-created.json` BEFORE writing the config, so an abandoned
migration can always find and remove what it added, even if the process stops between the two writes. Abandon removes
only overrides whose value still matches what it recorded. If abandon cannot read `config.json`, it removes nothing and keeps the journal (with a
warning), so a later abandon still finds and removes the override. If `config.json` is missing or unreadable, the carry is skipped with a warning and
the migration continues; the job then resolves from any existing override or the defaults, which today means full
instructions (no job is on the reviewed list), the conservative outcome. If `config.json` is readable but writing the carried override fails, the failure is
caught with a warning and the migration continues (the new job layout is kept); the job then resolves from defaults,
again full instructions, and the journal entry just added for the unwritten override is taken back out, so a
later abandon cannot delete a same-valued override someone sets by hand (if that journal rewrite also fails, the stale
entry remains, and such a hand-set override matching it exactly could be removed by an abandon). The same residual applies to a crash between the journal write and
the config write (the journal is written first on purpose, so a carried override can always be undone): the stale entry
stays, and if someone later sets exactly that key to exactly that value by hand, an abandon of this migration removes
it. The trade is deliberate: an override that cannot be undone is worse than this narrow, visible case. If the journal write itself fails, the override is not carried at all
(abandon could not undo it), with a warning, and the migration continues; the job resolves from defaults.

## 6a-sexies. Every behaviour rule the short text states (complete list)

The job-mode text replaces the full instructions with a short, fixed set of rules (`generateJobModeText`). In place of the
agent home's instruction files, a job sees these rules; instructions outside the three excluded agent-home files
(for example an account-level CLAUDE.md, see 6b) still load as before, and the job may read more on demand. Files that reach a session ONLY through an `@` import inside
one of the excluded files (an imported reference or notes file) are not loaded either, since the importing file is not;
the transcript check does not flag this, and the paired replay covers it like the other differences. Each can change what an opted-in job does compared with a launch under
the full instructions, and none of these changes is detected by the transcript check (it proves what loaded, not how
the job behaved):

1. Do the job prompt's task and finish; the full instruction files and memory index are not loaded but may be read on
   demand (CLAUDE.md, `.instar/reference/INDEX.md`).
2. Use `$INSTAR_SERVER_URL` with the bearer token; look state up through the server before claiming it.
3. Record anything durable through the server; auto-memory is off (see 6a-septies).
4. No interactive commands (shared clause, same source as CLAUDE.md).
5. Cite only from real tool output (shared clause).
6. Report Instar bugs or missing features through `POST /feedback`, never GitHub issues: a job that previously filed
   elsewhere would now route reports to the feedback API.
7. Never force-push; no destructive git or file-deletion commands beyond what the job prompt asks; never print a
   secret value. A maintenance job whose prompt is vague about a deletion or cleanup step may skip it.
8. Message the person only if the job prompt says to, through the relay script it names, in plain complete sentences
   with no commands (shared clauses), and with technical detail (commands, file paths, ids) only when the person asked
   for it. A job whose prompt is silent about messaging, and which sent updates under the
   full instructions, may stop sending them.

Everything else in the full instructions (proactive feature triggers, registry tables, detailed anti-patterns,
multi-machine guidance) is absent unless read on demand. These differences are exactly what the paired replay, required
before any job is switched over, compares by outcome, and what each job's review checks before it joins the reviewed
list. Full-instruction launches are unchanged.

## 6a-septies. Auto-memory is off for job-mode sessions

Job-mode launches pass `autoMemoryEnabled: false`, so a job-mode session neither reads the Claude Code auto-memory
index nor writes new auto-memory entries, and the short text directs jobs to keep anything durable through the agent
server (memory, notes, commitments). A job that relied on auto-memory to carry information from one run to the next
loses that continuity in job mode, even when its transcript check passes (the check proves what loaded, not what the
job remembered). This is another outcome difference the paired replay must compare before a job is switched over, and
a review item for each job before it joins the reviewed list. Full-instruction launches are unchanged.

## 6a-octies. Only a real model reply closes the check window

The job check and the positive control read only up to the first model reply. That reply must be real
(`isRealModelReply`): an assistant record with a model name other than Claude Code's `<synthetic>` placeholder, no API
error flag, and token usage. A placeholder or error record as the first assistant record makes the job verdict unknown
(or fail, if an excluded file was already listed), and makes a probe an error. Verified live on Claude Code 2.1.330
(2026-11-22): the real probe still reports visible under this rule.

## 6a-nonies. What agents are told

The awareness entry (`src/data/awareness/job-mode-instructions.md`) tells agents to compare a job both ways (a paired
replay with full and job-mode instructions, outcomes matching) before opting it in, and names the auto-memory and
messaging differences, so the guidance agents follow matches the process obligation in 7b. The launch code still does
not enforce the replay; an override set without one takes effect on the next eligible launch when the gate is on.

## 6a-decies. A version change starts a new check generation

Each change of the instar and Claude Code version pair advances the job's check generation, so a verdict that arrives
late from a run launched under an earlier stint of the same pair (A, then B, then back to A) is discarded rather than
applied to the fresh state.

## 6a-undecies. An unreadable version is not a version change

If the Claude Code version cannot be read at launch (the probe returns unknown), the job launches with full
instructions and its check state is not touched: an unreadable version never counts as a version change, so a transient
probe failure cannot clear an exhausted-unknown fallback or reserve a recovery probe after a failed check.

## 6a-duodecies. Recovery can end early (conservative direction)

During recovery after a failed check, unknown verdicts from runs still in flight (an earlier probe, or ordinary runs
under another account, lane or launched version) are counted alongside the current probe's when deciding whether to
reserve another probe. Recovery can therefore stop before the current account, lane and version bucket has had three
probes or three unknowns of its own, and the job stays on full instructions. This only ever errs toward full
instructions; it never lets job mode through without a pass. A version change starts recovery again. An operator clear
is different by design: it lifts the fallback at once (an explicit person's decision, `DELETE /jobs/<slug>/job-mode-check`),
so the next eligible launches use job mode with checks, and runs that overlap before the first verdict arrives also
load the short instructions.

## 6a-terdecies. A rejected job-mode spawn counts as unknown

If `spawnSession` rejects a job-mode launch, the run is recorded as an unknown verdict (bucket `spawn-rejected`), not
discarded. Repeated rejections, which could be caused by the job-mode flags themselves, reach the unknown limit and the
job falls back to full instructions instead of retrying the same flags forever. A rejected recovery probe uses up that
attempt rather than being refunded. Any rejection of a launch the scheduler prepared for job mode counts, including an
unrelated failure (for example tmux unavailable) and a restricted or non-Claude spawn that would have skipped the
flags anyway (the scheduler prepares the check before `SessionManager` decides whether the flags apply); three such
rejections move the job to full instructions, and a rejected recovery attempt is used up. The same handler also catches an exception thrown by the scheduler's own bookkeeping
after a session has started; that run is then recorded as `spawn-rejected` (unknown) and its transcript is not checked,
even though it ran. Its verdict is never a pass, so this too errs toward full instructions only. How the count works: for ordinary launches, `spawn-rejected` is its own bucket and the
fallback limit applies to the LARGEST single bucket (`unknownAttempts`), so mixed failures (for example two unknown
transcript checks under one account plus one rejected spawn) do not yet trigger fallback; three rejections, or three
unknowns in one bucket, do. For a job already suppressed after a failed check, the SUM across buckets decides whether
another recovery probe is offered (6a-duodecies), so there a rejection does count with the others; that is the
conservative direction.

A verified pass clears the `spawn-rejected` count (launches are evidently going through), so occasional rejections
spread across successful, verified runs do not accumulate into a fallback.

## 6a-quattuordecies. A fail removes that combination's pass

A failed check suppresses the job and also removes the failing account, lane and launched-version combination from
the recorded passes, so that combination is checked again if recovery ever reaches it rather than keeping its earlier
pass.

## 6a-quindecies. Symlink aliases still match

The excluded-file match compares both the lexical path and, when the file exists, its real path (symlinks resolved)
on both sides, so an excluded file listed under a symlink alias of the agent home still fails the check. A path that
does not exist at check time is compared lexically only.

## 6b. What job mode excludes, exactly

Job mode excludes exactly three project instruction files in the agent home (`CLAUDE.md`, `AGENTS.md`,
`.claude/CLAUDE.md`) and turns off the auto-memory index; it appends the short job-mode text. Other instruction sources
still load as before (for example a user-level `CLAUDE.md` in the account's config home, or instruction files of
another directory the session reads). A passing transcript check confirms those targeted exclusions and the marker,
not that nothing else loaded. The check matches conservatively: any load record for a path ending in
`memory/MEMORY.md` is treated as an auto-memory index (the index can live under any config home), so an unrelated file
with that name, loaded before the first reply, also fails the check and returns the job to full instructions (a false
fail costs tokens, never coherence). Measured on Echo, the three files and the memory index were the bulk of a job's first
turn (about 50 thousand of about 80 thousand tokens).

## 6c. Pinned session ids

A spawn that pins or resumes a session id (`sessionId`, `resumeSessionId`) skips job mode on every launch path, headless
and rerouted interactive alike, and records `applied: false` with reason `session-id-pinned`: job mode would add its own
`--session-id`.

## 7a. Claude Code only

Job mode's launch flags exist for Claude Code only. A non-Claude job (Codex, for example) that is opted in still
resolves to `job-mode` as its configured mode in the scheduler and in `GET /jobs/:slug/job-mode`, but spawns with its
usual instructions: the shared flag helper returns no flags for other frameworks, and the session records
`applied: false` with reason `not-claude-code`, so no transcript check runs for it. The status route
(`GET /jobs/:slug/job-mode`) reports `configured` (the job's own setting, read regardless of the rollout gate), an `effective` prediction for the next launch with its reason
(`script-runner-no-session` for jobs that run as scripts and start no Claude session, `configured-full`, `gate-off`, `suppressed-…`, `unknown-after-retries`, or `claude-code-launches-only`, since the
framework is chosen at spawn; a fallback reason holds for the `asOfVersionPair` it was recorded under, and after an
instar or Claude Code update the next launch is re-decided, a suppressed job getting a job-mode recovery probe (re-reserved after an unknown result, at most three probe launches per version pair in total across all accounts), which the
field `afterUpdate` says in words), and `lastRun`: what the most recently COMPLETED job-mode launch actually did (written at completion, so with overlapping runs it reflects the last to finish, not the last to start), including
`not-claude-code` when a non-Claude launch skipped the flags.

Probe-state semantics, for reading the status route: one function, `recoveryProbeAvailable`, decides both whether a
suppressed job's next launch is a recovery probe and what the status route predicts. It is true when a probe is
reserved (`probeReserved`) or the last probe has had no verdict for more than 6 hours (`probeStartedAt`; for example
lost in a scheduler restart, since the probe id lives in memory), and fewer than three probe launches have happened for
the current version pair (`probeLaunches`). Then the status reports `effective: job-mode, probe-on-next-launch`;
otherwise `effective: full`. Three is a ceiling, not a promise: a probe whose check passes
lifts the fallback; a probe whose check fails ends recovery for that version pair at once; only the current probe's unknown verdict, a
stale probe, or a released one (restricted spawn or non-Claude run; refunded; a rejected spawn is not refunded, see 6a-terdecies) is offered again; every other probe launch counts toward the three. One exception, intended: if the last probe allowed was launched and its verdict arrives late (after recovery
stopped offering probes), a PASS from it is still accepted and lifts the fallback, because it is a real verified
job-mode run of the current generation; late verdicts of the other kinds are applied as
usual, in the conservative direction: a late fail from any run of the current generation (even a superseded probe)
suppresses the job again, and a late unknown revokes that account, lane and version's pass and counts toward its
unknown limit. Otherwise, once recovery ends, the job stays on full instructions until an
instar or Claude Code update or an operator clear. One more path, stated: if a job's check-state file is missing, unreadable, or fails its field-by-field shape check,
it is treated as fresh, so the next eligible launch is job mode WITH a check; a job that still loads an excluded file
fails that check and falls back again after that one run. If the check state cannot be WRITTEN (an unwritable state directory), the launch
decision itself fails, the scheduler reports the degradation once, and the job spawns with its full instructions:
job mode never runs unrecorded. An error anywhere in the post-run check (finding or reading the transcript, or the
positive control's probes) is recorded as an unknown verdict, so repeated errors still reach the
unknown limit; only a failure to write the check state itself leaves no record (logged). Two timing qualifications, stated: the check runs after the run completes and is not
awaited, so a launch of the same job that starts before the verdict is recorded can still use job mode; and the
check's context lives in memory, so a scheduler restart during a run records no verdict for that run: for a key not yet
passed the next job-mode run is checked; for a key that already passed, checking continues on the normal sample
cadence (the lost run does not count toward it). Deliberately asymmetric: a failed check from any run of the current generation and
version pair, including a superseded probe or an ordinary run that reports late, returns the job to full
instructions even after a newer pass, because a failure is direct evidence that a job-mode session loaded an excluded
file; only a pass is restricted to the current recovery probe.

Metadata kept and shown: each session record's `jobMode` entry stores whether job mode applied (or why not), the marker
version, the text's byte length, the Claude session id, the config-home path, the launch path and the project folder
the exclusions were built from (the post-run check uses that same folder for its transcript lookup and path matching), never the text itself (Claude Code's own transcript of the session does contain it, as above). The per-job
check files under `.instar/state/job-mode-checks/` and the bearer-authenticated `GET /jobs/:slug/job-mode` response
include the check state, which names config-home directory paths (`passedConfigHomes`, `unknownByHome`); these are
local account-folder paths, not credentials, and the route is visible only to holders of the agent's bearer token.

## 7b. Constitution fit (added 2026-11-21)

The operator approved "A Smaller Context Never Costs Coherence" today. At merge no job runs in job mode unless someone
switches it over: the reviewed list is empty, no override exists, and no `jobs.json` entry carries
`"instructions": "job-mode"` (the field is new in this change). Any of those three, with the rollout gate on (live on
a development agent, dark on the fleet), changes what an eligible Claude Code job loads at its next spawn. The
article's evidence requirement (a paired replay, full versus job mode, outcomes graded blind, all tokens counted) is a
process obligation tracked on the context budget project's card, not a check in the launch code; on Echo no job will
be switched over before that replay is done. Exhausted
unknown transcript checks return a job to full instructions (fixed today: unmeasurable counts as failure).

## 7c. Positive control per account (added 2026-11-21, from the second-pass review)

The positive control (proof that transcripts reveal what loaded) runs per Claude config home and keeps ONLY the latest
result for each home (tagged with its Claude Code version); a result for a different version counts as no result, so
a caller on one version never receives a control still running for another (it waits, then decides for its own
version), and switching versions back and forth (A, then B, then A again) re-runs the three probes on each switch even within the
7-day window or 6-hour error backoff, and a job's check uses the control for the home its session ran under. A control
result from one account never validates a job that ran under another. The transcript itself is looked up only under the config home the session recorded (no fallback to other
accounts), so a pass is credited only to the account that produced it. A probe whose transcript is missing or never
reached a model reply is an error (not proof that exclusions worked), and an error control result turns a job check that
would have passed on that account into unknown. A check that fails (an excluded file listed, or a snapshot without
the marker) is still a fail and returns the job to full instructions at once: the control is consulted only to
confirm a pass, never to soften a failure. The control reads each probe transcript only up to its first model reply, the same window the job check reads, so a
visible result shows that instruction loads are recorded before the reply. A control result validates a job's pass only if its Claude Code version equals the version of the binary that job
ACTUALLY launched (probed from the launched executable right after spawn, as the run history already does; the control
runs the configured binary, so a different launched version, or a launch version not yet probed, makes the verdict
unknown). The control re-reads the Claude Code version after its three probes and records an error if it changed, so a
result is never labelled with a version its probes did not all run on. The comparison is strict (an update during the run makes the verdict unknown), and an unreadable Claude Code version on either side
makes it unknown too. Probes run once per Claude Code version per account and are re-run when that result is older than 7 days
(`CONTROL_RESULT_MAX_AGE_MS`) at the next check that needs them (the expiry schedules nothing by itself; the refresh
happens when a checked transcript would otherwise pass, so for a rarely run job it can be weeks later); an error result is retried at
most every 6 hours (three small Haiku calls per attempt; the result is also held in memory, so the back-off holds even
if its cache file cannot be written; a computed result that cannot be cached still counts, visible or not). The probes deliberately run under the account's real
settings (its `CLAUDE_CONFIG_DIR` and inherited environment), because what they validate is how that account's
transcripts record instruction loading; account-level hooks configured there run for the probe as for any session,
inside a temporary working directory that holds only the sentinel files. Outside that directory the probes write into the account's own config home: a project
folder named after the temporary path (unique per run) under `CLAUDE_CONFIG_DIR/projects/`, holding a sentinel
`memory/MEMORY.md` and the three probe transcripts. Both the temporary directory and that project folder are removed
after the probes (through SafeFsExecutor, best effort); an interrupted run or a failed cleanup can leave that folder
behind. That folder holds only the sentinel text and the three probe transcripts, under a path no real project uses. The
probes run with no tools (`--tools ''`) and one model turn, but under the account's real settings and the server's
environment, so the account's own hooks (session start, stop, and any others it configures) and enabled integrations
run for each probe as they would for any session, and can do work outside the folders the cleanup removes. The job's own pass is per account, launch path (headless or rerouted interactive; the session record carries `lane`) AND launched Claude Code version, so a headless pass never vouches for a rerouted interactive run, nor a pass on one binary version for a run on another: the check state
records the config homes the job has passed under for the current version pair, and a run under a config home not in
that list is checked even though the version pair is unchanged (a version change or an operator clear empties the
list). Unknown results are counted per account, launch path and launched Claude Code version, so a pass for one never resets
another's count; any one reaching the limit returns the job to full instructions. Deliberately shared
and conservative: suppression after a failed check, or after exhausted unknowns, under any account sends the job's
launches under every account back to full instructions on this machine until a probe passes. Only the reserved recovery probe's pass lifts a fallback
(each probe launch carries an id); a pass from an ordinary run that was already in flight when the job fell back is
recorded for its account but does not restore job-mode. Exhausted unknowns are lifted only by a version change or an
operator clear. A recovery probe whose check is unknown is re-reserved, so after an update a suppressed job can have at most three job-mode probe launches per version pair in total across all accounts. A recovery probe whose session started but skipped the job-mode flags (a restricted or
non-Claude spawn) is given back with its attempt refunded when that run completes (it did not run in job mode, so it
does not count; the skip is known only from the session record). A probe whose spawn was REJECTED is not refunded: it
counts as an unknown verdict and uses up that attempt, so three rejected recovery launches end recovery and leave the
job on full instructions (6a-terdecies); until then, other launches of the job use full instructions, and the launch after the refund probes again. Residual case: a skipped probe launch that outlives the 6-hour stale window is replaced by a new probe, and its late refund no longer applies (only the current probe is refunded), so it stays counted.

## 8. Rollback cost

To roll back one job, set its override to `"full"` (this survives updates), or turn off `scheduler.jobModeInstructions`. Reverting the PR leaves only inert data: the config key and any jobs.json fields (old readers ignore both) and the check-state folder. No data migration is needed.

## Conclusion

The change is safe to ship behind the dev-agent gate. It reduces tokens only where explicitly opted in, verifies the result on real transcripts, and falls back to today's launch on a failed check, and after three unmeasurable checks for any one account, launch path (headless or rerouted interactive) and launched Claude Code version (an unreadable version is its own bucket) for the current version pair (one or two unknown results keep job mode while the check is retried).

## Second-pass review (if required)

(appended below)

## Evidence pointers

Spec `docs/specs/job-mode-instructions.md` and its convergence report. Tests: `tests/unit/job-mode-instructions.test.ts`, `tests/unit/session-manager-job-mode-launch.test.ts`, `tests/unit/scheduler/job-mode-scheduler.test.ts`, `tests/integration/job-mode-routes.test.ts`, `tests/e2e/job-mode-instructions-lifecycle.test.ts`. Neighbouring suites green: claude-headless-extra-flags, confined and triage spawn, job-mcp-access, CLAUDE.md layout and template tests (121 tests).

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect is fixed. The one self-triggered spawn (the positive-control probes) is registered and ratcheted; see the Class-Closure Declaration below. The post-run check fires no restart, notify or retry of the job. It changes which flags the job's next launch carries, mostly in the conservative direction (a passing recovery probe is the one way back to job mode). Its only spawns are the positive control's probes: up to three small `claude -p` processes, once per Claude Code version and account (error results retried at most every 6 hours), run when a transcript would pass and the control has no current result; they make small model calls and run the account's own hooks, as described in sections 6 and 7c. Not applicable.

## Second-pass review (independent, Codex, 2026-11-22)

Concur with the review.

"Both Claude Code launch lanes get the same exclusion settings, appended prompt, and generated session ID. Restricted,
pinned, and non-Claude launches skip those flags. The transcript check runs after completion, so fallback affects later
launches. The artifact accounts for sampling, overlapping runs, and the limits of the headless positive control."

Reached after many rounds; every concern raised along the way was either fixed in code (with a test) or disclosed above.
The positive control was re-run live against the real Claude Code 2.1.330 binary after each change to it: visible.

## Framework generality

Job mode is a Claude Code optimization delivered through the framework abstraction, not a Claude-only assumption baked
into the scheduler. The scheduler decides only whether a job WANTS job mode; whether it applies is decided at launch
in `SessionManager` per framework. Claude Code launches (headless and rerouted-interactive lanes) get the exclusion
settings, the appended job-mode text and a pinned session id (`claudeHeadlessExtraFlags` in
`frameworkSessionLaunch.ts`). Codex CLI and Gemini CLI launches get no job-mode flags at all and record
`applied: false, reason: not-claude-code` (tested in `session-manager-job-mode-launch.test.ts`), so they launch exactly
as today with their own instruction files; their transcripts are not checked and their verdicts never touch the check
state. The status route counts any non-Claude or script-runner job as effectively full. A future framework gets the
same default (no flags, full instructions) until it adds its own equivalent of instruction exclusion and a transcript
signal to verify it; the shared rules in the short text are rendered from the same source as the agent's CLAUDE.md, so
a framework-specific job-mode text could reuse them. Codex and Gemini do not yet gain the token saving; that is a
framework-optimizing opportunity, not a correctness gap.

## Class-Closure Declaration (display-only mirror)

- defectClass: `unbounded-self-action`; closure: `guard`; enforcement: `ratchet`; citation:
  `tests/unit/self-action-convergence.test.ts` (controller `job-mode-positive-control`).
- How it converges: the only self-triggered spawns are the positive control's probes, paced by `controlRerunDue` over
  a persisted record: one three-probe attempt per Claude Code version and account, an error retried at most every
  6 hours (the registered rate floor), a success reused for 7 days. The scheduler's fallback paths only change the
  flags a job's next launch carries; they never restart, notify or retry a job.
