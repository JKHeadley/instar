# Hermetic local unit suite — ELI16

> The one-line version: local unit tests should mean the same thing on a developer's live-agent machine as they do in CI.

## The problem in one breath

The unit suite was green in CI but red on a real developer box running a live Instar agent on Node 25. That makes local evidence unreliable: a developer can run the same nominal unit command and get failures caused by their installed agent's config, tunnel state, native-module state, or runtime load rather than by the code under test. This change keeps the suite honest by fixing the places where the local machine leaked into tests, while preserving the assertions that caught real behavior.

## What already exists

Instar already has a large Vitest unit suite, and CI runs it in a cleaner environment than a dogfooding developer machine. The repo also already has a watchdog bind probe, tunnel-manager tests, config loading tests, package export tests, and generated built-in manifest checks. Those tests are valuable because they catch real regressions, but they should not depend on the operator's active `.instar/config.json`, active tunnel lifecycle, current framework selection, or whether Node 25 has freshly rebuilt native modules.

## What this adds

This patch makes the local-red cases reproducible and isolated. The watchdog template now handles the no-auth health probe path explicitly, so an empty auth argument array cannot accidentally influence the curl invocation. The config tests pin the fixture's framework to `claude-code` when they are asserting `claudePath`, so a live Codex dev agent does not legitimately resolve the selected framework binary and fail a Claude-specific assertion. The coherence-gate export tests use static imports instead of repeated cold dynamic package imports, removing a full-suite timeout that appeared only under serial Node 25 load.

## The new pieces

- **Watchdog no-auth probe fix** — a tiny shell-path correction in the shipped watchdog template. It does not add a new decision; it makes the existing health probe call match the existing intent: send auth headers only when an auth token exists.
- **Framework-explicit config fixtures** — test data now says which framework it is asserting. That keeps the test about config preservation, not about the developer machine's selected framework.
- **Static export verification** — the export test still verifies the same public exports, but it avoids expensive dynamic imports during the full suite.

## The safeguards

No test was skipped, suppressed, or loosened. The tests still assert the same observable behavior: no auth header in the no-auth watchdog path, custom config paths are preserved, and the package exports are present and typed. The tunnel-manager and worktree-detector failures found earlier were absorbed by current main's newer provider/cwd seams, and the focused validation keeps those files in the evidence set so that rebase did not hide them.

The generated built-in manifest failure from the first full run is recorded as a generated-artifact priming issue: the manifest test rewrote the ignored manifest, and the immediate targeted rerun passed. That does not become a committed source artifact and does not justify changing the assertion.

## What ships when

This ships as a small Tier-1 fix: one runtime template bug fix plus two unit-suite isolation changes. The next queued transcript-auditor build remains separate and should not be mixed into this PR.

## What you actually need to decide

Approve this if the local unit suite should be trusted as evidence on a live developer machine without skipping tests or weakening the assertions that found the leaks.
