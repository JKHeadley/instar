---
title: "One PIN attempt policy for every place the PIN is checked"
slug: identity-security-piece1c-pin-policy
author: Echo
tier: 2
status: approved
eli16-overview: identity-security-piece1c-pin-policy.eli16.md
parent-principle: "Know Your Principal — An Unverified Identity Is a Guess"
sibling-principles: "Signal vs. Authority; Security Fixes Keep the Experience Whole; No Single Device Lockout; An Instar Agent Is Always a Multi-Machine Entity; Judgment Within Floors"
parent-spec: "identity-security-levels.md (approved 2026-11-17 19:34 PST, Justin, topic 144636), §12 item 1 ('PIN limits keyed on the real client address behind the tunnel') and §10"
split-from: "identity-security-piece1 (round 5 reviewed this as §2 paragraph 2)"
lessons-engaged: "fix-the-class-not-the-instance, no-single-device-lockout, spec-reviews-not-falling-means-cut, a-dark-guard-is-worse-than-no-guard"
review-convergence: "2026-11-18T11:28:00Z"
review-iterations: 3
review-completed-at: "2026-11-18T11:28:00Z"
review-report: "reports/identity-security-piece1c-pin-policy-convergence.md"
cross-model-review: "codex-cli gpt-6.2-astra (headley.justin) rounds 1 and 2 (and round 5 of piece 1 as its section 2)"
approved: true
approved-by: "Under the approved umbrella identity-security-levels.md (Justin, topic 144636, 2026-11-17 19:34 PST: \"great! approved, please enter a 24 hour autonomous session in gpt 6.2 astra to build this\") and Justin's standing guidance that only constitution changes need his approval (2026-10-22). No constitution text changes here."
---
# One PIN attempt policy for every place the PIN is checked

## Problem statement

The dashboard PIN guards sign-in and several owner actions. Only the sign-in route (`POST /dashboard/unlock`) runs the shipped guessing limits (`PinThrottle`, SEC-002 design (b), on by default): marker-first admission, 3 soft failures then exponential backoff to 15 minutes, a coarse budget per /24 or /48, a marked-abuse cap, and an owner alert.

Every other place that checks the PIN does less (round-5 review, confirmed against the code at `916e8c6d7`; sites in the table below):

- **Shared tunnel bucket.** Step-up and the three mandate-PIN copies key on `req.ip`. `trust proxy` is never set, and both tunnels forward to `127.0.0.1`, so every remote caller shares one bucket: one stranger locks every remote owner out of step-up and every mandate route, and anyone's success clears it for all.
- **No limit.** Five routes compare the PIN with no limit at all.
- **One counter for all.** The money-layer routes keep one in-memory counter for everyone: 5 failures lock everybody out for 15 minutes.
- **Memory only.** The three mandate copies each keep their own in-memory map (3 × 5 guesses per window). PinThrottle's global cap, network caps and backoff are in memory too, and a restart resets them.
- **Separate budgets.** A guess on one route mostly does not count on another; the store keys differ.
- **Store failures.** A missing or corrupt attempt store fails open without a word, and it accepts negative counts. When the store cannot be created, every optional-chained call is skipped, including `checkPublicPin`'s global cap.
- **Global reset.** On the legacy path (throttle off), a successful unlock resets the global budget for everyone.

## Proposed design

### 1. One verifier, two budgets

`verifyOwnerPin(req, candidate, { action, pool })` (new, `src/server/ownerPinVerifier.ts`) is the only code that compares a caller's input with the dashboard PIN. It is **synchronous**: admission, the constant-time compare and the charge happen with no `await` between them, so parallel requests cannot pass the limit together. It reads the current PIN through one path (today's unlock path, including the graph owner re-check). A success proves only "someone with the PIN" (umbrella receipt proof type `pin-check`). Each route keeps its own action, requester, role and device checks, and its own response shape.

Every wrong guess is charged once, in the budget of the route it was made on:

