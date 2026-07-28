# Side-Effects Review — Worktree-safe Telegram relay recovery

**Version / slug:** `telegram-reply-worktree-home`
**Date:** `2026-07-10`
**Author:** `instar-codey`
**Second-pass reviewer:** `framework_guard_review`

## Summary of the change

The canonical `telegram-reply.sh` now resolves its owning agent home from explicit `INSTAR_AGENT_HOME`, otherwise from the exact `/.worktrees/` path marker, otherwise from the unchanged current directory. Config reads and recovery queue writes use that home. Recovery refuses an `unknown` agent id loudly before creating state. PostUpdateMigrator registers the v1.3.813 template SHA so existing unmodified installs receive the fix. Integration and migration tests cover all boundaries.

## Decision-point inventory

- Agent-home resolution — modify — explicit launcher state wins; only a structural worktree marker permits walk-up.
- Recoverable relay enqueue — modify — known agents retain durable enqueue; unknown identity exits non-zero without an undrainable store.
- Existing-script migration — modify — the current shipped SHA becomes an allowed predecessor for safe backup-and-replace.

## 1. Over-block

A recoverable relay attempt with a genuinely missing `projectName` exits non-zero rather than queueing locally. This is intentional because a live server cannot drain an `unknown`-keyed queue. The message remains in the calling transcript and the stderr reason is explicit. Agent ids literally named `unknown` are also refused; that reserved value is already the absence fallback and cannot safely identify a drain owner.

## 2. Under-block

An incorrectly supplied but non-empty `INSTAR_AGENT_HOME` can still point at the wrong agent; launcher-provided identity is authoritative and this script cannot independently authenticate filesystem ownership. A cwd with a nonstandard worktree layout lacking the exact marker remains unchanged rather than guessed upward. Customized deployed relay scripts are preserved and receive a `.new` candidate, so their operator must reconcile the update through the existing degradation path.

## 3. Level-of-abstraction fit

The fix lives in the installed relay template because both the config lookup and recovery path are shell-side before the server can participate. It reuses the existing PostUpdateMigrator hash-safe deployment authority rather than adding another installer. The narrow structural marker is the least-powerful resolver that covers the defined worktree convention without cross-tenant discovery.

## 4. Signal vs authority compliance

Required reference: [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] This is hard-invariant validation at a transport boundary, not a judgment about message meaning.

The unknown-id refusal has deterministic blocking authority because a queue keyed `unknown` is mechanically undrainable. It does not classify conversational content or intent. The worktree resolver likewise selects from explicit structural ownership signals and performs no semantic judgment.

## 5. Interactions

- **Shadowing:** home resolution runs before config-derived port/auth/id values, so all later paths share one owner. Explicit port/auth environment overrides keep their existing precedence.
- **Double-fire:** the change prevents an orphan queue from later double-firing; known-id enqueue and delivery-failed emission retain their existing single path and delivery id.
- **Races:** the change introduces zero shared mutable structures. The queue retains its existing SQLite concurrency and permission behavior.
- **Feedback loops:** a refused unknown-id attempt cannot enter the redrive loop; it remains loud in the caller transcript instead.

## 6. External surfaces

Worktree-launched Telegram replies now reach the correct local server and recovery database. Unknown-id failures gain a clearer stderr explanation and non-zero status; they create zero persistent database files. Existing unmodified agent scripts are backed up and replaced on update. Routes, credentials, network destinations, and operator actions remain unchanged.

## 6b. Operator-surface quality

Operator surface unchanged; this criterion is not applicable.

## 7. Multi-machine posture

**Machine-local by design:** an agent home, server port, auth injection, and pending-relay database belong to the machine executing the script. The message route continues to use the local owning server, whose existing messaging layer handles user delivery. The change emits zero additional notices, creates zero cross-machine durable records, leaves topic transfer unchanged, and generates zero URLs.

## 8. Rollback cost

Pure script/template and migration-allowlist rollback: revert and ship a patch. Correctly queued rows remain compatible with the existing drain path. Schema and state repair are unnecessary. A rollback would reintroduce the worktree orphan risk until deployed scripts update again.

## Conclusion

The fix closes both halves of issue #1086 without broad filesystem discovery: worktree sessions resolve the owning agent home, and identity-less recovery fails visibly instead of persisting an undrainable ghost. Normal cwd behavior and customized-script preservation remain intact. Clear to ship after independent messaging-path review and CI.

## Second-pass review

**Reviewer:** framework_guard_review
**Independent read of the artifact:** concur

Home resolution is conservative and correctly ordered: explicit launcher home, exact `/.worktrees/` structural owner, then unchanged cwd. Config and recovery state share that owner; unknown identity stays transcript-visible, exits non-zero, and creates no undrainable queue. The v1.3.813 template SHA matches the migration allowlist entry, customized scripts retain the `.new` path, and the reviewer's focused suite passed 26/26.

## Evidence pointers

- `tests/integration/telegram-reply-end-to-end.test.ts`
- `tests/unit/PostUpdateMigrator-telegramReply.test.ts`
- `tests/unit/lint-template-sha-history.test.ts`
- `tests/unit/migration-relay-script-hash.test.ts`
