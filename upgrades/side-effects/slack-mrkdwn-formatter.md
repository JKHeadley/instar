# Side-Effects Review — SlackMrkdwnFormatter (GFM→mrkdwn outbound formatter)

**Version / slug:** `slack-mrkdwn-formatter`
**Date:** `2026-07-02`
**Author:** Echo (autonomous)
**Tier:** 1 (small, low-risk, additive outbound-formatting transform mirroring the shipped `TelegramMarkdownFormatter`)
**Second-pass reviewer:** self (genuine second pass over the final diff — see Evidence)

## Summary of the change

Agent-authored GitHub-flavored markdown sent to Slack used to arrive raw —
`**bold**` rendered as literal asterisks, `[text](url)` as bracket soup, `#`
headings as pound signs. This adds a server-side GFM→mrkdwn converter at the
single outbound Slack chokepoint, mirroring the existing
`TelegramMarkdownFormatter` (GFM→HTML) pattern.

Files added:
- `src/messaging/slack/SlackMrkdwnFormatter.ts` — pure converter
  (`formatForSlack` + the `applySlackFormatter` wire-up helper). Bold / italic /
  bold-italic / strike; inline + fenced code (language tag dropped, contents
  `&<>`-escaped exactly once via PUA-sentinel extraction so double-escaping is
  structurally impossible); `[text](url)` → `<url|text>` with a scheme
  allowlist (`http`/`https`/`mailto`; others stay literal) and balanced-paren
  URL parsing; headings → bold lines; bullets → `•`; blockquotes preserved;
  tables → fenced code blocks; horizontal rules → a rule line. 32KB ReDoS guard
  (oversized input passes through raw); NUL + Supplementary-PUA-B stripping
  (sentinel-collision defense).
- `tests/unit/slack-mrkdwn-formatter.test.ts` — formatter contract + wire-up
  helper skip rules.
- `tests/unit/slack-mrkdwn-wireup.test.ts` — wiring integrity: the REAL
  `SlackAdapter` delegates every user-visible outbound path through the real
  funnel.
- `tests/integration/slack-mrkdwn-reply-route.test.ts` — the full
  `POST /slack/reply/:channelId` + `/internal/slack-forward` HTTP pipeline
  (transport stubbed BELOW the funnel).
- `upgrades/next/slack-mrkdwn-formatter.md` — release fragment.
- `docs/specs/slack-mrkdwn-formatter.eli16.md` — plain-English ELI16.

Files modified:
- `src/messaging/slack/SlackAdapter.ts` — one new private funnel
  `formattedApiCall()`; `send`, `sendToChannel`, `updateMessage`,
  `postEphemeral`, and `sendBlocks` now route their `chat.postMessage` /
  `chat.update` / `chat.postEphemeral` calls through it. `sendToChannel` gains a
  `formatMode` option that sets the internal `_formatMode` per-call flag.
  `escapeMrkdwn` removed from the import (now used only inside the formatter).
- `src/messaging/slack/types.ts` — `SlackConfig.formatMode?: 'mrkdwn' | 'legacy-passthrough'`.
- `src/messaging/slack/index.ts` — re-exports the formatter public surface.
- `src/server/routes.ts` — `POST /slack/reply/:channelId` reads
  `metadata.formatMode` (validated to the two legal values, else `undefined`)
  and passes it to `sendToChannel`.
- `src/commands/server.ts` — the one internal callsite that hand-authors mrkdwn
  (the PromptGate relay fallback) is tagged `{ formatMode: 'legacy-passthrough' }`.
- `CLAUDE.md` — architecture note under `messaging/`.

## Which outbound paths now transform (the load-bearing behavior change)

Transform applies ONLY to message-body sends: `chat.postMessage`,
`chat.update`, `chat.postEphemeral`. Concretely: `SlackAdapter.send` (the
OutgoingMessage chunked path), `sendToChannel`, `updateMessage`,
`postEphemeral`, and the `text` fallback slot of `sendBlocks`. Everything else
(`reactions.add/remove`, `pins.add`, `users.info`, `conversations.*`,
`files.info`, `auth.test`) still calls `apiClient.call` directly and is
untouched — verified by grep.

Skip rules (pass through byte-for-byte, `didFormat:false`):
- non-send methods,
- config `formatMode: 'legacy-passthrough'`,
- per-call `_formatMode: 'legacy-passthrough'`,
- `params.blocks` present (Block Kit authored deliberately; `text` is only the
  notification fallback),
