# Secret Drop Hardening — ELI16 Companion

**Who this is for:** Justin (and any operator reading this for the first time)
**Reads in:** ~2 minutes
**Companion to:** SECRET-DROP-HARDENING-SPEC.md (technical)

---

## What happened, in one paragraph

Earlier today you typed a one-time SMS code into a secure web form. My server stored the code in a small in-memory inbox and notified my agent process to pick it up. The pickup code had a parsing bug — it asked for the code, the server handed it over, and the pickup code dropped it on the floor. The server had already deleted the code from the inbox the moment it handed it over, so when I noticed the value was missing, there was nothing to retry. We had to ask Telegram for a fresh code. This PR makes that whole class of failure impossible: a fumbled handoff is now recoverable instead of terminal.

---

## What changes (three pieces)

1. **The server stops deleting on read.** When my agent asks for a submitted secret, the server returns it but keeps a copy in the inbox until either (a) my agent explicitly says "I have it, you can throw it away," or (b) the existing 5-minute cleanup timer fires. So if my agent fumbles the handoff, it can ask again and get the same value.

2. **An explicit "consume" path for callers that want it.** Some callers genuinely want one-shot semantics — they're confident they've handed off the value and a stale re-read would be wrong. Those callers pass `?consume=true` on the request URL. Same outcome as before, but now opt-in instead of the default trap.

3. **A "stuck consumer" alert.** If a code gets submitted to the form and 60 seconds pass without any agent actually consuming it, the server sends a system message to the bound Telegram topic saying "hey, a secret you submitted is sitting unread — the consumer probably has a bug, it'll auto-clean in N minutes." That way the failure has a visible cue instead of just silently waiting for an SMS that won't arrive.

---

## Why this matters

The bug that hit us today on a recoverable SMS code is the **gentlest possible failure mode** for this class of failure. If the same bug had hit on a higher-stakes secret (a long-lived API key, a database password, a service-account token), the failure could have been:

- The secret is lost in transit — the operator has to revoke and reissue.
- The downstream system that needed the secret is left half-configured.
- The operator has no way to know the consumer dropped it, because the server's response said "200 OK, here's the secret."

After this PR, all three of those become visible and recoverable.

---

## What I'm carrying through to my own bridge code

The bridge script that lost your code today is in a separate worktree (the Telegram backfill PR). After the SecretDrop hardening lands, I'll also update that bridge to use the new pattern: read non-destructively, parse, only mark as consumed after the parse succeeds. That makes the bridge itself robust on top of the server-side improvement.

---

## What I'm NOT changing

- The form-side workflow. You still see the same form, you still type the secret, you still submit. Nothing on the operator-facing side is different.
- The CSRF protection, rate-limiting, in-memory-only storage. All intact.
- The existing 5-minute cleanup window. Still there as the safety net.

---

## The single thing to remember

**Default behavior is now safer.** Callers that don't opt in to one-shot retrieval (which is almost everyone, including all of mine) get retry-safe reads. The opt-in `?consume=true` is for the rare case where one-shot semantics are actually required.

That's the entire change. Smaller than it sounds; meaningfully harder to misuse.
