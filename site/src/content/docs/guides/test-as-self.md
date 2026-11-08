---
title: Testing a Build on a Throwaway Agent
description: Use `instar test-as-self` to deploy the running build into a disposable agent, boot it, drive it, and tear it down.
---

`instar test-as-self` deploys the **dist that is currently executing** into a throwaway agent home, starts its server,
optionally runs a real Telegram round-trip, verifies the deploy, and tears the agent down. It is the clean way to
prove that a change to the deploy, lifeline or server-boot path still boots — and the **test-agent rung** of a
feature's maturation ladder: deploy a throwaway from a worktree's `dist/`, then drive the feature against it.

## When to use it

- Before shipping a change that touches the deploy, lifeline or server-boot path, and again after it lands.
- To reproduce a crash observed in the wild on a clean home.
- To run a feature's scripted live test on a disposable agent (the Skill Learning Sentinel's test-agent rung replays
  scripted request histories through the real sentinel on the throwaway and writes a signed live-test artifact).

## Usage

```bash
instar test-as-self --no-roundtrip                 # deploy + verify only (no bot)
instar test-as-self --bot-token <secret-drop-id>   # plus a real Telegram round-trip
instar test-as-self --keep --target <dir>          # keep the throwaway running
instar test-as-self --report-json <path>           # write the per-step report
instar test-as-self --slack                        # credential-free Slack permission demonstration instead
```

Because the harness deploys the `dist/cli.js` that is running it, `node <worktree>/dist/cli.js test-as-self …` tests
that worktree's build — no release needed.

## What it refuses

- A raw bot token on the command line (Secret Drop ids only).
- A real agent home or the operator's own agent as the target (structural guards; the default target is under
  `~/.instar/test-deploys/<timestamp>`).

## Steps and the report

1. bot-acquire (Secret Drop) · 2. target-prep (guards) · 3. dist-deploy (`instar init --dir`) · 4. process-start plus
`/health` and the lease · 5. round-trip (Telegram Bot HTTP API) · 6. `verify.mjs` · 7. signal-safe teardown (skipped
with `--keep`). Exit 0 means every step passed; the JSON report names the failing step otherwise.
