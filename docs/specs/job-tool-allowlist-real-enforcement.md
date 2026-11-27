---
title: "Job tool allowlists really restrict — confine declared and clamped Claude jobs, say plainly when a list is not enforced"
slug: job-tool-allowlist-real-enforcement
author: "echo"
parent-principle: "Verify the State, Not Its Symbol"
sibling-principles: "A safety control that logs enforcement while enforcing nothing is worse than an absent one (EVO-008); Verify at the Consumer, Not the Producer; Structure > Willpower; Maturation Path (live on development agents, dark on the fleet); Updates never restrict existing agents without opt-in; Testing Integrity (both sides of the boundary)"
eli16-overview: job-tool-allowlist-real-enforcement.eli16.md
source-proposal: "EVO-008 (approved 2026-08-23); owner commitment CMT-1124"
status: approved
approved: true
approved-basis: "Operator ruling 2026-10-22: only constitution changes need the operator (cited in the CMT-1124 build brief); this spec changes no constitution file. EVO-008 itself was approved 2026-08-23."
review-convergence: "2026-11-10T09:43:34.209Z"
review-iterations: 6
review-completed-at: "2026-11-10T09:43:34.209Z"
review-report: "docs/specs/reports/job-tool-allowlist-real-enforcement-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 11
cheap-to-change-tags: 1
contested-then-cleared: 9
---

# Job tool allowlists really restrict

## Problem statement

A scheduled agentmd job can carry a `toolAllowlist` (for example `["Bash"]`), or the
scheduler can clamp it to `["Read"]` (a `"*"` request without manifest
`unrestrictedTools: true`, or an `origin: instar` job whose lock-file trust is in a real
tamper state). The scheduler passes the list to `SessionManager.spawnSession` as
`allowedTools`. The headless and rerouted Claude launch argv both carry
`--dangerously-skip-permissions`, which bypasses the permission system `--allowedTools`
feeds. **The list is recorded and inert.**

Verified at the consumer on 2026-11-10 with the installed Claude Code 2.1.322 on the
Studio (Haiku):

| argv form | cwd | result |
|---|---|---|
| `--dangerously-skip-permissions --allowedTools Read -p …` (today's job path) | scratch dir | Bash ran and wrote its file — the clamp is inert |
| `--allowedTools Read --strict-mcp-config --mcp-config {"mcpServers":{}} --permission-mode dontAsk --tools Read --no-chrome -p …` (the triage confinement form) | scratch dir | Read returned the file; Bash unavailable; no file written |
| same form, `Bash` as the only tool, also asked to use Write | scratch dir | Bash ran; "Write tool is disabled"; no Write file |
| Read-only form, asked to use Bash, Task/Agent and Write | **Echo's agent home**, with its real `.claude/settings.json` (broad `permissions.allow`, a catch-all PermissionRequest auto-approve hook, project MCP servers) | Read worked; Bash "disabled … including for subagents"; no Task/Agent tool; no Write tool; reported tool list: `Read`; no file written |

The last row matters: `--tools` removes tools from the session entirely, so project allow
rules and an auto-approve hook have nothing to approve.

Meanwhile `emitAllowlistSignals` writes a `job_allowlist_clamped` event saying the job
was "clamped to [Read]" and a degradation entry whose impact says "Job will run with
Read-only tools" — both false. The run ledger records `toolAllowlist: ["Read"]` for
hundreds of runs that used shell freely.

The building block exists on main: `applyClaudeToolConfinement(argv, tools)`
(`src/core/SessionManager.ts`) removes the bypass flag, adds
`--permission-mode dontAsk --tools <list> --no-chrome`, and throws if the form did not
apply; `spawnSession({ confinedTools })` also forces `allowedTools = confinedTools` and
`disableProjectMcp` (strict, empty MCP config) on both the headless and the rerouted
interactive Claude lanes. Today only triage sessions use it.

### Three facts that shape the design

1. **Most `["Read"]` lists on the fleet were not written by the job's author.**
   `jobMigrate.writeUserTemplate` (`src/commands/jobMigrate.ts:139`) writes
   `toolAllowlist: ['Read']` into every user job it migrates from `jobs.json`, which the
   resolver classifies as `kind: 'array'` — the same kind as an author-declared list. And
   every user job with no list resolves to `kind: 'default-user'` → `['Read']`. On Echo
   the 637 recent `["Read"]` rows are all `default-user` (bugs-overseer, topic-issues, …,
   bodies full of `curl`, `gh`, `tmux`); only 2 of Echo's 22 user job files carry a list,
   and neither is `["Read"]`. Elsewhere the migrated lists exist and cannot be told apart
   from authored ones by the file alone.
2. **The six builtins EVO-008 named as clamped no longer clamp.** Their shipped
   templates and Echo's installed manifests all carry `toolAllowlist: "*"` +
   `unrestrictedTools: true` (`kind: 'unrestricted'`), and the last 30 MB of Echo's run
   ledger holds zero `clampedAllowlist: true` rows. `health-check` is `runner: script`.
   Nothing in this change restricts them; a template test pins that (§Tests).
3. **A tampered builtin can step around today's tamper clamp.** `resolveAllowlist`
   returns `kind: 'array'` for any declared list *before* it consults lock-file trust; the
   tamper check runs only on the `"*"` and no-list branches. An `origin: instar` job in
   `untrusted-not-in-lockfile` or `untrusted-bad-signature` (which the loader still loads)
   keeps its own list.

### Threat model, stated plainly

The tool list limits which of Claude's built-in tools a job session is offered. It
defends against an accidental `"*"`, a misbehaving or prompt-injected job body, and
in-place tampering of an instar job's body or manifest that keeps it an instar job (the
lock-file clamp). It does not defend against someone who can write the jobs folder: they
can add a user job, or rewrite an existing job's `origin` to `user` or its runner, which
the lock file never checks — the same reach as adding a job. It is **not** an OS sandbox: a list that
includes `Bash` gives the job a shell, which can write files, call the agent's own API
with the session's token, or start another `claude` process. `Read` has no path scope.
The record and the wording say so (§5, §6). The `unrestrictedTools` manifest flag is a
plain boolean the agent itself can write; the out-of-band confirmation that
INSTAR-JOBS-AS-AGENTMD §Trust Model describes for widening was never built. This spec
does not build it; its wording tells an agent to ask the job's owner (the operator for an
instar job) before widening rather than to flip the flag itself.

