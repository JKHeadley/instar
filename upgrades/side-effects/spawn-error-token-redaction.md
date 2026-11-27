# Side-Effects Review — Spawn error token redaction

**Version / slug:** spawn-error-token-redaction
**Date:** 2026-11-06
**Author:** Echo
**Second-pass reviewer:** two independent general-purpose subagents (spawn_error_review, spawn_error_rereview)

## Summary of the change
Tier 1 narrow bug fix for #2184. Session spawns pass credentials to `tmux new-session` as argv (`-e GH_TOKEN=…`, `-e INSTAR_AUTH_TOKEN=…`, provider keys, bind/fencing tokens). When tmux fails, Node's execFileSync error message is `Command failed: <every argv element>\n<stderr>`. SessionManager wrapped that in `Failed to create tmux session: …` after removing only origin (`ior1_`) tokens, and POST /sessions/spawn returned it verbatim as `{ error }`. New `src/core/redactSpawnError.ts` discards the message from `Command failed:` onward (so a multi-line argv element such as a prompt cannot carry argv past a line break) and uses the child-process error's own `stderr` field, when it carries one, as the reason, keeps exit status / signal / code and a stderr excerpt, scrubs `NAME=value` assignments, the shared `scrubSecrets` shapes and origin tokens, and caps the excerpt at 500 characters. `SessionManager.originSpawnError` (used by all four new-session sites) now delegates to it; the `/sessions/spawn` and `/sessions/refresh` catch blocks apply it again before responding. The anthropic-headless and openai-codex `agenticSessionHeadless` transports had the same pattern (raw argv message, with `ANTHROPIC_API_KEY` / OAuth `-e` values, thrown in an `UnexpectedError` that also carried the raw error as `cause`); they now use the helper and no longer attach the raw error. Tier 1 because it changes only error text and a revert fully undoes it; it adds no credential handling.

## Decision-point inventory
- None added. Spawn success/failure, retries and capacity refusal are unchanged; only the failure message text changes.

## 1. Over-block
Nothing is blocked. Risk is over-redaction of diagnostics: everything from `Command failed:` on is removed, so a re-wrapped message that has lost its `stderr` field also loses tmux's reason, so the error no longer names the tmux binary or flags, and stderr `UPPER_CASE=value` text is redacted. The exit status and tmux's own stderr reason ("duplicate session", "no server running", "command too long") remain, which is what an operator needs. No code parses the spawn error text (checked: no test or caller matches on it).

## 2. Under-block
A secret written by tmux to stderr in a shape neither `scrubSecrets` nor the `NAME=value` rule recognises would still pass through, bounded to 500 characters; tmux does not echo environment values on failure. Errors that are not child-process failures (e.g. capacity refusal) pass through with the same scrub applied. Secrets remain in tmux argv itself (visible to same-user `ps`) — a separate, pre-existing exposure not introduced or widened here.

## 3. Level-of-abstraction fit
The existing chokepoint `originSpawnError` already sat on every spawn failure path; the fix widens it rather than adding per-site code. It reuses `monitoring/scrubSecrets` for token shapes. The route-level call is defence in depth for errors thrown before the chokepoint.

## 4. Signal vs authority compliance
Required reference: docs/signal-vs-authority.md. No signal or authority is introduced; this is output sanitisation.

## 4b. Judgment-point check
No judgment point; deterministic text transform.

## 5. Interactions
`revokeOriginSession` still runs before the throw. The two provider transports' `UnexpectedError` no longer has a `cause`; nothing in src or tests reads it for these errors. Callers that log or forward the thrown message (routes, scheduler, triage) now receive the redacted text. Capacity-refusal errors are a separate class and still propagate their own message. No state, timers or I/O added.

## 6. External surfaces
HTTP 500 bodies of POST /sessions/spawn and /sessions/refresh change wording: `error` now reads `Failed to create tmux session: tmux new-session failed (exit status N): <stderr>`. The response shape and status codes are unchanged.

## 6b. Operator-surface quality
Operators see a shorter error that still states tmux's reason and no credential.

## 7. Multi-machine posture
Machine-local BY DESIGN: a pure function applied where the error is created on the spawning machine. Nothing is replicated.

## 8. Rollback cost
Code revert only; no data or config. Rollback reintroduces the leak.

## Validation
`tests/unit/redactSpawnError.test.ts` (7) exercises a real child-process failure with fake classic and fine-grained GitHub tokens in argv and in stderr, including argv that continues past a multi-line element. `tests/unit/spawn-error-token-leak.test.ts` drives `SessionManager.spawnSession` with a failing tmux mock and a GH_TOKEN in argv; run against the original SessionManager it fails on `expected 'Failed to create tmux session: Error:…' not to contain 'github_pat_11…'`, and passes with the fix. `tests/unit/headless-spawn-reroute.test.ts` (53) and all `tests/unit/providers` tests still pass (41 files, 493 tests together with the new ones). `tsc --noEmit` and `npm run lint` pass. Full unit suite on this host: 72 files fail, all of them also failing with this change set aside (same files; per-test differences are run-to-run flakes). Causes are host-environmental: EACCES on ACL-restricted temp paths, SourceTreeGuard refusing the temp location, and a media disk-space floor on the 4 GiB worktree volume. CI is the authoritative full run.

## Independent second pass
spawn_error_review: Concur with the review. Verified all four new-session catch blocks route through `originSpawnError`, that no raw spawn error reaches a log or DegradationReporter before redaction inside SessionManager, that the routes' second redaction is harmless, that no caller parses the spawn error text, and reran the new tests 7/7. Non-blocking notes, both addressed in this PR: (1) a newline inside an argv element left later argv in the message, now handled by preferring the error's `stderr` and covered by a test; (2) the anthropic-headless and openai-codex transports leaked argv the same way, now routed through the helper with the raw `cause` dropped.

spawn_error_rereview (fresh reviewer, final diff): Concur with the review. Rechecked every token-carrying new-session path in SessionManager and both transports (all use `encoding: 'utf-8'` with piped stderr), the route second pass, Buffer stderr and ENOENT probes, and that nothing parses the text or reads the removed `cause`; focused tests passed. Noted that an error with no `stderr` field and a multi-line argv element still kept post-newline argv; the helper now drops everything from `Command failed:` on in every case, with tests updated.
