# Feedback executor: confined Claude sessions start with `--no-chrome`

## What Changed

- `src/core/credentialEnvNames.ts`: `CLAUDE_CONFINED_PERMISSION_ARGS` gains `--no-chrome` (Claude Code's documented "Disable Claude in Chrome integration" option). `applyClaudeConfinement` splices this constant into every confined launch — the executor's canary and build sessions and the rerouted confined lane — so none of them shows the Claude in Chrome startup offer.

Why: on 2026-10-25 at 15:50 PDT the first executor canary on 1.3.1437 passed every runner probe and then the Claude session inside wrote no report and no transcript. Its last screen was Claude Code 2.1.303's startup offer "Claude in Chrome extension detected … No, keep browser tools off / Yes, use my browser". The startup state machine pressed Enter on the safe default 0.5 s after answering the trust dialog; the key did not take and each dialog is answered once by design, so the session sat on the question until the canary ended it and the executor latched for a day. The offer is per login: it appears when the login's config lacks `claudeInChromeDefaultEnabled: false` and the Chrome extension is detected on the machine, which is why the 12:48 canary (a different login) had not hit it. A confined session has no browser tools, so the question is removed at the source instead of answered faster.

- `tests/integration/subscription-relogin-runtime.test.ts`, `tests/e2e/subscription-relogin-lifecycle.test.ts`: each `createSubscriptionReloginRuntime` now gets a private `seatLease` file under the test's own state dir instead of the production default — the machine-wide `~/.instar/state/playwright-seat-lease.json`. A live browser user on the same machine held that seat during both of this PR's verify runs, so the drives answered seat-busy and 9 tests timed out; reproduced with a fake HOME holding a busy seat (7/8 fail before, 8/8 + 8/8 after). Production code unchanged.

## What to Tell Your User

The safety check before the feedback pipeline writes a fix was stopped by a start-up question from Claude Code about using the browser. Sealed sessions now start with browser tools switched off, so the question no longer appears.

## Summary of New Capabilities

None — one start-up flag; nothing a confined session may do changes.

## Evidence

Live, Claude Code 2.1.303 in tmux under a login without the Chrome flag: `claude --permission-mode dontAsk --tools Bash,Read` shows the browser offer right after the trust dialog; `claude --no-chrome --permission-mode dontAsk --tools Bash,Read` goes straight to the prompt. Unit: the three tests pinning the exact confined argv (`session-manager-confined-reroute`, `session-manager-confined-spawn`, `feedback-factory/execute-units`) include `--no-chrome`; 68/68 green; `tsc` clean. Side-effects review: `upgrades/side-effects/confined-no-chrome.md`.
