---
title: "Confirm-page PIN guesses from strangers go through the sign-in limits"
slug: sec135-approval-link-guess-bound
author: Echo
tier: 2
status: draft
eli16-overview: sec135-approval-link-guess-bound.eli16.md
parent-principle: "Know Your Principal — An Unverified Identity Is a Guess"
sibling-principles: "No Single Device Lockout; Security Fixes Keep the Experience Whole; Judgment Within Floors"
parent-spec: "identity-security-piece1c-pin-policy.md (approved 2026-11-18), the per-request budget for approval links"
amends: "identity-security-piece1c-pin-policy.md, 'Per-request budget' bullet: for recommended-service confirm pages only, an answer from a browser that never unlocked the dashboard, away from the machine, is admitted and charged exactly like sign-in; a browser that unlocked the dashboard and the machine itself keep their own budgets, as on sign-in"
decision-source: "Chief of Staff, 2026-11-21 03:00Z (message 77d972f7): option C with two conditions (owner never subject to the backstop; per-source key from the tunnel-trusted address or the socket, never a client-supplied header)"
security-ledger: "SEC-135 (medium)"
approved: false
---
# Confirm-page PIN guesses from strangers go through the sign-in limits

## Problem statement

Piece 1c gives each approval link its own PIN budget: 5 wrong guesses per live request id or page token per 5-minute window (`PinAttemptStore` has one 5-minute window for every key), kept in the durable store. It promises that the strangers' public aggregate never refuses an approval link, so guessing at the sign-in page cannot lock the owner out of a link opened on a phone.

The budget is per token, so the total is bounded only by how many tokens a caller can get:

- `GET /recommended-services/:id/confirm` is reachable before any sign-in (`middleware.ts`), and every call mints a fresh page token (`ConfirmTokenStore.mint`, `src/recommended/confirmTokens.ts`). The page `dashboard-pair/service-yes.js` calls it with a same-origin `fetch`.
- Minting is capped at 30 a minute agent-wide (`MAX_MINTS_PER_MINUTE`), with 50 live tokens per service. Both caps are shared by every caller.
- So anyone who knows a machine's address can mint about 30 tokens a minute and spend 5 guesses on each: at least 150 guesses a minute, at least 9,000 an hour per machine (each live token also regains 5 guesses every window during its 30-minute life). A 4-digit PIN falls in about an hour; a 6-digit one (the generated length) in about four days.
- The wrong guesses feed only an alert-only count (`PIN_ALERT_ONLY_KEY`), which never refuses anything.
- `/mcp/approve/:id` is not affected: its request ids are created by the agent itself when a tool change is requested, so a stranger cannot mint them. It keeps piece 1c's design unchanged and is out of scope.

## Proposed design

Scope: the recommended-services confirm routes (`GET` and `POST /recommended-services/:id/confirm`) and their page `dashboard-pair/service-yes.js`. `/mcp/approve/:id` and every other PIN route are unchanged, including `POST /recommended-services/email/code`, which the same page uses for the email proof code: it keeps today's public aggregate with no marker or local exemption, so under attack an owner can answer yes to email but may have to wait to enter its code.

### 1. One shared hook for the public PIN limits

The sign-in page's public PIN logic lives in closures in the `AgentServer` constructor (`publicPinContext`, `publicPinAdmit`, `publicPinFailure`, `publicPinSuccess`, the shared `PinThrottle`, `LOCAL_PIN_KEY`). It is exposed to routes as one hook on the route context, as `pinEntryRefusedHere` already is:

```ts
ctx.publicPin = {
  context(req): { ip, markerId, isLocalDirect, localUnmarked },   // publicPinContext, unchanged
  verify(req, candidate, opts: { requestKey: string; alertKey?: string }):  // the one entry point for the confirm route
    { ok: true } | { ok: false, reason: 'insecure-connection' } | { ok: false, reason: 'wrong-pin' | 'paused', path: 'public' | 'marker' | 'local', retryAfterSeconds },
}
```