## Proposed design

### 1. Tamper is checked first (`resolveAllowlist`)

For an `origin: instar` job whose `lockTrust` is a real tamper state
(`isLockUntrustedTamper`), `resolveAllowlist` returns `kind: 'lock-untrusted-clamped'`,
`["Read"]`, **whatever the frontmatter declares** — array, `"*"` or absent. User jobs are
unchanged (the gate is instar-scoped, as today). With the switch off this changes only
the recorded list and event for such a job; with it on, the job is confined (§2) or
refused (§4).

A whole-lock-file fault (malformed, or a signature that cannot be verified) marks every
`origin: instar` entry `untrusted-bad-signature` (`AgentMdJobLoader`). With the switch on,
every session-run builtin then runs Read-only (and is refused on a non-Claude lane);
script-runner builtins are unchanged by this spec (they open no session). That is the
lock file's designed fail-closed answer, not a side effect: the loader already raises a
`lock-mismatch` problem on the dashboard Issues card for it, the run records say
`confined` with kind `lock-untrusted-clamped`, and the switch reverses it at the next
spawn. Echo's builtins are in the transitional `untrusted-no-lockfile` state today (171
of 171 recent script rows), which is not a tamper state.

### 2. One enforcement decision per spawn (`JobScheduler.resolveToolEnforcement`)

A pure static helper next to `resolveAllowlist`, returning
`{ confinedTools?, requireConfinement, refuse?, reason }`. Inputs: the resolution kind
(tamper is already resolved first, §1), the job's origin, its enrolment (§2a), the switch
(`on` = resolved value, `explicitOff` = the key is literally `false`, or `unreadable`), and
the names. The rules apply **in this order; the first that matches decides**:

| # | condition | decision |
|---|---|---|
| 1 | kind is `unrestricted`, `instar-no-allowlist` or `legacy` | not applied, `not-applicable` |
| 2 | kind is `default-user` (no list declared) | not applied, `no-declared-allowlist` |
| 3 | `array`, not enrolled, `origin: user`, names (trimmed, de-duplicated) exactly `["Read"]` | not applied, `read-only-default` |
| 4 | switch explicitly `false` (the rollback) | not applied, `gate-off` — for every kind, enrolled included |
| 5 | not enrolled and switch `unreadable` | not applied, `config-unreadable` |
| 6 | not enrolled and switch resolves off | not applied, `gate-off` |
| 7 | a name outside the confinable set, or an empty list — enrolled | **refuse** the launch (decision `unsupported-tool-names` + `refuse`; the run row reads `confine-refused`) |
| 8 | a name outside the confinable set, or an empty list — not enrolled | not applied, `unsupported-tool-names` |
| 9 | otherwise — `array` | **confine** to the list; **required** if enrolled |
| 10 | otherwise — `clamped` (`"*"` without authorization) | **confine** to `["Read"]` |
| 11 | otherwise — `lock-untrusted-clamped` (tamper) | **confine** to `["Read"]`, **required** |

