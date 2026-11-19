---
title: A peer's Local Verify result is signed, and a peer green on main has bounded authority (SEC-113)
slug: local-verify-peer-result-trust
eli16-overview: local-verify-peer-result-trust.eli16.md
status: approved
author: echo
created: 2026-11-18
parent-principle: "Know Your Principal — An Unverified Identity Is a Guess"
parent-spec: docs/specs/local-verify-main-on-peer.md
approved: true
approved-by: "Chief of Staff (maintainer approval, not a Justin decision), run-mwle6ihk-409422e0, 2026-11-18 08:47 PST; agent messages b546a352 and 4f3edeb8 to echo-echo-instar-security"
review-convergence: "2026-11-18T16:38:22.461Z"
review-iterations: 6
review-completed-at: "2026-11-18T16:38:22.461Z"
review-report: "docs/specs/reports/local-verify-peer-result-trust-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
---

# A peer's Local Verify result is signed, and a peer green on main has bounded authority (SEC-113)

## Why this exists

Local Verify (LV) can hand a `main` verify, or a PR verify, to a peer machine (dark switch
`monitoring.localVerify.mainOnPeers` for main; Part D of `local-verify-capacity.md` for PRs).
The coordinator (lease holder) posts the job to `{peer.url}/local-verify/peer-run` and later
pulls `GET {peer.url}/local-verify/peer-result` (`src/localVerify/localVerifyWiring.ts:489-536`).

What backs the exchange today:
- Transport: plain HTTP to a configured LAN URL with the pool-wide Bearer token.
- Request: the run inputs, including `isolation` and `preflightRediscoverable`
  (`LocalVerifyService.ts:2204-2209`), are taken by the peer as they arrive (`:1935`) and are not
  echoed in the record.
- Result checks: field equality only (`importRefusal`, `src/localVerify/peer.ts:179-203`): attempt
  id, coordinator id, a self-reported `record.machineId`, repo, pr, head, base, verifier version,
  policy hash, lease epoch, start time. `outcome`, lanes, counts and `flakyRetried` are taken as given.
- No signature, no corroboration.

What a green `main` record from a peer does (`completeMain`, `LocalVerifyService.ts:3429-3495`):
1. Marks the head verified (`noteMainHeadVerified`), which also makes it "already covered" for
   `retargetStaleMain` (`:2979`) and release collapsing (`:1330-1338`).
2. Saves it as THE green-main record (`saveGreenMain`, `:3789`). Its existence flips
   `isolationInput().allowed` from false to true (`:3796`), enabling isolation re-runs for PR
   verifies. (Its `notCleanOnGreenMain` list is only logged, `orchestrator.ts:816-817`.)
3. Moves the "main unverified since" clock (`oldestUnverifiedAt`, `:3476-3485`). Without a green,
   a healthy main turns `main-suspect` 3 h after the first unverified merge (`mainHealth.ts:405-416`,
   `unverifiedSuspectMs`). A non-healthy main holds merges (`statusProjection.ts:133-137`,
   `GreenPrAutoMerger.ts:994`).
4. Records `lastGreenHead` (`mainHealth.ts:373-377`).
5. Re-arms blocked preflight replays (`:3446-3460`) and feeds `noteFlaky` (`:3463`): durable flaky
   history and flaky-escalation attention items naming files the record lists.

A peer green is NOT taken when main is not healthy (`:2382-2389` and `:2338`, `peer-main-unjudged`),
so a peer cannot clear red. But while main is healthy, a peer that never runs anything can keep it
healthy indefinitely: if main is actually broken, no red is ever raised and merges keep landing.

Threats:
- **T1 tampering or impersonation on the hop**: anything that can answer at, or sit on the path
  to, the configured peer URL can return a matching record, or alter the request so the real peer
  runs under looser inputs and honestly reports green.
- **T2 a lying or broken peer**: the peer machine itself returns green without a real run (bug,
  stale build, compromise).

## Design

### D1. Peer results are signed over the request and the result (closes T1 for result integrity, both kinds)

- **Module**: `src/localVerify/peerResultSignature.ts`, imported by `peer.ts` and the service. It
  MUST be reachable from a `VERIFIER_ROOTS` entry (`verifierVersion.ts`), so any change to signing or
  verifying changes the verifier version; a test asserts it is in the hashed import graph. Two pure
  functions: `peerResultPayload(body)` and `verifyPeerResult(...)`.
