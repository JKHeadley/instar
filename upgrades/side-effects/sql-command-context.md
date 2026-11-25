# Side-Effects Review — SQL command context

**Tier:** 1 narrow reversible false-positive repair, SMALL with dedicated safety review. **Author:** Instar Agent (echo).

## Summary

The existing whole-input SQL-shaped matcher refused literal rg searches and source-writing text. A shared embedded Python context check now exempts only recognized literal data operations before the original SQL action. New/update writers import the same snippet; standalone template contains identical bytes. Original patterns, safety levels and all non-SQL decisions are preserved per writer. Baseline actual 27 selected literal cases failed across all three writers; 24 other cases were excluded by selection.

## Decision-point inventory

The original SQL matcher retains authority for anything not recognized as literal data. New recognition is intentionally small and bounded: standard data commands without uncertain expansion, literal shell wrappers, one structurally quoted heredoc with safe trailing commands, and a typed subset of Path/string Python operations. No new permission, automatic action, remote request or live installation change.

## 1. Over-block

Unknown syntax/programs, variables, globs, comments, uncertain escape/operator forms, control/separator characters, environment overrides/configuration and unsupported Python retain original SQL matching and can still falsely refuse harmless commands. This conservative boundary is explicit. The repair does not claim a full shell interpreter.

## 2. Under-block

Incorrect recognition could skip a real SQL check. The classifier rejects active dollar/backtick/process substitutions, uncertain pathname/brace/tilde expansion, rg execution flags and inherited ripgrep configuration. It also rejects printf variable assignment, wrappers with shell startup configuration, and unsupported shell programs. Compound/piped commands must all satisfy the data check. Python values must be literals, proven strings/bytes or real Path expressions from exact known imports; rebinding/dynamic calls/other imports/statements fall back. Unknown or failed classification never skips the original check. Existing policy does not inspect arbitrary script-file contents or independently validate executable binaries; this does not expand that claim.

## 3. Level-of-abstraction fit

Command context belongs before the SQL-shaped text matcher. This patch leaves the existing catastrophic/credential/deployment/non-SQL authorities in place. It neither strips every quote nor grants an entire command based on its first word.

## 4. Signal versus authority

Reference: [signal versus authority](../../docs/signal-vs-authority.md). This corrects an existing deterministic input classifier, not a new competing policy. Uncertainty preserves the original SQL decision. Dedicated independent review and both sides of each recognized boundary are required before publication.

## 5. Interactions

The function is defined but invoked only after an existing SQL pattern matches; its result is cached per hook invocation. No extra interpreter process for ordinary commands without SQL matches. Hook stdin extraction is unchanged; positional JSON command/cmd/tool_input is normalized for context and description text is not promoted to execution. No changes to force-with-lease, catastrophic database flags or credential checks.

## 6. External surfaces

No network call, API, setting or credential is added. A matched SQL-looking command may spawn one local Python context check. Input length and nested shell depth are bounded; unknown/parse/read failure keeps original matching. Source text is never evaluated and test command contents are never executed. Existing block or self-verification messages remain unchanged.

## 7. Multi-machine posture

Machine-local by design: a command is classified on the machine receiving the hook call. Shipped init and always-overwrite update paths install the same shared classifier on each agent. Existing migration overwrites built-in hooks, preserves custom hooks and is checked twice for idempotence. No replicated state, authority, generated URL or one-voice notification.

## 8. Rollback

Normal revert and hook refresh restore the previous matching behavior. No data migration or queue repair. Existing and new agents must both receive the reverted hook through their normal paths.

## Review and verification

Reviewer sql_context_review identified argument-variable and glob expansion as execution uncertainty; those now retain the original check with regressions. Dedicated reviewer sql_context_review independently read the final implementation, all three writer paths, tests and artifact, and concurred after the argv, comment, operator, JSON and heredoc boundary corrections. No tests or classifier were run by the reviewer. Baseline 27 expected failures are preserved. Allocated GREEN passed all 158 unit cases across three files and all 32 native-hook integration cases. Lifecycle first failed because its stale-hook fixture was seeded with a non-installed file mode; the driver stopped and preserved that result. An independently reviewed fixture-only executable-mode correction retained the assertion and passed one lifecycle case under a fresh explicit allocation, with all other ten hashes unchanged. Normal build passed and compiled classifier bytes match frozen source. Complete coordinator verification remains required. Broader non-SQL patch-payload classification is a separate tracked next PR, ACT-501, due 2026-11-24T03:00Z; the rejected optional fixture edit remains unapplied and existing floor tests are included unchanged. Normal full verification remains required; no live safety hook is changed.

## Proportion

The source classifier is shared by two generated writers and copied into the standalone template; byte parity is enforced. The larger line count is mostly the conservative recognizer, its required template copy and boundary tests. This is one policy-context repair with one independent review, not unrelated hook cleanup.

## Class closure

No agent-authored-artifact defect. This is one existing hook evaluation per tool call with at most one context subprocess on a matching SQL input, no new autonomous loop, retry, notification, restart or state repair.