- **Public budget** for routes a stranger can reach with no other proof: `POST /dashboard/unlock`, `POST /dashboard/session/step-up` (registered before the auth middleware; the dashboard calls it with its cookie only, `dashboard/index.html:4528`), and the recommended-services email-code route. Sign-in and step-up share one set of helpers. The owner's browser carries the remembered-browser cookie from its own sign-in, so on both it is judged on its own marker and strangers cannot drain it. This is PinThrottle exactly as unlock uses it today: marker-first admission, 3 soft failures then backoff to 15 minutes per source, the coarse network budget of 10, the marked-abuse cap of 50, the owner alert, and the aggregate of 20 unmarked failures per 5 minutes.
- **Per-request budget** for approval links that check the PIN only after a live, unguessable request id or token: `/mcp/approve/:id` and recommended-services confirm. Each live request id gets 5 wrong guesses, and the public aggregate never refuses them. A stranger guessing at the sign-in page cannot use up an approval link the owner opens on their phone, which has no remembered-browser cookie. Its counters are kept in the durable store (key `req:<request id>`, expiring with the request), so a restart gives no fresh guesses. Wrong guesses here feed a separate alert-only count, so the owner is still alerted to an attack; that count never refuses anything.
- **Signed-in budget** for routes behind the auth middleware (a bearer, a dashboard `dst_` session, an `mps_` session or a device key): every mandate-PIN route, the work board, skill learning, the money layer and the five routes with no limit today. The source is the credential that authenticated the request:
  - a dashboard session: its session family id, so a refresh does not grant fresh guesses;
  - a device id;
  - `forwarded:<machine>` for a verified peer machine;
  - a request carrying the agent key plus a valid remembered-browser cookie (`instar_pin_ok`): that cookie's id. With the scoped-session feature off, the owner's dashboard holds the agent key, so this keeps a confused local script from refusing the owner;
  - else the operator-session token, if the request carries one;
  - otherwise `agent-bearer`, shared by local scripts and sessions. A session retrying a stale PIN can hold this one key's backoff, which is no worse than today's shared `127.0.0.1` bucket. The owner's browser is keyed on its cookie, so it is not affected. Each source gets 5 wrong guesses per 5 minutes, as the mandate PIN allows today. There is no shared signed-in aggregate, so one credential's wrong guesses never refuse a different credential's right PIN. The callers that share `agent-bearer` are the exception named below. Every source here has already proven something. A credential minted with only the agent's own key (a device or session created by a bearer holder) is inside the Basic boundary: that holder can already read the PIN from the config. The number of such credentials is bounded by their stores (sessions, devices, the machine roster).
  - A stranger cannot reach these routes, so strangers' guesses at the public budget never refuse a signed-in owner. This is what today's separate buckets give, kept.
  - Only a caller who already holds the agent's key or a session can guess here, and each is limited on its own.

A success clears only its own source's counter, never an aggregate. Marked browsers, the machine's own local budget and, once piece 1a lands, its verified-local budget keep their own routes (section 5).

A ratchet test fails on any comparison with `dashboardPin` outside the verifier. Its allowlist names, with reasons:
- the `x-instar-principal-pin` audit compare (`routes.ts:14157`, recorded only);
- unlock's post-success re-check against the graph credential (`AgentServer.ts:2321`, inside the verifier's read path);
- the redaction lists.

### 2. Who the caller is (public budget)

- The source is the existing `callerAddress` resolver.
- Behind the agent's own Cloudflare tunnel, the real client address arrives in `cf-connecting-ip` on a loopback socket with one of the agent's own names as Host. cloudflared overwrites that header, so a remote client cannot choose it. It is a **per-source signal only**: it picks whose backoff applies and never exempts. A local process could forge it, but a local process of the same OS user can read the PIN from the config anyway (inside the Basic boundary).
- A loopback request without that header is unattributable: localtunnel, relayed traffic, or an own-name Host with no header. It is charged to the public aggregate only, never to a shared `127.0.0.1` source key, so one stranger cannot back off everyone.
- The aggregate is the hard bound: 20 unmarked failures per 5 minutes.

### 3. Counters that survive a restart

