---
title: "Confirm-page PIN guesses from strangers go through the sign-in limits"
slug: sec135-approval-link-guess-bound
author: Echo
tier: 2
status: approved
eli16-overview: sec135-approval-link-guess-bound.eli16.md
parent-principle: "Know Your Principal — An Unverified Identity Is a Guess"
sibling-principles: "No Single Device Lockout; Security Fixes Keep the Experience Whole; Judgment Within Floors"
parent-spec: "identity-security-piece1c-pin-policy.md (approved 2026-11-18), the per-request budget for approval links"
amends: "identity-security-piece1c-pin-policy.md, 'Per-request budget' bullet: for recommended-service confirm pages only, an answer from a browser that never unlocked the dashboard, away from the machine, is admitted and charged exactly like sign-in; a browser that unlocked the dashboard and the machine itself keep their own budgets, as on sign-in"
decision-source: "Chief of Staff, 2026-11-21 03:00Z (message 77d972f7): option C with two conditions (owner never subject to the backstop; per-source key from the tunnel-trusted address or the socket, never a client-supplied header)"
security-ledger: "SEC-135 (medium)"
review-convergence: "spec-converge 6 rounds (Tier 2 cap), cross-model codex-cli:gpt-6.2-astra every round; report docs/specs/reports/sec135-approval-link-guess-bound-convergence.md. The round-6 security finding (per-token limit survives a store outage) was applied as specified; the cap's operator acceptance was given with the approval below."
approved: true
approved-by: "Justin (owner), 2026-11-21 10:16 PST, Telegram topic 141385: 'Please proceed as you recommend' on the ask recommending 'accept, faster'"
approval-answers: "Open question 1: accept the experience cost at medium. Open question 2: the faster staged path (b)."
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

### What these limits are, and what they are not

Every limit in this design is a rate control: it bounds how many PIN guesses anyone can make and keeps the owner's own paths free during a flood. None of them identifies anyone. A browser marker or a local connection only decides which allowance an answer is charged to; it is never treated as proof of who is answering. The dashboard PIN remains the only proof of identity on a confirm page, as on sign-in.

### 3. Page opens for the owner's browser and the machine itself

- A `GET` counts as an owner open only when it carries `X-Instar-Request: 1` **and** either a valid marker or local-direct status. `service-yes.js` sends that header on its own `fetch`. A page on another origin cannot add it: the CORS allow-list is `Content-Type, Authorization`, so a cross-origin request with the header fails its preflight. A local process or raw TCP forwarder can still reach the local status, exactly as on sign-in (inherited).
- Owner opens use their own mint allowance of 30 a minute, separate from the strangers' `MAX_MINTS_PER_MINUTE`. A browser restoring more than 30 confirm tabs at once gets the 31st and later ones refused for up to a minute; `service-yes.js` retries such a refusal with brakes: it waits the refill time the server reports plus a random 0-10 seconds, so refused tabs do not retry together; it doubles the wait after each further refusal; it gives up after three tries and shows "Too many of these pages opened at once. Reload this one when you need it."; and only one tab per browser retries at a time (a shared `localStorage` lock), so a restore of many tabs drains one by one within the allowance instead of in a burst. A page whose 30-minute token expired while the owner was away shows "This page timed out while you were away. Reload to continue", and a reload mints a fresh token (an owner open), so an interruption costs one reload. A stranger flood can never stop an owner open, and owner opens never count toward the strangers' cap. The number is the existing cap, applied to a second bucket, so neither kind of caller can starve the other.
- Owner-open token rows carry `protected: true`, and keep the 30-minute life and the 50-per-service list. At capacity, the incoming caller decides the outcome:
  - an unprotected mint evicts the oldest unprotected token, and is refused (429 `too-many-pages`, no row changed) only when all 50 are protected;
  - a protected mint evicts the oldest unprotected token if there is one; when all 50 are protected it is refused (429 `too-many-pages`, no row changed) instead of evicting a live owner page, and the page says: "Too many approval pages for this service are still active, including some that may already be closed. They expire on their own within 30 minutes. Try again then, or approve from the dashboard." The store knows only how many protected tokens are live, not which tabs are open, so the message does not claim more than that.

  So neither a stranger flood nor a 51st owner open ever pushes out a page the owner has open. A local process flooding owner opens (the inherited local gap) can fill the 50 protected rows, limited by the owner allowance; the owner then sees that message.
- Everyone else's page opens are unchanged: the 30-a-minute mint cap and the 50-token list. No per-source open limit is added: the guesses those tokens allow are already bounded by section 2, whatever their number.

### Experience cost

