# Side effects: the dashboard on a weak or missing connection

Spec: docs/specs/app-weak-network.md (tier 1). ELI16: docs/specs/app-weak-network.eli16.md.

## The change

- New `dashboard/console/net-state.js`: wraps the global `fetch` once for the whole dashboard. Allowlisted status GETs (needs, attention, commitments, sessions, pool, work board and projects, development reads, health, plans, jobs, guards, mandate) are saved to `localStorage` under a per-sign-in key and shown when the agent cannot be reached. A top line (`.net-line`, role=status) says what is shown and how old it is. Background `/health` checks back off 2/5/15/30/60 s and re-read the current page (at most every 15 s) when the agent answers.
- `console.js`: installs it, puts the line in the shell, wipes saved copies on sign-out, exposes the in-place page refresh to it, and keeps a stored sign-in when the boot check cannot reach the server (was: PIN screen).
- `browser-device.js`: the status check returns `{error:'unreachable'}` on a network failure instead of throwing (the Conversations page sat on "Checking this browser…" forever).

## Over-block

Sends (any non-GET) fail at once when the browser says it is offline (`navigator.onLine === false`). A browser that wrongly reports offline (rare; some captive portals) would refuse sends that might have worked. Reads in that state show saved copies. The line says "Offline", so the person can see why.

## Under-block

- A page opened for the first time on a dead connection has nothing saved: it says so plainly, no content.
- Conversations, topic names and anything read with the PIN are never saved by design (existing privacy rule), so those pages show only the line offline.
- A reload with no connection cannot load the page itself (no service worker); in the apps, the native frame now says so (separate app change).

## Level of abstraction

One wrapper below every page is the right layer: about 30 page modules each have their own fetch helper, so a per-page change would be 30 places to remember (Structure > Willpower). Pages do not change how they read.

## Signal vs authority

No blocking authority over the agent. It only decides what the browser shows when the agent does not answer, and labels it.

## Interactions

- Good connection: a read that answers is passed through untouched (the saved copy is only written). A read that is slow past 4 s triggers one `/health` check; if the agent answers, the page keeps waiting as before. No line, no change.
- 401/403/5xx from the agent are passed through: sign-out and error handling are unchanged. Only a network failure or no answer serves a saved copy.
- The page's own timeouts still apply; a served saved copy resolves before them.
- The 30 s page refresh and the back-online refresh share the router's one-at-a-time guard.

## External surfaces

Browser storage only, per origin and per sign-in tag. No server change, no API change, nothing other agents see.

## Multi-machine posture

Machine-local by design (browser-local cache of what that browser was shown). Pooled reads (`/pool`, `/needs`) are saved as answered, already merged.

## Rollback cost

A revert removes it; leftover `instar-net:*` keys in browsers are inert (small, expire after 7 days, wiped on sign-out).

## Second pass

Independent reviewer read of net-state.js + wiring: see below.

Independent reviewer (cold read of net-state.js, console.js, browser-device.js), 2026-11-16 ~15:00 PST. Concern raised, five findings, all fixed in this change:

1. Over a Cloudflare tunnel the edge answers 502/504/52x/530 when the agent is down; the probe and reads counted that as the agent answering, so the saved copy never showed. Fixed: `frontCouldNotReach()` treats those as no answer (503 stays the agent's own "switched off"). Tests added.
2. `navigator.onLine === false` on the agent's own machine (localhost, no adapter) would refuse working requests. Fixed: loopback hosts are never "offline".
3. The saved-copy key followed the current sign-in, not the request's. Fixed: keyed by the request's own bearer; a read that lands after the sign-in changed is not saved; no bearer, nothing saved. Test added.
4. The unlock form could keep a typed value unchecked when the network failed. Fixed: only the boot check of an already-stored sign-in tolerates "couldn't reach".
5. A `Request` object's method and headers were ignored. Fixed (latent; no caller does this today). Test added.

Reviewer also confirmed: abort handling, single body read and clone, timers cleared, no unhandled rejections, query strings keyed, non-JSON not saved, onBack rate limit holds.

Re-check after fixes: reviewer concurred; one remaining non-blocking gap (a slow read whose live answer then fails returned an error instead of the saved copy) fixed in the same change.
