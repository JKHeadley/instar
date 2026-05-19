---
title: "Neutral relay path — ELI16"
slug: "portability-neutral-relay-path-eli16"
parent: "portability-neutral-relay-path.md"
---

# Neutral relay path — explained simply

## The problem

When your agent talks back to you on Telegram, it runs a small helper script.
That script was only ever installed inside the `.claude/` folder — the folder
that only exists when the runtime is Claude Code. Codex and Gemini don't have
that folder. So a Codex agent's instructions told it to run a script at a path
that wasn't there. The instructions even had a smarter "prefer the neutral
location" rule already, but nobody ever put the script in the neutral location,
so that rule never kicked in.

## The fix

Two small changes. First, the script is now also installed in `.instar/scripts/`
— the folder that exists for every runtime. Second, the agent's identity file
now tells it to use that neutral path (and mentions the old Claude path as a
fallback for older setups). Now a Codex or Gemini agent can actually reply.

## Why it's safe

The old Claude-folder copy stays exactly where it was, so nothing that already
worked breaks. The neutral copy is installed with the same careful "don't
clobber a customized script" logic as the original. Four tests prove both
copies appear with identical content, the neutral one is runnable, repeat runs
don't churn, and nothing happens when Telegram isn't set up. This is the second
of six small portability patches the v1.0 notes promised.
