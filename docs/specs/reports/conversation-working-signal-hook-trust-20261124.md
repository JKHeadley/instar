# Managed Codex resume and hook trust

The review-only harness at the [working-indicator prototype](../conversation-working-signal-prototype.md) now tests trusted and changed hooks on a real Codex 0.171.0 TUI. It uses a disposable home, private Unix relay and tmux server, and the repository loopback-only model. It does not read or modify any live agent's Codex home or approvals.

## Observations

| Case | Codex `hooks/list` result | Managed resume |
|---|---|---|
| Hook had never been reviewed | `untrusted` | The native review prompt held the turn until the test explicitly selected approval in the disposable home. After approval, Stop blocked once and then allowed the turn; the working signal appeared and cleared. |
| Same hook after closing both processes | `trusted` | The original native thread reopened without another prompt. The same two Stop decisions occurred, the loopback model received two requests, and the signal appeared and cleared. |
| Approved hook command changed before reopening | `modified` | The native review prompt held the turn. There was no Stop receipt and no new model request. The fixture left the prompt unapproved. |

The read-only request queried the exact fixture project using a separate native app-server and checked the matching file entry, the presence of its current hash, and the returned trust state. It did not inject or compare local hashes itself. When the fixture reopened both children, it rotated the loopback provider to keep each server's existing four-request cap. The only config edit during this rotation was the loopback URL, preserving native trust entries. An earlier run exceeded the provider cap before rotation and returned HTTP 403. That failure was fixture capacity, not a Codex hook refusal.

## Replay

Build the draft's TypeScript and run on macOS with Codex 0.171.0, tmux and the Xcode command line tools.

```sh
node node_modules/typescript-native/bin/tsc
node tests/fixtures/codex-working-signal/probe.mjs --resume --trusted-restart
node tests/fixtures/codex-working-signal/probe.mjs --resume --changed-hook-restart
```

Both commands should exit zero. The changed-hook case passes only after the native review prompt appears without any Stop or model call. The original `--resume` without explicit fixture approval still reproduces the extra prompt.

## Product boundary

The product spec remains unapproved. The existing parser of stored `trusted_hash` values detects whether there is a historical record. A record alone cannot prove that the current hook matches it. The fixture demonstrates that Codex has a native distinction between untrusted, trusted and modified hooks, including after process restart. It does not prove that a separate cwd query is an adequate production launch authorization or that the observed state cannot change between a preflight and resume. The generated native schema also offers a loaded-thread query, which would need to be examined for real sessions with selected environments.

A product proposal still needs to preserve effective account and project placement, demonstrate the exact managed lifecycle, retain the ordinary embedded path when native hook trust cannot be established, and prove the signed owner read and browser behavior. No flag, production startup code, trust policy, or deployment surface changed in this checkpoint.
