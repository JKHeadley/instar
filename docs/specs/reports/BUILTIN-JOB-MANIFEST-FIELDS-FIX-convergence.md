# Convergence Report — Built-in job manifest missing required fields

**Spec:** `docs/specs/BUILTIN-JOB-MANIFEST-FIELDS-FIX.md` · **Converged:** iteration 2 (0 material findings)
**Mode:** abbreviated (surgical bug fix) — internal reviewers (lessons-aware [mandatory], integration, adversarial); externals skipped per abbreviated-convergence allowance.

## ELI10 overview

Every Instar agent's automatic background jobs (health check, reflection, the evolution pipeline,
the overseers) quietly stopped loading about a week ago. Each job has a settings file (`.md`) and a
little "index card" (`.json` manifest) the scheduler reads first. The code that writes the index
card was leaving out three required fields — including how important the job is — so the scheduler
rejected every built-in job as invalid. On the agent we checked, the loaded-job count is literally
zero, with 1,200+ rejection lines in the log since ~May 20.

The fix has the index-card writer copy those fields off the settings file (where they already live),
and — because the writer rewrites every card on each update — it automatically repairs broken cards
fleet-wide on the next update. The review made the fix considerably more robust than first drafted.

## Original vs converged (what the review changed)

- **Found a second broken writer.** The review caught that `jobMigrate.ts` has the identical bug and
  corrupts *user* jobs, which the built-in self-heal never reaches. The fix now covers both writers.
- **Turned a runtime bug into a compile-time one.** Instead of two hand-rolled writers that can each
  silently drift from what the loader requires, the fix introduces ONE shared, typed
  `buildPerSlugManifest(): PerSlugManifest` helper — so dropping a required field becomes a `tsc`
  error, not a fleet-wide outage.
- **Rejected the "be lenient" instinct.** The first draft floated defaulting a missing priority to
  `medium`. All three reviewers converged that this inverts the lesson — it converts a loud,
  diagnosable failure into a silent one (a `critical` health-check silently demoted). Replaced with
  producer-only + a producer-side self-check that validates its own output and fails loud.
- **Raised the evidence bar.** Added reproduce→verify (pin the bug with a round-trip test that the
  OLD shape FAILS the loader), tightened the "jobs are alive" check from `>0` to
  `>= shipped-count` + zero validation problems, and made live before/after on Echo's real server
  (jobCount 0 → ≥N) a mandatory gate.

## Iteration summary

| Iter | Reviewers | Material findings | Changes |
|------|-----------|-------------------|---------|
| 1 | lessons-aware (5), integration (5), adversarial (6) | consolidated ~8 distinct | second producer (jobMigrate); shared typed helper; reject consumer leniency → producer self-check; pass-through fields; coercion guard; evidence-bar + live-on-Echo; tightened E2E; migration-parity citation; lockfile-unaffected note; operator-customization policy |
| 2 | lessons-aware, adversarial (confirming) | 0 | none |

## Convergence verdict

Converged at iteration 2. Both reviewers verified every prior finding RESOLVED against the actual
source and found no new material issues. The spec is ready for user review and approval.
`approved: true` is the user's step.