- **Nothing changes on an ordinary day** except that an unknown browser now has sign-in's own limits: it is refused only when an applicable budget is exhausted, by strangers or by its own repeated wrong tries.
- **During an attack**, the owner's browser that unlocked the dashboard before, and the computer the agent runs on, keep working. That is the Chief of Staff's own definition of the owner for this fix (option C, condition 1: "a request from a browser the owner has already unlocked ... skips the agent-wide backstop"). It names the paired owner phone too; the Instar app does not use this page (it answers offers through its own signed routes), so it is not affected either way.
- **The residual case** is an owner on a browser that never unlocked the dashboard, away from the computer, when an applicable public limit is reached. That is usually during an attack, but it can also happen after their own few wrong tries (per-source backoff) or when their network's allowance is spent. They see the paused message, which names the ways through, and, when the refusing limit raises it, the brute-force alert has told them guessing is going on. This is the same limit sign-in already has for an unknown browser (piece 1c), not a new one. It applies only when a public limit is reached, exactly as on sign-in.
- **Search for a design with no loss even there:** before the PIN is compared, every signal the server has for that browser is one a stranger also has: an address of the same kind, no marker, and a token anyone may mint. Exempting it re-opens the guessing rate this spec closes, and every owner proof the server can check (marker, locality) is already exempt. An owner-only link with a private token was considered and rejected. Round 3 showed it creates a long-lived, forwardable PIN-guessing credential, needs a principal check of its own on a new route, and needs migration of the agents' instructions that hand-write bare links. That is far more surface than the residual case it would serve.

## Decision points touched

| Decision point | Classification | Basis |
|---|---|---|
| Unmarked, non-local confirm answers admitted and charged by sign-in's public limits | invariant | basis: irreversible-consequence; evidence: a guessed dashboard PIN grants owner authority (unlock, approvals, the money layer) that cannot be taken back short of changing the PIN everywhere. Every number is piece 1c's shipped sign-in policy, so no new limit is introduced and the two surfaces cannot drift apart. The risk target those numbers meet: a stranger's even chance of guessing a 6-digit PIN takes about 78 days per machine (20 public guesses per 5 minutes), far longer than the brute-force alert, which fires on the first burst and tells the owner to change the PIN. They are inherited starting values, not derived here; if sign-in's policy changes, confirm pages change with it, and tuning within the ceiling (for example per-network judgment) belongs to sign-in's own policy so both surfaces stay one policy. |
| Exemption by caller (valid marker, local-direct) | invariant | basis: enumerable-domain; evidence: piece 1c already exempts exactly these two on sign-in. The marker is HMAC-signed with the agent token. Local-direct (`ownLoopbackHost`) is reachable by any local process or raw TCP forwarder, as on sign-in, and is bounded by `LOCAL_PIN_KEY` (10 per 5 minutes), separate from the public 20. |
| Owner opens use their own mint allowance and outrank stranger tokens for eviction | invariant | basis: enumerable-domain; evidence: an owner open is a valid marker, or local-direct with `X-Instar-Request`, which a cross-origin page cannot send; a local process could also reach it, as on sign-in, bounded by its own 30-a-minute allowance. |
| Owner allowance size (30 opens a minute; 50 live tokens per service, shared with stranger tokens) | judgment-candidate | floor: the measured rewrite ceiling of the token file (one mint, including the full-file rewrite, took 19 ms at p99 and 53 ms at worst with every service at the 50-row cap, so the file can absorb roughly 1,000 mints a minute before rewrites queue), and the per-service row cap that keeps the file bounded; arbiter: the starting values 30 a minute and 50 rows, today's store values, kept so owner and stranger tokens share one consistent policy; fallback: those values. They are far inside the ceiling, so raising them (for a team that needs more pages, or adaptive admission) is a later judgment that does not touch safety; the brakes on `service-yes.js` retries (section 3) keep a many-tab restore from becoming a burst either way. |
| Which page is evicted at the 50-token cap | invariant | basis: enumerable-domain; evidence: the order is fixed by the caller kind (section 3). A protected owner page is never evicted: a stranger's mint cannot evict one, and a 51st owner open is refused with a message instead of evicting a live owner page. The only page that can be evicted is an unprotected one (an unknown browser's), which is today's behaviour for every page; its holder sees the existing expired-page answer and reopens it. The 50 and the 30-minute life are the existing token store's values, chosen to bound the file; a reload after expiry costs one tap. They are starting values within the measured resource ceiling (the token-file benchmark), not derived limits; a team that needs more than 50 live pages for one service, or adaptive admission, would be a change to the token store for every page and is out of scope here. |

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
- **Development-agent rung:** Echo runs it from the merge. Graduation evidence, judged by the maturation review once it exists (no fixed number of days):
  - **Successes inside the window, tied to its alert.** The counters record each event with its time, not only cumulative totals. For a review window the review reads the `DashboardPin.bruteForce` alerts in the degradation log for that window and, for each alert, the exempt-path answers (`marker` and `local`) completed while that alert's public aggregate was full. Evidence is at least one `marker` and one `local` success inside the window, each falling inside an alerted full-aggregate period. Older successes and successes outside an alerted period do not count.
  - The marker path is the remote owner's way through, so a local success alone is not enough.
  - **A dated fallback, so the review never waits forever.** If 21 days after merge no review window holds both kinds of success (a real attack is needed for that, and may not come), the agent does not keep waiting: it records what it has (the counters, any alerts, the throwaway-agent run) and hands the graduation decision to the Chief of Staff with that evidence and a plain statement of what was not observed. This is a tracked commitment opened at merge, due on that date.
  - **No synthetic activity on a real Echo machine.** If a window lacks either kind of success, the review waits for one up to the fallback date; it is never supplied by flooding a real Echo machine's sign-in budget. A controlled flood on a throwaway agent (the standard throwaway recipe, created and destroyed by the test) shows the same behaviour as test-agent evidence and is recorded on that rung only.