"Required" means the decision's `requireConfinement` is passed to the launch as
`requireToolConfinement`, so a non-Claude lane refuses before starting (§4) — for an
enrolled job and for the tamper kind alike, on the scheduled path and the rollback path
(both go through `spawnJobSession`). Rules 4–6 make the tamper kind follow the switch: with
the switch off it is recorded and reported (§7), not applied.

A user job's `["Read"]` is not applied because it cannot be told apart from the value
`jobMigrate` wrote into every migrated job and the value the resolver gives a job with
no list; neither was an author's choice, and confining them would cut migrated jobs that
use the shell to Read on any development agent. It is recorded as `read-only-default`.
An author who wants a user job truly limited to reading enrols it (§2a); a list other
than the bare default (for example `["Read", "Grep"]`) is also confined like any other.

A declared array wins over the manifest's `unrestrictedTools` (as the resolver does
today): the flag only authorizes `"*"`.

### 2a. The author's explicit enrolment: `toolAllowlistEnforce: true`

A job author can enrol a declared list with frontmatter `toolAllowlistEnforce: true`
(a new key on the loader's closed frontmatter set). The loader accepts it only as a
boolean and, when `true`, only beside a `toolAllowlist` **array**; enrolment with no list
or with `"*"` is a frontmatter problem and the job is withheld (reported on the dashboard
Issues card like any malformed job), because there would be nothing exact to apply.
Enrolment on a `runner: script` job is refused the same way: a script opens no model
session, so an enrolled list would be accepted and never applied on its normal path. An enrolled
job's list is applied **exactly and fail-closed**:

- its list is applied even when it is a user job's bare `["Read"]` (the enrolment is the
  provenance the file otherwise lacks);
- it is applied whatever the switch's default — the author's opt-in is the consent the
  fleet default lacks — and only an explicit `jobs.toolAllowlistEnforcement.enabled:
  false` (the rollback) turns it off; a missing or unreadable config does not;
- a name the launch cannot honour **refuses** the launch (`confine-refused`, a
  `job_tool_allowlist_refused` event) instead of running unapplied, so a typo can never
  widen an enrolled job to full tools;
- a non-Claude lane refuses it before launch (`requireToolConfinement`), like the tamper
  kind.

