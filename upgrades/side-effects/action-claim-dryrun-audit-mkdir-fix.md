# Side-effects review — action-claim dryRun audit mkdir fix

## Change

`src/server/routes.ts`, `POST /action-claim/observe` dry-run branch (minted-id
Slack lane, §8.1): add `fs.mkdirSync(path.dirname(logPath), { recursive: true })`
immediately before the best-effort `fs.appendFileSync` that writes the
`would-register` audit line to `logs/action-claim-observe.jsonl`.

## Files touched

- `src/server/routes.ts` (one added line inside the existing dry-run `try` block)

## Side-effects analysis

- **Filesystem**: now creates the `logs/` directory if absent (idempotent,
  `recursive: true`). Previously the append silently failed via the swallowing
  `catch` when the directory did not exist. No new files beyond the audit log
  the feature already intended to write.
- **Response contract**: unchanged. The route returns the identical
  `{ observed: true, registered: false, dryRun: true, wouldRegister: true, ... }`
  body. No status-code change; never-500 guarantee preserved (the `mkdirSync`
  is inside the same `try/catch`).
- **Live path**: untouched — the non-dry-run branch calls `record()` and never
  reaches this code.
- **Migration / config / hooks**: none. No config keys, no settings, no CLAUDE.md
  template surface, no operator-facing change.
- **Security**: none. Directory is created under the agent's own state tree with
  default permissions, same as the sibling audit writers.
- **Concurrency**: `mkdirSync(..., { recursive: true })` is safe to call
  repeatedly and from concurrent requests (no-op when the dir exists).

## Test impact

Fixes `tests/integration/action-claim-route.test.ts` → "dryRun → would-register
audit line, NO row", which failed in clean CI environments because
`<os-tmpdir>/logs/` did not pre-exist. No test was modified or skipped; the code
was fixed to satisfy the existing assertion.

## Causal autopsy

Origin: new-code. The dry-run audit-write branch was introduced by this same PR
(slack-followthrough-generalization) and shipped with the missing `mkdirSync`.
The failure is a latent bug in that new code, masked locally by a leaked
`logs/` directory in the OS temp dir.
