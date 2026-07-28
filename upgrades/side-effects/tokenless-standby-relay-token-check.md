# Side effects — tokenless-standby relay token check

## What this changes at runtime

`TelegramAdapter.sendToTopic` now decides "tokenless → relay" by checking that
the bot token is a non-empty STRING, instead of the old truthy check
(`!this.config.token`). The change is confined to the relay-vs-direct branch.

## Who is affected

- **Token-holding adapters (the normal case — laptop, single-machine agents):**
  NO behavior change. Their `config.token` is a real string, so
  `hasUsableBotToken` is `true` and they continue to send directly via the
  Telegram API exactly as before. Verified by the "sends DIRECTLY" unit test.
- **Tokenless pool standbys (a moved session on a machine without the token):**
  Their externalized token (`{ secret: true }` / `null`) is now correctly seen
  as "no usable token", so their replies route through `outboundRelay` to the
  lease holder instead of silently failing a direct send.

## Blast radius

- Single file (`src/messaging/TelegramAdapter.ts`), one branch condition.
- No config keys added or changed. No migration required (the change is in
  compiled source, not in any agent-installed file/hook/skill).
- The relay target (`outboundRelay`, wired in `server.ts`) is unchanged.

## Failure modes considered

- If a standby has no usable token AND `outboundRelay` is not wired, behavior is
  unchanged from before (it falls through to the direct-send branch and fails the
  same way) — no new failure introduced.
- The relay still surfaces a hard error if the lease holder is unreachable
  (`telegram outbound relay failed`), so a lost reply is loud, not silent.
