# ELI16 — action-claim dryRun audit line: create the logs dir before writing

## What was broken

The Slack minted-id lane of `POST /action-claim/observe` (new machinery in the
slack-followthrough PR) has a dry-run mode. In dry-run the route does NOT create
a commitment row — instead it writes a single "would-register" audit line to
`<stateDir>/../logs/action-claim-observe.jsonl` so there's a durable trace of
what it *would* have done. That audit write is best-effort: it is wrapped in a
`try { ... } catch { /* audit is observability */ }` so a logging failure can
never break the route's "never-500" contract.

The bug: `fs.appendFileSync(logPath, ...)` does not create missing parent
directories. If the `logs/` directory does not already exist on disk, the append
throws `ENOENT`, the `catch` swallows it silently, and the audit file is never
written. The route still returns the correct `{ dryRun: true, wouldRegister: true }`
JSON, so nothing looks wrong — but the promised audit line is missing.

## Why it only showed up in CI

The integration test `action-claim-route.test.ts` ("dryRun → would-register
audit line, NO row") asserts the audit file exists. Each test run uses a fresh
`mkdtemp` directory under the OS temp dir, so the audit path resolves to
`<os-tmpdir>/logs/action-claim-observe.jsonl`. On a developer machine that
directory usually already exists — leaked there by an earlier test run — so the
append succeeds and the test passes locally. In a clean CI runner the `logs/`
directory does not exist, so the append silently fails and the assertion
`expect(fs.existsSync(auditPath)).toBe(true)` fails with `expected false to be
true`. That is exactly the intermittent-looking Integration Tests failure on the
PR.

## The fix

Add one line before the append: `fs.mkdirSync(path.dirname(logPath), { recursive: true })`.
This mirrors the exact pattern already used by every other audit-log writer in
`routes.ts` (e.g. the principal-coherence and correction-learning audit paths,
which `mkdirSync` their directory before appending). The write stays inside the
same best-effort `try/catch`, so the never-500 guarantee is untouched: if the
`mkdirSync` itself ever failed, the `catch` still absorbs it.

## Blast radius

Tiny and behavior-preserving. The change only affects the dry-run audit branch
of the minted-id lane. It does not alter any response body, does not create a
commitment row, and does not change the live (non-dry-run) path. The audit line
now reliably lands whether or not the logs directory pre-existed — which is the
behavior the feature always intended and the test always asserted.