An instar build older than this one withholds the whole job carrying the new key (the
loader's closed-set rule withholds a job with an unknown key), so on an agent whose machines run mixed versions an
enrolled job does not run on the older machine; that is fail-closed for the enrolled
policy, the loader reports the withheld job, and if that machine holds the scheduling
lease the gap shows in `GET /jobs?scope=pool` → `pool.coverage`. An enrolled job refused on
every run (a typo) fails each run visibly; the existing crash-loop pauser may pause it,
which is the intended way a broken enrolled policy surfaces.

Before confining, names are trimmed, de-duplicated and checked, **case-sensitively,
against the tool names the installed CLI actually honours under `--tools`**, measured on
2026-11-10 from the CLI's own start record (`--output-format stream-json`, the `init`
event's `tools`) on Claude Code 2.1.322: `Read`, `Write`, `Edit`, `NotebookEdit`,
`Glob`, `Grep`, `Bash`, `WebFetch`, `WebSearch`, `Skill`, `Task`, `Agent` (honoured as
`Task`), `TaskStop`. Names the same CLI silently drops — `LS`, `MultiEdit`,
`SlashCommand`, `BashOutput`, `TodoWrite` — and every other name are refused. The shape
check alone is not enough: given `--tools Bassh` the CLI starts with **no tools at all**
and exits 0, so a typo would yield a job that can do nothing and reports success.
`mcp__…` names are refused too (the form loads no MCP servers). `Task`/`Agent` are kept
because delegation inherits the limit — measured 2026-11-10: a session confined to
`Read,Task` started a subagent that reported only Read and Agent, and its Bash and Write
steps created no files. The opt-in live test reads the same `init` record on each
machine's installed CLI and asserts the session's tools equal the requested list after
canonicalizing the known alias (`Agent` → `Task`), so a CLI that renames or drops a tool
is caught on that machine. A list that fails is **not confined** and reports `unsupported-tool-names`
(naming the entries) — for an **unenrolled** job the job runs exactly as today and the
record and event say the list was not applied and the job had its framework's normal
tools (an enrolled job is refused instead, rule 7). This never weakens `applyClaudeToolConfinement`'s own validation, which
still throws on any bad name it is handed. (The tamper kind always confines to `["Read"]`,
so it never takes this branch.)

The gate is `jobs.toolAllowlistEnforcement.enabled`, read live at every spawn through
the scheduler's existing config read (`readAgentConfig`, mtime-cached), resolved with
`resolveDevAgentGate` (omitted ⇒ live on a development agent, dark on the fleet). An
explicit `false` turns it off on a development agent; an explicit `true` turns it on for
a fleet agent. If the config is missing or cannot be parsed, the gate resolves off (today's behaviour,
fail-open toward running the job) and the reason is `config-unreadable`, not `gate-off`.

### 3. Spawn wiring

`spawnJobSession` passes `confinedTools` (and `requireToolConfinement: true` when the
decision says required — an enrolled job or the tamper kind) to `spawnSession` when the
decision says confine; when it says refuse, no launch is attempted and the spawn-error
path records `confine-refused`. `allowedTools` keeps
today's value (SessionManager overrides it with the confined list). `mcpAccess: 'none'`
is unchanged and compatible. The rollback path (`spawnProjectedSession` origin
`rollback`) goes through `spawnJobSession` and so gets the same decision; the triage path
is unchanged (it already confines).

### 3b. Text typed into a confined session never starts with a control character

On the rerouted interactive lane the job prompt is typed into Claude's input box. A
prompt whose first character is `!` runs a shell command there **even with only `Read`
allowed** — measured 2026-11-10: a Read-only, dontAsk interactive session given
`!touch <file>` created the file. A first `/` would run a slash command (project slash
commands can embed shell), a first `#` writes memory, and on the headless lane a first `-`
could be parsed as an option. Two guards close this:

1. **The spawn prompt.** Whenever `confinedTools` is requested, `spawnSession` puts one
   fixed neutral line, `Instructions follow.`, before the prompt (job, rollback and
   triage; on a Codex launch without the require flag the line is added too and is
   harmless). The first typed or passed character is therefore never a control character
   (with `ultracode` on, the word `ultracode` comes first, which is also plain text).
   Measured the same day: the same `!touch` text pasted after a plain first line was
   treated as message content and no file was created. Later lines cannot switch modes:
   a multi-line prompt goes in as one bracketed paste whose embedded paste markers are
   stripped.
2. **Every later write.** There are two text writers into a session. Inside
   SessionManager every write ends in `performTmuxInjectionEffect`; it looks up the
   target session and, when it carries `confinedTools` and the text's first non-blank
   character is `!`, `/` or `#`, puts the same lead line first. (Embedded paste markers
   are stripped earlier, in `rawInject`, which every multi-line SessionManager write
   passes through.) The second writer is the server's `tmuxOps.sendKeys` (session-to-
   session message delivery), which types text line by line with no paste wrapping, so
   a later line could still start with `!`: it is **refused** for a `confinedTools`
   session through `isConfinedWriteRefused`, the same public check it already calls for
   the older confined form. A confined job session therefore takes no slash command and
   no relayed message from Instar. The only Instar slash command sent to sessions today
   (`/compact`, context-wall recovery) targets topic-bound sessions, which a scheduled job
   session is not.
   If the session list cannot be read, the in-SessionManager guard leads the text anyway
   (harmless on an unconfined session), while the outside writer's check lets the write
   through, because refusing there would block message delivery to every session.

### 4. The consumer reports what it actually applied; tamper fails closed

`SessionManager.spawnSession`:

- sets `session.confinedTools` to the list **only** on a lane where
  `applyClaudeToolConfinement` returned, and only after the final argv is assembled — it
  re-asserts the **whole confinement contract on the final argv**: no
  `--dangerously-skip-permissions`; `--permission-mode dontAsk`; `--tools` equal to the
  list; `--allowedTools` equal to the list; `--no-chrome`; `--strict-mcp-config`; and
  exactly one `--mcp-config`, whose value is the empty server map. The Threadline
  `--mcp-config` splice runs after confinement today; a confined spawn is `stripped`, so
  it must not add one — and if it ever did, this check throws before the launch
  (`confined-tools-adapter-missing`) rather than recording a confined run;
- with `requireToolConfinement: true`, throws `confined-tools-unavailable:<framework>`
  **before launching** when the resolved headless framework is not `claude-code`. The
  scheduler's ordinary spawn-error path records the failed run; nothing runs unconfined.
- on any other framework without the require flag, ignores `confinedTools` as today and
  leaves the field unset.

If a session comes back on `claude-code` without `confinedTools`, that is a lane bug, not
a framework limit: the reason is `not-applied:claude-code` and it is reported as an
`error` (degradation + feature evidence), never as a framework limitation.

Under `dontAsk`, a hook that answers `ask` (for example the dangerous-command guard)
becomes a silent denial rather than a prompt; for the Bash-only builtins that run one
fixed command this does not arise, and the run record plus the session output show it if
it ever does.

`Session.confinedTools` is an optional field on the persisted session record; old records
read as unset.

The scheduler decides `toolsConfined` from the returned session — never from its own
request. A request the launch did not honour can never be recorded as confined.

### 5. Codex and other frameworks: an honest answer

