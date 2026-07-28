# Network errors shouldn't crash the whole agent — Plain-English Overview

> The one-line version: a failed network call during an outage was crashing the entire server instead of being shrugged off — this teaches the crash-handler to treat network failures as recoverable.

## The problem in one breath

When the internet (or a peer machine, or Anthropic's API) is briefly unreachable, some background network call fails. If nobody caught that failure, it bubbles all the way up as an "uncaught exception" — and the server's default reaction to an uncaught exception is to shut the whole agent down. On 2026-06-15, during an API/network rough patch, exactly this happened: a routine "fetch failed" took the server down (it restarted itself ~50 seconds later, but it shouldn't have gone down at all).

## What already exists

- **The crash handler** — at the very top of the server there's a catch-all for "uncaught exceptions." By default it does the safe thing for a truly-unknown error: close the databases cleanly and exit, so the next boot isn't corrupted.
- **A recoverable-errors allowlist** — the handler already knows that a *small, specific* set of errors are harmless and should be logged-and-ignored instead of crashing: web-server double-reply hiccups, a Slack reconnect race, and a "this machine is on standby" stray write. These were added one at a time as each proved harmless.
- **First-seen-stack logging** — when it suppresses one of those, it logs the full origin the first time so the real un-guarded spot is still findable and fixable, then stays quiet on repeats so the log doesn't flood.

## What this adds

Network failures join that allowlist. A failed outbound network call — talking to a peer machine, reconnecting to Slack, any HTTP request — is *isolated by nature*: that one call gave up, but the databases, the web server, and everything else are completely fine, and whatever made the call will simply try again. So crashing the entire agent over it is strictly worse than logging it and moving on. The specific signatures added are the ones Node and its HTTP library actually produce: `fetch failed`, `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`, `EAI_AGAIN`, and `socket hang up`.

## The new pieces

- **Seven new allowlist entries (plus a comment explaining why).** No new code paths, no new module — just additions to the existing list the handler already consults. The handler's logic is untouched.

## The safeguards

**Keeps the safe default.** Anything the handler doesn't recognize still crashes, exactly as before. We only *added* recognized-as-harmless cases; we didn't change what happens to unknown errors.

**Keeps the boundary tight.** The matching is on specific network tokens, not on a loose word like "failed." A unit test proves that ordinary failures such as "assertion failed" or "migration failed" still crash — they are not swept up by the network rule.

**Doesn't hide the real bug.** The first-seen-stack logging still fires, so the actual un-guarded network call that threw is still recorded and can be properly wrapped later. This entry is the safety net, not an excuse to skip the proper fix.

**Reversible instantly.** It's a pure code change with no saved data or migrations — if it ever proved wrong, removing the seven lines restores the old behavior on the next build.

## What ships when

One Tier-1 change: the allowlist additions plus the tests, in a single PR. The optional follow-up — wrapping the specific network calls (the peer broadcast and the Slack reconnect) so they never reach the catch-all in the first place — can land separately; this backstop is valuable on its own and protects every future un-guarded network call too.
