---
title: "Sibling-machine reach — the outbound check knows what my OTHER machines hold"
slug: "sibling-machine-reach"
author: "echo"
parent-principle: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions; The Agent Carries the Loop"
eli16-overview: "sibling-machine-reach.eli16.md"
status: "converged"
approved: true
approved-by: "echo (agent approval of its own converged Tier 2 spec; no constitution or protected-list change) within Justin's 2026-11-20 11:19 PST pre-approval to keep project 33890 moving (topic 141385); spin-off brief from echo-topic-33890 for CMT-2073"
parent-spec: "B17 HELD-ACCESS (PR #3205, src/core/agent-reach.ts); WS5.1 subscription pool scope (GET /subscription-pool?scope=pool)"
commitment: "CMT-2073 / feedback fb-56855d0f-0d2"
review-convergence: "2026-11-21T04:55:40.939Z"
review-iterations: 6
review-completed-at: "2026-11-21T04:55:40.939Z"
review-report: "docs/specs/reports/sibling-machine-reach-convergence.md"
cross-model-review: "codex-cli:gpt-6.2-astra"
single-run-completable: true
frontloaded-decisions: 7
cheap-to-change-tags: 1
contested-then-cleared: 1
---

# Sibling-machine reach

## 1. The problem (the case study)

After the Mac Studio rebuild on 2026-11-20, four subscription accounts were missing on the
Studio but were signed in on the Mac Mini and on Echo 2. The agent told its operator to open
the dashboard, enter his PIN and do four sign-ins. The operator (topic 33890, message 146072,
2026-11-20T20:14Z): "I don't see why you can't coordinate with the laptop to get it done." The
real fix was entirely agent work: the Studio started each login (`POST /subscription-pool/enroll`)
and a helper session on the Mini approved it in the Mini's browser profile signed in to THAT
account's Google identity (memory: lesson_cross_machine_signin_via_peer_helper).

The outbound message check had two chances. `B21_USER_TASK_SUBSTITUTION` nudged twice, and the
agent overrode it with a reason ("needs his PIN and passwords") that nothing put next to the
other machines. The B17 HELD-ACCESS sub-clause never fired because the agent reach it reads
(`src/core/agent-reach.ts`) describes ONLY this machine. To the gate, "the Studio lacks these
accounts" looked like "the agent lacks these accounts".

The class: **an agent hands its operator a per-machine task (a sign-in, a browser step, a
missing account on one machine) that another of its own machines can do.**

## 2. What exists (and stays)

- `buildAgentReach(registry)` → `AgentReach` (browser accounts on this machine, key reads, vault
  entry names), rendered by `renderAgentReachLines` into the gate prompt as DATA inside a per-call
  boundary. Built on every non-health-alert review in `evaluateOutbound` (`routes.ts`), the one
  outbound path every channel (telegram, slack, app, whatsapp, imessage) goes through.
- The B17 HELD-ACCESS sub-clause judges by meaning whether the candidate asks the operator for
  access the reach shows the agent already holds. B17 is a HARD block (self-stop family).
- `B21_USER_TASK_SUBSTITUTION` is ADVISORY: a 422 `tone-gate-advisory` the agent may override
  with `toneAdvisoryAck` + a required `toneAdvisoryAckReason`. The reply scripts print the 422's
  `issue`, `suggestion` and `howToProceed` to the agent.
- `GET /subscription-pool` (plain) returns this machine's pool accounts with `status` and the
  live login signal `loginCheck` (`ok | signed-out | unavailable`). `GET /playwright-profiles`
  returns this machine's browser profiles and accounts (with `lastAsserted`); it is dev-gated
  (503 on fleet agents) and its full view reads the vault and may seed a registry file.
- `ctx.listPoolMachines()` (every registered machine, URL or not) and `ctx.resolvePeerUrls()`
  (dialable peers with admissible ropes) — the same roster pair `readReaperPoolPeers` uses.

## 3. The change

### 3.1 A background cache of each sibling machine's holdings (new: `src/core/sibling-holdings.ts`)

`SiblingHoldingsCache` keeps, per other machine, a minimal projection with **per-surface
evidence**:

