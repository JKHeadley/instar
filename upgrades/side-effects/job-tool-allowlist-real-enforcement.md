# Side-Effects Review — Job tool allowlists really restrict (EVO-008)

**Version / slug:** `job-tool-allowlist-real-enforcement`
**Date:** `2026-11-10`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent — concurred`

## Summary of the change

A scheduled job's `toolAllowlist` (and the scheduler's `[Read]` clamp for an unauthorized
`"*"`) was recorded and inert: every Claude job launched with
`--dangerously-skip-permissions`, and the clamp event claimed the opposite. This change
routes a declared or clamped list on a Claude job through the existing confined launch
form (`applyClaudeToolConfinement`: no bypass flag, `--permission-mode dontAsk`,
`--tools <list>`, strict empty MCP config), records whether the launched session really
carried it (`toolsConfined` / `toolEnforcement` on the run row, read from the returned
session), and rewrites the clamp/tamper/not-enforced wording to say what happened, after
the launch, once per day per outcome. It is behind `jobs.toolAllowlistEnforcement.enabled`
(dev-agent gate: live on development agents, dark on the fleet), plus an explicit per-job
enrolment `toolAllowlistEnforce: true` that applies the list exactly and fails closed.

Tier 2 (adds real blocking of tools; security-sensitive). Spec converged in 6 rounds (the
Tier-2 cap) with Codex `gpt-6-astra` every round; ~560 LOC across 10 source files, 6 new or
changed test files. Commit attempts: see the PR body.

Files: `src/scheduler/JobScheduler.ts` (tamper-first `resolveAllowlist`,
`resolveToolEnforcement`, `toolEnforcementOutcome`, gate read, outcome-based
`emitAllowlistSignals` with a persisted report-once map, spawn wiring, evidence rows),
`src/core/SessionManager.ts` (`requireToolConfinement`, `CONFINED_PROMPT_LEAD`,
`assertClaudeConfinementContract` on the final argv of both Claude lanes,
`session.confinedTools`, `guardConfinedToolsText` at the text chokepoint,
`isConfinedWriteRefused` extended), `src/core/types.ts` (`Session.confinedTools`),
`src/scheduler/JobRunHistory.ts` (two optional fields), `src/scheduler/AgentMdJobLoader.ts`
(enrolment key + validation), `src/commands/jobMigrate.ts` (stops writing `['Read']`),
`src/core/PostUpdateMigrator.ts` + `src/scaffold/templates.ts` (CLAUDE.md section + shadow
marker), `src/core/devGatedFeatures.ts`, `src/data/feature-ladders.json`.

## Decision-point inventory

- `JobScheduler.resolveAllowlist` — modify — tamper (lock-file real-tamper state) is now checked before a declared array, so a tampered instar job can no longer keep its own list.
- `JobScheduler.resolveToolEnforcement` — add — the ordered 11-rule table (spec §2) deciding applied / not applied / refused per spawn.
- `SessionManager.spawnSession` `requireToolConfinement` — add — refuses a non-Claude launch before starting when confinement is required (tamper kind, enrolled job).
- `assertClaudeConfinementContract` — add — throws before launch if the final argv lost any part of the confined form.
- `guardConfinedToolsText` / `isConfinedWriteRefused` — add/modify — text into a confined session never starts with `!`, `/`, `#`; the outside line-by-line writer is refused for confined sessions.
- `AgentMdJobLoader` frontmatter validation — modify — new key `toolAllowlistEnforce` (boolean, only beside an array, not on `runner: script`).
- `emitAllowlistSignals` — modify — worded from the outcome, after the launch; once per `(slug, kind, reason)` per 24 h.

---

## 1. Over-block

