# Instar Upgrade Guide — NEXT

<!-- bump: patch -->

## What Changed

**Agent-to-agent Telegram comms primitive — send side now wired in.** Builds on the
TelegramAdapter groundwork that landed in v1.3.34 (where the adapter learned to run a
second bot cleanly + expose `is_bot`/`sender_chat` on inbound messages). This release adds
the actual send function plus its safety machinery, still **dark** (no caller uses it
yet — the mentor wires it in the follow-up):

- **`sendAgentMessage`** — formats the visible `[a2a:from=… to=… role=… id=… corr=… ts=… v=1]`
  marker, sends via an injected adapter, and writes one audit row for every outcome
  (`ok` / `failed` / `role-refused`) — never silent.
- **Runtime anti-loop guard** — refuses to send any role the caller wasn't constructed with
  permission for. No marker formed, no send attempted, audit row written. This makes the
  import-surface lint a backup rather than the only defense; the runtime guard always
  applies. A role-handler that *consumes* role X structurally cannot *send* role X.
- **Bot-token scrubbing on every error/audit surface** — Telegram 401 response bodies
  sometimes echo the token; redaction makes leaks structurally impossible from this module.

## What to Tell Your User

- Nothing changes in how your agent behaves today — still plumbing. Your agent's own
  Telegram keeps working exactly as before. A follow-up update wires this into the mentor
  feature.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| `sendAgentMessage` + audit ledger | Internal — see `src/messaging/AgentTelegramComms.ts`; formats the marker, sends via injected adapter, writes a `SendAuditRow` for every outcome, scrubs the bot token |

## Evidence

**Net-new groundwork, not a bug fix.** Proven by 5 new unit tests (25 total in the suite,
all green): happy-path send + audit (marker round-trips through `parseMarker` — sender output
IS receiver input); correlation threading (explicit `correlationId` lands in the marker's
`corr=` field for prompt↔reply linkage via Telegram chat history alone); the anti-loop
role-refusal (a role not in the caller's allowed-set → no send, no marker, `role-refused`
audit row); adapter failure with the bot token in the error body → token scrubbed from both
the result reason and the audit row; `scrubToken` unit coverage across full-token,
secret-portion, no-token-present, and undefined-token cases. `tsc --noEmit` clean.
