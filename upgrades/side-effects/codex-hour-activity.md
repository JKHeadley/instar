# Side-Effects Review — Codex hour-scale activity detection

**Date:** 2026-07-16  
**Author:** instar-codey

## Summary

Extends the existing Codex TUI duration grammar from `Ns` / `Nm Ns` to the real `Nh Nm Ns` hour rendering. The same hour token is removed from the spinner-immune hash so a ticking clock does not masquerade as new model output.

## Decision-point inventory

- `CODEX_CLI_SIGNAL.toolCallOrSpinner` and `.liveActivity`: identify a current Codex working-status line.
- `stripVolatileStatus`: removes only the exact hour/minute/second duration token before change hashing.

## Seven dimensions

1. **Over-block:** the pattern still requires the literal `Working (` prefix and a complete duration ending in seconds, so ordinary prose containing hours does not become a live signal.
2. **Under-block:** seconds, minutes, and the observed hour form are pinned. Unknown future formats remain unchanged rather than guessed.
3. **Abstraction:** duration recognition remains in the shared framework signal; volatile clock normalization remains in its existing hashing boundary.
4. **Signal vs authority:** the status line is a liveness signal, not proof of semantic progress. Existing unchanged-pane logic can still classify a frozen spinner as stalled.
5. **Interactions:** idle model-name/composer text and scrollback-persistent action bullets retain their existing behavior.
6. **External surfaces:** none. No messages, APIs, persistent state, or credentials change.
7. **Rollback:** code-only revert with no migration or cleanup.

## Judgment-point check

No new semantic judgment is introduced. This is an exact finite grammar extension grounded in an observed Codex TUI rendering.

## Operator-surface quality

No operator surface changes. Monitoring becomes more truthful without asking the user to configure or operate anything.

## Multi-machine posture

Framework pane parsing is machine-local on every host. The same deterministic grammar ships to each machine; no replicated state or cross-machine authority is involved.

## Rollback cost

One code revert. There is no state to repair.

## Evidence pointers

- Real hour form: `Working (10h 19m 44s • esc to interrupt)`.
- 36 focused unit assertions pass across framework signals, activity classification, and spinner-immune hashing.
- Full TypeScript check passes.