- **Fleet:** meeting that evidence raises the feature to the recurring maturation review (Maturation Path). The fleet-default change is opened only when that review's model decides to graduate it.
- **Until then, the fleet keeps today's exposure** (about 9,000 guesses an hour per machine through confirm pages). The SEC-135 ledger row records this, with the graduation review as a tracked commitment.
- **Operator acceptance of that interim is required, not assumed.** It is asked together with the experience decision (Open questions), as one choice for Justin. Both options keep the development-agent rung:
  - **(a) The standard path:** Echo runs it until the evidence above exists, then the maturation review decides the fleet change.
  - **(b) A faster staged path:** Echo runs it first, the maturation review is held as soon as the first window with both kinds of success exists (instead of waiting for further windows), and the fleet change follows that review immediately. The fleet's exposure lasts only until that first qualifying window.
  - The build does not start until one is chosen, and the PR body quotes the choice.
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
  - at capacity with all 50 protected, an unprotected mint and a protected mint are both refused with no row changed (section 3: a 51st owner open never evicts a live owner page). This bullet earlier said a protected mint replaces the oldest protected row, which contradicted section 3; the build follows section 3.
- **Unit, no wrong exemptions:** an `mps_` token or bearer gives no exemption, and a forged `cf-connecting-ip` sent straight to the port is ignored.
- **Unit, sign-in unchanged:** sign-in's answers and wording are identical after the hook refactor.
- **Unit, store outage:** with the store unavailable and public capacity left, five wrong answers on one token make its next answer refused before comparison, for a stranger and for a marked caller.
- **Unit, storage and counters:**
  - one persist per wrong guess (`recordFailures`);
  - counters flush at most once a minute;
  - an unreadable stats file reports `unknown`.
- **Integration:** a stranger flood on the confirm routes, after which a marked browser and a local caller both still complete an answer.
- **E2E:** the real server with the aggregate full; a marked-browser confirm completes and an unmarked one gets `pin-paused`.

## Build notes

- The verdict also has `{ ok: false, reason: 'unavailable' }` (no PIN can be read: the route answers today's 503) and `{ ok: false, reason: 'missing', path }` (no PIN sent: today's 403, nothing compared or counted). An ok verdict also carries `path` and `aggregateFull`, which the counters need.
- The confirm route reaches the verifier through a `verifyConfirmPin(req)` dep beside `checkConfirmPin`; it returns null when the switch is off or the hook is absent, and then `checkConfirmPin` runs exactly as before.
- Graduation evidence: each exempt-path answer completed while the public aggregate was full also writes a `fired` row (`marker-answer-while-aggregate-full` or `local-answer-while-aggregate-full`) to `logs/feature-evidence.jsonl`, which the `security.approvalLinks` ladder entry reads.

## Open questions (answered)

Justin answered both on 2026-11-21 at 10:16 PST (Telegram topic 141385), quoting the ask that recommended "accept, faster": "Please proceed as you recommend". So: (1) the experience cost is accepted at medium; (2) the faster staged path (b).

### As asked

For Justin, asked together by the Chief of Staff:

1. **Experience cost (Security Fixes Keep the Experience Whole).** SEC-135 is rated medium. The residual case (Experience cost) is an owner on a browser that never unlocked the dashboard, away from the computer, when a public limit is reached; they see the paused message. Accept that cost for a medium finding, or re-rate SEC-135 critical.
2. **Interim exposure (A Dark Feature Guards Nothing).** (a) the standard path, or (b) the faster staged path. Both run on Echo first; (b) holds the review at the first qualifying window (Rollout and maturation).