```ts
interface SiblingMachineHoldings {
  machineId: string; nickname?: string;
  pool?:    SurfaceState<SiblingPoolAccount>;
  browser?: SurfaceState<SiblingBrowserAccount>;
}
SurfaceState<T> = {
  last?: { accounts: T[]; omitted: number; observedAt: string; verifiedAddress: string };  // last SUCCESSFUL, identity-checked read
  lastAttemptAt?: string;
  lastFailure?: 'unreachable' | 'unauthorized' | 'identity-mismatch' | 'surface-off' | 'oversize' | 'peer-too-old' | 'offline' | 'no-known-url';
}
SiblingPoolAccount    = { label; email?; provider; login: 'signed-in' | 'not-signed-in' | 'unknown' }
SiblingBrowserAccount = { service; identity; owner: 'agent' | 'operator'; lastVerifiedAt?: string }   // only lastAsserted:true accounts
```

- **Refresh is OFF the send path.** `refresh()` is async, single-flight and never throws. A timer
  armed in `createRoutes` (only when `resolvePeerUrls` is wired) runs it 30 s after start and
  every 10 minutes (`unref()`'d, cleared by `cache.stop()`); each tick first reads
  `toneGate.siblingReach.enabled` through `liveConfig` and does nothing when it is `false`.
- **Who is read.** The roster is `listPoolMachines()` ∪ `resolvePeerUrls()` minus self. **Dial
  targets come only from `resolvePeerUrls()`** (admitted ropes); a machine known only to
  `listPoolMachines()`, or marked offline in the pool registry, is never dialed and is reported
  UNKNOWN (`no-known-url` / `offline`). The admitted URL is kept with the roster entry. Fetches per refresh are bounded (12 peers, round-robin
  over refreshes). Each fetch goes through the existing `poolPeerFetch` (admitted ropes only,
  bearer, 5 s timeout) and reads the body as a stream, cancelling at 256 KB before parsing; an
  oversize body is the distinct failure `oversize` under the long (60-minute) backoff.
- **Two surfaces per peer, judged separately.** Plain `/subscription-pool` (which now carries the
  responder's `machineId` on EVERY response, including `{enabled:false}` and its 503 body) and `/playwright-profiles?view=accounts` (§3.2). The
  browser surface is requested ONLY from a peer whose pool body carried `machineId` (i.e. runs this
  code and so honors the light view); an older peer's browser surface is UNKNOWN (`peer-too-old`),
  so the heavy full view (vault read, possible registry seed) is never triggered by this cache. Each surface keeps its own last-SUCCESSFUL
  projection and `observedAt` (this machine's clock at read time, never a peer timestamp). A
  failed read never renews or erases the other surface, and never erases its own previous
  projection: the old evidence stays, dated, until it ages out at 60 minutes, and the failure
  reason is carried beside it. A 503 or `{enabled:false}` is `surface-off` → UNKNOWN, never "none".
- **Login state is normalized, not passed through.** A pool account is `signed-in` only when its
  `status` is `active` AND `loginCheck === 'ok'`; `signed-out`/`needs-reauth`/`revoked`/… →
  `not-signed-in`; anything else (including a peer on code without `loginCheck`) → `unknown`. A
  browser account is kept only when `lastAsserted === true`. `owner` is `operator` only on an
  exact match.
- **Identity of the answering machine.** Both bodies carry the responder's `machineId`. When it
  differs from the machine asked, the whole read is discarded as `identity-mismatch` (a stale URL
  now pointing at another machine). An older peer omits it: its pool read is accepted (the bearer
  key already limits answers to this agent's own machines) — a named limit until the fleet runs
  this code — and its browser surface is not read.
- **Backoff (per surface).** `surface-off` (503 / `enabled:false`) and `oversize` back that
  surface off to the 60-minute cap. A peer whose reads both fail is retried on the next tick, then backs off
  (10 → 20 → 40 → 60 minutes, capped at the age limit). A never-read peer whose first read failed
  (e.g. still booting after a rebuild) gets one retry 60 s later.
- **Order at the fetch bound:** peers due for a retry (never read, or out of backoff) come before
  peers whose data is merely aging.
- **Targeted refresh.** When a B17/B21 verdict fires and the reach listed a DIALABLE peer older
  than 10 minutes or never read, the route kicks a background refresh of just those peers
  (fire-and-forget, single-flight, at most once a minute, each peer's backoff honored; `offline` /
  `no-known-url` never trigger it). The send that triggered it never waits on it.
- **Send time reads only memory.** `snapshot()` is synchronous and uses the roster captured at
  the last refresh (no disk, no network).
- **Least revelation.** Kept fields only: label (nickname or id), email, provider, normalized
  login; browser service, identity, owner. Never `configHome`, quota detail, profile paths, vault
  names or any credential field. Every string goes through `clean()` (control and boundary
  characters stripped, clamped). Per-machine account lists cap at 24 with an omitted count,
  ordered signed-in first then by provider; every machine is rendered (no machine cap).
- **Lifecycle.** The cache is built in `createRoutes` when `resolvePeerUrls` is wired and is
  returned on the routes context so AgentServer's shutdown and test teardown call `stop()`.
- **Observability and the agent's one lookup.** `cache.status()` plus the current snapshot (per
  machine: surface ages, last failure, pool accounts with login state, asserted browser profiles
  with identity and last-verified time) is exposed under `siblingReach` in
  `GET /subscription-pool?scope=pool` (bearer; the new field follows the stricter rule below, whatever
  the existing pool rows show). This is the capability-checked lookup the awareness entry points to. The
  identity-bearing fields (account emails/labels, browser identities, last-verified times) are
  included only for the agent's own bearer (`bearerMatches`); any other credential (e.g. a
  dashboard session) gets machine names, ages, failure reasons and counts only. A
  `DegradationReporter` event fires once per episode when the roster is non-empty and no peer has
  been read successfully for longer than the age limit (the feature is then effectively off).

### 3.2 A light accounts view on the peer (`GET /playwright-profiles?view=accounts`)

Returns `{ machineId, view: 'accounts', profiles: [{ id, accounts: [{ service, identity, owner,
lastAsserted, lastVerifiedAt }] }] }` read from the registry file only: **no vault read, no
seeding, no write** (an absent file answers `profiles: []`). Bearer-gated like every route, but
NOT behind the dev gate that closes the full view on fleet agents: it exposes no secret, no vault
name and no path, only account identities the agent itself registered, so fleet agents get the
browser evidence too (where it has registered profiles; an agent with none answers
`profiles: []`). Handler order: the `view=accounts` branch runs BEFORE the existing
`playwrightFeatureEnabled()` 503 check. Readers: the agent's own bearer key ONLY (`bearerMatches` against the
agent auth token); a dashboard session or any other credential gets the same answer the full view
gives it today (503 on fleet). The mesh needs nothing more, and the operator's account
identities are not widened to team members' dashboard sessions. The cache never sends this query to a peer that did not identify itself in
its pool body (§3.1), so an older peer's full view is never triggered.

### 3.3 The reach carries this machine's pool and the other machines (`agent-reach.ts`)

`buildAgentReach(registry, extras?)` gains `extras = { localPool?, siblings? }` and `AgentReach`
gains `localPoolAccounts`, `localPoolUnreadable`, `otherMachines`, `unknownMachines`.
`renderAgentReachLines` renders **one account per line** (no line can approach the gate's
400-char belt) and only when the data is present, e.g.:

```
Subscription accounts on THIS machine:
- claude / studio-main (signed-in)
Your OTHER machines (reached by the agent itself ...; last-asserted, not proven):
- Mac Mini (subscription accounts read 4 min ago; browser profiles read 4 min ago):
  - subscription account: claude / a@x.com (signed-in)
  - browser profile asserted signed in: google / a@x.com (operator's account; last verified 2 days ago)
- Echo 2 (subscription accounts read 7 min ago; browser profiles: UNKNOWN — surface-off)
Other machines whose holdings are UNKNOWN right now (unknown, not empty): M5 Pro (offline)
```

**Where it renders:** the other-machines lines and this machine's pool lines are NOT part of the
existing AGENT REACH block that B17 reads. They render in a separate `=== OTHER MACHINES ===`
section placed after the B21 rule material and labelled as evidence for the B21 per-machine
sub-clause only, together with that sub-clause and the B17 exclusion sentence (§3.4).
**Single machine / switch off:** when the roster is empty or `toneGate.siblingReach.enabled` resolves off,
that whole section (data AND rule text) is omitted, so the COMPLETE gate prompt is
byte-identical to today's.

### 3.4 Other machines' holdings NUDGE, they never hard-block (`MessagingToneGate.ts`)

- **A local B17 cannot be masked either.** The OTHER MACHINES section instructs: when HELD-ACCESS
  applies from THIS machine's reach, return B17 even if the per-machine sub-clause also applies.
  And in code: when the sibling-aware review returns ANY B21 (with or without a
  `siblingProfileRef`, since a model can drop an optional field), the same local-only re-review
  runs; if it returns B17, that local B17 is the verdict. If it returns anything else, or gives no
  verdict, the first B21 stands as the advisory, with its hint, and its `decisionRef` is the one
  graded. So the outcome for
  a local-only B17 is identical with or without siblings. The re-review triggers are a B17, or any B21,
  from a review that rendered the OTHER MACHINES section; a PASS never triggers it, so the extra
  call stays off the common path. Its frequency is visible in the `sibling-confirm` decision-log
  lines.
- **B17 HELD-ACCESS stays local.** The OTHER MACHINES section (rendered only when siblings are
  present) opens with: holdings listed in this section never satisfy B17 HELD-ACCESS condition (2)
  and must never be the basis of a B17 verdict; an ask covered only by another machine is judged
  under B21. The section is placed apart from the AGENT REACH block B17 reads. **Code
  confirmation:** when a review that rendered the OTHER MACHINES section returns
  `B17_FALSE_BLOCKER`, the route re-runs the review ONCE with that section omitted (the exact
  pre-feature prompt). The hard block stands only if the local-only review also returns B17;
  otherwise the local-only verdict is used as-is (it attaches no route hint: the reference table
  belongs to the first prompt). If the re-review itself gives no verdict (provider error, budget
  timeout, unparseable), the outcome is the gate's EXISTING no-verdict path for the send (the same
  hold-for-retry / degrade that applies when the first review cannot answer), never a confirmed
  B17; on retry the whole review runs again. No B17 is made overridable (the self-stop family
  stays walls). The re-review is wrapped in `reviewWithinBudget` with
  `min(configured review budget, route timeout − elapsed − 5 s)` so the two reviews together can
  never pass the outbound route's timeout (defaults: two 20 s reviews inside the 120 s route and
  the reply script's 125 s), counts against the gate's spend
  limit (when that budget is under 5 s the re-review is skipped and the send takes the existing
  no-verdict path, counted as `b17-unconfirmed`, never a confirmed B17), and is logged with
  `reason: sibling-confirm` so its frequency is measurable. The profile reference table lives
  only with that one review call (in memory, released when the verdict is built). The
  FINAL verdict's `decisionRef` is the one logged and graded; an overturned or unconfirmed first
  B17 is recorded as a `toneGate.siblingReach` evidence row (`b17-overturned` /
  `b17-unconfirmed`). These are confirmation outcomes (two model calls with different prompts
disagreeing, or a second call giving no verdict), not a measure of causation by sibling data.
  Every account identity RENDERED in that prompt (pool labels and emails as well as browser
  identities) that appears verbatim in the model-written `issue` or `suggestion` is replaced with
  "the account" before the 422 is built (redaction of known values). So a peer's data (up to an hour old) can never by itself hard-block this machine's
  messages. The extra call happens only on that rare combination.