`verify` is one synchronous verifier, as piece 1c §1 requires: no `await` between admission, comparison and charging, so parallel requests cannot pass a limit together. In order, it:
1. refuses with `insecure-connection` if the connection is not secure enough to take a PIN (`pinEntryRefusedHere`, kept from `checkPublicPin`; the route answers 403 `insecure-connection` with today's wording, compares nothing and counts nothing). Otherwise it refuses with `paused` if any applicable budget is already spent: the caller's class budget (section 2) or the per-request key `opts.requestKey`. The per-request key is enforced on all three paths. `retryAfterSeconds` is the throttle's own value, or the store window (300) for a durable block;
2. compares the PIN in constant time through the same current-PIN read as sign-in;
3. on a wrong PIN, charges the class budget, the per-request key and, for marked and local callers, `PIN_ALERT_ONLY_KEY` (until it is full, as today) in one write, and returns `wrong-pin`. `recordFailures(keys)` returns each key's remaining count, which fires the same alerts as today. When there is no store, or a write fails, the in-memory fallback keeps every budget `verify` checks, the per-request key included, so a store outage never lifts the 5-per-token limit on any path;
4. on a right PIN, clears this source's counters only, as sign-in.

Sign-in and step-up are refactored onto the same internal functions and render their own answers exactly as today. Wiring in `recommendedServiceRoutes.ts`: the `checkConfirmPin` dep delegates to `ctx.publicPin.verify`, a new `ownerOpen(req)` dep classifies a `GET` as an owner open, and `ConfirmTokenStore.mint(binding, { protected })` takes the flag. `PinAttemptStore` gains `recordFailures(keys)`, which charges several keys in one write, so a wrong guess costs one persist.

### 2. How a confirm answer is admitted

For `POST /recommended-services/:id/confirm`, after today's checks (`X-Instar-Request`, the token shape and `tokens.isLive`):

- **On the machine itself, unmarked** (`localUnmarked`): the local budget exactly as sign-in (`LOCAL_PIN_KEY`, 10 wrong per 5 minutes; piece 1c §5), plus today's per-request budget. A local caller with a marker takes the marker path below, as on sign-in.
- **From a browser with a valid remembered-browser marker** (`instar_pin_ok`, verified on this POST): the throttle's marker path exactly as sign-in (its own backoff, its abuse cap of 50), plus the per-request budget. A marker that the throttle no longer honours, and the durable-check gap for it, behave exactly as on sign-in (inherited, piece 1c).
- **Anyone else:** `verify` with sign-in's public admission: per-source backoff after 3 misses, the per-network budget of 10, and the public aggregate of 20 wrong per 5 minutes per machine, shared with sign-in. The source is `context(req).ip`, so an unattributable loopback caller gets no shared source key. A refused attempt compares nothing and charges nothing. A wrong guess charges the public budget and the per-request key in one write. Sign-in and confirm requests contend for the same aggregate inside `verify`, so with one attempt left exactly one of two parallel requests is compared.
- **The refused answer** on the public path is 429 `{ error: 'pin-paused', message, retryAfterSeconds }` with one fixed `message` wording for every refusing limit, rendered by the confirm route (not by `publicPinAdmit`'s sign-in bodies), so the wording reveals nothing about which limit fired (the retry interval can differ between the throttle and a durable block): "Too many wrong PINs have been tried, so this page is paused for a few minutes. If you are the owner, open it in a browser that still remembers your dashboard sign-in, or on the computer I run on, or try again in a few minutes." `service-yes.js` shows that server text for `pin-paused`. On the marker and local paths, which reveal nothing to a stranger, the refusal says: "Too many wrong PINs from this browser. Wait a few minutes and try again."
- Alerts: the throttle's `DashboardPin.bruteForce` alert covers stranger guesses, as on sign-in. `PIN_ALERT_ONLY_KEY` now counts only marked and local wrong guesses on confirm pages; stranger guesses no longer feed it, because they feed the throttle's alert instead.

Result: a stranger gets no more guesses through confirm pages than through sign-in, under the same limits and alert, because they are the same limits. A 6-digit PIN (900,000 values) at 20 guesses per 5 minutes per machine is fully covered in about 156 days per machine, and an even chance falls at about 78 days. This is piece 1c §4's figure, unchanged. Before this fix it was 9,000 guesses an hour per machine: full coverage in about 100 hours, an even chance at about 50 hours.

### 3. Page opens for the owner's browser and the machine itself

- A `GET` counts as an owner open only when it carries `X-Instar-Request: 1` **and** either a valid marker or local-direct status. `service-yes.js` sends that header on its own `fetch`. A page on another origin cannot add it: the CORS allow-list is `Content-Type, Authorization`, so a cross-origin request with the header fails its preflight. A local process or raw TCP forwarder can still reach the local status, exactly as on sign-in (inherited).
- Owner opens use their own mint allowance of 30 a minute, separate from the strangers' `MAX_MINTS_PER_MINUTE`. A stranger flood can never stop an owner open, and owner opens never count toward the strangers' cap. The number is the existing cap, applied to a second bucket, so neither kind of caller can starve the other.
- Owner-open token rows carry `protected: true`, and keep the 30-minute life and the 50-per-service list. At capacity, the incoming caller decides the outcome:
  - an unprotected mint evicts the oldest unprotected token, and is refused (429 `too-many-pages`, no row changed) only when all 50 are protected;
  - a protected mint evicts the oldest unprotected token if there is one, and otherwise the oldest protected token.

  So a remote stranger flood never pushes out the owner's open page. A local process flooding owner opens (the inherited local gap) can evict protected rows, limited by the owner allowance. All 50 being protected needs 50 owner opens within 30 minutes, bounded by the owner allowance above.
- Everyone else's page opens are unchanged: the 30-a-minute mint cap and the 50-token list. No per-source open limit is added: the guesses those tokens allow are already bounded by section 2, whatever their number.

### Experience cost

- **Nothing changes on an ordinary day** except that an unknown browser now has sign-in's own limits: it is refused only when an applicable budget is exhausted, by strangers or by its own repeated wrong tries.
- **During an attack**, the owner's browser that unlocked the dashboard before, and the computer the agent runs on, keep working. That is the Chief of Staff's own definition of the owner for this fix (option C, condition 1: "a request from a browser the owner has already unlocked ... skips the agent-wide backstop"). It names the paired owner phone too; the Instar app does not use this page (it answers offers through its own signed routes), so it is not affected either way.
- **The residual case** is an owner on a browser that never unlocked the dashboard, away from the computer, when an applicable public limit is reached. That is usually during an attack, but it can also happen after their own few wrong tries (per-source backoff) or when their network's allowance is spent. They see the paused message, which names the ways through, and, when the refusing limit raises it, the brute-force alert has told them guessing is going on. This is the same limit sign-in already has for an unknown browser (piece 1c), not a new one. It applies only when a public limit is reached, exactly as on sign-in.
- **Search for a design with no loss even there:** before the PIN is compared, every signal the server has for that browser is one a stranger also has: an address of the same kind, no marker, and a token anyone may mint. Exempting it re-opens the guessing rate this spec closes, and every owner proof the server can check (marker, locality) is already exempt. An owner-only link with a private token was considered and rejected. Round 3 showed it creates a long-lived, forwardable PIN-guessing credential, needs a principal check of its own on a new route, and needs migration of the agents' instructions that hand-write bare links. That is far more surface than the residual case it would serve.

## Decision points touched

| Decision point | Classification | Basis |
|---|---|---|
| Unmarked, non-local confirm answers admitted and charged by sign-in's public limits | invariant | basis: irreversible-consequence; evidence: a guessed dashboard PIN grants owner authority (unlock, approvals, the money layer) that cannot be taken back short of changing the PIN everywhere. Every number is piece 1c's shipped sign-in policy, so no new limit is introduced and the two surfaces cannot drift apart. |
| Exemption by caller (valid marker, local-direct) | invariant | basis: enumerable-domain; evidence: piece 1c already exempts exactly these two on sign-in. The marker is HMAC-signed with the agent token. Local-direct (`ownLoopbackHost`) is reachable by any local process or raw TCP forwarder, as on sign-in, and is bounded by `LOCAL_PIN_KEY` (10 per 5 minutes), separate from the public 20. |
| Owner opens use their own mint allowance and outrank stranger tokens for eviction | invariant | basis: enumerable-domain; evidence: an owner open is a valid marker, or local-direct with `X-Instar-Request`, which a cross-origin page cannot send; a local process could also reach it, as on sign-in, bounded by its own 30-a-minute allowance. |
| Owner allowance size (30 opens a minute; 50 live tokens per service, shared with stranger tokens) | invariant | basis: external-constraint; evidence: these are `confirmTokens.ts`'s existing `MAX_MINTS_PER_MINUTE` and `MAX_PER_SERVICE`, which exist because every mint rewrites `tokens.json`; they bound the token file's rewrite rate and size. **Measured capacity** (2026-11-21, M5 Pro, the real `ConfirmTokenStore` with six services each at the 50-row cap, 2,000 mints): one mint including the full-file rewrite takes 0.75 ms median, 19 ms p99, 53 ms worst. The combined worst case of 60 mints a minute is about one rewrite a second, under 0.1% of a second at the median and about 2% at p99, so the doubled rate is well inside capacity. The ceiling is a size and rate bound, not a capacity limit, so no measured number would justify raising it either. Counterexample considered: an owner opening more than 30 confirm pages in one minute. No person does that; a reload loop that does is held at 30 a minute and recovers in the next minute. A browser restoring a session reloads each confirm page through `service-yes.js`, whose `fetch` carries the owner header, so a restored owner page is a protected open and counts against the owner allowance, not the strangers'. |
| Which page is evicted at the 50-token cap | invariant | basis: enumerable-domain; evidence: the order is fixed by the caller kind (section 3), and the evicted page is never a protected owner page while an unprotected one exists. The page that can be evicted is an unprotected one: a page opened by an unknown browser, which is today's behaviour for every page (oldest of 50 dropped). Its holder sees the existing expired-page answer and reopens the page, which mints a fresh token; nothing is approved or lost by the eviction. |

## Multi-machine posture

- **Page tokens** (with the new `protected` field): machine-local, as today (registry entry `recommended-service-tokens`, scope `machine-local`). machine-local-justification: physical-credential-locality (a page token is a single-use credential that exists only in the serving machine's token file and is accepted only there; it lives 30 minutes, minted at page open, as today). Why no other machine honours it, beyond "that is where it is written": (1) the link that carries the token is the minting machine's own address, so no other machine ever receives it in the ordinary journey; (2) single use needs one place that spends it exactly once, and the pool has no authenticated cross-machine writer today (state journal replication is pull-based and unsigned, the SEC-088 record), so accepting a token minted elsewhere would mean trusting a peer-supplied token row, a path a compromised or impersonated peer could use to forge approvals; (3) the approval it carries is answered on the machine that offered it, which also holds that offer's PIN counters. Replicating tokens would add a forgery path to save nothing a person sees.
- **PIN counters:** no new counter rows. Every charge uses sign-in's existing throttle and public aggregate, whose per-machine posture piece 1c §4 declares. `state/pin-attempts.json` is added to `src/data/state-coherence-registry.json` (it was missing) with category `pin-attempts`, scope `machine-local`, conflictShape `single-writer`, transport `none`, at most 4096 rows, describing piece 1c's posture.
- **Confirm counters** (see Observability): per machine, proxied-on-read. Each machine reports its own in `GET /recommended-services`, and the graduation review reads every machine's (the pool roster in `GET /pool`) and sums them. No pool route is added.

## Frontloaded Decisions

- **Shape:** the Chief of Staff's option C (2026-11-21 03:00Z, message 77d972f7), met with its two conditions. The owner (a marked browser, or the machine itself) is never refused by strangers, and the source key is sign-in's own. The "backstop" is the existing sign-in public budget. No owner-delivered token is introduced (see Experience cost).
- **Scope:** recommended-services confirm only; `/mcp/approve/:id` unchanged.
- **Refusal:** one fixed wording, rendered by the confirm route.
- **One switch** for the rollout; no new limits.
- **Rollout:** dev-gated for a week of evidence, then fleet-wide through the maturation review (see Rollout and maturation).

## Migration

- Token rows gain the optional `protected` field; rows written before the update are unprotected and expire within 30 minutes.
- One config key, `security.approvalLinks.enabled`, read through `devGatedFeatures` (absent means the dev-gated default); no `migrateConfig()` step.

## Observability

Counters per machine, kept in memory and flushed to `state/recommended-service-tokens/confirm-stats.json` at most once a minute (cumulative, with a `since` timestamp), so a flood cannot drive disk writes. They are reported in the signed-in `GET /recommended-services` answer as `confirmStats`. Before the first flush the in-memory counters are reported. An unreadable file reports `confirmStats: unknown` with the reason, never zeros. The counters are:
- `publicPathRefused`: answers on the public path (no valid marker, not local-direct) refused by the public limits;
- `answersByPath`: completed answers counted by the path they took: `marker`, `local`, `public`;
- `exemptPathOpens`: page opens that used the second mint allowance (marker or local-direct with the header), counted whether or not the strangers' allowance had room;
- `exemptPathAnswersWhileAggregateFull`: answers completed on the `marker` and on the `local` path while the public aggregate was full, counted separately.

**What each counter does and does not prove (state vs symbol).** Every counter names a path, never a person. The public path includes the owner on a browser that never unlocked the dashboard, so `publicPathRefused` is not "strangers refused". The local path is any local process, as on sign-in, so a `local` answer is not "the owner answered". A `marker` answer proves only that the browser once unlocked the dashboard with the PIN (the marker is HMAC-signed with the agent token). The claim these counters support is narrower than identity: *the two exempt paths keep completing answers while the public aggregate is full.* The independent corroboration that the aggregate really was full is the `DashboardPin.bruteForce` alert in the degradation log for the same window. When the stats file is unreadable the result is `confirmStats: unknown` with the reason, never zeros, and the graduation review treats an unknown week as missing evidence.

## Rollout and maturation

- **Test-agent rung:** the e2e test boots the real server with the public aggregate full and completes a confirm from a marked browser and from the machine itself, while an unmarked answer gets the paused wording. Stranger requests in tests use a Host that is not one of the agent's own names (so a loopback caller is unattributed and takes the public path) or the LAN address, never plain `localhost`. Before merge, a throwaway test agent (the standard throwaway recipe) is driven through a stranger flood and a marked-browser answer, with `confirmStats` read back.
- **Development-agent rung:** Echo runs it from the merge. Graduation evidence:
  - `confirmStats` from every Echo machine with a `since` at least seven days old;
  - the independent corroboration of the `DashboardPin.bruteForce` alert history in the degradation log for the same week;
  - at least one `exemptPathAnswersWhileAggregateFull.marker` and one `.local` across Echo's machines. The marker path is the remote owner's way through, so a local success alone is not enough. If the week lacks one, the evidence is supplied on the development-agent rung itself: a controlled observation on one Echo machine (flood to a full aggregate, then that kind of answer), recorded with its run log. A test-agent run never fills a development-agent gap; if no Echo observation is made, the evidence window extends by a week.
- **Fleet:** meeting that evidence raises the feature to the recurring maturation review (Maturation Path). The fleet-default change is opened only when that review's model decides to graduate it.
- **Until then, the fleet keeps today's exposure** (about 9,000 guesses an hour per machine through confirm pages). The SEC-135 ledger row records this, with a dated graduation review (commitment, due one week after merge).
- **Operator acceptance of that interim is required, not assumed.** It is asked together with the experience decision (Open questions), as a single choice for Justin: (a) accept one dev-gated evidence week with the fleet exposure above; or (b) turn the fix on fleet-wide at merge and run the evidence week fleet-wide, with the switch as the rollback. The build does not start until one is chosen, and the PR body quotes the choice.
- **Off** means today's behaviour exactly.

## Rollback

Revert the commit. Older code ignores the `protected` field. `confirm-stats.json` is unused and harmless. Sign-in is refactored onto the shared internal functions; a revert restores the closures as they were.

## Tests

- **Unit, stranger path:**
  - once sign-in's public aggregate is full, an unmarked non-local answer is refused with the fixed `pin-paused` wording, with nothing compared or charged;
  - sign-in and confirm guesses share the aggregate and the per-source backoff;
  - a stranger gets no more guesses across any number of tokens.
- **Unit, one verifier:**
  - an exhausted per-request key refuses while public admission still allows the caller;
  - with one aggregate attempt left, two parallel wrong candidates (one sign-in, one confirm) compare exactly one;
  - a right PIN processed first leaves that last attempt available for the other request;
  - an insecure connection is refused before any compare and is not counted in `publicPathRefused`.
- **Unit, owner paths:**
  - with the aggregate full, a marked answer passes with the right PIN, and so does a local-direct one;
  - their wrong guesses use the marker path and the local budget;
  - a marked or local `GET` with `X-Instar-Request` loads with the mint cap full, and an unprotected flood never evicts a protected token;
  - a marked `GET` without the header is a stranger open: it uses the strangers' cap and makes an unprotected row;
  - a CORS preflight for the confirm path does not list `X-Instar-Request` in `Access-Control-Allow-Headers`, which pins the assumption the owner-open check rests on (with a comment at that header list in `middleware.ts`);
  - at capacity with all 50 protected, an unprotected mint is refused with no row changed, and a protected mint replaces the oldest protected row.
- **Unit, no wrong exemptions:** an `mps_` token or bearer gives no exemption, and a forged `cf-connecting-ip` sent straight to the port is ignored.
- **Unit, sign-in unchanged:** sign-in's answers and wording are identical after the hook refactor.
- **Unit, store outage:** with the store unavailable and public capacity left, five wrong answers on one token make its next answer refused before comparison, for a stranger and for a marked caller.
- **Unit, storage and counters:**
  - one persist per wrong guess (`recordFailures`);
  - counters flush at most once a minute;
  - an unreadable stats file reports `unknown`.
- **Integration:** a stranger flood on the confirm routes, after which a marked browser and a local caller both still complete an answer.
- **E2E:** the real server with the aggregate full; a marked-browser confirm completes and an unmarked one gets `pin-paused`.

## Open questions

For Justin, asked together by the Chief of Staff:

1. **Experience cost (Security Fixes Keep the Experience Whole).** SEC-135 is rated medium. The residual case (Experience cost) is an owner on a browser that never unlocked the dashboard, away from the computer, when a public limit is reached; they see the paused message. Accept that cost for a medium finding, or re-rate SEC-135 critical.
2. **Interim exposure (A Dark Feature Guards Nothing).** (a) one dev-gated evidence week, with the fleet keeping today's exposure; or (b) fleet-wide at merge with the switch as rollback (Rollout and maturation).
