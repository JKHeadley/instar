# Convergence Report — Job tool allowlists really restrict

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier external pass ran through the agent's Codex CLI in every one of the six
rounds (round 1's first attempt failed only because the agent-home build asked Codex for
the retired `gpt-5.5`; it was re-run from a fresh build of current main and succeeded).
Gemini was not signed in (`gemini-not-authed`) and was not available.

## ELI10 Overview

Scheduled jobs can say which tools they may use, like "only the shell" or "only reading
files", and the scheduler cuts a job down to "reading only" when it asks for everything
without permission. Until now none of that did anything: every job started Claude with a
switch that skips all permission checks, so the list was written down and ignored — and
the scheduler's own messages claimed the opposite. We proved this on the real Claude
program: a "reading only" job still ran a shell command and wrote a file.

This change makes those lists real for jobs that run on Claude: the job starts in a
limited mode where unlisted tools simply do not exist. We proved that too, including with
Echo's own very permissive settings and auto-approve hook in place, and including that a
helper the job starts inherits the same limit. Where a list cannot be applied (Codex has
no per-tool switch, or a tool name Claude would not recognise), the job runs as before and
every record and message now says plainly that the list was not applied. A built-in job
whose lock file looks tampered with is cut to reading only and refused on an engine that
cannot limit it. A job's author can also mark a list as binding, which makes it apply
exactly and refuse to start rather than run without it.

It is on for development agents (Echo) and off on the fleet until the lists on other
agents have been checked, because those lists never did anything before and some may be
narrower than their jobs need. One setting turns it off again at the next launch.

## Original vs Converged

- **Originally**, every declared list would have been applied, including user jobs' bare
  "reading only" lists. Review showed most of those were written automatically by an old
  migration or are the resolver's own default, so applying them would have broken many
  user jobs. **Now** a bare user `["Read"]` is read as a default, the migration stops
  writing it, and an author who really wants it marks the job binding.
- **Originally**, a tampered built-in job could escape the tamper clamp by declaring its
  own list, and on Codex it would have run with full tools. **Now** tamper is checked
  first and a tampered job is refused on any engine that cannot limit it.
- **Originally**, the messages were written before the launch. **Now** they are written
  after, from what the launch actually did, at most once a day per job and outcome, and
  that daily window survives a restart. Known framework limits are events, not filed bugs.
- **Originally**, tool names were checked only by shape. Review showed Claude silently
  ignores some familiar names and starts with no tools at all for a misspelled one. **Now**
  names are checked against the set read from Claude's own start-up record, and the live
  test re-checks it on each machine.
- **Review found a real escape**: instructions typed into Claude's chat box run a shell
  command when they start with "!", even with the shell disallowed. **Now** every confined
  prompt and every later message into a confined session starts with a plain line, and
  relayed messages from other sessions are not typed into a confined session at all.
- **Originally**, the "this run was confined" record would have come from the request.
  **Now** it comes from the launched session, set only after the final launch command
  passed a check of the whole limited form.
- Multi-machine posture rewritten as unified (one policy, one switch read on each machine).

## Iteration Summary

Reviewer model: internal reviewers ran as Claude subagents on this session's model
(Opus 5.5). Round 1 ran the six lenses as six reviewers; rounds 2–6 ran the same six lenses
combined into fewer reviewers (2–3 in rounds 2–3, one all-lens reviewer in rounds 4–6) to
keep cost in proportion; no lens was dropped.

| Iteration | Reviewers who flagged (design) | Design findings | Left behind | Spec changes |
|-----------|--------------------------------|-----------------|-------------|--------------|
| 1 | security, adversarial, integration, decision, lessons, scalability; gate 4 flags | 13 | 9 | tamper-first; fail-closed tamper; events after launch; report-once; user `["Read"]` default; known-name set; unified posture; ladder + dev gate; migration change |
| 2 | codex (2), security/adversarial (3), decision/lessons (1), integration (2) | 8 | 6 | full final-argv contract; CLI-measured name set; lead line (measured `!` escape); census for `"*"`; whole-lock-file fault stated |
| 3 | codex (2), security/adversarial (1), integration/decision (1) | 4 | 5 | delegation measured; guard on every later write; neutral lead line; census covers `"*"` |
| 4 | codex (2), all-lens (1) | 3 | 4 | explicit enrolment `toolAllowlistEnforce`; second text writer refused |
| 5 | codex (2), all-lens (1) | 2 | 5 | one ordered 11-rule decision table; enrolment requires an array |
| 6 | codex (2: one fixed, one accepted); all-lens: none | 1 accepted | 5 | enrolment refused on `runner: script` |

Standards-Conformance Gate: ran every round (4, 5, 2, 2, 4, 3 flags). Its recurring flags
are recorded under Left behind.

## Proportion

