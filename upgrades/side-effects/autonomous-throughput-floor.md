# Side-effects review: Autonomous Throughput Floor

## Changed

- Adds bounded Git/GitHub and Telegram-history reads for eligible single-machine autonomous runs.
- Adds one constant-size 0600 machine-local sidecar per run plus a scrubbed JSONL audit row.
- Adds authenticated `GET /autonomous/throughput-floor` and dashboard consumption of that pull surface.
- Adds fleet-dark config, migration, guard posture, agent awareness, and release documentation.

## Explicitly unchanged

- No Telegram or Slack message, attention item, notification, A2A message, dispatch, restart, remediation,
  scheduler mutation, PR mutation, git fetch/checkout, or route write is possible from this feature.
- No personal SSH, repository worktree, conversation content, autonomous run document, or pairing state is written.
- HOLD authority is not added. Missing lane-saturation truth remains false/unavailable.

## Resource and failure posture

- One tick at a time; PR/history bounds are fixed; failures back off 15m/30m/60m then open a persisted 6h breaker.
- Missing/corrupt/future state, incomplete history, invalid scope, moves, and multi-machine runs fail to
  `unknown`/`ineligible`, never to a flatline claim.
- Audit/status expose only ids, durations, decision/failure enums, and timestamps—no raw messages, stderr,
  repository paths, URLs, refs, or PR prose.
- The append-only observation audit is explicitly registered as machine-local state with bounded streamed
  retention; the source annotation binds the write site to that declaration without changing runtime behavior.
- Expected bounded-read and fleet-dark initialization failures carry explicit fallback annotations: reads fail
  closed to `unknown`, breaker accounting remains durable, and initialization failure is logged.
- The hand-authored dark-gate attribution map is advanced by the five ConfigDefaults lines introduced by this
  feature; its 25-path set is unchanged, and the real-default resolver test verifies every attribution.

## Follow-on gate

Proactive attention is not part of this change. It is named only as follow-on work gated on a separately
converged SelfHealGate; there is no dormant config path or callback that can enable it.

Decision-audit evidence is carried with the implementation commit and covers every behavior-changing file.