- `params.mrkdwn === false` (caller explicitly asked Slack for plain text),
- `text` not a string.

## The rollback lever + per-call opt-out (both verified by test)

- **Global rollback:** `formatMode: 'legacy-passthrough'` in the slack messaging
  config block → byte-for-byte pre-formatter behavior (mirrors
  `telegramFormatMode`). Verified in both the wireup and route integration tests.
- **Per-call opt-out:** `sendToChannel(..., { formatMode: 'legacy-passthrough' })`
  and `metadata.formatMode` on `POST /slack/reply/:channelId`. The internal
  `_formatMode` flag is stripped inside `applySlackFormatter` before params reach
  the Slack API (asserted: `'_formatMode' in outgoingParams === false`).
- **Precedence:** per-call → config → default `'mrkdwn'`. A per-call `'mrkdwn'`
  wins over a `'legacy-passthrough'` config (tested).

## Roll-up across the seven review dimensions

1. **Over-block**: none. The formatter never blocks or drops a message; the
   worst case (oversized / passthrough) is the exact old raw-bytes behavior.
2. **Under-block**: N/A — not a gate. Escaping is if anything MORE conservative
   than before (raw `<@U123>` is now `&lt;@U123&gt;`, so agent DATA can no longer
   be misread by Slack as a live mention/entity).
3. **Level-of-abstraction fit**: correct. The transform lives at one private
   adapter chokepoint (`formattedApiCall`) — the Slack sibling of
   `TelegramAdapter.apiCall` + `applyTelegramFormatter` — so all send paths get
   it uniformly and the pure functions are unit-testable in isolation.
4. **Signal-vs-authority compliance**: N/A to message-flow authority. This is a
   presentational transform, not a decision gate; it never blocks, delays, or
   suppresses a send. No silent try/catch — the formatter has no catch that
   swallows errors; oversized input is an explicit, tested passthrough.
5. **Interactions**: reads one new config field (`config.formatMode`), no shared
   mutable state, no new timers. Idempotency: running the formatter, then
   passing the result through `legacy-passthrough`, is a fixed point (tested).
   Note: applying the `mrkdwn` transform TWICE is not idempotent (e.g. `*x*`
   would re-italicize), which is exactly why already-mrkdwn callers use the
   opt-out — the one internal such callsite (PromptGate fallback) is tagged.
6. **External surfaces**: no NEW network calls, endpoints, or files. The only
   external-facing change is the shape of the `text` field already being sent to
   the Slack Web API. Link scheme allowlist means agent output cannot emit a
   clickable `javascript:`/`data:` link.
7. **Rollback cost**: low. Single revertable commit; the new module is additive;
   every adapter change is a call-site swap to the funnel. Zero persistent
   state, zero migration. Instant runtime rollback via the config flag without a
   redeploy.

## Migration-parity note

This is agent-runtime source (`src/…`), not an agent-installed file
(`.claude/settings.json` hooks, `.instar/config.json` defaults, CLAUDE.md
template, hook scripts, or built-in skills), so no `PostUpdateMigrator` entry is
required — existing agents pick it up on the normal server update. The new
`formatMode` config field is optional and defaults to `'mrkdwn'` when absent, so
no config migration is needed. The repo `CLAUDE.md` note is documentation, not
the scaffold template (`src/scaffold/templates.ts`); no user-facing capability
endpoint or proactive trigger is added, so no template change is warranted.

## Credential-handling note

None. The change touches no secrets, tokens, or credentials.

## Evidence pointers

- `npx tsc --noEmit` — clean (exit 0).
- `npx vitest run` on the three new files — 74/74 pass (formatter contract +
  escaping + guards + wire-up skip rules; adapter wiring integrity across every
  outbound path; HTTP route integration incl. rollback + per-call opt-out +
  `/internal/slack-forward`).
- Second-pass self-review of the final diff: confirmed the funnel is genuinely
  wired (grep: all message-body sends route through `formattedApiCall`; the
  removed `escapeMrkdwn` import has no remaining reference in `SlackAdapter.ts`),
  the rollback lever + per-call opt-out exist and are exercised end-to-end, and
  `applySlackFormatter` is a live dependency of `formattedApiCall` (not a dead
  export).
