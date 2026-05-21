# What this PR does — in plain English

## The bug

Yesterday I shipped the new `npx instar` runtime prompt that asks
"Which AI runtime — Claude Code or Codex CLI?" The first real test
of the Codex path failed instantly:

```
The 'gpt-5.2-codex' model is not supported when using Codex with a
ChatGPT account.
```

OpenAI retired that model from ChatGPT subscription accounts on
2026-04-14 (it's API-only now). instar was spawning Codex without
telling it which model to use, so Codex picked its own default,
which happens to be the retired one. The wizard never got a chance
to render.

## The fix

Pass the model name to Codex when instar spawns it. The codebase
already knows which models work on ChatGPT subscription accounts
(it has a whole table empirically probed against Justin's account
back in May). The setup wizard just wasn't reading that table.

The pinned model is `gpt-5.3-codex` — the "balanced" tier from the
existing model map. It's confirmed working on ChatGPT auth.

## The test

A new canary test reads the source code of setup.ts and refuses to
let any future PR remove the model flag from either of the two
places Codex gets spawned. If a third spawn shows up later, the
test will catch a missing flag in CI instead of on a user's
machine.

## Why this matters

The Codex install path was effectively broken for every
ChatGPT-subscription user from the moment v1.2.1 shipped (and
likely longer — the underlying `instar setup --framework codex-cli`
in v1.0.x had the same gap). The bareword prompt I added in v1.2.1
just made the bug reachable from the more natural command, so it
got tested first. This PR closes the door.

## What it doesn't change

- The bareword runtime prompt is unchanged.
- The Claude Code path is untouched.
- The wizard flow itself is unchanged.
- No new authority, no new CLI surface, no migration.
