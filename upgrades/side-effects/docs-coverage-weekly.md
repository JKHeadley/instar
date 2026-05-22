# Side-effects review — docs-coverage-weekly

Spec: `docs/specs/docs-coverage-weekly.md`
ELI16: `docs/specs/docs-coverage-weekly.eli16.md`
Companion to: `docs/specs/docs-coverage.md` (the underlying script + per-PR CI gate)

## Surface map

| Change | File | Type |
|---|---|---|
| New job template | `src/scaffold/templates/jobs/instar/docs-coverage-audit.md` | `agentmd` job, `enabled: false` by default. Distributed via `installBuiltinJobs()` on `instar init` and on every update via `PostUpdateMigrator` |
| New CI workflow | `.github/workflows/docs-coverage-weekly.yml` | GitHub Actions cron workflow, Mondays at 10:00 UTC |

No production code touched. No agent behavior changes at runtime unless an operator explicitly enables the job.

## Over-block analysis

**Could the job spam an operator?**

The job ships `enabled: false`. Operators with the instar source repo on their machine can flip it to `true` in `.instar/jobs/instar/docs-coverage-audit.md`. The job's first action is to locate the instar source repo; if it can't find one, it sends a short message and exits — and the operator can disable the job again. So the worst case is one Telegram message before the operator turns it back off.

When enabled and working correctly, the job stays silent most weeks. The delta thresholds (≥3 newly-undocumented items in a category, any category below CI floor, ≥2-point overall drop) ensure that only meaningful drift surfaces a message.

**Could the CI workflow spam an issue tracker?**

The workflow opens or updates one standing issue tagged `docs-coverage` and appends weekly reports as comments. If the issue is closed by a maintainer (signaling "stop tracking this"), the workflow creates a new one on the next run. This is the desired behavior — closing the issue is the soft way to say "I'm aware, I'll re-engage later." Comments accumulate on a single issue rather than creating a new issue per run.

**Could the CI workflow fail and block other CI?**

No. The workflow is its own job in its own file with no dependencies on other workflows. A failure is visible in the Actions UI but doesn't gate any other PR or push.

## Under-block analysis

**What does the weekly audit NOT catch?**

- Same content-quality limitations as the per-PR coverage check — a documented capability with completely wrong content still counts as documented. The audit catches enumeration drift, not comprehension drift.
- Doesn't catch capabilities that exist outside the enumerated locations (e.g. an exported class moved to a directory the script doesn't walk). This is a deliberate scope choice; the alternative is walking everything and producing noise.
- Doesn't catch deleted docs that should still exist (the script measures coverage of what's in code; if code AND docs both lose a capability, neither shows up as drift).

## Level-of-abstraction fit

The job lives in `src/scaffold/templates/jobs/instar/` alongside the other default jobs. The CI workflow lives in `.github/workflows/` alongside other workflows. Both are at the right level: the job is at the agent-behavior layer (something the agent does), and the workflow is at the project-infrastructure layer (something the project does to itself).

The script they both invoke (`scripts/docs-coverage.mjs`) was deliberately built first as a separate concern. This change layers two delivery mechanisms on top of it without modifying the script. If the cadence needs to change (daily, monthly), the script doesn't care.

## Signal-vs-authority compliance

Both surfaces are **signals**. Neither has authority to fail a build or block work. The per-PR coverage check from the docs-coverage spec is the authoritative gate. The weekly job and the weekly workflow are loud heads-ups, but they can't refuse to ship anything. The separation matches how other signal/authority pairs work in instar.

## Interactions with existing systems

- **`installBuiltinJobs()`** — picks up the new `docs-coverage-audit.md` template on every install/update. Existing agents get the template (off by default) on their next update via `PostUpdateMigrator`. No separate migration code needed because `installBuiltinJobs` already overwrites built-in templates idempotently.
- **Scheduler** — sees the new job. With `enabled: false`, the scheduler reads it on startup but doesn't schedule it for execution. No CPU cost.
- **GitHub Actions cron** — runs in the same project as other workflows but in its own job and on its own schedule. Doesn't share state with any per-PR workflow.
- **Telegram adapter** — the job uses the same `telegram-reply.sh` path every other job uses for outbound messages. No new adapter integration.
- **Docs-coverage script** — invoked via `node scripts/docs-coverage.mjs`. The script is deterministic and idempotent, safe to run repeatedly.

## Rollback cost

Trivially reversible. Remove the two added files. Existing agents lose the template on their next update; the workflow stops running on the next merge.

## Risk summary

- **Low risk of regression.** Pure additions. Job is off by default; workflow runs independently of any other workflow.
- **Low risk of friction.** Job stays silent most weeks. Workflow posts to one standing issue rather than spraying alerts.
- **No risk of data loss.** Both surfaces are read-only against the codebase.

## Verification done before commit

- Job template parses correctly (verified via reading frontmatter in test fashion).
- CI workflow YAML validates against GitHub Actions schema (manual review).
- The underlying script (shipped in the docs-coverage spec) is already tested and verified — no changes needed.
- `enabled: false` confirmed in the template so this lands silently for existing agents.
- Distribution path verified: `installBuiltinJobs()` walks `templates/jobs/instar/` and installs all `.md` files regardless of `enabled` flag, so the file reaches every agent on update; the `enabled: false` controls whether the scheduler runs it.
