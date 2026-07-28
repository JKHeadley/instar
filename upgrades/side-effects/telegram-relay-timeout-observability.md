# Side effects — tokenless-standby relay timeout + observability

## What changes at runtime

The tokenless-standby outbound Telegram relay (`outboundRelay`, used only when a
pool standby serves a moved session) now (a) aborts after a bounded timeout
instead of hanging, and (b) logs one explanatory line on every failure path.
Logic extracted into `src/core/TelegramRelay.ts`; success behavior unchanged.

## Who is affected

- **Single-machine agents:** zero behavior change. `outboundRelay` is only wired
  in the multi-machine session-pool branch and is only invoked by `sendToTopic`
  when the adapter has no usable bot token (a standby). A single-machine agent
  never relays.
- **Multi-machine standbys (a moved session replying):** a relay to an
  unreachable/slow holder now fails after `relayTimeoutMs` (default 15s) instead
  of hanging indefinitely, and the failure is logged with its cause.

## Blast radius

- New file `src/core/TelegramRelay.ts` + a wiring change in `src/commands/server.ts`
  (the `outboundRelay` assignment) + one import. No route, schema, config-key, or
  migration change. New optional config `multiMachine.relayTimeoutMs` (absent →
  15s default).
- Compiled source only — no agent-installed file/hook/skill, so no
  PostUpdateMigrator change; agents get it on the normal server update.

## Failure modes considered

- **Timeout too aggressive:** default 15s is generous for a tunnel round-trip;
  tunable up via config if a deployment needs it. On timeout the reply fails
  (logged) rather than hangs — strictly better than the prior unbounded hang.
- **Log noise:** one line per failed relay only (success is silent), so a
  healthy multi-machine setup adds no log volume.
- **Behavior parity:** the success path (POST holder, return messageId, pass
  `silent` through) is byte-equivalent to the original; covered by a 2xx test.