Codex (and Gemini, Pi, Grok) have no per-tool switch the confinement form can map to.
`decideJobModelRoute` already refuses to route a non-`"*"` list to Codex
(`codex-tool-allowlist`), but a Codex-default agent still launches such a job on Codex.
For an unenrolled `array` and for `clamped`, the job runs and the record says `not-applied:<fw>`;
refusing would stop every allowlisted job on a Codex agent the moment the gate turns on,
an outage nobody opted into, while running and saying so is visible and reversible.
For an enrolled job and for the tamper kind the run is refused (§4): a possibly tampered instar job with full
tools is the harm the clamp exists to prevent, and its effects cannot be undone.

### 6. Run record

`JobRun` gains two optional fields written at `recordStart` on the job path:

- `toolsConfined: boolean` — true only when the returned session carries
  `confinedTools`. Meaning: *the confined launch form was applied to this run's argv on a
  Claude lane*. That the CLI then refuses unlisted tools is the CLI's behaviour, shown by
  the live proof above and re-checked by the opt-in live test on a machine's installed
  version.
- `toolEnforcement: string` — `confined`, `confined-with-shell` (the list includes
  `Bash`: Claude's other tools are refused but the job has a shell),
  `gate-off`, `config-unreadable`, `no-declared-allowlist`, `unsupported-tool-names`,
  `read-only-default`, `not-applied:<fw>`, `not-applicable`; on a spawn-error row
  `confine-refused` (tamper or enrolled job refused) or `confine-failed` (the launch's own
  confinement check threw).

`toolAllowlist` keeps its meaning (the list the resolver produced). A failed spawn's
row (the spawn-error path) carries `toolEnforcement` naming the decision
(`confine-refused` when a tamper or enrolled launch was refused) and no `toolsConfined`; its
error text names the confinement in plain words so triage and the failure alert do not
misread it. Script-runner runs are unchanged (`toolAllowlist: null`, no session). Old rows have
neither field and read as unknown, never as confined. `not-applicable` rows record
`toolsConfined: false`.

### 7. Wording is decided after the launch, and reported once

`emitAllowlistSignals` moves into the spawn's `.then(session)` and takes the final
outcome. Before the launch nothing is claimed.

- Clamped, confined: "Job "X" asked for all tools without authorization. This run had
  Read only; other tools were refused. To give it all tools, ask the job's owner to set
  unrestrictedTools: true in its manifest."
- Clamped, not confined: "Job "X" asked for all tools without authorization. Its tool
  list is recorded as [Read] but was NOT applied (<reason>): this run had its framework's
  normal tools."
- Tamper, confined: "Job "X" claims origin:instar but its lock-file trust is "<state>".
  This run had Read only." Tamper, refused: the spawn-error event names
  `confined-tools-unavailable`.
- Declared list not applied because of `unsupported-tool-names` or
  `not-applied:<fw>`: one `job_tool_allowlist_not_enforced` event naming the slug,
  reason and list, saying the list was not applied and the job had its framework's
  normal tools.


**Volume.** `DegradationReporter.report` does not deduplicate and files a feedback
item per call. So each `(slug, kind, reason)` is reported at most once per 24 hours: the scheduler
keeps the last report time per key in a small file under `state/`
(`job-tool-allowlist-reports.json`, read once at start, written on each report), so a
restart does not re-file, and a job alternating between two outcomes reports each at
most daily. The guarantee is: the first occurrence of each distinct outcome per window is
reported. The run record is the per-run truth.

What is reported, by kind:

- **Tamper (`lock-untrusted-clamped`)** — always, whatever the switch: event +
  degradation. With the switch off the wording says the list was NOT applied (switch
  off), so a tampered job on the fleet is never silent.
- **Clamped (`"*"` without authorization)** — always, whatever the switch: event +
  degradation, worded from the outcome (confined / not applied and why).
- **Declared list not applied for `unsupported-tool-names` or `not-applied:<fw>`
  (fw ≠ claude-code)** — event only, plus a `held` evidence row. A known framework or
  name limit is not a broken primary path, so it is not filed upstream as a bug
  (`DegradationReporter` files a feedback item per report, `internalOnly` or not).
- **`not-applied:claude-code`** (a lane bug) — event + degradation + `error` evidence.
- **`gate-off` for an `array` list, `config-unreadable`, `no-declared-allowlist`,
  `read-only-default`** — nothing per run; the run record carries it.
- Today's `instar-no-allowlist` degradation (a `not-applicable` kind) moves under the
  same once-per-24-hours rule; its wording is unchanged. The 24-hour repeat is a reminder cadence for an unchanged known state, not a
safety limit: a longer or shorter gap changes only how often the same fact is repeated.

### 7b. Maturation evidence

Each launch that applied confinement writes a `fired` row to
`logs/feature-evidence.jsonl` (`featureId: jobs.toolAllowlistEnforcement`, context: slug,
kind, shell); a declared list not applied for `unsupported-tool-names` or
`not-applied:<fw>` writes `held`; a refused tamper or enrolled launch (`confine-refused`) and a
`not-applied:claude-code` lane bug write `error`. A ladder entry `jobs.toolAllowlistEnforcement` (risk
`sensitive`) reads these rows, and the switch joins `DEV_GATED_FEATURES` with its
justification: on a development agent it can only remove tools from that agent's own
declared-list jobs, it is read live at every spawn, and `false` restores today's launch
at the next spawn.

### 8. Migration stops writing an unasked-for list

`jobMigrate.writeUserTemplate` stops writing `toolAllowlist: ['Read']`. A migrated user
job then resolves as `default-user` (still recorded as `['Read']`, not applied) — the
same tools it has today and the same record. Files already migrated are not rewritten;
their `["Read"]` is read as a default (§2), so they keep their tools.

### 9. Agent awareness

A short `### Job tool limits` section (shared constant in `PostUpdateMigrator`, used by
`generateClaudeMd`, appended by `migrateClaudeMd` under a content-sniff guard, placed next to `SCRIPT_JOBS_CLAUDEMD_SECTION`
in both `generateClaudeMd` and `patchClaudeMdContent`, and its marker added to the
AGENTS.md / GEMINI.md shadow marker list after `### Scheduled jobs run as scripts` — these
are the agents whose lists are not applied; the layout files it under sessions-and-jobs) tells the agent: an
unenrolled declared or clamped list is applied only to Claude jobs, only with the switch on, and
not when it names tools the form cannot express, and not for a user job whose list is
exactly `["Read"]` unless the job is enrolled with `toolAllowlistEnforce: true` (which
also makes it fail closed); a list with Bash limits Claude's tools,
not what the job can do; read `toolsConfined` / `toolEnforcement` on the run before
telling anyone a job "can only read"; a job that needs more tools declares them
(`["Read","Bash"]`), and widening an instar job to `"*"` + `unrestrictedTools` is the
owner's call; the switch is `jobs.toolAllowlistEnforcement.enabled`.

### 10. Builtin manifests

No builtin needs widening: every session-run builtin template is `kind: 'unrestricted'`
except four that declare `["Bash"]` (doorway-scan, routing-price-refresh,
routing-price-web-verify, stall-matrix-live-check). Their bodies run one `test -f` and
one `node scripts/….mjs` through Bash and use no other tool, so Bash-only is correct.
`evolution-proposal-implement` is `"*"` + `unrestrictedTools: true` and keeps full
tools. A template test pins all of this.

## Decision points touched

- **Tamper-first resolution** — invariant; basis: enumerable-domain; evidence: `isLockUntrustedTamper` names three lock-trust states and `origin` has two values; the lock file is the higher trust authority by the existing jobs-as-agentmd design.
- **Confine-or-not per spawn** — invariant; basis: enumerable-domain; evidence: the ordered table in §2 is a total function of `AllowlistResolution.kind` (seven values), the origin, the enrolment, the switch (on / off / explicitly off / unreadable) and the known-name check; the declared list or the existing clamp rule is the authority, and the migration-written `["Read"]` is read as a default (§2).
- **Run-and-report on an unsupported framework or list (array, clamped)** — invariant; basis: irreversible-consequence; evidence: refusing would stop every allowlisted job on a Codex-default agent at the flip, with no confirmation from its owner; running reproduces today's behaviour and records it.
- **Fail closed for the tamper kind (while the switch is on)** — invariant; basis: irreversible-consequence; evidence: a tampered instar job with full tools can make changes that cannot be undone; refusing only delays a job whose manifest is already untrusted.
- **Gate posture (dev live, fleet dark)** — invariant; basis: irreversible-consequence; evidence: declared lists and unauthorized `"*"` requests on fleet agents were never exercised (they did nothing), so any declared list may be narrower than its job needs and any clamped `"*"` job would drop to Read; a fleet-wide flip would stop such jobs without warning; the switch is read live and reverses at the next spawn.
- **Known-tool-name check** — invariant; basis: external-constraint; evidence: the set is the CLI's own `init` tool record under `--tools` on 2.1.322; an unknown name makes the CLI start with no tools and exit 0, and five plausible names are silently dropped (both measured 2026-11-10); a name outside the set fails toward today's behaviour, recorded, and the per-machine live test catches CLI drift.
- **Lead line on confined prompts and on control-character writes** — invariant; basis: external-constraint; evidence: Claude's input box treats a first `!` as a shell command regardless of `--tools` (measured 2026-11-10); a plain first character removes the mode switch for the spawn prompt and for every later write through the injection chokepoint.
- **Enrolled jobs fail closed** — invariant; basis: irreversible-consequence; evidence: the author explicitly asked for this exact list; running it unapplied is the harm they enrolled against, while refusing only delays a job whose author can fix the list.
- **User `["Read"]` read as a default** — invariant; basis: external-constraint; evidence: it is byte-identical to the migration-written list and the resolver default, so no signal distinguishes an authored one.
- **Report-once with a 24-hour repeat** — judgment-candidate; floor: the per-run truth is always in the run record, tamper and clamp are reported whatever the switch, and the first occurrence of each distinct outcome per window is always reported; arbiter: the operator reading the degradation digest; the repeat gap only sets reminder frequency.
- **The clamp rule itself (`"*"` without authorization ⇒ Read)** — invariant; basis: enumerable-domain; evidence: unchanged from INSTAR-JOBS-AS-AGENTMD §5 — two flags (`"*"`, manifest `unrestrictedTools`) with a fixed answer for each pair.

## Frontloaded Decisions

| Decision | Value | Why |
|---|---|---|
| Enforce `default-user` (no declared list)? | No — record `no-declared-allowlist` | The author never asked for a restriction; enforcing would stop most user jobs fleet-wide |
| Gate posture | Dev-agent gate: live on development agents, dark on the fleet | Declared lists on the fleet were never exercised; a census checks them first |
| Codex for unenrolled array/clamped | Run, record, one event | No per-tool switch exists; refusing is an unasked-for outage |
| Codex for the tamper kind | Refuse before launch | Full tools on a tampered job is the harm the clamp exists to stop |
| Explicit enrolment | `toolAllowlistEnforce: true` applies the list exactly, fail-closed, whatever the switch default | Lets an author ask for an exact read-only job and never widens an invalid enrolled policy |
| A user job's `["Read"]` | Not applied, `read-only-default` | Identical to the migration-written value and the resolver default; not an author's choice |
| Unknown or `mcp__` tool names (unenrolled; enrolled are refused) | Not confined, reported, event says normal tools | Confining would remove tools the author listed |
| Where `toolsConfined` comes from | The returned session (consumer), set after the final argv check | A request the launch ignored must never be recorded as confined |
| Event timing | After the launch, from the outcome; once per (slug, kind, reason) with a 24 h repeat | No pre-launch claim; no per-run flood of digests and feedback items |
| Migration | Stop writing `['Read']` | It created lists nobody authored |
| Builtin manifests | No change; template test pins them | All need-shell builtins are already `unrestricted` or `["Bash"]` |

## Open questions

*(none)*

## Multi-machine posture

- **Posture: unified.** Every machine runs the same decision from the same code, the same
  job manifests (which already travel with the agent's state) and the same switch key.
  Each launch is decided on the machine that starts the job, because the flags go on that
  machine's own `claude` process; there is no state to replicate, only a policy to keep
  identical. The report-once timestamps file is kept per machine, so an agent on N
  machines can report the same fact up to N times per window — acceptable for a daily
  reminder, and each machine's report names its own runs.
- **The switch must read the same on every machine.** `jobs.toolAllowlistEnforcement.enabled`
  lives in each machine's config. The fleet flip, and any rollback, is applied on every
  machine of the agent, and checked by reading the key on each. Until then a job that
  moves with the lease could run confined on one machine and not on another; the run
  record on each machine says which.
- **Claude version per machine.** The live proof is per installed version; the opt-in
  live test runs on each machine in the pool before the fleet flip (graduation criterion).
- Run record fields: written to each machine's job-run ledger; read per machine with
  `GET /jobs/:slug/history` (there is no pool read of run rows today, and this spec adds
  none).
- Events/degradations: the existing per-machine event log and DegradationReporter; no
  new user-facing notice is added, so no one-voice gating is needed.

## Maturation plan

- **ladder:** jobs.toolAllowlistEnforcement
- **test-agent-live:** the unit/wiring suite, the opt-in live CLI test against the
  installed `claude`, and the recorded live proof above (denied tool unavailable, allowed
  tool works, with Echo's real project settings).
- **dev-agent-live:** Echo (developmentAgent) runs it live from the release that carries
  it; the opt-in live test is run on each of Echo's machines when the release lands
  there, and a first confined failure on a machine is treated as that machine failing the
  check. Its enabled confined job today is `feature-maturation-review` (Read, Bash, Write,
  Edit, Glob, Grep; its body uses no Agent, TodoWrite or web tool); the four `["Bash"]`
  builtins are disabled on Echo, so their branch is covered by the live test, not by
  Echo's runs. Each confined run
  is checked for a failure caused by a missing tool.
- **fleet:** flip after a fleet census of declared `toolAllowlist` arrays (other than a
  user job's `["Read"]`, which stays a default) and of `"*"` jobs without
  `unrestrictedTools: true` (which become Read-only), each checked against what the job
  does, tracked on CMT-1566
  <!-- tracked: CMT-1566 -->.
- **graduation criterion:** ladder metrics over 14 days: `fired` rows for the feature
  ≥ 3 (Echo's one enabled confined job runs about three times a week) and an `error`
  ratio of 0; plus two owner-recorded `outcome` rows (`POST /maturation/evidence`): a
  review of every confined run on Echo finding none failed for a missing tool, and the
  opt-in live test passing on each of the agent's machines. The fleet rung advances by the
  owner on those, not by code. A window with no confined launch is not a pass.
- **dark-window:** at most 28 days from merge to the fleet decision; if the census is
  not done by then, the reason and a new date go on CMT-1566 <!-- tracked: CMT-1566 -->.

## Carriers

Frozen excerpt of the commitment the fleet step is tracked on (ledger: `docs/specs/carriers/job-tool-allowlist-real-enforcement.json`):

> **CMT-1566** — "Before turning job tool limits on for the fleet, I will run a census of declared toolAllowlist arrays (other than a user job bare ["Read"]) and of "*" jobs without unrestrictedTools: true on fleet agents, check each against what the job does, then decide the fleet flip within 28 days of the EVO-008 merge or record the reason and a new date here."

## Tests

- Unit: `resolveAllowlist` tamper-first for array/`"*"`/absent × each tamper state;
  user jobs unchanged.
- Unit: `resolveToolEnforcement` over every kind × gate on/off/unreadable × good, padded,
  `mcp__` and empty names; `confined-with-shell` when Bash is listed.
- Wiring: the scheduler passes `confinedTools` for array and clamped with the gate on,
  plus `requireToolConfinement` for the tamper kind; passes none with the gate off and for
  `default-user`; records `toolsConfined` / `toolEnforcement` from the returned session;
  emits `job_tool_allowlist_not_enforced` once when the session came back on Codex; 50
  spawns of one job produce one degradation; no clamp event is written before the launch.
- Consumer (SessionManager, mocked tmux): a scheduler-shaped spawn with `confinedTools`
  produces a final argv meeting the whole contract (§4) on both Claude lanes; sets
  `session.confinedTools`; a final argv with an extra `--mcp-config` is refused before
  launch; on Codex the field is unset, and with `requireToolConfinement` the spawn throws
  before launching.
- A user job with `["Read", "Grep"]` confines to exactly those tools; a user job with
  `["Read"]` does not; with `toolAllowlistEnforce: true` it does, even with the switch
  default off; an enrolled job with an unknown name is refused before launch; the loader
  accepts the key only as a boolean.
- `isConfinedWriteRefused` is true for a `confinedTools` session and false otherwise.
- Consumer (real CLI, opt-in `LIVE_CLAUDE_CONFINEMENT_TEST=1`): runs the argv the
  builder produced against the installed `claude`, from a directory carrying a permissive
  `.claude/settings.json` with an auto-approve hook, and asserts a denied tool's side
  effect did not happen and an allowed tool's did — both sides of the boundary; and reads
  the CLI's `init` record to assert the session's tools equal each confinable name.
- Unit: every confined spawn prompt starts with the lead line on both lanes; a body
  starting with `!`, `/`, `#` or `-` is never the first character typed or passed; a
  one-line `!x` write into a confined session goes in behind the lead line, and the same
  write into an unconfined session is unchanged.
- Template census: every shipped job template is `"*"` + `unrestrictedTools: true` or a
  list that confines cleanly.
- `jobMigrate`: a migrated user job has no `toolAllowlist`.
- Dev-gate registry: `jobs.toolAllowlistEnforcement.enabled` resolves live on dev, dark
  on fleet.

## Rollback

`jobs.toolAllowlistEnforcement.enabled: false` restores today's argv at the next spawn
(read live, no restart). The tamper-first resolver change, wording, run-record fields and
the migration change are a code revert; no stored state needs repair.

## Left behind

- A post-run transcript check that no tool outside the list was used (stronger
  corroboration than the launch form plus the live test) — feedback fb-32e9245d-a13.
- A Codex mapping (for example a read-only sandbox for a Read-only list) — not
  equivalent to a tool list; the honest report stands.
- The out-of-band confirmation for `unrestrictedTools` described in
  INSTAR-JOBS-AS-AGENTMD — a foundation gap named in §Threat model; this spec's wording
  points at the owner but does not enforce it.
- A pool-wide check that the switch reads the same on every machine — every dev-gated
  switch (and `developmentAgent` itself) has the same per-machine config shape, so this
  is a class concern for the dev-gate machinery, not this feature; per-machine run
  records show any divergence.
- The confinable-name list is fixed to today's Claude tool names; a newer tool outside it
  fails toward today's behaviour and is recorded, never confined wrongly.
