### dev-preflight-new-surface-friction-guard side effects

Primary risk reviewed: a developer convenience command could become hidden authority over route
classification.

Decision inventory:

- `instar dev:preflight` is verify-only and has no write path.
- The command never edits `src/server/CapabilityIndex.ts`.
- The command never mutates route files or server config.
- The command exits nonzero only for `pnpm lint` or the explicit
  capabilities-discoverability/CapabilityIndex test invocation.
- Diff route-prefix findings are advisory warnings only.
- Diff lookup failure is a warning, not a failure, because the canonical guard remains the
  discoverability test.
- `SafeGitExecutor` now includes `diff` in the explicit `sourceTreeReadOk` read-tier set so this
  command can inspect the current Instar checkout without bypassing the safe git funnel.

Secondary risk: the heuristic could miss routes or flag false positives because it is regex-based.
That is acceptable by design. The heuristic is early friction for authors, not the source of truth.
The source of truth remains the existing CapabilityIndex registry and its unit tests.

Operational risk: running the command can be slow because it runs lint and a targeted Vitest
invocation. This is deliberate; the command is a contributor preflight, not a server path or
background job.
