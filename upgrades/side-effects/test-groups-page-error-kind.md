# Side effects: a test-group page failure reports the error kind and a filtered message

## What changed
The Web K test-group page script's `fail()` also records, only when the thrown value carries no Telegram code or type: the
error's constructor name (`^[A-Za-z]{1,40}$`) as `kind`, and its message only when it matches `^[A-Za-z0-9 _.:()'-]{1,120}$`
(anything with quotes, angle brackets, other characters or longer text is dropped). A thrown bare string in Telegram's error
form is read as `type`. `parseFailure` accepts and re-validates both fields; they reach the reply and the audit line through the
failure detail added in PR #2990.

## Why
Live on the Studio, 2026-11-09 10:36 PST, after #2990: the list still failed with `{"step":"list"}` and an audit
`failure: {step: "list"}`: no code and no type, so the thrown value was a plain script error, not a Telegram refusal.

## Review
1. Over-block / 2. Under-block: none; no decision changes.
3. Level: the page script is the only place that sees the thrown value.
4. Signal vs authority: diagnostic only.
5. Interactions: none; the fields are optional and validated on both sides.
6. External surfaces: an agent-facing error body and audit file. Page text cannot pass the message filter (no quotes, no angle
   brackets, 120 characters at most); a test proves a message with quotes and angle brackets is dropped.
7. Multi-machine: unchanged.
8. Rollback: revert.

## 6b. Operator-surface quality
Not an operator surface.
