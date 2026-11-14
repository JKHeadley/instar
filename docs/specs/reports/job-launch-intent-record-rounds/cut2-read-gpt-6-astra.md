- **DESIGN — Another field projection is missing.** `scripts/regen-default-job-templates.mjs:42` (`frontmatterFor`) explicitly selects fields from `getDefaultJobs()` entries. It would discard `thinkingMode` before `InstallBuiltinJobs` receives the template. The proposed round-trip test starts downstream of this generator, so it cannot detect that loss. Add the generator and a generation→installation→load assertion. Deferring built-in opt-ins to the pilot does not establish the promised preservation across definition paths.

- **PRECISION — The dashboard claim is false.** Testing says “no dashboard view shows run history.” `dashboard/index.html:9004` fetches and renders `/jobs/:slug/history`, and `dashboard/console/schedule.js:195` also consumes it. State that this change adds no dashboard presentation of `launch`, if that is the intended boundary; justify the proof exemption on that narrower basis.

- **PRECISION — Review provenance remains stale.** `docs/specs/reports/job-launch-intent-record-convergence.md` still identifies `c5fd5704…`, describes day-alternating arms and a script-computed graduation floor, and declares readiness for approval. Those claims do not describe the reviewed `5ab6a46e4dc78752f5be63c70d9c072bd8fd39ad90799450bb5bfbde650dc29e` artifact. Update or explicitly supersede that report before owner review.

The two previous DESIGN fixes hold **at spec level**: §1 now explicitly covers `jobMigrate.ts:164` and the portable bundle’s shared export/import whitelist, with preservation testing. The truncation order, missing-launch no-op, cap exceptions, reroute capture points, Codex argument placement, and retainer-null fallback are now consistent with the inspected source.

Both spec copies match the stated hash. The builder mappings, main/script/triage recording boundaries, and latest-row-copy update strategy check out. No files were edited.

VERDICT: NOT CONVERGED