# Codex connect is explicit — Plain-English Overview

> The one-line version: my server stops rewriting the operator's shared Codex config at every boot; a hand-started Codex gets connected to one agent on request with `instar codex connect <agent>`, and the test suite can no longer reach the real file.

## The problem in one breath

The Codex command-line tool reads one settings file per user (`~/.codex/config.toml`). Every Instar agent's server wrote its own Threadline tool entry into that one file each time it booted. Whoever booted last won, so a Codex the operator started by hand would silently talk as the wrong agent. Worse, the test suite boots the same code: on 2026-10-20 an end-to-end test rewrote Justin's real Codex config to point at a throwaway worktree, a temp folder, and an agent called "no-id-agent".

## What already exists

- **Per-session override** — every Codex session Instar launches is started with its own agent's Threadline entry baked into the command line. Those sessions never read the shared file, so the boot-time write never helped them.
- **The Codex config writer** — a small, tested module that adds or replaces exactly one table in `config.toml` and keeps everything else the operator put there.
- **Test environment stripping** — the shared test setup already strips live-agent and git variables so tests cannot act on the operator's real agent. It did not cover the Codex config location.

## What this adds

The boot-time write is removed. Nothing else about Threadline startup changes.

- **`instar codex connect <agent>`** — a new command for the one case the boot write served: an operator who starts Codex by hand and wants it to carry a specific agent's Threadline tools. It finds the agent's home, writes that agent's entry into the shared config, keeps the operator's other settings, and says plainly that the file names one agent at a time. `--dry-run` shows the entry without writing. `CODEX_HOME` is honored.
- **Hermetic tests** — the shared test setup now points `CODEX_HOME` at a fresh temp folder for every test process, so no test (present or future) can write the real Codex config. Every test that boots Threadline in-process also moves `HOME` to a temp folder, because that boot writes the user's Claude config too. A guard test fails the suite if either rule stops holding.
- **Agent awareness** — the agent's own instructions gain a short section on the command, and existing agents receive it on their next update.

## The safeguards

**Prevents the shared file from being clobbered by a boot or a test.** The only remaining writer runs when an operator types the command. The suite's default Codex home is a temp folder, verified by a guard test that registers a probe entry and checks the real file is byte-identical before and after.

**Prevents the Claude-side leak of the same shape.** Any test file that boots Threadline without isolating `HOME` fails the guard test with the file named and the fix stated.

**Prevents a silent wrong-agent connection.** The command's output names the file it wrote and warns that connecting another agent replaces this one. Instar-launched sessions are unaffected either way, which the end-to-end test proves by building a second agent's session command line after connecting the first.

## What ships when

One pull request: the removal, the command, the test-setup change and guard, the three test tiers, the awareness section with its migration, and this overview.

## What you actually need to decide

Nothing beyond the PR review: this removes a write, adds an explicit command for the one case it served, and closes the test leak. The real `~/.codex/config.toml` is not touched by this change; if the operator wants a hand-started Codex connected to Echo, they run `instar codex connect echo` once.
