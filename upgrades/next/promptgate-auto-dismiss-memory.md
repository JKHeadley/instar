<!-- bump: patch -->

## What Changed

Fixed PromptGate auto-dismiss repeats for deterministic prompts whose stale text remains visible in the terminal capture after the dismiss key is sent. PromptGate now records successful auto-dismisses separately from normal prompt dedup, keeps that memory across the input reset, and clears it only when the captured pane content changes.

The server records dismiss memory only when the key send reports success. Failed sends do not poison the cache, so a prompt can still be retried if the key was not delivered.

## What to Tell Your User

- **Less repeated modal handling**: "When I dismiss a known-safe terminal prompt for another agent, I should stop pressing the same stale prompt every few seconds while the terminal catches up."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| PromptGate successful auto-dismiss memory | Automatic for deterministic auto-dismiss prompts such as known Gemini CLI modals. |

## Evidence

Observed before: after PromptGate successfully auto-dismissed the Gemini package-runner install modal, the stale prompt text remained inside the capture window and PromptGate fired the same auto-dismiss again roughly every monitor cycle.

Observed after: focused PromptGate regression tests verify that a successfully auto-dismissed prompt does not re-fire while pane content is unchanged, that failed sends do not create dismiss memory, and that changed pane content re-arms the same prompt shape.
