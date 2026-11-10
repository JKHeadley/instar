## What Changed
A scheduled job's tool list now really limits the job, where it can, and says plainly where it cannot (EVO-008).
- **The list was inert.** Every Claude job started with permission checks switched off, so a `toolAllowlist` (or the scheduler's [Read] clamp for an unauthorized `"*"`) was recorded and ignored, while the clamp event said the job was "clamped to [Read]".
- **Now applied on Claude.** With `jobs.toolAllowlistEnforcement.enabled` on (omitted = on for a development agent, off on the fleet), a job with a declared list, or a clamped `"*"`, starts in the confined launch form: only the listed tools exist. A user job's bare `["Read"]` (what older migrations wrote, and the default for a job with no list) is left alone.
- **Binding lists.** Frontmatter `toolAllowlistEnforce: true` applies a job's list exactly, even with the switch default off, and refuses to start the job rather than run it without its limit (unknown tool name, or an engine with no per-tool limit).
- **Tamper.** A built-in job whose lock file is in a real tamper state is cut to Read whatever it declares, and refused on an engine that cannot limit it.
- **Honest records.** Each run row carries `toolsConfined` (read from the launched session) and `toolEnforcement` (why). Clamp, tamper and not-applied messages are written after the launch, from what happened, at most once a day per job and outcome.
- **Typed-text escape closed.** A prompt or later message typed into a confined session never starts with `!`, `/` or `#` (a first `!` runs a shell in Claude's chat box regardless of the tool list); relayed session-to-session messages are not typed into a confined session.
- Job migration no longer writes `toolAllowlist: ['Read']` into migrated user jobs.

## What to Tell Your User
A scheduled job that says it can only use certain tools now really is limited to them on Claude, starting with development agents. Before, those limits were written down but not applied. Nothing changes for jobs that never set a limit. If a job ever needs a tool it was not allowed, I'll see that in its run history and widen its list.

## Summary of New Capabilities
- Real per-job tool limits for Claude jobs (dev-agent live, fleet dark), recorded per run as `toolsConfined` / `toolEnforcement`.
- `toolAllowlistEnforce: true` to make a job's tool list binding and fail-closed.

## Evidence
- `tests/integration/job-tool-confinement-live.test.ts` (opt-in, real Claude Code 2.1.322): a Read-only job could read but its Bash and Write steps left no file, even with a permissive settings file and an auto-approve hook; a Bash-only job's Bash worked and Write did not; every confinable name is in the CLI's own start-up tool record. 3/3 pass.
- `tests/unit/scheduler/JobScheduler.tool-enforcement.test.ts`: the decision table both ways, tamper-first, enrolment, the scheduler passing `confinedTools` and recording the outcome from the session, Codex not-applied, refused launches, report-once across a restart.
- `tests/unit/session-manager-job-confinement.test.ts`: the whole confined form on both Claude lanes, `session.confinedTools` only then, Codex unset, required confinement refused before launch, the lead line and the outside-writer refusal.
- `tests/unit/job-templates-tool-confinement-census.test.ts`: every shipped job template either is authorized for all tools or lists only confinable tools.
