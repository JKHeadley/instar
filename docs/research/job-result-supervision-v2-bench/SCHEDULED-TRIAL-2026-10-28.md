# Isolated scheduled-run trial — 2026-10-28

This trial exercises the **real JobScheduler and its child script** on an expiring throwaway agent. It complements the separately recorded mock-worker trial. It is still partial evidence for the approved `test-agent-live` step: the production Jev and cohort gates remained off, and the two trials did not run as one server-owned pipeline.

## Isolation

- Source: Instar 1.3.1499 from a fresh `JKHeadley/instar` worktree at `8b4dc5f41`.
- The parent agent was created with `instar init --expires-in 6h` under `/private/tmp`. Its installed job definitions and config were not edited. Its normal throwaway job guard stayed in force.
- The trial runner made a private nested scheduler workspace with exactly one synthetic script job, scheduled for January 1 and triggered manually. The throwaway override applied only to that private scheduler instance. It did not start the agent server or any of the agent's installed jobs.
- The runner and child ran under macOS `sandbox-exec` with outbound networking denied. The parent refused an unsandboxed run; the child exited successfully only after its own outbound connection was denied. The script created no session and made no provider call.

## Observed result

The synthetic script produced a structured healthy result and printed a **fake Anthropic-key-shaped credential**. The scheduler recorded one successful script run and one durable supervision attempt. That attempt stayed `unchecked:triage-dark`, with evidence hash and completion time present and zero model-call rows. The fake credential was absent from the model evidence and from every file in the trial's durable `state`, `ledger`, and `logs` directories; the run summary contains `[REDACTED:anthropic-key]`.

An earlier exploratory run used an arbitrary secret-like marker that did **not** match the shared scrubber's documented known-token patterns. That marker appeared in the job-history summary, showing why an arbitrary marker is a poor credential-redaction test. The recorded trial uses a realistic fake key shape and checks all durable stores. The shared scrubber's scope is known token shapes, as documented in `src/core/durableSecretScrub.ts`; this trial does not claim to catch every unknown or obfuscated secret.

## Reproduce

Build Instar, create an expiring throwaway agent under the OS temp root with auto-start disabled, then run:

```bash
sandbox-exec -p '(version 1)(allow default)(deny network-outbound)' \
  node scripts/job-supervision-scheduled-trial.mjs /absolute/path/to/throwaway-agent
```

The runner writes a local `summary.json` and durable ledgers under the agent's `.instar/state/job-supervision-scheduled-trial/` directory. It refuses a non-temporary or non-expiring agent, an agent whose real scheduler is allowed on throwaway agents, and a process with outbound networking.

## Remaining test-agent-live requirements

The actual server-owned pipeline must join a scheduled result to its model call under a code-owned test cohort and audited isolation. The spec also requires certificate revocation and provider settlement-race trials. This run proves the scheduled execution and record-only spine under isolation, not Jev accuracy or the active rollout path.
