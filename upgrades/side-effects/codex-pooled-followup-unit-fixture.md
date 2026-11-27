# Side-effects review for the pooled Codex unit fixture

Tier 1. The diff changes two test files and release documentation. All 11 focused unit cases passed.

The stub handles the fixture executable and exact account query. Other subprocess calls delegate to the real implementation. The shell remains in the shared fixture for integration and end-to-end tests. The production resolver, time limit, and account boundary are outside the patch.

An explicit timeout returns no transcript and refuses the attempted delivery. The success cases still resolve a temporary transcript, including when the account directory ends in a space. Reverting these two test-file changes restores the former shell-dependent unit check. No data migration is required.
