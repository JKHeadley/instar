---
title: "Setup framework flag + wizard launch — ELI16"
slug: "setup-framework-flag-eli16"
parent: "setup-framework-flag.md"
---

# Setup framework flag + wizard launch — explained simply

## What's new

Before this release, `instar setup` (the part that asks you "what's your
agent's name? what's your Telegram token?") only knew how to run with
Claude Code. If you didn't have Claude on your computer, the wizard
exited before you could even start. Now you can pass a framework choice:
"--framework codex-cli" and the wizard runs inside Codex instead.

## How it works

The first part of `npx instar` is a small Node program (no AI yet) that
checks whether the runtime you asked for is installed. If it is, the
program launches that runtime with a one-line instruction: "please read
the setup-wizard's instructions file and follow them." The instructions
file lives in one place in the package; both runtimes can read it. The
conversational wizard — agent name, identity, secrets, browser-driven
Telegram setup, finish — runs entirely inside whichever runtime you
picked.

For Claude users, nothing visible changes. Same command, same output.
For Codex users, the setup wizard finally works.

## Where verification happens

The piece that's hardest to test in isolation — spawning the right
binary — is verified by an end-to-end run on this machine right after
this PR merges (task #66): a fresh Codex-only install on a clean
directory, all the way through to a working Telegram bot. That's the
real proof.

## What's next

This was PR 3 and PR 4 of the four-PR install upgrade. They ship together
because splitting them would leave an awkward intermediate state where
the wizard recognizes the Codex flag but then tries to spawn Claude
anyway. With them combined, the audit's install/wizard portability gap
is functionally closed.
