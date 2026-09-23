# Job-completion audit: per-job opt-out now actually reaches the scheduler

## What Changed

`completionAudit` and `declaredEffects` are declared in a job's markdown
frontmatter, but the scheduler does not read frontmatter at runtime — it reads
the per-slug manifest JSON written at install time. Neither field was carried
through `buildPerSlugManifest()` or mapped in `installBuiltinJobs()`, so both
were silently inert on every installed job.

Two consequences, both real:

- A job declaring `completionAudit: excluded` was still captured. That includes
  the audit's OWN batch job (`jev-completion-audit`), whose template carries
  `completionAudit: excluded` precisely so the auditor never audits itself.
- A job declaring `declaredEffects` got no effect verification, so its audit
  evidence fell back to output-only — the weaker signal the field exists to
  replace.

Both fields are now carried into the installed manifest (`completionAudit`
through a closed-set check, `declaredEffects` filtered to strings).

## Evidence

Two regression tests in `tests/unit/jev-audit-wiring.test.ts`:

- `buildPerSlugManifest` carries both fields.
- `installBuiltinJobs()` writes `.instar/jobs/schedule/jev-completion-audit.json`
  with `completionAudit === 'excluded'` — the test reads the INSTALLED artifact
  rather than the source template, which is the assertion shape that would have
  caught this originally.

The defect was found by inspecting the manifest that landed on a live machine
after #2036 merged, not by a failing test.

## What to Tell Your User

If you turn on the scheduled-job completion audit, a job that says "don't audit
me" is now genuinely skipped, and a job that names the files it should produce
gets those files checked. Before this, both settings were written down but never
read — including the audit's own batch job, which would have audited itself.

## Summary of New Capabilities

None — this repairs two existing job settings that were never wired through to
the running scheduler.
