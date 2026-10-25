# Side-Effects Review — Jev audit: carry the manifest vocabulary

**Version / slug:** `jev-audit-manifest-vocabulary`
**Date:** `2026-09-22`
**Author:** `echo`
**Second-pass reviewer:** `not required (Tier 1; restores declared behaviour, adds no decision surface)`

## Summary of the change

`buildPerSlugManifest` and `InstallBuiltinJobs` did not carry
`completionAudit` / `declaredEffects` into the per-slug manifest. The loader
(`manifestToJobDefinition`) reads BOTH from the manifest, never the body
frontmatter, so every declaration was silently inert — including the
`jev-completion-audit` built-in job's own `completionAudit: excluded`, which
exists so the auditor never audits itself. Found by reading the INSTALLED
manifest on this agent after the merge (`completionAudit: null`), not by the
suite.

## Decision-point inventory

- *(none)* — this restores declared data flow. The audit still decides nothing;
  the only behavioural difference is that a job's opt-out and declared effects
  now take effect as the approved spec states.

---

## 1. Over-block

The batch job now genuinely excludes itself, which is the intended exclusion.
A job declaring `excluded` is skipped — again as declared. No legitimate input
is newly rejected: unknown values still fall through to `undefined` (eligible),
and `validateManifest` already refuses bad values by name at load.

## 2. Under-block

`declaredEffects` reaching runtime means the audit now performs the jailed stat
checks it always specified; the jail (load-time refusal + audit-time lstat/
realpath containment) is unchanged and already tested.

## 3. Level-of-abstraction fit

The fix sits in the producer (installer) and the shared manifest builder, which
is where every other pass-through field (`mcpAccess`, `perMachineIndependent`)
is carried. No new mechanism.

## 4. Signal vs authority compliance

Unchanged: verdicts remain unconsumed. This only stops a declaration being lost.

## 5. Interactions

The built-in job installer is idempotent and rewrites manifests on update, so
deployed agents pick the field up on their next update with no migration.
Manifests that predate this keep working (absent = eligible).

## 6. External surfaces

None. The self-exclusion REDUCES egress (the audit no longer audits its own
runs during a soak).

## 7. Multi-machine posture

Unchanged — machine-local, `hardware-bound-resource`: each machine installs and
reads its own manifests.

## 8. Rollback cost

Revert; the fields return to being ignored. No data migration, no state repair.

## What would have caught it

A test that reads the INSTALLED manifest rather than the template. That test is
added here, alongside a builder-carry unit test.