- **Seams**: the service gains `signer?: MachineSigner` (used by `peerResult()`,
  `LocalVerifyService.ts:1998`) and `keyLookupFactory?: () => MachineKeyLookup` (a factory, so each import builds an uncached lookup), both injected where server.ts
  builds LV (near the peer wiring, `server.ts` ~26760) from `loadMachineSigner(stateDir)` and
  `() => identityKeyLookup(stateDir)`. Missing signer on a peer → it answers `unsigned`; missing lookup on a
  coordinator → no peer is dispatchable (fail closed, audited `peer-verify-unavailable`).
- **Request digest**: when dispatching, the coordinator stores
  `requestDigest = sha256(canonicalJson(JSON.parse(JSON.stringify(req))))` on the remote marker. The
  peer computes the same digest over the raw JSON body it received, before `parsePeerRunRequest`'s
  result is used, and stores it with the attempt in its persisted peer state, so it survives a peer
  restart.
- **Signed payload**: the peer answers `peer-result` `done` with
  `{ state, record, run?, requestDigest, sig }`. `sig` is a `MachineSignature`
  (`src/core/AppRecordSignatures.ts`) from `loadMachineSigner(stateDir)` over
  `instar-lv-peer-result-v1\n<sha256(canonicalJson({ record, run: run ?? null, requestDigest }))>`,
  where the peer first round-trips `{record, run}` through `JSON.stringify`/`JSON.parse` so it signs
  exactly the JSON it sends (`canonicalJson`, `src/core/appMediaTypes.ts`, is deterministic on
  parsed JSON: no `undefined`, no NaN).
- **Verification on the raw body, after the field checks**: `makePeerClient.result`
  (`localVerifyWiring.ts:525-535`, which today rebuilds the answer and drops unknown fields) returns
  the raw parsed `record`, `run`, `requestDigest` and `sig` alongside its parsed view. The signature
  check runs on that raw body, before `parsePeerMainRun` reshapes anything, and AFTER the existing
  field checks in `importRefusal`, so an attempt that spans the coordinator's own upgrade reads as
  `verifier-mismatch`, not `unsigned`. Today every refusal is abandoned with `failure: true`
  (`LocalVerifyService.ts:2371`); this spec changes that line so `verifier-mismatch` and
  `policy-mismatch` abandon with `failure: false` (a version skew is not a peer fault), while every
  signature and request refusal keeps `failure: true`. It requires:
  1. `requestDigest` equals the digest stored on the marker (the peer ran what was sent);
  2. `sig.machineId` equals the configured `peer.machineId` of the marker;
  3. `verifyMachineSignature(keyLookupFactory(), sig, payload, receivedAtMs)` is `ok`,
     where `receivedAtMs` is the coordinator's clock when the answer arrived (never a peer time), so
     a key revoked before receipt never verifies.
  The lookup reads the pinned peer key history the pool already keeps
  (`IdentityStore.signingKeyHistory`); it never trusts a key that arrives with the result. The lookup's
  30 s per-machine cache (`AppRecordSignatures.ts:140`) is avoided by calling `keyLookupFactory()` for each import
  (a fresh lookup with an empty cache; imports are a few per hour), so a revocation counts at once.
- **Refusals** (new `importRefusal` reasons): `unsigned`, `request-mismatch`,
  `signature-wrong-machine`, `signature-unknown-key`, `signature-bad`. Each is audited
  (`peer-result-unverified`: peer, attempt id, reason; never the record body), counts as a peer fault
  (`noteFailure`), and is abandoned with `remoteAttempts` set to the cap (`peer.ts:122`), so the
  entry runs on the coordinator instead of going back to a peer. `signature-bad` and
  `request-mismatch` also open that peer's breaker at once and raise one deduped attention item
  `local-verify:peer-result-unverified:<machineId>` ("A test result from <machine> failed its
  check, so that verify ran on this machine instead."). The observed fact is a failed check;
  tampering is one explanation, a signing bug on the peer another; both warrant refusal.
- **Pre-dispatch check**: `dispatchable` (`LocalVerifyService.ts:2078-2092`) skips a peer for which
  the coordinator's own key lookup has no current key (`signingKeyHistory(peer.machineId)` has no
  unrevoked key, or is unreadable). That is a local fact, not something the peer reports, so an
  unpaired peer (including one with no identity, which reports a `m_host_<hostname>` id) never burns
  a run. Audited once per peer per boot (`peer-unpinned`, naming the reason). `peer-status` also
  reports the peer's current `signerKeyHash` as a hint (`makePeerClient.status`,
  `localVerifyWiring.ts:510`, is extended to parse it); when it is not in the coordinator's pinned
  history (the peer rotated and the pin has not caught up), the peer is skipped the same way instead
  of wasting a run. A missing hint (older peer) skips the peer too (`no-key-hint`); the version check would refuse it anyway.
