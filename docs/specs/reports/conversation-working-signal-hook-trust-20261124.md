# Managed Codex resume and hook trust

The review-only harness at the [working-indicator prototype](../conversation-working-signal-prototype.md) now tests trusted and changed hooks on a real Codex 0.171.0 TUI. It uses a disposable home, private Unix relay and tmux server, and the repository loopback-only model. It does not read or modify any live agent's Codex home or approvals.

## Observations

| Case | Project `hooks/list` | Loaded-thread `hooks/list` | Managed resume |
|---|---|---|---|
| Hook had never been reviewed | `untrusted` | `thread not found` while review was pending | The native review prompt held the turn until the test explicitly selected approval in the disposable home. After approval, Stop blocked once and then allowed the turn; the working signal appeared and cleared. |
| Same hook after closing both processes | `trusted` | `trusted` on the resumed native thread | The original native thread reopened without another prompt. The same two Stop decisions occurred, the loopback model received two requests, and the signal appeared and cleared. |
| Approved hook command changed before reopening | `modified` | `thread not found` while review was pending | The native review prompt held the turn. There was no Stop receipt and no new model request. The fixture left the prompt unapproved. |

Both read-only requests check the one matching enabled hook, the presence of its current hash, and its trust state. The project request uses a separate native app-server. The loaded-thread request uses a separate bounded connection to the same disposable managed app-server, identifies the thread confirmed by the TUI, and accepts the native “thread not found” result only when the exact fixture thread is identified and the TUI is already waiting for hook review. It did not inject or compare local hashes itself. When the fixture reopened both children, it rotated the loopback provider to keep each server's existing four-request cap. The only config edit during this rotation was the loopback URL, preserving native trust entries. An earlier run exceeded the provider cap before rotation and returned HTTP 403. That failure was fixture capacity, not a Codex hook refusal.

## Replay

Build the draft's TypeScript and run on macOS with Codex 0.171.0, tmux and the Xcode command line tools.

```sh
node node_modules/typescript-native/bin/tsc
node tests/fixtures/codex-working-signal/probe.mjs --resume --trusted-restart
node tests/fixtures/codex-working-signal/probe.mjs --resume --changed-hook-restart
```

Both commands should exit zero. The changed-hook case passes only after the native review prompt appears without any Stop or model call. The original `--resume` without explicit fixture approval still reproduces the extra prompt.

## Product boundary

The product spec remains unapproved. The existing parser of stored `trusted_hash` values detects whether there is a historical record. A record alone cannot prove that the current hook matches it. The fixture demonstrates that Codex has a native distinction between untrusted, trusted and modified hooks, including after process restart. It does not prove that a separate cwd query is an adequate production launch authorization or that the observed state cannot change between a preflight and resume. The loaded-thread query is a possible check after a native thread is available. It did not provide an earlier answer at either hook-review prompt. A real session with additional selected environments still needs independent verification.

A product proposal still needs to preserve effective account and project placement, demonstrate the exact managed lifecycle, retain the ordinary embedded path when native hook trust cannot be established, and prove the signed owner read and browser behavior. No flag, production startup code, trust policy, or deployment surface changed in this checkpoint.

## What the TUI actually requests

A later run correlated the TUI's own JSON-RPC request IDs with the responses on the managed connection. In both review-prompt cases it used project-scoped `hooks/list`, which returned `untrusted` or `modified`. The thread IDs observed before review came from `thread/read`, rather than a successful `thread/resume`. After explicit fixture approval it sent `thread/resume` and received the exact original thread. For the unchanged hook, it read project trust as `trusted` before the resume worked, then the separate loaded-thread check also returned `trusted`.

This narrows what a future production check can claim. Codex itself can inspect project hooks before the conversation loads. A saved thread ID from a metadata read is insufficient to establish that the runtime has loaded that thread. Before using project-level hook inspection to select a managed launch, verify that it covers the exact effective home and all hooks that can apply to the resumed environment, and account for changes between inspection and load.

## Ephemeral side threads

In the same run, the TUI opened a distinct native thread using `thread/start` with `ephemeral: true` after a real resume. Before the correction, the prototype emitted positives for both the selected conversation and that side thread. The protocol regression first failed because the side-thread request cleared the active conversation's hint.

The corrected prototype ignores that exact ephemeral thread-start request before changing the selected thread. It leaves the transport and native requests alone. Four focused test files passed 23 checks, including a regression proving that an ephemeral start cannot clear the selected hint, light a side-thread hint or prevent later selected work. A real managed replay again observed the ephemeral thread and emitted only selected-thread positives. The separate changed-hook case still waited before any Stop hook or model call. These checks are isolated and provide no new production approval.

## A trusted result can expire before resume

Run the same fixture with `node tests/fixtures/codex-working-signal/probe.mjs --resume --change-after-preflight`. This case starts the private managed app-server and reads project `hooks/list` through a bounded second connection to that same server before launching the TUI. It verifies the project's one exact enabled hook is trusted. The test then changes the disposable hook command before the TUI begins loading the thread. The TUI reads `modified`, stops at native hook review, and does not submit its fixture prompt or execute Stop. The loaded-thread query still returns “thread not found.” The command exits zero only after checking those outcomes.

This is a real time-of-check/time-of-use boundary, even without replacing the app-server, account home or project. A project hook query is evidence about that moment. It does not authorize later managed startup or delivery. Keep the ordinary launcher for anything unproven. For a future opt-in, verify the final effective Codex home and canonical working directory after account placement and existing setup, the exact native version and resume target, and the native load including the applicable hooks. A managed setup that stalls or loses verification must settle before any message injection and before a second process can write to the same conversation. The fixture does not implement or establish that fallback.

## Disposing of a held candidate before giving input to the ordinary launch

The tracked macOS fixture now also runs as `node tests/fixtures/codex-working-signal/probe.mjs --resume --fallback-before-input`. It reproduces the change after a trusted preflight, with one additional constraint. The managed TUI receives neither an initial prompt argument nor typed input. The fixture verifies that native hook review holds the candidate before any Stop receipt, model request or loaded thread.

The fixture then identifies the exact disposable TUI PID and the one direct app-server child bound to its private socket alias. It closes its private tmux server, relay and child, and independently requires both process IDs and the relay socket to disappear. Only afterward does it start ordinary embedded Codex in the same fixture home and directory, using the same original native thread ID and the held prompt exactly once. The original thread's one disposable rollout contains exactly one matching user input record. Stop still blocks once and then allows the ordinary turn.

An early fixture run did not complete the initial test-only approval. The fixture now reads back the selected approval option before pressing Enter. The final fallback case and the previous changed-hook case both passed. No real hook approval, login, or agent state was modified.

This proves the ordering and one recorded input for a disposable scenario. It does not prove a production SessionManager handoff. A production candidate must also keep the ordinary pane name and publication state private until readiness, hold the exact conversation reservation, withhold pending input and revoke any candidate credentials before fallback. The ordinary kill path does not currently own the managed app-server or relay. The product remains off.
