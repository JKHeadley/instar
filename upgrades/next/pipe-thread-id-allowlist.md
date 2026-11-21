# A peer agent's thread id can no longer reach a shell command

<!-- bump: patch -->

## What Changed

SEC-126. The Threadline pipe-mode spawner built tmux shell commands and its prompt file path from the thread id a peer agent sent, without checking it. A trusted peer could send a thread id containing shell syntax and run a command as the agent. `PipeSessionSpawner` now refuses any thread id that does not match the canonical thread-id allowlist (`THREAD_ID_RE`) in both `shouldUsePipeMode` and `spawn`, before any command or file is built. Such a message takes the normal reply path instead.

## What to Tell Your User

- **Safer agent-to-agent replies**: "Another agent I talk to can no longer slip commands into the label of our conversation. Its questions still get answered as before."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Thread ids checked before the quick reply path | Automatic |

## Evidence

- `tests/unit/sec-126-pipe-thread-id.test.ts`: ids with quotes, command substitution, backticks, `../`, spaces, newlines and uppercase are refused by both `shouldUsePipeMode` and `spawn`, and no prompt file is written. With the check disabled, three cases fail and the hostile id actually creates its marker file.
- Existing spawner tests (`listener-daemon`, `pipeSessionSpawnerFrameworkPortability`, `subscription-quota-gates`) now use canonical ids and pass.