- **Replay**: an old signed answer cannot be reused: the attempt id, coordinator id, lease epoch and
  request digest are inside the signed digest, and the marker matches one attempt.
- **Not closed by D1**: the pool Bearer token travels in clear on the hop, so an on-path party
  holds it and can submit its own `peer-run` requests to a peer. It cannot make the coordinator
  import their results (wrong attempt id, request digest). Encrypting the hop is a pool-wide
  transport change, recorded as a residual.

### D2. A peer green on main has bounded authority (bounds T2)

Definitions: the **local anchor** is the head and finish time of the last `main` green the
coordinator ran itself on the head that was current when it started (`mainRunOnCurrentHead`), kept
in the flaky-history file under a new key `greenMainLocal`. The `FlakyHistory` type and both
`readFlakyHistory` (`:3769`) and `writeFlakyHistory` (`:3778`), which today rebuild only
`{ v, files, greenMain }`, are extended to carry `greenMainLocal`, the holding record below and the
`origin` field of `greenMain`, so ordinary flaky writes keep them.

The anchor, `locallyVerifiedMainHeads`, `peerMainGreens`, the second clock and the quarantine list
are bound to **unbroken holding by this machine**, not to the raw epoch, because a server takes a new
epoch on every boot (`LeaseCoordinator.ts:1015`; `FencedLease.buildAcquisition` writes exactly
`currentEpoch + 1`, `FencedLease.ts:433-437`). The service records `{ holder: self, epoch }` with the
state on each readable tick while holding. On a later readable read with holder = self it keeps the
state when the epoch is the recorded one or the recorded one + 1 (its own restart), and re-records
the new epoch. Another machine's acquisition in between consumes at least one epoch, so a gap of 2 or
more, or a read showing another holder, means the lease was broken and the state starts empty
(covers A→B→A). A gap the store skipped for another reason also resets, the safe direction. An
`epoch: null` read (single machine, no lease view, `LocalVerifyService.ts:1825`) with holder = self
always keeps state (null on both sides, as on a single machine with peers configured and no lease
view, counts as unbroken holding, so nothing is reset or reported lost), and a readable read with `holder: null` (no one holds the lease) is not "another
holder". Two consequences are kept distinct: **peer main dispatch pauses at once** on any read that
is not a readable holder = self (it resumes on the next such read), while **durable state is deleted
only** on the lease-loss evidence in D2.5 (another holder on two successive readable reads, or an
epoch gap of 2 or more). Unreadable or absent reads as no anchor.

1. **What a peer green may write**: `noteMainHeadVerified` (peer list), `lastGreenHead`, the
   existing `oldestUnverifiedAt` move, and the preflight-replay re-arm (re-arming only re-runs
   verifies). It may NOT write the green-main record (`saveGreenMain`) or feed `noteFlaky`. A peer
   green therefore never flips `isolationInput().allowed` and never writes flaky history or raises
   flaky items.
   Origin is checked every time the record is read, not once: `saveGreenMain` writes
   `origin: 'local'` into the record itself, and `isolationInput` (and
   every other reader) treats a record without `origin: 'local'` as absent. No epoch condition: a
   local green is this machine's own run whatever the epoch, so a restart keeps isolation re-runs. A record written by older code (before this version, or after a rollback) therefore never
   counts, with no migration marker to go stale. Cost after upgrade: isolation re-runs wait for the
   next local main green (a main verify runs on every merge, so usually within the hour). Peer records also
   skip `noteFlaky` at the import site (`LocalVerifyService.ts:3462`) for every kind.