- **B21 gains a per-machine sub-clause (advisory):** an ask that hands the operator a per-machine
  task — "sign in account X on machine Y", "do this browser step for account X", "this machine is
  missing account X, please add it", including the dashboard + PIN + sign-ins procedure — is
  user-task substitution when the AGENT REACH shows another of the agent's machines with a
  **browser profile signed in to that exact identity** (same email / account). The agent starts
  the login on the machine that lacks it and approves it in that profile; the operator's PIN or
  password is not needed for that route. A pool account signed in there is corroboration only,
  never enough alone (a CLI login there cannot approve a browser sign-in here).
- **PASS cases (explicit):** the other machine is UNKNOWN; only the provider matches (a different
  identity, including another person's account on a shared machine); the matching profile is the
  operator's own and the step is not a sign-in to that same account; the account is new and no
  machine lists its identity; a one-time code, passkey, CAPTCHA or other physical step; a one-tap
  PIN-gated approval (a decision, not a procedure); the message names a concrete attempt on the
  other machine and how it failed (taken at the draft's word — a known limit, inherited from
  HELD-ACCESS, acceptable under the under-fire bias). UNDER-FIRE BIAS stays decisive.
- **Browser evidence is a candidate, not proof.** Two ages are kept apart: the registry-READ age
  (how fresh this machine's copy is, which ages out at 60 minutes) and the ASSERTION age
  (`lastVerifiedAt`, which a repeated read never renews). The section shows both, and the
  sub-clause treats the profile as a route for a helper to try and verify, not as proof the login
  will work. When `lastVerifiedAt` is absent or older than 24 hours the server hint says "verify
  that profile is still signed in first, then approve".
- **The gate cites a profile by opaque reference.** Each rendered sibling browser profile line
  carries a short reference (`S1`, `S2`, …, minted per prompt). When B21 fires on this sub-clause,
  the gate returns an extra output field `siblingProfileRef` naming the profile whose identity
  matches the asked account. The sub-clause tells the gate to name the machine in its suggestion
  but never to quote an identity or email (identities stay inside the prompt).

### 3.5 The nudge carries the route to the agent (`routes.ts`)

When the verdict rule is `B21_USER_TASK_SUBSTITUTION` AND the gate returned a `siblingProfileRef`
that VALIDATES against the reference table minted with that same prompt (the ref exists, so its
machine, service and identity are known server-side), the 422 body gains, for that machine only,

```json
"otherMachine": { "machineId": "m-…", "machine": "Mac Mini", "address": "<the admitted peer URL from resolvePeerUrls>",
                  "readMinutesAgo": 4, "browserProfiles": 2, "signedInSubscriptionAccounts": 3 },
"otherMachinesHint": "Mac Mini may hold a google browser profile for this account (verify there first). Before overriding or asking: start the login on the machine that is missing the account and approve it on Mac Mini through a helper session there (POST <address>/sessions/spawn with your bearer and no topicId — a topic-bound spawn is a one-shot session)."
```

The hint is a SERVER-OWNED template filled from the validated reference (machine name, service,
and "the operator's own account: act in it only for this same account's sign-in or under a
standing grant" when the profile's owner is `operator`); it never contains an identity or email.
An unvalidated or absent ref, a B17 verdict, or a pool-only sibling attaches nothing (the gate's
own suggestion still speaks). **Address binding:** each successful identity-checked read records,
PER SURFACE, the admitted address it used. The hint binds to the cited BROWSER observation: at 422
time `address` is included only when `resolvePeerUrls()` still resolves that machine to the
browser surface's verified address and the browser surface's latest attempt was not
`identity-mismatch` (a pool-only recovery cannot restore it). If it differs, is absent, or the
browser surface's last attempt was `identity-mismatch`, `address` and the spawn instruction are omitted (the hint names the machine
only) and a targeted refresh of that peer is kicked. Any `identity-mismatch` observed on EITHER surface
invalidates the machine's verified address for both, until a fresh matching browser read restores
it. A hint without an address
right after a normal network-path switch (e.g. LAN to Tailscale) is expected, not a fault. The `address` is re-resolved from `resolvePeerUrls()`
(local, synchronous) when the 422 is built, so the agent dials the rope the server would dial now.
This is a deliberate exception to the pool views' "never return a peer URL" rule: the reader is the
agent itself, the URL is not a secret (the bearer is still required), and without it the route is
not actionable. A failed dial means "re-resolve", not "the machine is down".
**Where `siblingProfileRef` is requested:** only inside the OTHER MACHINES section, so the static
prompt template and parser contract are unchanged without siblings; the parser accepts it as an
optional clamped string and ignores it when no OTHER MACHINES section was rendered.

The hint sentence is appended to `suggestion` and `howToProceed` — the fields the
reply scripts already print, so the agent sees it with no script change. Emails are NOT put in
the 422 (labels and counts only); they stay inside the gate prompt. A `featureEvidence` row
(`toneGate.siblingReach`, `hint-attached`) is recorded, and the matching override/complied
reaction is recorded under the same feature (registered on the feature ladder beside
`toneGate.waitingAskLinks`, read through the existing feature-evidence surfaces). These are
outbound-message outcomes only: a `complied` means the message was rewritten, not that a helper
did the work. The observable claim is that the override decision now has the other machine's
holdings in front of it; whether that changes the decision is what the evidence measures.

### 3.6 Awareness entry (`src/data/awareness/access-you-already-hold.md`)

Adds: before asking about a per-machine resource (a sign-in, a browser step, a missing account on
one machine), check every machine with ONE lookup — `siblingReach` in `GET /subscription-pool?scope=pool`
(each machine's signed-in accounts and browser profiles, already gathered safely; never query a
peer's playwright views by hand) — and use a helper on the machine that can: start the login on the machine
that lacks it, approve it in the browser profile signed in to that exact account on another
machine (`POST <peer>/sessions/spawn`, no topicId — a topic-bound spawn is a one-shot session).
The outbound check now nudges when another machine holds what is being asked for.

## 4. Signal vs authority

The cache, the reach and the 422 hint are DATA and signals. The authority is the existing LLM
tone gate. Sibling data feeds only the ADVISORY rule (B21); the hard B17 wall keeps reading only
this machine. Nothing string-matches. Both failure directions are named: stale positive evidence
(an account signed out on the peer in the last hour) can cause an avoidable nudge, which the
agent can override with a reason; missing positive evidence (a sign-in done on the peer since the
last read, or a peer UNKNOWN) lets an avoidable operator ask through — today's behavior. One
delay case: a B17 caused by sibling data whose local re-review times out takes the existing
no-verdict path, so during a slow-provider episode such a message can be held for retry; the
existing outbound retry bounds (the same as for any gate outage) cap it, and it is counted as
`b17-unconfirmed` evidence so its frequency is visible. Accepted residual: a sibling-aware review that returns PASS
where the local-only prompt would have returned B17 is not re-checked (doing so would double the
gate's cost on every message of every multi-machine agent). The OTHER MACHINES section instructs
B17 priority, the section only ADDS an advisory sub-clause, and the model test includes a local
B17 with siblings present; the residual is an under-fire, the direction the gate already biases
toward. Its rate is not measured by this change (unknown, not zero). Bounds:
60-minute ageing to UNKNOWN, UNKNOWN as an explicit PASS, exact-identity browser evidence only,
the under-fire bias, and the kill switch.

## 5. Multi-machine posture

- sibling-holdings cache — unified (proxied-on-read, ephemeral, nothing persisted, nothing
  replicated, nothing written to a peer). Each machine reads its peers' own surfaces under the
  agent's bearer on a timer. The source surfaces (a machine's pool logins and browser profiles)
  are machine-local because the logins physically live on that disk, which is why a proxied read
  is the right posture rather than replication. N machines → at most 2 small GETs per peer per
  10 minutes per machine (fewer with backoff).
- Mixed versions: an older peer's pool is read (no `loginCheck` → `unknown` login; no `machineId`
  → accepted without identity check), and its browser surface is UNKNOWN (`peer-too-old`); it is
  never asked for any playwright view.
- The light `?view=accounts` view is not dev-gated, so fleet agents carry browser evidence too
  (an agent with no registered profiles answers `profiles: []`, rendered as "none registered").

## 6. Tests (all three tiers)

- **Unit** (`tests/unit/sibling-machine-reach.test.ts`): projection (login normalization,
  `lastAsserted` filter, owner exact match, field stripping, `clean()` on hostile strings, caps +
  order, 256 KB bound); per-surface retention (cold failure, partial failure after success, a
  pool success does not renew browser evidence, expiry); `identity-mismatch`; backoff and the
  never-read retry; roster with a URL-less and an offline machine → UNKNOWN; single-flight;
  `liveConfig` switch checked per tick; `buildAgentReach` extras and one-account-per-line
  rendering (no line > 300 chars at full caps); the COMPLETE gate prompt is byte-identical to
  today's for an empty roster and for the switch off; prompt text: B17 local-only sentence, B21
  per-machine sub-clause and PASS cases present.
- **Regression** (same file): the 2026-11-20 ask replayed — a Studio reach with the four
  accounts missing and a Mini with browser profiles signed in to those four identities → the
  prompt lists the Mini's profiles beside the B21 sub-clause, and a B21 verdict naming the Mini
  yields a 422 with `otherMachine` + the hint in `suggestion`; a B17 verdict, a pool-only Mini, an
  unknown `siblingProfileRef` attach nothing. Contrast cases: a Mini profile for a
  different identity at the same provider, and an active Mini pool account with no browser
  profile → no `otherMachines` sign-in evidence in the prompt section that the sub-clause keys on.
- **Integration** (`tests/integration/sibling-machine-reach-routes.test.ts`): a real HTTP stub
  peer serving `/subscription-pool` and `/playwright-profiles?view=accounts`, routes built with
  `resolvePeerUrls` → after a refresh, a send whose stubbed gate verdict is B21 and a gate-named sibling returns
  422 with `otherMachine` + the hint in `suggestion`; the reply script run against that body prints the
  hint; peer down → UNKNOWN; switch off → nothing fetched; the `view=accounts` route returns
  accounts without reading the vault and without creating a registry file, and answers (not 503)
  with the dev gate off.
- **E2E** (`tests/e2e/sibling-machine-reach-lifecycle.test.ts`): the production `createRoutes`
  wiring arms the cache, a refresh against a live stub peer populates it, `GET
  /subscription-pool?scope=pool` shows `siblingReach.armed: true` with the peer's age, and the
  reach built on the send path carries the peer (feature alive, not a no-op).
- **B17 confirmation** (unit + integration): local-only B17 + sibling-aware B21 (with and
  without a ref) → final B17; local-only pass/no-verdict after a sibling-aware B21 → the first B21
  with its hint; a stubbed gate returning B17 with siblings rendered triggers exactly one
  local-only re-review; B17 stands only when the re-review also says B17
  (a legitimate local B17 with siblings present still blocks); otherwise the local verdict wins.
  A re-review that times out or fails to parse takes the existing no-verdict path (never a
  confirmed B17). Repeated reads of an unchanged `lastAsserted` row do not renew its assertion age.
  A 422 whose machine now resolves to a different address omits `address`. A gate
  stub that quotes a sibling email in `suggestion` yields a 422 with the email replaced. The
  `view=accounts` route refuses a dashboard-session credential (same answer as the full view).
- **Model test (live model, no send)** (`tests/unit/sibling-machine-reach.model.test.ts`, run with
  a real provider when available, skipped otherwise; one recorded real-model run is required
  evidence before merge and its output goes in the PR): the 2026-11-20 ask with the Mini's matching
  profiles → B21 with `siblingProfileRef` pointing at a Mini profile, never a surviving B17; a local B17 case
  (the access held on THIS machine) with siblings present → B17 from the first review; a same-provider-different-identity
  Mini → no B21 on this sub-clause.
- **Live proof (no message sent):** after deploy on Echo (multi-machine), a script runs the real
  gate review on the 2026-11-20 ask against Echo's live cache snapshot and prints the verdict and
  the 422 body it would return. Nothing is delivered to any channel; the feature adds no operator
  surface, so the proof is the agent's own outbound path judged live.

## Decision points touched

- Nudge an outbound message that asks the operator for a per-machine task another machine can do — judgment-candidate; arbiter: the existing LLM tone gate under B21 (advisory) with sibling holdings as DATA; floor: bounded action space (pass / advisory, never a hard block on sibling data), exact-identity browser evidence only, UNKNOWN as an explicit PASS, the decisive UNDER-FIRE BIAS, the override with a recorded reason, and `toneGate.siblingReach.enabled:false` as the deterministic last rung.
- B17 HELD-ACCESS ignores other machines' holdings — invariant; basis: irreversible-consequence; evidence: B17 is a non-overridable hard block, so another machine's up-to-60-minute-old self-reported data must never alone strand a needed operator ask; enforced in code by the local-only confirmation review (§3.4), not only by prompt text.
- Attach the route hint to a 422 — invariant; basis: enumerable-domain; evidence: attaches only when the rule is B21 (a closed RULE_IDS value) AND the gate's `siblingProfileRef` is a key of the reference table minted with that prompt (a closed set); the hint is a server template appended to an already-refused send and changes no verdict.
- Whether a sibling projection is shown as evidence or as UNKNOWN (age) — judgment-candidate; arbiter: the tone gate, which sees each surface's "read N min ago"; floor: past 60 minutes the surface renders UNKNOWN (pass direction), never as holdings and never as "none".
- Discard a read whose responder `machineId` differs from the machine asked — invariant; basis: enumerable-domain; evidence: machine ids are a closed set from the pool registry; a mismatch means the URL reached a different machine, so attributing its holdings to the asked machine would send a helper to the wrong place.

## Fixed limits

- Refresh every 10 minutes — judgment-candidate default; basis: a sign-in takes minutes to set up, and a targeted refresh fires when a B17/B21 verdict meets a stale peer, so freshness is pulled where it matters; cost 2 small GETs per peer per tick. Counterexample it accepts: a sibling sign-in done 2 minutes ago is not yet visible → today's behavior (pass).
- Age 60 minutes → UNKNOWN — judgment-candidate default; basis: six missed refreshes means the peer is not answering, and older login state is more likely wrong than right. The gate sees the age below it.
- 24 accounts per machine — judgment-candidate default; basis: mirrors the local reach's `MAX_ACCOUNTS = 24`; one line per account at ≤ ~150 chars keeps a full machine near 4 KB of prompt; signed-in accounts sort first so a cut drops the least useful rows, and the omitted count is shown. No machine cap: the roster is the pool registry (a handful of machines), so every machine is rendered.
- 12 peers fetched per refresh, round-robin — judgment-candidate default; basis: bounds work per tick above any real pool size today (6–7 machines), so it binds only on an unusual pool and then only delays reads.
- 256 KB read per surface — judgment-candidate default; basis: a real pool or accounts body is a few KB; a body past this is malformed or hostile and is treated as a failed read (UNKNOWN).
- Backoff 10 → 20 → 40 → 60 minutes; one 60 s retry for a never-read peer — judgment-candidate defaults; basis: P19 brakes on a dead peer; capped at the age limit so a recovered peer is visible within an hour.
- Prompt size: the OTHER MACHINES section is bounded by a total of 160 lines; past it, a whole machine collapses to one line "N subscription accounts, M browser profiles, not shown" — judgment-candidate default; basis: about 12 KB, under a tenth of the gate's input; today's pools (3–7 machines × a few accounts) stay far below it.
- "Verify that profile first" when `lastVerifiedAt` is absent or older than 24 hours — judgment-candidate default; basis: the registry's assertions are refreshed roughly daily by sign-in checks, so an older one is more likely stale; it changes only the hint's wording and gates nothing.
- Targeted refresh at most once a minute — judgment-candidate default; basis: bounds peer load from a burst of nudged sends.
- Per-peer fetch timeout 5 s — the existing `/subscription-pool?scope=pool` value, reused.

## Frontloaded Decisions

- Switch `toneGate.siblingReach.enabled`, resolved like `toneGate.waitingAskLinks.enabled` (`resolveDevAgentGate`): unset = live on development agents (Echo, where the case occurred), dark on the fleet until the ladder's graduation; an explicit true/false always wins. Cheap-to-change-after: read through `liveConfig` at every send and tick; no state written. The light `?view=accounts` peer view is additive and always answers (it is what a dev agent reads from its peers).
- Sibling evidence never feeds the B17 hard block (security / adversarial review, round 1).
- Exact-identity browser evidence, not provider-level and not pool-only.
- Hint (signal) rather than structurally checking the override reason: string-matching a free-text reason would violate "An LLM gate must not string-match".
- A new `?view=accounts` query on the existing route rather than a new route prefix; it is open to fleet agents (bearer only) because it carries no secret; older peers are never asked for it.
- The hint carries the admitted peer URL rather than adding a forwarding route: the agent dials the rope the server already admitted.
- Peers are read through `poolPeerFetch`, not `PoolPollCache` (dark behind `ws44PoolCache`) and not `fetchPeerSubscriptionViews` (that helper serves the account-follow-me views with a different shape); the timer already bounds load.

## Maturation plan

- **test-agent-live:** the three test tiers run the cache, the light view, the reach rendering, the
  two-review protocol and the 422 hint against a real HTTP stub peer, with no second machine.
- **dev-agent-live:** live on Echo (multi-machine: Studio, Mini, Laptop) from the release that
  carries it; the live proof in §6 is run there after deploy, and the evidence rows begin.
- **fleet:** flip the default for `toneGate.siblingReach.enabled` fleet-wide after the graduation
  criterion holds on Echo.
- **graduation criterion:** over 14 days on Echo, at least 5 `hint-attached` rows, zero
  `error` rows above 10% of firings, and every `b17-overturned` / `b17-unconfirmed` row
  hand-checked (none showing sibling data held a message the operator needed). A zero count is not
  a pass.
- **dark-window:** at most 30 days from merge to the fleet decision; if the criterion is unmet, the
  reason and a new date are recorded on CMT-2073's follow-through, never left dark silently.
- **ladder:** toneGate.siblingReach

## Open questions

*(none)*

## 7. Rollback

Set `toneGate.siblingReach.enabled: false` (read through `liveConfig` at every send and every tick: takes
effect immediately, no restart), or revert the PR. No state is written, no migration, no data to
repair. The `?view=accounts` query is additive and harmless if left.

## 8. Out of scope (by design)

Peer vault entry NAMES are not used: secrets are shared across machines by Cross-Machine Secret
Sync, so the local vault list already reflects them. The light view never reads the vault, and no
peer is ever asked for the full view, so no vault name crosses the mesh for this feature.