- The public aggregate and the signed-in per-source counters are kept in `state/pin-attempts.json`, the existing store, and loaded at boot. A restart no longer resets them. PinThrottle's per-source backoff and network caps stay in memory, as today, bounded by the durable aggregate.
- One write per charged guess: the source and its aggregate are written together. A refused attempt writes nothing.
- The store prunes expired rows on load and on every write, and holds at most 4096 rows. The oldest unlocked row goes first, and a locked row is never evicted. Locked rows stay few: on the public budget the 20-guess cap means at most 4 new sources can reach a 5-guess lock per window, and on the signed-in budget sources are credentials, bounded by their own stores. So the cap is never reached by locked rows alone.
- **A missing file** at first boot or after a restore starts fresh.
- **An empty, corrupt or invalid file** is moved aside to `pin-attempts.corrupt-<time>.json`, and the degradation `PinAttemptStore.load` is reported. Invalid includes a negative, non-integer or over-cap count. The public aggregate then starts the current window as fully used, so ordinary unmarked attempts are refused for one 5-minute window with 429 `pin-paused`. The pause is written back as a valid file at once, so a restart during it stays paused instead of starting fresh ("PIN sign-in is paused for a few minutes; use a browser that signed in before, your phone, or this computer"). Counting then resumes. Nobody has to repair anything, and at most one window is given back. Marked browsers, local callers and paired devices are unaffected.
- **A failed write** leaves the in-memory counters enforcing, because they are still correct in this process, and reports the degradation `PinAttemptStore.persist` once per failure episode. A full disk never pauses anyone's sign-in. If the process restarts during such an episode, at most the current window's charges are lost, and a remote caller cannot cause a restart.

### 4. Multi-machine posture

The PIN may be synced between an agent's machines (secret sync is dev-gated), and each machine keeps its own counters. A stranger who reaches N machines therefore gets N public aggregates. This spec keeps that residual explicitly bounded and invents no routing:
- Generated PINs are 6 digits (`randomInt(100000, 1000000)`, 900,000 values).
- At 20 guesses per 5 minutes per machine, the expected time to hit is about 19.5 days at N = 4, during which the owner alert fires on every machine.
- A shorter PIN set by hand lowers that: a 4-digit PIN at N = 4 falls in about 5 hours. Requiring a minimum length is part of PIN policy in piece 1d.

One credential holder per secret comes with piece 4 (credential cutover).

### 5. The local link and marked browsers

The verifier keeps every existing way in that does not depend on the remote budget: a browser with the signed `instar_pin_ok` marker (its own per-marker backoff and abuse cap, as today), the machine's own unmarked local budget (10 per 5 minutes), and, once piece 1a (PR 3406) is merged, the verified-local budget of its one-time local link. Whichever lands second wires the other in; the verifier's interface takes the locality decision as an input, so neither piece changes the other's policy. A marked browser or the local link still has to supply the right PIN.


## Sites

