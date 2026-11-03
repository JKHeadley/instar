## What Changed

- `instar install` now gets past its tools step. Its git check always said git was missing, so every install stopped there.
- On Linux the installer installs git when it's missing, the same way it installs tmux.
- Claude Code (or Codex, Gemini and the others) installed in `~/.local/bin` is now found even when that folder isn't on PATH. Claude Code's own installer puts it there, and so does `instar install` when the global npm folder isn't writable.
- The installer leaves a new agent's settings file readable only by its owner. That file holds the agent's keys.

## What to Tell Your User

- **Claude Code in ~/.local/bin**: "If Claude Code is installed in your home folder's .local/bin, I now find it there even when that folder isn't on my PATH."

## Evidence

- A full `instar install` on a fresh Ubuntu 24.04 container (2026-11-03) completed after these fixes. Before them it stopped at "needs git" and then at "couldn't install Claude Code". A Claude Code session started in the new agent's folder opened straight to its prompt, with no first-run screens.

## Summary of New Capabilities

| Capability | How to use |
|---|---|
| Binaries found in ~/.local/bin | automatic |
