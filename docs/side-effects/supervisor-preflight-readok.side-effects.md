# Side-effects review — supervisor-preflight-readok

## Change surface

One callsite: `ServerSupervisor.preflightSelfHeal()`'s read-only
`SafeGitExecutor.readSync(['status'])` gains `sourceTreeReadOk: true`.
One test added (source-pattern pin, authored by Codey during the live
2026-06-05 incident).

## What could this affect?

1. **SourceTreeGuard exemption surface** — widened by exactly one read-only
   `git status` at one callsite. `status` mutates nothing. The guard still
   blocks every destructive verb (rebase --abort in the very next block still
   goes through the guarded `execSync` WITHOUT the opt-in, unchanged — a stuck
   rebase on a dogfooding agent's source tree still requires the guard's
   normal handling).
2. **Non-dogfooding agents** — zero change. The guard only activates when cwd
   is an instar source tree; for every normal agent this option is inert.
3. **Dogfooding agents (echo, codey, gemi)** — recovery preflight no longer
   aborts on the guard rejection; the stuck-rebase check actually runs for
   them now. Strictly more recovery coverage, not less.
4. **Failure path** — if `git status` itself fails for a real reason, the
   surrounding try/catch handles it exactly as before; this change does not
   alter error handling.

## What this deliberately does NOT do

- Does not touch the guard, the funnel, or any destructive operation.
- Does not generalize the opt-in (each callsite still opts in explicitly —
  per the guard's design).
- Does not port Codey's two other suggestions from the incident report
  (advisory-preflight fail-soft semantics; duplicate-vs-real-drop replay
  reporting) — those are real but separate, tracked via his feedback entry
  fb-f3bf0ed0-7e9.

## Rollback

Revert the one line + test. The runtime hot-patch on echo's installed copy
becomes irrelevant the moment any later release deploys (which is also why
this PR exists — the hot-patch alone cannot survive).
