# Isolated worker trial — 2026-10-28

This is a reproducible **partial** test-agent trial for the approved job-result supervision design. It exercises the real evidence projector, durable store, and worker against five simulated provider answers. It does not open the production rollout gates or count as the `test-agent-live` graduation in the spec.

## Setup and isolation

- Source: Instar 1.3.1497, fresh worktree from `b9369ac8c` on `JKHeadley/instar`.
- Agent: `instar init --expires-in 6h` under `/private/tmp`, with `autostart.autoInstall=false`, no `scheduler.allowOnThrowawayAgent=true`, and an unexpired throwaway record.
- The runner was launched with macOS `sandbox-exec` denying outbound networking. It probes a loopback TCP connection and refuses to run unless the OS returns `EPERM` or `EACCES`. Without the sandbox, the same runner failed before creating a trial record.
- Provider replies were supplied by an in-process fake `fetch`. No real Jev call or other third-party call was made. The worker's `auditReady` dependency was injected as true for this trial; the production code-owned audit and cohort gates remain closed.
- The worker trial did not start the agent server. In a separate server boot under the same network sandbox, the server attempted egress and the OS denied it. No files appeared in the temporary agent's job state directory, and after shutdown no process or listener on its port remained. `/jobs/triage` returned 503 because that endpoint was unavailable in this temporary configuration, so it supplied no rollout evidence. Shutdown emitted a libc++ mutex exception after the server reported closing its SQLite handles; this is an observed limitation, not a clean-shutdown claim.

## Results

| Simulated result | Stored state | Meaning |
| --- | --- | --- |
| Healthy with an independent signal | resolved/routine | Independent evidence allowed routine closure. |
| Failed dependency | unresolved/needs-session | Investigation was unavailable; the result stayed open. |
| Status-only OK | unresolved/evidence-insufficient | A mock routine verdict could not close it. |
| Provider timeout | unchecked/provider-timeout | No verdict was invented. |
| Healthy with planted sensitive text | resolved/routine | The planted text was absent from the provider request and all trial state files. |

Each attempt has exactly one durable call row, including provider, intended model, prompt and evidence hashes, settlement, and token counts where a response arrived. Four calls settled as current; the timeout call settled as failed. This is audit plumbing with simulated answers, not a model quality measurement.

## Reproduce

Build Instar, create an expiring throwaway agent under the OS temp root with `autostart.autoInstall=false`, and run:

```bash
sandbox-exec -p '(version 1)(allow default)(deny network-outbound)' \
  node scripts/job-supervision-offline-trial.mjs /absolute/path/to/throwaway-agent
```

The runner writes a local `summary.json` and durable SQLite call ledger under the temporary agent's `.instar/state/job-supervision-offline-trial/` directory. It refuses a non-temporary or non-expiring agent, an agent allowed to schedule jobs, or a process with outbound networking.

## Remaining graduation work

The spec's `test-agent-live` step still requires an actual isolated launch through the scheduled result path, certificate revocation, provider settlement race, three-tier proof, and zero unsupervised production jobs. The mock provider cannot establish Jev accuracy, provider latency, or external data-flow behavior. Development shadow and active rollout remain closed until those checks and the separate provider benchmark pass.
