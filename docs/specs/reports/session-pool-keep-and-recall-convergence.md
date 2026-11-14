# Convergence report: session-pool-keep-and-recall

**Outcome: stopped by proportion after 2 rounds, not by a clean round.** The last outside verdict was still
"serious issues". Its two design points need a failing local registry write, or a session with no ownership record
away from the lease holder. Both are stated as limits in the spec, on a path that is off until step 2.

| Round | Standards-Conformance Gate | Internal | Outside (codex-cli, gpt-6-astra) | Result |
|---|---|---|---|---|
| 1 | not run | not run | serious issues, 4 | keep runs placement with this machine as the only candidate; router confirms at once; wording; size cap covers the whole response |
| 2 | not run | not run | serious issues, 3 | deadlines stated; two design points stated as accepted limits |

Round 1 mattered. Skipping placement would have kept a session on a machine that had lost its Slack workspace. Its
question about confirmation led to a real gap: only Telegram confirms a self-placement, so a kept Slack row would
have stayed `placing` and queued every later message.

## Limits left behind

- Keep protects sessions on the lease holder only.
- A failed confirm is logged, not retried by the router.
- Recall is best effort: at most 50 messages, and it can still start blank.
- Slack and drained messages on an ordinary self-placement still do not confirm. That predates this change; the
  step 2 work should check it before routing goes live.
- Not yet proven live.