Tier 2 (security-sensitive: it adds real blocking of tools). Spec ~520 lines; code touches
10 source files plus 6 test files. 6 of 6 rounds used — ⚠ at the Tier-2 cap. The reason is
that each round found a real, measurable behaviour (the inert clamp, CLI-dropped tool
names, the `!` shell escape, delegation inheritance, a second text writer), each confirmed
on the installed CLI before the spec was changed.

## Left behind

- Runtime CLI compatibility probe for enrolled jobs (Codex r6). Accepted risk: a CLI that
  drops or renames a tool only ever REMOVES that tool from a confined session (fails toward
  restriction, visible as a job failure, never as extra capability); the opt-in live test
  per machine reads the CLI's own start record and catches drift.
- Post-run transcript check for tools outside the list — feedback fb-32e9245d-a13.
- Codex/other engines have no per-tool limit (gate flag "Framework-Agnostic", every round).
  The honest report stands; a read-only sandbox is not equivalent to a tool list.
- `unrestrictedTools` is a flag the agent can write itself; the out-of-band owner
  confirmation from INSTAR-JOBS-AS-AGENTMD was never built (gate flag "Structure beats
  Willpower", every round). Named in the threat model; wording points at the owner.
- A pool-wide check that the switch reads the same on every machine: a class concern for
  all dev-gated switches, not this feature; per-machine run records show divergence.
- The 24-hour repeat window (gate "Judgment Within Floors"): it only sets reminder
  frequency; the first occurrence of each distinct outcome is always reported and every
  run's truth is in its run record.
- Per-machine report-once file: an agent on N machines may report a fact up to N times a
  day.
- Slash commands typed into a confined job session are neutralised; nothing in the job
  path sends one today.
- A whole-lock-file fault confines every session-run builtin when the switch is on (the lock
  file's designed fail-closed answer; loud via the existing Issues card; reversible).

## Full Findings Catalog

**Round 1** — Security: tamper bypass via declared array (resolved: tamper-first); tamper
fails open on Codex (resolved: required confinement); Bash-in-list overstated (resolved:
`confined-with-shell`, threat model); live proof only in a scratch dir (resolved: re-run in
Echo's agent home with its real settings and auto-approve hook — tools still absent);
argv checked before final assembly (resolved: final contract check). Adversarial:
migration-written lists confine on dev agents (resolved: user `["Read"]` default + migration
change); array + `unrestrictedTools` precedence (resolved: stated); unknown names start
with no tools (resolved: measured set); events before launch / repeated on capacity
retries (resolved: after launch, report-once). Integration: posture lint failure
(resolved: unified); events before launch; missing ladder entry (resolved); wrong pool
read claim (resolved). Decision-completeness: array authority conflated (resolved);
unreachable graduation bar (resolved: ladder metrics + owner rows); event timing; tamper
basis (resolved). Lessons: event before launch; P20 symbol vs state (resolved:
`toolsConfined` = launch form applied, runtime refusal proven live); self-service widening
(left behind, worded); migrated lists (resolved). Scalability: per-run degradation flood
files bugs (resolved: report-once, persisted, events-only for known limits).

**Round 2** — Codex: explicit opt-in for exact Read-only (resolved in r4: enrolment); final
check must cover MCP (resolved). Security/adversarial: `!` typed into the interactive lane
runs a shell (measured; resolved: lead line); whole-lock-file fault (resolved: stated);
user `["Read"]` silent (resolved: wording). Decision/lessons: name list wrong for the
installed CLI (measured; resolved: CLI-measured set). Integration (late): tamper silent with
switch off (resolved: always reported); alternating outcomes flood (resolved).

**Round 3** — Codex: origin/runner rewrite (resolved: threat model narrowed); delegation
inheritance unproven (measured: inherits; kept). Security: lead line only on first prompt
(resolved: chokepoint guard). Integration/decision: census must cover `"*"` jobs (resolved).

**Round 4** — Codex: unknown names widen enforceable policy; exact Read-only opt-in
(resolved: enrolment, fail-closed). All-lens: second text writer `tmuxOps.sendKeys`
(resolved: refused for confined sessions).

**Round 5** — Codex: enrolment's require flag; enrolment input contract (resolved: ordered
table, loader requires an array). All-lens: enrolment without an array fails open
(resolved: withheld by the loader).

**Round 6** — Codex: runtime CLI compatibility (accepted risk, above); enrolment on a
script runner (fixed: withheld by the loader, test added; not re-reviewed — it only
narrows what the loader accepts). All-lens: no design findings; five precision items fixed
in passing.

## Convergence verdict

Converged at round 6 (the Tier-2 cap). The final internal round found nothing that changes
what gets built; the final external round's two design items were one fixed (a loader
refusal that only narrows input) and one accepted with its reason above — it fails toward
restriction, so it is not a safety, security or data-loss finding. Nine items are left
behind. The spec is ready for approval.
