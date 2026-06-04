<!-- bump: patch -->

## What Changed

Adds a structural dedup at the Telegram→session delivery chokepoint
(`SessionManager.injectTelegramMessage`). A given Telegram `messageId` now reaches a
session at most once: the method keeps a small per-`(session, messageId)` ledger (pruned on
a 10-minute window) and, on a repeat, suppresses the re-injection and logs it instead of
delivering the same user message again. `messageId` is threaded in from both delivery paths
— the `/internal/telegram-forward` route (lifeline → server) and the in-process
`telegram→session` path. Callers that carry no positive `messageId` are unaffected (no
dedup), preserving back-compat.

This closes an observed bug where a single user message was forwarded to a codex session
five times over ~50s (upstream re-forward while the session was starting), making the agent
queue and re-process the same task repeatedly. The suppression is logged so the upstream
over-forward stays visible for a separate root-cause.

## What to Tell Your User

Nothing user-facing changes in how you talk to your agent. Under the hood, if a single
message you send ever got relayed to the agent more than once (a rare hiccup when the agent
was just starting up), the agent now notices and acts on it only once — so it won't
double-work a request or burn extra model usage repeating itself. A note is written to the
log each time a duplicate is caught, so the underlying relay glitch can still be chased down.