2. **A second clock peers cannot move**: the coordinator keeps `oldestNotLocallyVerifiedAt` beside
   `oldestUnverifiedAt`. It is set when a head other than the local anchor head is observed and it is
   null; it is moved only by a coordinator-run green, through the same `oldestUnverifiedAfterGreen`
   rule (`mainHealth.ts:119-139`) the existing clock uses. Release collapsing follows the single rule
   in D2.3 (anchor head or `locallyVerifiedMainHeads`). `noteUnverifiedAge` is called with the older of the two clocks.
   So main reaches `main-suspect` (`unverified-too-long`) no later than `unverifiedSuspectMs` (3 h)
   after the first merge the coordinator has not verified itself, whatever peers report. If main has
   not moved since the anchor head, nothing is unverified and nothing fires, which is correct. With
   no anchor (fresh lease holder), the clock starts at the first observed head, and D2.3 keeps every
   main verify local until an anchor exists.
3. **Local corroboration before the bound** (a routing rule plus one trigger):
   - Routing: `dispatchable` refuses kind `main` to peers while there is no local anchor, or while
     the second clock is older than `localAnchorRefreshMs`. A fresh lease holder therefore runs its
     first main verify locally before any peer green can count.
   - Trigger: when the second clock passes `localAnchorRefreshMs` and no `main` entry is queued or
     in flight, the coordinator enqueues a local `main` verify of the current head (checked on the
     existing tick that calls `noteUnverifiedAge`, `:2457`; deduped against a queued or running main).
     It fires at most once per (head, clock episode), only while main is `healthy` or `main-suspect`
     with reason `unverified-too-long`, and never for a head whose `mainErrorRetries` reached the cap.
     A red head is left to the existing main-red flow; an erroring head to the existing retry cap.
     Without this, a quiet main whose last merge was only peer-verified would never be re-checked
     here, and at 3 h it would sit in `main-suspect` with nothing to clear it.
   - "Already covered" while routing is local: `retargetStaleMain` (`:2977-2980`) uses only the local
     anchor head and a new `locallyVerifiedMainHeads` list; the `lastGreenHead`, `verifiedMainHeads`
     and `mainSupersededAt` shortcuts are not consulted, since peers can write the first two. Release
     collapsing (`:1330-1338`) uses `locallyVerifiedMainHeads` and the anchor head for its enqueue
     decision whenever `mainOnPeers` is on (with it off no peer ever served main, so today's rule
     stands), so a release commit on a peer-only head still gets verified here.
   - `localAnchorRefreshMs` = `unverifiedSuspectMs` − 1.5 × the 90th percentile of this
     coordinator's last 10 local main verify durations that ended `success` or `failure` (not
     `error`; a two-strike rerun counts as its own run), capped at 2.5 h and with no lower floor. A
     result at or below zero means peers never serve main on this coordinator (its own main runs are
     too slow to leave room). Until 10 durations exist the coordinator has no measurement, so main
     stays local; the durations come from those same local runs, so peers start serving main only
     once the threshold rests on this machine's own evidence. A coordinator whose main runs take 20
     minutes gets 2.5 h; one whose p90 is 1.5 h gets 45 minutes.
   - If the local run cannot finish before the 3 h mark (backlog, stall, three `error` outcomes),
     the 3 h rule turns main suspect: the bound holds without a deadline of its own, every main keeps
     running locally until a local green, and nothing loops.
   - Lease churn: a new holder's clock starts fresh, so a pool whose lease moved every < 3 h with no
     holder ever finishing a local main verify would never reach suspect. No peer green counts during
     that churn (no anchor → no peer main dispatch), so a lying peer gains nothing from it; this is
     the existing behaviour of lease churn and is not widened here.
