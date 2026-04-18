# Side-Effects Review — TelegramLifeline sends auth on /internal/* forwards

**Version / slug:** `telegram-lifeline-auth`
**Date:** `2026-04-18`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

One source file changed: `src/lifeline/TelegramLifeline.ts`. Both internal fetches — `forwardToServer()` to `/internal/telegram-forward` and the callback handler to `/internal/telegram-callback` — now compose their headers as an object, conditionally adding `Authorization: Bearer <token>` when `this.projectConfig.authToken` is set. Body, method, abort signal, and timeout are unchanged. The fix closes a client-side gap created by PR3 (commit `42cb9ee`) which tightened `/internal/*` middleware to require bearer auth without updating the only in-tree client that calls those endpoints.

## Decision-point inventory

- `src/lifeline/TelegramLifeline.ts` `forwardToServer` — **modify** — build `fwdHeaders` with optional `Authorization`, pass into `fetch`. No logic change downstream; the method still returns `response.ok`.
- `src/lifeline/TelegramLifeline.ts` `handleCallbackQuery` — **modify** — same header construction for `cbHeaders`. Retry/user-reply branches on `response.ok` unchanged.

---

## 1. Over-block

No block/allow surface is introduced. The change adds an Authorization header to outbound localhost requests. It cannot reject, delay, or filter any message. There is no risk of over-blocking because the change strictly makes a previously-failing request succeed.

---

## 2. Under-block

The change does not introduce a block or authority surface. The existing middleware on `/internal/*` continues to enforce bearer auth, localhost-only, and X-Forwarded-For rejection as before. Clients without a configured `authToken` would still fail the bearer check — but this matches pre-0.28.53 expectations (an agent with no token has never been a supported configuration for server-side enforcement).

---

## 3. Level-of-abstraction fit

Correct layer. The bug is a client-side omission: the caller of a bearer-auth-protected endpoint wasn't sending the bearer token. Fixing it in the caller — specifically in the one file that constructs the request — is the narrowest possible intervention. Moving the header logic deeper (e.g., into a shared fetch wrapper) is out of scope and would expand the blast radius unnecessarily for an urgent deploy.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface. It is a client-side auth-header construction, not a decision point.

---

## 5. Interactions

**Shadowing:** None. The Authorization header is additive; it does not replace or override any other header. The `Content-Type: application/json` header is preserved verbatim.

**Double-fire:** N/A — header construction runs once per fetch call.

**Races:** None. `projectConfig.authToken` is loaded at lifeline construction and not mutated at runtime.

**Feedback loops:** None. The header goes out; the server's decision comes back; the lifeline reads `response.ok` exactly as before.

**Backwards compatibility:** Server versions whose `/internal/*` middleware doesn't require auth (e.g., pre-PR3 main-branch deployments) simply ignore the extra header. The fix is safe to roll out without a server-side coordination.

---

## 6. External surfaces

- **Other agents:** Every agent on 0.28.53 with a configured `authToken` regains working inbound Telegram. Agents with no token see no behavioral change (the `if` guard skips the header).
- **Install base users:** Inbound messages that were being silently dropped on 0.28.53 will begin landing after the 0.28.54 upgrade. No user-visible breakage — only a restoration of previously-working behavior.
- **External systems:** Telegram Bot API is untouched. The change is purely on the local agent↔server loopback.
- **Persistent state:** None. No DB, config, or registry is modified.
- **Timing/runtime:** Adds one constant-time header assignment per internal fetch. Immeasurable overhead.

---

## 7. Rollback cost

Trivial. Revert the one commit; `TelegramLifeline` returns to its 0.28.53 state and inbound Telegram breaks again. No state to unwind, no migration to reverse, no user communication required beyond "downgrade reintroduces the bug." A follow-up unit test asserting the bearer header is present is tracked but not in this patch (per explicit user instruction to skip testing for the urgent deploy).
