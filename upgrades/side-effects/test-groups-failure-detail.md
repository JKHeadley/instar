# Side effects: Telegram test-group failures carry Telegram's own code and type

## What changed
`TelegramTestGroups` keeps the `code` and `type` that the page script already returns on a failed step (validated by
`parseFailure`: a safe integer and `^[A-Z_0-9]{1,48}$`) for the current operation, and adds them to the generic
`test-group-failed` reply and to the operation's outcome audit line (`failure: {code, type, step}`). Cleared when the next
operation is admitted.

## Why
First live run on the Studio, 2026-11-09 08:12 PST: `GET /telegram/browser/justin-telegram/test-groups` answered
`{"error":"test-group-failed","step":"list"}` twice; the audit line said only `test-group-failed`. The page result held the
reason and the server dropped it, so the failure could not be diagnosed.

## Review
1. Over-block: none; no decision changes.
2. Under-block: none; same refusals.
3. Level: the orchestrator is where the page result is parsed; the fields were already validated there.
4. Signal vs authority: diagnostic data only.
5. Interactions: audit reader requires only `at` and `op`, so the extra key is read fine; flood-wait and rollback paths unchanged.
6. External surfaces: two optional fields in an error body seen only by the agent session; no page text, ids or hashes.
7. Multi-machine: unchanged (profile is machine-local by its login).
8. Rollback: revert; no state.

## 6b. Operator-surface quality
Not an operator surface: an agent-facing error body and an audit file.