4. **Disagreement on the same head only, self-healed before anyone is told**: when a
   coordinator-run `main` verify of head H reaches `main-red` (the existing two-strike rule,
   `mainHealth.ts:396-407`) and a peer P reported H green under the same `verifierVersion` and
   `policyHash` (read from a persisted, bounded, holding-bound record `peerMainGreens`: head → peer,
   verifier version, policy hash, time; last 50, kept in `state/local-verify/peer-trust.json`), the coordinator
   records `peer-main-disagreement` (peer, head), adds P to a persisted `mainQuarantine` list (same file) and stops dispatching `main` to P at once. It then self-heals once, bounded:
   - **Arbitration attempt**: if another pinned, unquarantined peer Q is idle, the coordinator sends
     it one `main-arbitration` attempt for H: a new peer-run kind, signed and request-bound like D1,
     that is exempt from the health and routing gates (`peer-main-unjudged`, D2.3) because its result
     never reaches `completeMain`: not main health, `noteMainHeadVerified`, `lastGreenHead`, the
     unverified clocks, coverage lists, the green-main record or flaky history. Its only consumer is
     this decision. It does not take the coordinator's main slot (it is not counted by `remoteMain()`
     or the one-main-in-flight rule at `:2090`), so a local verify of a repair merge never waits
     behind it. It holds Q's slot like any peer run, under the existing peer attempt limits; a
     timeout, `error` outcome, refusal or busy Q counts as "no Q". At most one arbitration per
     quarantine episode.
   - Arbitration plumbing: the arbitration marker (attempt id, Q, head, request digest, sent time) is
     persisted in `state/local-verify/peer-trust.json` and polled by the same `pollPeers` loop (`:2318-2410`) as
     queue-entry remote attempts, through a separate branch that never touches the queue. D1 applies
     in full, with `kind` inside the request digest. Lease loss cancels it. "One per episode" is a
     flag on the quarantine entry, so it survives a restart. On the peer, `parsePeerRunRequest`
     (`peer.ts:156`, main-shape checks `:164-166`) accepts kind `main-arbitration` with the main-shape
     constraints (`pr === MAIN_VERIFY_PR`, head equal to base, no isolation); the record carries kind
     `main-arbitration` (added to `record.ts`), `importRefusal`'s kind check (`peer.ts:188`) compares
     the exact kind sent, and the peer never writes an arbitration record into its own LV index or
     journal as a main verdict. An older peer is refused by the version check.
   - Q red, or no Q: P stays quarantined and one deduped attention item
     `local-verify:peer-main-disagreement:<machineId>` is raised ("<machine> said the main code passed
     its tests, but the same code fails on <holder>. <machine> no longer tests main until you clear
     it; other helper machines still can. To change that, open <holder>'s console, go to Work, then Development, and on the card
     "A helper machine no longer tests main" tap "Let it test main again"."). Its link is the lease holder's console URL for the Development page.
   - Q green: the coordinator's red on H is likely environmental. P's quarantine is lifted, audited
     `peer-main-disagreement-cleared` (reason `third-machine-green`, Q's machine id and attempt id),
     no item about P. This is a peer vouching for a peer: if P and Q share a fault it lifts a
     quarantine that should stand and restores P's bounded authority, so P's false greens can again
     count within the D2.2 bound. Arbitration still cannot clear the coordinator's red, and the 3 h
     bound is unaffected. Main health is
     unchanged (still red on the coordinator's word, as today); the existing main-red item tells the
     owner.
   A red on any other head never counts against a peer. Same-head disagreement is rare (D2.3 retargets
   local runs to the current head, so it mostly fires on a quiet main); the bound in D2.2, not the
   quarantine, is the real protection, and quarantine only saves wasted runs. Accepted: with only one
   peer, an honest peer can be quarantined by a coordinator-side fault; the cost is that main stays
   local until cleared.
5. **Clearing**: one owner-only route `POST /local-verify/peers/:machineId/main-quarantine/clear`,
   gated by the dashboard operator session: `localVerifyRoutes` gains an injected
   `verifyOperatorSession` dependency wired to `ctx.verifyDashboardOperatorSession` (`routes.ts:1318`,
   used at `:3341`). Missing dependency → 503 `operator-session-unavailable`; never a fallback to the
   Bearer token. Listed in the capability index. The console sends it with the PIN-unlock pattern the
   Accounts page uses (`askPin`, the `X-Instar-Operator-Session` header, `forgetOperatorSession` on
   401; `dashboard/console/accounts.js:229-230`), since the Development page's `send()`
   (`development.js:44-49`) sends only the Bearer token today. It removes the entry and resolves the item. The button "Let it test main again" sits
   on a card at the top of the Development page (Work → Development; the page shows in maintainer
   mode, where Local Verify is surfaced today), one card per kept-off machine titled "A helper
   machine no longer tests main", with the machine id as a muted support line (`dashboard/console/development.js`, which already reads
   `GET /local-verify`), shown per quarantined peer; the item deep-links there. Before the wording
   ships, the page is loaded at 1280x728 and 390x844 and the quoted words are checked on screen. On a standby the route
   answers 409 naming the holder, like the other LV routes.
   - Lease loss: on the existing tick (`:2457`), which also runs while this machine does not hold the
     lease, the service compares a lease read with the holding record above. Today
     `leaseState()` (`:1824-1830`) turns a failed read into `{ holds: false, epoch: null, holder: null }`,
     indistinguishable from a change; it gains an `unreadable: true` flag from that catch branch, and
     an unreadable read is skipped. Lease loss is a holder other than self on two successive readable
     reads, or an epoch gap of 2 or more; an epoch advancing by one with holder = self (a restart) is
     never loss. That counts as lease loss (and when the holder is still self, after a gap, the items
     resolve with "Main checks restarted on <holder>." instead of the hand-over text): the quarantine list is cleared and open disagreement items resolve with "This machine no longer runs the tests; the machine that
     took over checks main itself first." A quarantine therefore never outlives its holder, and
     regaining the lease never revives a stale one.
   No automatic clear otherwise: a quarantined peer is never sent `main`, so it could never earn one.

Net bound, during one continuous lease: a lying peer can keep main looking healthy for at most 3 h
after the first merge the coordinator has not verified itself; main turns suspect then even if the
local run has not finished. Local corroboration is scheduled earlier (the refresh age, at most 2.5 h and earlier on a slow coordinator) so
that it normally finishes first; that is an expectation, not part of the bound. It can no
longer enable isolation re-runs or write flaky history. Across lease moves the clock restarts with
each holder, but no peer main green counts until that holder has its own local green, so lease churn
gives a lying peer nothing (D2.3, lease churn).

### D3. Wiring, rollout, posture, observability

- `mainOnPeers` stays dark. D1 also applies to PR verifies on peers (Part D). Mixed versions are
  already refused by the exact `verifierVersion` check; because signing and verifying sit inside the
  verifier roots, a signing coordinator never imports from a non-signing peer.
- **Observability**: `GET /local-verify` status gains a `peerTrust` block: per peer `pinned`,
  `mainQuarantined` (with head and time), last refusal reason; plus `localAnchor` (head, age),
  `notLocallyVerifiedSinceMs`, and a counter `mainKeptLocal` (main verifies D2.3 kept local) beside the
  existing dispatch counters, so the offload `mainOnPeers` buys is measured, not assumed.
  `peer-result-unverified` raises its item on the first `signature-bad` or `request-mismatch` per peer
  (deduped by peer id, refreshed on recurrence), and closes on the next verified import from that
  peer. Items go through the existing LV attention seam (`seams.signal`, cleared with `seams.clearSignal`), one voice, same as
  `local-verify:main-red`.
- **Awareness and migration**: `src/data/awareness/local-verify-main-on-peers.md` gains two
  sentences: peer results are signed and checked, and a peer's pass on main only goes so far: once
  the main commits only peers have checked reach the refresh age (at most two and a half hours, sooner on a slow machine), this machine checks main itself;
  a disagreement a third machine cannot settle stops main going to that helper until the owner taps Clear next to
  that machine on the Development page (Work → Development) of the console of the machine running
  the tests. No config default, hook or template changes,
  so no `PostUpdateMigrator` step (verified: neither `src/scaffold/templates.ts` nor
  `PostUpdateMigrator.ts` mentions `mainOnPeers`).
## Multi-machine posture

The anchor, second clock, `locallyVerifiedMainHeads`, quarantine list
and signature checks are lease-holder state, beside the LV queue and peer state they extend. On a
lease move the new holder has no anchor (state is bound to unbroken holding), so peer main
dispatch waits for its own first local green. A quarantine does not move with the lease. Effect: the new
holder may dispatch main to a peer the old holder quarantined (after its own first local green);
that peer is still bound by D2.2 to 3 h, and a repeat same-head disagreement re-quarantines it.
Losing the list costs throughput protection, never the bound (see D2.5, lease loss).

New durable state lives in `state/local-verify/peer-trust.json` (a dedicated file beside
`peer-attempts.json`; not `peer-hold.json`, which `writePeerHold` rewrites and deletes most ticks and
which the planned-restart guard reads): the quarantine list, `peerMainGreens` (at most 50), the
holding record and at most one arbitration marker. The state-coherence registry gains a
`machine-local` entry for it with this section's justification and those limits, and the
`local-verify-flaky` entry's description and record limit are updated for `greenMainLocal`, the
holding record and `origin`.

machine-local-justification: operator-ratified-exception — commit `6a8c3a2c26afeb3df573d5a9ae9e93ce775b3f17` (#2398, Part D of `docs/specs/local-verify-capacity.md`, whose approved-by line 13 records Justin's ratification in Telegram topic 130715 on 2026-10-26) shipped the lease-holder-local queue and peer state; this spec extends that exact state ownership and gives the new state no merge authority beyond narrowing a peer's.

## Maturation plan

- **dark-window:** D2 rides the existing dark switch `monitoring.localVerify.mainOnPeers`, off by default; D1 is live wherever peers are configured, because it only refuses results. At most 28 days from merge to the fleet decision on D2; if the graduation criterion is not met by then, the reason and a new date go on the SEC-113 ledger row.
- **test-agent-live:** a throwaway coordinator and peer pair: one signed main verify imported; one tampered answer (flipped `isolation.allowed` in the request, edited `outcome` in the result) refused and run locally; one restart while holding keeps the anchor; one forced same-head disagreement quarantines, and the Clear button on the Development page clears it with the operator session.
- **dev-agent-live:** on Echo's Studio coordinator with `mainOnPeers` on for at least 7 days: zero `peer-result-unverified` refusals from honest peers, `mainKeptLocal` and peer main counts reported from `peerTrust`, and no `unverified-too-long` suspect caused by the second clock while local runs were finishing on time.
- **fleet:** `mainOnPeers` stays opt-in per agent; D1 ships with the release to every agent that has peers.
- **graduation criterion:** over the dev window, at least one peer main green imported and verified, at least one local corroboration run triggered by the refresh age, zero false refusals, and the share of main verifies served by peers reported with its sample size. A zero count is not a pass.
- **ladder:** not applicable: D2 is gated by the existing monitoring.localVerify.mainOnPeers switch, and D1 only refuses results.

## Decision points touched

- `importRefusal` (peer import gate): request and signature checks, refuse-only and fail-closed — invariant; basis: enumerable-domain; evidence: each check has two outcomes (the request digest matches the stored one or not; the signature verifies under the pinned key at receive time or not), and the refusal reasons are a closed list of five; nothing is weighed.
- `dispatchable`: unpinned-peer, no-anchor, second-clock-age and quarantine conditions — invariant; basis: irreversible-consequence; evidence: dispatching main to a peer that cannot be verified, or past the age at which a lying peer could hold main healthy beyond 3 h, lets merges land on unverified code, which cannot be undone once merged; every condition can only keep work local.
- `completeMain`: what a peer green may write — invariant; basis: enumerable-domain; evidence: the writable effects are the six listed in Why this exists, each assigned allowed or denied in D2.1; it never adds authority.
- `localAnchorRefreshMs`: when peers stop serving main — judgment-candidate; a threshold computed from this machine's own measured durations under a 2.5 h cap; the floor it serves is the existing 3 h `unverifiedSuspectMs`, which it never relaxes.
- Quarantine clear: one owner-only control behind the operator session — invariant; basis: external-constraint; evidence: the owner's verified console session (`ctx.verifyDashboardOperatorSession`) is the authority the parent constitution names for owner actions; the Bearer token alone is refused. No new authority to block PRs.

## Tests

- Unit `local-verify-peer-signature.test.ts`: payload stable across key order; each refusal
  (missing sig, request digest mismatch after flipping `isolation.allowed`, other machine, unknown
  key, key revoked before receipt (including after an earlier successful import on the same service instance), bad sig, `flakyRetried`/`outcome` tampered after signing); a good
  signature imports; verification runs on the raw body.
- Unit `local-verify-main-on-peer.test.ts` (service, fake seams and clock): a peer green writes no
  green-main record and no flaky history; repeated peer greens without a local green → suspect 3 h
  after the first unverified merge; second clock older than 2 h → main runs locally, including on a
  head a peer already called green (and not shortcut by `lastGreenHead`); no anchor → no peer main
  dispatch; A→B→A lease moves and an epoch gap ≥ 2 start with no anchor; one other-holder read followed by
  an unreadable read pauses peer main dispatch but deletes nothing; a gap with holder = self resets
  with the "Main checks restarted" wording; `epoch: null` keeps state; a restart while holding
  (epoch + 1, holder self) keeps the anchor, the quarantine and isolation re-runs and raises no
  lease-loss item;
  arbitration: Q green lifts, Q red / timeout / error / busy keeps the quarantine, an arbitration
  result never changes main health or coverage, one arbitration per episode; a green-main record without `origin: 'local'` never enables isolation (including upgrade → rollback → peer green → re-upgrade); one throwing lease read clears nothing; a quiet main with a peer-only head past the refresh age enqueues a local verify; the
  refresh age follows measured durations (2.5 h cap, no floor; ≤ 0 → peers never serve main; fewer than 10 durations → main stays local); local run delayed past 3 h → suspect on
  time; same-head local
  `main-red` and no other peer → quarantine + item; another peer green on H → lifted, no item;
  another peer red → quarantine + item; lease loss clears the list and resolves the items; peer
  green on A then local red on descendant B → no quarantine; a
  single flaky red → none; quarantine survives restart; the clear route clears it; unpinned peer is
  never dispatched; signature refusal runs the entry locally (not on another peer).
- Unit (wiring): `makePeerClient.result` passes `sig`, `requestDigest` and the raw body through;
  the signing module is in the verifier-version import graph; an attempt spanning a coordinator
  upgrade reads `verifier-mismatch`, not a breaker fault; a lease move starts with no anchor and runs
  main locally; the unverified item raises once, dedupes and closes on a verified import; a peer
  record never reaches `noteFlaky`; a green-main record without `origin: 'local'` (older code, or a peer) never enables isolation, including after later flaky-history writes.
- Integration `local-verify-peer-routes`: the real `peer-result` route returns a signature
  verifiable with the peer's pinned key; the clear route refuses the Bearer token alone and accepts
  the operator session; `GET /local-verify` shows `peerTrust`.
- E2E alive: a coordinator and a peer server on the real HTTP routes and real wiring complete one
  signed `main` verify and import it; a tampered answer is refused and the verify runs locally.

## Rollback

Revert. New state (`greenMainLocal`, `mainQuarantine`, the second clock) is ignored by older
builds; an older build that rewrites the flaky-history file drops them, which after a re-upgrade
reads as no anchor and no valid green-main record (the safe direction: main local first, isolation
waits for a local green). Open `peer-result-unverified` / `peer-main-disagreement` items stay open until resolved by
hand; they describe a past event and carry no action after a revert. After a revert, peer greens write
the green-main record again, as before this spec. Turning `mainOnPeers` off returns all main
verifies to the coordinator immediately.

## Residuals

Each residual is a row under SEC-113 in the security findings ledger (owner: the security owner
session, Telegram topic 143781), which is re-read on every security pass and re-surfaced to the
Chief of Staff until each row is fixed or deliberately accepted:

- SEC-113-R1: a peer's PR green (Part D) still merges a PR on that peer's word: the parent spec makes
  peers merge-authorizing principals. D1 stops tampering and impersonation; a lying peer for PRs is
  not bounded here.
- SEC-113-R2: the pool-wide Bearer token travels in clear on the LAN hop to peers (all mesh calls
  share it). Fixing it is a pool-wide transport change; the ledger row asks the Chief of Staff for an
  owner.
- SEC-113-R3: a T2 peer can report `main` red: main goes `main-suspect` and merges hold until the
  coordinator's rerun, and its failing-file list steers the hold lists meanwhile. Accepted: bounded
  by one local rerun, and the parent spec already lets a peer make main suspect.
