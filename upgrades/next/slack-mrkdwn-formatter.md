# Slack replies render natively: GFM→mrkdwn formatter at the outbound funnel

<!-- bump: patch -->

## What Changed

Roadmap 0.1. Agent-authored GitHub-flavored markdown sent to Slack used to
arrive as raw bytes — `**bold**` rendered as literal asterisks, `[text](url)`
as bracket soup, `# headings` as pound signs. Slack speaks its own dialect
(mrkdwn: `*bold*`, `<url|text>`, no headings/tables), so the fix is a
server-side converter at the single outbound chokepoint, mirroring the
existing `TelegramMarkdownFormatter` (GFM→HTML) pattern:

- New `src/messaging/slack/SlackMrkdwnFormatter.ts` — pure GFM→mrkdwn
  converter: bold/italic/bold-italic/strike, inline + fenced code (language
  tag dropped, contents `&<>`-escaped exactly once via sentinel extraction —
  double-escaping structurally impossible), `[text](url)` → `<url|text>` with
  a scheme allowlist (javascript:/data: stay literal) and balanced-paren URL
  parsing, headings → bold lines, bullets → `•`, blockquotes preserved,
  tables → fenced code blocks, horizontal rules → a rule line. 32KB ReDoS
  guard (oversized input passes through raw), NUL + PUA-B stripping
  (sentinel-collision defense).
- `SlackAdapter` gains one private funnel, `formattedApiCall()` — every
  user-visible send (`send`, `sendToChannel`, `updateMessage`,
  `postEphemeral`, `sendBlocks`) now routes through it. Block Kit payloads,
  `mrkdwn:false` sends, and non-send methods pass through untouched.
- Default ON (`'mrkdwn'`). Rollback lever: `formatMode:
  'legacy-passthrough'` in the slack messaging config block restores
  byte-for-byte pre-formatter behavior (mirrors `telegramFormatMode`).
  Per-call opt-out for callers that already author mrkdwn:
  `sendToChannel(..., { formatMode: 'legacy-passthrough' })` /
  `metadata.formatMode` on `POST /slack/reply/:channelId` (the internal
  `_formatMode` flag is stripped before the bytes reach the Slack API).
- The one internal callsite that hand-authors mrkdwn (the PromptGate relay
  fallback in `server.ts`) is tagged with the per-call opt-out; all other
  internal sends are plain English or agent-authored GFM (audited).

Tests: 74 new across two tiers — unit (formatter contract: every conversion
case, escaping, guards, wire-up helper skip rules; wiring integrity: the REAL
adapter delegates every outbound path through the real funnel) + integration
(the full `POST /slack/reply/:channelId` and `/internal/slack-forward` HTTP
pipeline, transport stubbed below the funnel).

## What to Tell Your User

<!-- audience: user, maturity: stable -->
- **Slack messages now look right**: when your agent replies in Slack, its
  formatting renders natively — bold is bold, links are clickable, lists get
  real bullets, and code blocks stay monospaced — instead of showing raw
  asterisks and bracket syntax. Nothing to configure; if you ever want the
  old raw behavior back, one setting restores it exactly.

## Summary of New Capabilities

- Slack messages render natively formatted (bold/italic/links/lists/code/
  quotes) with a config rollback (`formatMode: 'legacy-passthrough'`) and a
  per-call opt-out for already-mrkdwn callers.

## Evidence

- 74/74 new tests green (unit formatter contract, adapter wiring integrity,
  HTTP route integration); full unit suite green; `npm run lint` clean.
- Live-proof clause (run by the orchestrator post-merge): a formatted message
  renders natively in a real Slack channel.
