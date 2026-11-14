# `instar test-as-self` — the throwaway-deploy harness

`instar test-as-self` deploys the **dist that is currently executing** into a throwaway agent home, starts its
server, optionally runs a real Telegram round-trip, verifies the deploy with `verify.mjs`, and tears the agent
down — a clean, repeatable proof that a change to the deploy / lifeline / server path still boots, instead of
post-hoc log forensics on a real agent.

## When to use it

- Before shipping a change that touches the deploy, lifeline or server-boot path.
- After landing such a change, as the "it still boots" check.
- To reproduce a crash observed in the wild on a clean home.
- As the **test-agent rung** of a feature's maturation ladder: deploy a throwaway from a worktree's `dist/`,
  then drive the feature against that home (the Skill Learning Sentinel's rung script does exactly this — it
  replays scripted histories through the real sentinel on the throwaway and writes a signed live-test artifact).

## Usage

```bash
instar test-as-self --no-roundtrip                       # deploy + verify only (no bot)
instar test-as-self --bot-token <secret-drop-id>         # + a real Telegram round-trip (token via Secret Drop, never raw)
instar test-as-self --keep --target <dir>                # leave the throwaway running for inspection
instar test-as-self --report-json <path>                 # per-step JSON report (steps, verdict, failedAtStep)
instar test-as-self --slack                              # credential-free Slack permission demonstration instead
```

Because the harness deploys **the `dist/cli.js` that is running it**, `node <worktree>/dist/cli.js test-as-self …`
deploys that worktree's build — no release is needed to test a branch.

## What it refuses

- A raw bot token on the command line (Secret Drop ids only).
- Targeting a real agent home or the operator's own agent (structural guards; the default target is under
  `~/.instar/test-deploys/<timestamp>`).

## Steps and report

1. bot-acquire (Secret Drop) · 2. target-prep (guards) · 3. dist-deploy (`instar init --dir`) · 4. process-start +
`/health` + lease · 5. round-trip (Telegram Bot HTTP API) · 6. `verify.mjs` · 7. signal-safe teardown (skipped with
`--keep`). Exit 0 means every step passed; the JSON report names the failing step otherwise.
