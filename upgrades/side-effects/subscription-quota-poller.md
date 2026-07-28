# Side-Effects Review — QuotaPoller (P1.2)

## Scope of change

- `src/core/QuotaPoller.ts` (new) — per-account quota reader + mapper + burn rate.
- `src/server/routes.ts` — 2 new routes under the existing `/subscription-pool`
  prefix (POST `/subscription-pool/poll`, GET `/subscription-pool/:id/quota`) +
  RouteContext `quotaPoller` field.
- `src/server/AgentServer.ts` — threads the `quotaPoller` option → RouteContext.
- `src/commands/server.ts` — instantiates the poller; starts the background loop
  ONLY when the pool is non-empty.
- tests (unit/integration/e2e).

## Mutability / authority analysis

- **External network call with a credential — the notable surface.** The poller
  resolves each account's OAuth access token transiently from that account's own
  config home and calls the READ-ONLY `GET /api/oauth/usage` telemetry endpoint.
  It is NOT inference and NOT a mutation of any Anthropic-side state — it reads
  usage stats, the same endpoint the official client's /usage screen calls. This
  stays inside Justin's accepted decision-C bounds (subscription-only, official-
  client login reused, no API keys). It is distinct from the inference-spoofing
  Anthropic enforces against.
- **Token handling (the security-sensitive part).** Tokens are read TRANSIENTLY
  for the duration of one fetch and never persisted, never logged, never
  returned. The SubscriptionPool still stores only the config-home LOCATION; the
  poller reads the token from the OS credential store (macOS keychain entry
  `Claude Code-credentials-<sha256(configHome)[0:8]>`, or `<configHome>/.credentials.json`
  on other platforms) at read time only.
- **Local writes.** The only persisted effect is writing each account's
  `lastQuota` snapshot (and a `needs-reauth`/`active` status transition) into the
  pool's single JSON file via the pool's existing atomic update path. No new
  files, no deletes.
- **No behavior authority.** The poller does not gate, block, spawn, kill,
  message, route, or alter any session/scheduling behavior. It is observe-only;
  the consumer that ACTS on quota (the swap scheduler) is P1.3.
- **Frequency.** Background loop is low-frequency (default 15 min) and only runs
  when the pool has ≥1 account. On-demand poll is available via the POST route.

## Failure modes considered

- **Unresolvable token** → account skipped, no snapshot (warn-logged, no token in log).
- **401/403 (revoked / password change)** → account flagged `needs-reauth`; a
  later clean read restores it to `active`. Covered both sides by tests.
- **Network error / timeout** → null snapshot this cycle, status unchanged, retry
  next cycle. Covered.
- **Sparse/partial usage response** → mapper tolerates missing windows. Covered.
- **Non-claude/disabled accounts** → skipped by pollAll. Covered.

## Blast radius if wrong

Contained. Dark (no accounts → no polling). Observe-only (no behavior change).
Worst realistic case: a stale or missing `lastQuota` value on an account, or an
account wrongly flagged needs-reauth (self-heals on the next clean read). No
session/scheduling impact until P1.3 consumes the data.

## Migration / parity

None. No config defaults, hooks, skills, or CLAUDE.md template changes. New
routes stay under the already-classified `/subscription-pool` INTERNAL prefix
(no CapabilityIndex change). Ships via dist on update.

## Tier rationale

Declared Tier 1 despite risk-floor signals (new route + new class). The change
is read-only external TELEMETRY, observe-only (no behavior authority), dark, with
transient-never-persisted token handling and fully hermetic tests (injected fetch
+ token resolver — zero credentials, zero network). The one genuinely sensitive
aspect — reading a per-account token to call the usage endpoint — is within the
operator's explicitly-chosen decision-C bounds and is flagged to the operator in
the progress report. Below-floor recorded for audit (the mind holds authority).