All become calls to `verifyOwnerPin` with the action and budget named; each keeps its response codes (unlock's missing PIN 400, mandate 403, money layer 401 `bad-pin`); `attemptsRemaining` becomes optional (four console callers already treat it so) (`AgentServer.ts`, `routes.ts`, `mandatePin.ts` paths at `916e8c6d7`).

| Today | Route(s) | Today's limit | After |
| --- | --- | --- | --- |
| `AgentServer.ts:2357` | `POST /dashboard/unlock` (throttle on, default) | PinThrottle + store per real IP; local unmarked 10/5 min | public budget: unchanged policy, durable aggregate, unattributable callers to the aggregate only |
| same, throttle off | legacy unlock | in-memory map, a success resets the global | public budget (the legacy branch is removed; nothing in src, tests or migrations sets `security.pinThrottle.enabled: false`; if found, it is ignored with a one-time degradation report; the `types.ts` comment and the SEC-002 spec line that call it the rollback switch are updated) |
| `AgentServer.ts:2521` | `POST /dashboard/session/step-up` | legacy map keyed on `127.0.0.1` | public budget, the same helpers as unlock (marker first, the real client, the durable cap) |
| `mandatePin.ts:76` via `routes.ts:16607` (40 callers, incl. `/mandate/issue`, the `X-Dashboard-Pin` pairing route), `routes.ts:3244` (work board), `skillLearningRoutes.ts:132` | mandate PIN | 3 separate in-memory maps keyed on `127.0.0.1` + store | signed-in budget; the three maps are deleted; the skill route's verified `forwarded:<machine>` bucket is that machine's source key |
| `checkPublicPin` (`routes.ts:16614`) | `/mcp/approve/:id`, recommended-services confirm, email code | as above + store global 20 on 403 | `/mcp/approve/:id` and recommended-services confirm: per-request budget; the email code: public budget |
| `MoneyLayerEnableSurface.ts:731` via `routes.ts:18721` | money-layer commit / restart / config-inspect | one global counter, everyone locked 15 min | signed-in budget; the global lockout is deleted; the 401 `bad-pin` response and its audit row stay |
| `routes.ts:34117, 35406, 35436, 41180, 42191` | `/passkeys/revert-method`, `/class-reviews/:k/outcome` and `/lifecycle`, the subscription relogin PIN check (approve, repair-cell, cancel, retry), subscription-pool repair-email | none | signed-in budget |

Not PIN checks, unchanged: the `x-instar-principal-pin` audit header on `DELETE /sessions/:id` (recorded only), `/dashboard/unlock-check` (charges nothing), `mobilePermissionsRoutes` (checks a PIN is set), `mobileOwnerPresenceRoutes` (shows the PIN after Face ID), `fileRoutes`. `PrivateViewer`'s per-view PINs are a different secret (left behind).

## Decision points touched

- **One verifier for every PIN compare** — invariant; basis: external-constraint (an attacker chooses the weakest route).
- **Three budgets: public, per-request and signed-in** — invariant; basis: irreversible-consequence (strangers must not be able to refuse a signed-in owner's correct PIN; today's separate buckets already give that).
- **Forwarded client address is a signal, the aggregate the authority; unattributable callers to the aggregate only** — invariant; basis: irreversible-consequence.
- **Inherited PinThrottle floors** (3 soft failures, backoff to 15 minutes, coarse budget 10, local budget 10, marked-abuse cap 50, public aggregate 20 per 5 minutes) and the mandate PIN's 5 per source per 5 minutes — invariant, preserved; basis: external-constraint (shipped SEC-002 design (b), ratified 2026-11-15). The tunables that exist today can lower these, never raise them above the floor (the section-4 arithmetic depends on it).
- **No signed-in aggregate; 5 per credential per 5 minutes** — invariant; basis: irreversible-consequence (a shared signed-in cap would let one credential refuse another's right PIN).
- **Evidence for the inherited numbers:** a 6-digit PIN has 900,000 values. The public aggregate of 20 per 5 minutes keeps a stranger's expected time to guess at about 78 days on one machine (19.5 at four) while an owner who mistypes three times waits seconds, not hours. The local budget of 10 is the same order for the one machine. The 4096-row cap bounds the store's size and rewrite cost and never evicts a locked row. These are the shipped SEC-002 design (b) values; this spec does not tune them.
- **Refusal before the compare** — invariant; basis: irreversible-consequence. A source is refused only after its own wrong guesses, or, on the public budget, after strangers exhaust the unmarked aggregate. Comparing first would let a refused source test guesses for free. The owner always keeps a route the refusal does not touch: a marked browser, the phone, this computer, or a signed-in session.
- **One paused window on a corrupt store** — invariant; basis: irreversible-consequence. The alternative is resetting to empty, the fail-open that gives a guesser a fresh budget whenever the file is damaged. Only unmarked public sign-in waits, for at most 5 minutes.
- **A corrupt store saturates one window, then resumes** — invariant; basis: irreversible-consequence (never fail open, never wait on a person).
- **A failed write keeps enforcing in memory** — invariant; basis: irreversible-consequence.

## Frontloaded Decisions

1. No switch. Every change applies limits the agent already has to routes with weaker ones or none, in the same budget a stranger could reach today. With the right PIN, no caller that works today is refused: strangers cannot drain the signed-in budget, and marked browsers, the local budget and paired devices keep their own routes. Refusal after repeated wrong PINs is known-invalid authentication, which umbrella section 10 refuses at once.
2. The forwarded client address stays what it is today, a signal on the agent's own tunnel names. No new dedicated tunnel transport: the stock tunnels all forward to the shared listener port, so one is not buildable here.

## Verify the state, not its symbol

| Detector | Symbol | State | Corroboration | Unmeasurable |
| --- | --- | --- | --- | --- |
| Attempt budget | the counters | how many wrong guesses this source and everyone made in the window | loaded at boot, written with each charged guess | corrupt: one window saturated, then resume; a failed write followed by a restart loses at most the current window |
| Caller | `callerAddress` | which source a guess came from | loopback peer + own Host + the tunnel's header | counted in the aggregate only |

## Rollout

| Stage | What happens | Fallback |
| --- | --- | --- |
| test-agent-live | Throwaway: strangers' wrong guesses drain the public cap while the machine itself, a browser that signed in before, and a signed-in owner action still accept the right PIN; one credential's wrong guesses limit only that credential; the old off switch and a looser budget setting are ignored; a restart keeps the cap; a damaged counter file pauses unknown browsers for one window, stays paused across a restart, while the owner's routes work. A real tunnel was not available when the proof ran (Cloudflare refused a quick tunnel); the client-address resolver is unchanged and unit-tested. | Discard. |
| dev-agent-live | Echo: the owner's dashboard sign-in, step-up and a mandate action with the right PIN still succeed first try. | Revert. |
| fleet | With the merge. | Patch release. |

## Tests and evidence

- **Unit:**
  - The verifier: admission before compare; one charge per guess; public guesses never refuse a signed-in caller; success clears only its own source, never an aggregate; the aggregate survives a reload; unattributable callers count only in the aggregate; pruning and the row cap; corrupt, empty and invalid files are quarantined with one window saturated, while a missing file starts fresh; a write failure keeps enforcing.
  - Parallel requests at 19 of 20 admit exactly one.
  - Each former site calls the verifier.
  - A ratchet fails on any `dashboardPin` comparison outside the verifier.
  - Tests that change: `skill-learning-routes` and its live variant (forwarded bucket, `attemptsRemaining`), `console-mandates`, `routing-spend-routes` (the 15-minute global lockout is gone), and the `dashboard-pin-throttle` integration and e2e (the legacy path). Mandate tests that expected 5 tries stay at 5 (signed-in budget).
- **Integration:** on one mounted server, unlock, step-up and the email-code route share the public budget; an approval link and a mandate route have their own budgets; saturating the public budget never refuses them.
- **E2E alive:** a real server: the right PIN is accepted on unlock, on step-up and on a mandate route; after the public budget is saturated, the signed-in mandate route still accepts the right PIN.

## Maturation plan

- **ladder:** not applicable: no switch, the routes get the limits the sign-in route already has
- **test-agent-live:** the rollout row above.
- **dev-agent-live:** the owner's right-PIN paths on Echo.
- **fleet:** with the merge.
- **graduation criterion:** green Local Verify, merged commit, throwaway proof through a real tunnel.
- **dark-window:** none.

## Open questions

*(none)*

## Review rulings (round 1, cross-model)

- **Observe mode before enforcing:** no caller with the right PIN is refused by this change (frontloaded decision 1), and refusal after repeated wrong PINs is known-invalid authentication. The umbrella's per-agent card is for enforcement that can refuse a legitimate caller.
- **Ownership migration, disputed PINs and team roles in piece 1:** owned by pieces 1d (PIN non-disclosure and the Basic reset), 1e (session controls by team role) and 1f (members' own conversations), which have their own specs.
- **Trusted construction of the own-name decision:** unchanged from today's resolver. The header is a signal only, and a remote client cannot choose it through cloudflared. A local forger is inside the Basic boundary.
- **One writer for admission and charging; restart-proof accounting:** the verifier is synchronous and the store is written with each charged guess (section 3). The residual after a failed write is stated.

- **Round 2 (cross-model):**
  - **Verified credential provenance:** the signed-in source comes only from what the auth middleware already verified. A `dst_` bearer reaching a handler has passed the middleware's session check, and the family is looked up live, so a dead token falls through to `agent-bearer`. A forwarded machine key is passed only after the route verifies the roster.
  - **Memory sessions:** `mps_` callers fall to `agent-bearer`. They are confined by `memorySessionAllows` and do not reach the owner's browser key.
  - **The no-token case:** that is piece 1h (PR 3411).
  - **Ownership migration and team boundaries:** pieces 1d–1f, as ruled in round 1.
  - **Overlapping starts:** the single-instance lock already prevents two servers on one state directory.
  - **Existing rows:** they keep their shape and are read as before.
  - **Downgrade:** an older build reads the same file. The pause row's large count is an integer, which it accepts.

## Awareness and parity

- An awareness entry (`src/data/awareness/pin-sign-in-paused.md`) lets the agent explain "PIN sign-in is paused for a few minutes" and the shared budgets.
- An upgrade note (`upgrades/next/identity-security-piece1c-pin-policy.md`) with a "What to Tell Your User" section.
- No agent-installed file changes, so Migration Parity needs no migration.
- The ratchet is the seed of the umbrella's PIN lint. Its `personProof` later wraps this verifier.

## Left behind

One credential holder for a synced PIN (piece 4). PIN non-disclosure and the Basic reset (piece 1d). `PrivateViewer`'s per-view PINs (a separate secret with no throttle today) — filed as its own feedback item. Per-source backoff surviving a restart (the durable aggregate bounds it).
