## What Changed

Follow-up to the built-in job-template auth fix. That change repaired the shipped `.md` templates; this repairs the **canonical source that generates them**. `src/scaffold/templates/jobs/instar/*.md` are produced from `getDefaultJobs()` in `src/commands/init.ts` via `scripts/regen-default-job-templates.mjs`, so the earlier fix was applied to generated output while the generator's input stayed broken — a regen would have silently reverted it (confirmed with the generator's `--dry-run`, which lists all five previously-fixed templates as regeneration targets).

- **13 unauthenticated calls** in canonical job definitions now carry `Authorization: Bearer $AUTH` + `X-Instar-AgentId`. Twelve mirror the prior fix; the thirteenth — `feedback-retry` → `POST /feedback/retry` — was found by the new guard and confirmed live as a 401.
- **12 config-only token reads** (`AUTH=$(python3 … config.json …)`) replaced with the env-first `${INSTAR_AUTH_TOKEN:-…}` form, across `reflection-trigger`, `memory-export`, `capability-audit`, `identity-review`, `commitment-detection`, and six CLAUDE.md-template instruction blocks. A config-only read is rejected outright on an agent whose stored token has drifted from the running server's.
- **The reflection activity digest** (ACT-620) fixed in both callsites, and it was worse than reported: in the `.md` the jq program is a **compile error** (interpolation backslashes lost), silenced by `2>/dev/null`, so every reflection ran on an empty digest. The filter excluded `job-start`/`job-queued`, which never occur — real types are `job_triggered` / `job_gate_skip` / `job_skipped` — and the text slot read `.message`/`.title`/`.session_name`/`.slug`, none of which exist; the real keys are `.summary` and `.metadata.slug`. Now filters the real noise types, reads the real keys, and prints a type-count summary so job volume is visible without consuming the 100-line budget.
- **The auth lint now covers the canonical source**, by resolving `getDefaultJobs(4042)` and linting the real `gate` + `execute.value` strings rather than regexing file text.

## What to Tell Your User

Reflection runs have been producing an empty activity digest — every reflection was working from a blank page, and the failure was silenced. Reflections will now see real recent activity. As with the prior fix, jobs that were quiet because they were failing will start producing output; that is the repair, not a new fault.

## Summary of New Capabilities

No new user-facing capability. Thirteen job bodies go from silently 401-ing to functional, reflection digests go from empty to populated, and the build-time guard now covers the source that generates the shipped templates.

## Evidence

- Guard proven to bite: with `init.ts` reverted to `origin/main`, the canonical-source test fails listing 13 unauthenticated calls (`reflection-trigger`, `feedback-retry`, `insight-harvest`, `evolution-overdue-check`, `evolution-proposal-evaluate`, `evolution-proposal-implement`); the config-only-token test fails with 12. Both pass on the fixed tree.
- The guard's own first version passed **vacuously** — it regexed raw `init.ts`, whose bodies carry `localhost:\${INSTAR_PORT:-${port}}`, which its pattern never matched. Rewritten to lint resolved job objects, with a sample-size assertion so an empty resolution can never read as clean. The rewrite then found the `feedback-retry` defect.
- Live: unauthenticated `POST /feedback/retry` returns `{"error":"Missing or invalid Authorization header"}`; authenticated returns `{"ok":true,"retried":0,"succeeded":0}`.
- Shipped jq confirmed a compile error against a real activity log; corrected jq emits real `scheduler_start`/`scheduler_stop` rows with summaries plus `462 job_triggered / 33 job_gate_skip / 3 scheduler_start / 2 scheduler_stop`.
- Real log census: keys are `type`, `timestamp`, `summary`, `metadata`, `sessionId`; types are `job_triggered`, `job_gate_skip`, `job_skipped`, `scheduler_start`, `scheduler_stop`.
- Generated bash for the reflection echo extracted from the resolved job object and executed: renders `-d '{"type":"quick"}'` with `$INSTAR_AUTH_TOKEN` left unexpanded.
- `tsc --noEmit` clean; auth lint (11 tests), `default-jobs-valid`, `refresh-jobs` green.

Remaining general byte-parity between generated templates and their generator source is tracked as ACT-1263 <!-- tracked: ACT-1263 --> rather than folded in — reconciling all 14 generated templates is a distinct change with its own review surface.
