# Side effects: stripped sessions keep no origin credential across restarts (SEC-107)

## What changes for running agents
- Normal sessions (interactive, triage, ordinary headless jobs): no change. Enrollment makes one or two extra `tmux show-environment` reads per session at server start, run one after another with a 5 s timeout, which adds a little to boot time.
- Credential-stripped and confined sessions (job sessions with `omitAuthEnv`, the feedback executor, confined triage): they are no longer re-armed with an origin token when the server restarts, and any token they still hold is revoked. Sessions started by the previous build are recognized from their blank agent token, so the upgrade restart itself does not re-arm them.
- Stripped sessions no longer show up in the boot "origin enrollment unavailable" list. They are skipped on purpose, not failed.
- On an agent with no API token configured, the blank-token signal is not used, because every session has a blank token there. Only the marker counts.

## Signal vs authority
The marker and the blank token are inputs to one decision: whether to MINT a credential. They grant nothing. A wrong reading fails toward giving no token, and any tmux error holds enrollment closed for that session.

## Residual (not closed here)
- A stripped or confined session that can reach the default tmux socket could clear its own marker. Its agent-token line would still be blank, though, so the second signal still holds. More importantly, the same socket access already lets it read other sessions' `INSTAR_AUTH_TOKEN` and `INSTAR_ORIGIN_TOKEN` with `show-environment`. That is a larger, existing gap in credential stripping. It is reported back to the security ledger as its own item.
- Recording `originOmitted` on the session record, which the server owns, would make the decision independent of tmux state. Left for that ledger item.
- Relaunch paths (resume, account follow-me, cross-machine transfer) mint a fresh decision at launch through `spawnSession` and are not affected here. Whether each one carries `omitAuthEnv` was not audited.

## Rollback
Revert the commit. No stored data changes. Revoked bindings belong to stripped sessions that should never have held them.

## Second-pass review
**Reviewer:** independent second-pass subagent (fresh context, read-only; verified the tmux semantics live on tmux 3.7c with a private socket). Nothing blocks. Every place that mints origin tokens is covered, both stripped launch paths are marked, and normal sessions see no regression. Its notes were taken:
- Pre-marker sessions are re-armed once at the upgrade restart: fixed with the blank-agent-token signal, guarded for agents with no token.
- The failure test did not discriminate: it now fails the marker key alone.
- The skip test did not prove revocation, and the mock did not carry `new-session -e` or exit 1 for unknown keys: fixed, with a revoke-proving test.
- Only the exact `=1` form counted: any marker form now counts, and only an "unknown variable" exit 1 reads as absent.
Recorded as residual above: the session-record field and the tmux socket reach.