- **A declared list narrower than its job needs** now really removes the missing tools. On Echo (the only dev agent here) the confined jobs are `feature-maturation-review` (Read, Bash, Write, Edit, Glob, Grep — its body uses no other tool) and four `["Bash"]` builtins that are disabled on Echo; their bodies run one `test -f` and one `node scripts/…mjs`. Fleet agents are untouched until the census (gate dark).
- **Hook "ask" decisions** become silent denials under `dontAsk`; the Bash-only builtins run one fixed command, so this does not arise for them.
- **An enrolled job with a typo** is refused every run (by design, visible; the crash-loop pauser may pause it).
- **A whole-lock-file fault** confines every session-run builtin to Read when the switch is on (the lock file's designed answer; loud on the Issues card; switch reverses it).
- **Slash commands typed into a confined session** are neutralised; nothing in the job path sends one (`/compact` targets topic-bound sessions only).
- User jobs with no list or a bare `["Read"]` are explicitly NOT confined (they would otherwise all break).

## 2. Under-block

- A list that includes `Bash` gives the job a shell (it can write files, call the agent's API, start `claude`); recorded as `confined-with-shell` and said plainly in the CLAUDE.md section. Not an OS sandbox.
- `Read` has no path scope.
- Codex/Gemini/Pi/Grok have no per-tool limit: unenrolled lists run unapplied there (recorded, event).
- Someone who can write the jobs folder can add a user job or rewrite `origin`; the lock file never covered that.
- `unrestrictedTools` remains agent-writable (the INSTAR-JOBS-AS-AGENTMD out-of-band confirmation was never built); wording points at the owner.
- CLI drift that drops a tool name removes that tool (fails toward restriction); the opt-in live test per machine catches it.
- Unknown/`mcp__`/pattern names on an unenrolled job leave the list unapplied (reported).

## 3. Level-of-abstraction fit

The decision lives in the scheduler (which owns the job's resolution and lock trust); the
mechanism stays in SessionManager's existing confinement primitive, already used by triage;
the proof (`session.confinedTools`) is set by the launch itself after the final argv check,
so the scheduler consumes the consumer's record instead of its own request. The text
guard sits at the existing single text chokepoint, and the outside writer reuses the
existing public `isConfinedWriteRefused` check. No parallel mechanism was added.

## 4. Signal vs authority compliance

- [x] Yes — but the logic is a deterministic policy evaluator over an enumerable domain, which `docs/signal-vs-authority.md` permits for constrained policy (not a brittle detector of fuzzy content).

The blocking authority added is exactly the authority the system already claimed (the
clamp) plus an author's explicit opt-in. Inputs are structural (resolution kind, origin,
enrolment, switch, a name set measured from the CLI's own start record) — not heuristics
over content. Codex agreed every round that an LLM authority would add nothing here.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The confine-or-not table is
an invariant over an enumerable domain (spec §Decision points touched, each row with basis
and evidence). The one judgment-candidate (the 24-hour report repeat) only sets reminder
frequency; its floor (every run recorded; first occurrence of each outcome always
reported) is declared.

## 5. Interactions

- **Triage**: already passes `confinedTools`; it now also gets the lead line and the final-argv contract check (both pass for its argv; triage tests unchanged and green), and the server's outside writer (`tmuxOps.sendKeys`) now refuses to type into a triage session, as into any confined session (asserted by a test; triage takes no relayed messages today).
- **Observability inside the launch callback**: the evidence row and the signals are wrapped so a throw there can never fall into the spawn-failure path and orphan a running session.
- **Rollback path** (`spawnProjectedSession` origin `rollback`) goes through `spawnJobSession` → same decision. Script runners unchanged.
- **Capacity/reroute refusals** re-enqueue before any signal is emitted (signals are in `.then`), so retries no longer repeat the clamp event.
- **Threadline MCP**: a confined spawn is `stripped`, so no `--mcp-config` is added; the final contract check would throw if one ever were.
- **DegradationReporter** files a feedback item per report; known framework/name limits are events only, and report-once (persisted under `state/job-tool-allowlist-reports.json`) bounds the rest.
- **JobModelRoute** already falls back from Codex for non-`"*"` lists; unchanged.
- **CrashLoopPauser** may pause an enrolled job refused every run — intended surfacing.

## 6. External surfaces

- Run rows gain `toolsConfined` / `toolEnforcement` (optional; old rows unknown). `GET /jobs/:slug/history` returns them.
- New event types `job_tool_allowlist_not_enforced`, `job_tool_allowlist_refused`; changed wording/metadata on `job_allowlist_clamped`, `job_lock_untrusted_clamped`.
- New `logs/feature-evidence.jsonl` rows (`featureId: jobs.toolAllowlistEnforcement`).
- New frontmatter key: an OLDER instar withholds a job carrying it (closed-set loader) — only jobs that opt in.
- Migration: new migrated user jobs get no `toolAllowlist` line.
- CLAUDE.md / AGENTS.md / GEMINI.md: new `### Job tool limits` section via the existing content-sniffed migration.
- Operator surface: no new operator action (the switch is config; the fleet flip is a later owner step). Not applicable.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

**Unified.** Every machine runs the same decision from the same code, manifests (which
travel with the agent) and the same switch key; each launch is decided where it starts
because the flags go on that machine's own `claude` process. No state to replicate. The
switch lives in each machine's config, so the flip and any rollback are applied on every
machine (a class concern for every dev-gated switch). The report-once file is per machine
(an N-machine agent may repeat a reminder up to N times a day). No user-facing notice is
added (events and degradations only). No URLs. Status surfaces: none new.

## 8. Rollback cost

`jobs.toolAllowlistEnforcement.enabled: false` restores today's launch at the next spawn
(read live, no restart) for every job including enrolled ones. A code revert removes the
rest; the only persisted artefacts are additive (two optional run-row fields, one small
state file, evidence rows) and need no cleanup. No user-visible regression during
rollback.

## Conclusion

The review (6 convergence rounds, each finding confirmed on the installed Claude CLI before
the spec changed) moved the design from "apply every declared list" to a safe, honest
shape: real confinement where an author asked for it on Claude, tamper fails closed while
the switch is on (recorded and reported, not limited, while it is off),
migration-written defaults left alone, an explicit fail-closed enrolment, and an escape
(`!` typed into the chat box runs a shell regardless of the tool list) closed for both the
first prompt and later writes. Live proof on Claude Code 2.1.322 passes both sides of the
boundary. Clear to ship on the dev-agent gate; the fleet step waits on the census
(CMT-1566).

---

## Second-pass review (if required)

**Reviewer:** independent second-pass reviewer subagent (Claude, this session's model)
**Independent read of the artifact: concur** (after one iteration)

First read raised three concerns, all fixed before commit: (1) the evidence write and
signals inside the launch callback could throw into the spawn-failure path and orphan a
running session — now wrapped, with a test; (2) the CLAUDE.md tamper bullet and this
artifact's Conclusion over-claimed fail-closed with the switch off — both now say "while
the switch is on"; (3) the outside-writer refusal for confined triage sessions was not
named — now in §5, with a test. Re-read: "Concur with the review."


---

## Evidence pointers

- Live CLI proof (opt-in): `LIVE_CLAUDE_CONFINEMENT_TEST=1 npx vitest run --config vitest.integration.config.ts tests/integration/job-tool-confinement-live.test.ts` — 3/3 pass on 2026-11-10 (Read-only: Bash/Write leave no file with a permissive settings file + auto-approve hook; Bash-only: Bash works, Write does not; every confinable name appears in the CLI's own init tool record).
- Manual probes recorded in the spec: inert clamp reproduced (Bash ran under `--allowedTools Read` + bypass); `!touch` typed into a Read-only interactive session created the file, and did not after a plain first line; subagent under `Read,Task` had only Read/Agent.
- Unit: `tests/unit/scheduler/JobScheduler.tool-enforcement.test.ts`, `tests/unit/session-manager-job-confinement.test.ts`, `tests/unit/job-templates-tool-confinement-census.test.ts`, `tests/unit/PostUpdateMigrator-jobToolLimits.test.ts`, loader cases in `tests/unit/scheduler/JobLoader.agentmd.test.ts`, `tests/unit/commands/jobMigrate.test.ts`.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect (the defect is in scheduler/launch code; no prompt, hook,
config, skill or standards text is fixed).

- **`defectClass`**: `unbounded-self-action`
- **`closure`**: `n/a` (negative declaration)
- **`reason`**: No new self-triggered action: this decides how an EXISTING scheduled job
  launch is formed (confined argv) or refuses that one launch before it starts; it adds no
  loop, retry, respawn or re-drive. A refused launch takes the existing spawn-error path,
  whose retry is the job's own next cron trigger, unchanged.
