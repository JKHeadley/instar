# Combined Luna fixes: two CI checks made green (ELI16)

The combined submission of Luna's multi-machine fixes failed two automatic checks on GitHub.

1. **The "no silent fallbacks" counter.** The repository counts every place where an error is caught and quietly ignored, and refuses any change that raises the count. Three new error handlers in the login-list migration ignore errors on purpose: a machine that has no identity yet, a migration record that does not exist, and a legacy file that cannot be read. Each of these is a normal, expected state, and each already falls back in the safe direction. They now carry the required explanatory note inside the handler, so the counter is back at its baseline. No behavior changes.

2. **Documentation coverage.** The repository requires a minimum share of its code classes to be mentioned in the public docs. A new background worker that scans Codex usage files had no mention, which pushed the share just below the floor. The token-ledger section of the observability docs page now names the Codex rollout parser and the worker and says what they do.

Nothing about how the agent runs changes; these are comments and documentation only.
