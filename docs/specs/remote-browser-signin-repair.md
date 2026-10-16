---
title: "Remote-browser sign-in repair — a browserless machine borrows a peer's browser step"
slug: remote-browser-signin-repair
eli16-overview: remote-browser-signin-repair.eli16.md
status: draft
author: echo
created: 2026-09-27
tracks: CMT-609
parent-specs: "skill-driven-signin-repair, assisted-subscription-relogin, ws52-code-paste-back, ws52-account-follow-me-security"
lessons-engaged: "P3 Migration Parity (§Frontloaded 9); P4 Testing Integrity (§Tests); P5 Agent Awareness (template bullet + boot line); P7 supervision (the episode is the supervisor; the canary job is tier-1 supervised); P8 No Dead Ends (§Authorization: the refusal sits on the routes the dashboard actually calls, with a cell that says what to do); P10 deferral with owner (FD1); P19 No Unbounded Loops (§Timeline, §Self-Heal brakes, poll coalescing, one anti-replay retry); P20 Verify the State (§Verify); P22 Self-Heal Before Notify (§Self-Heal, 300s ceiling); L12 destructive fs via SafeFsExecutor (transcript deletion); L15 reach ≠ authority (§Authorization: a grant the requester signs for itself is refused on every route; consent bound to admission and named); B2 no CLI instructions to users (all cell text is fixed plain sentences); auto-memory full-machine-access-no-screen-blockers (§Findings folded in); auto-memory skills-over-scripts-for-live-uis (§Alternatives: why the peer driver is the helper session, not the runbook scripts); auto-memory prove-product-not-hand-script (FD12: proof is the product's ledger, never a hand run); auto-memory live-verified-is-not-landed (FD12: Rung-2 evidence comes from a released build); runbook 'Mistakes' 1–3 (§Findings folded in)"
---

# Remote-browser sign-in repair

A machine that cannot drive a normal browser (the Mama PC: Windows 11, Instar inside WSL; any
headless Linux box) repairs its own expired Claude Code / Codex sign-ins by delegating ONLY the
browser step of an existing repair episode to a peer Mac that holds the account's Google profile.
The login is still minted on the machine that needs it. **No reusable credential and no PKCE
verifier ever crosses between machines.** What does cross, and is named as such: the public login
URL / device code (requester → peer) and, for Claude, the single-use PKCE-bound paste-back code
(peer → requester) — both sealed to the receiving machine's key in transit, and the code held in
the peer's memory only until the requester has it.

## Glossary (terms this spec leans on)

- **Episode** — one bounded repair of one account on one machine (`assisted-subscription-relogin`).
  It has a **tap** (operator approval), up to 3 **attempts** (each ≤ 10 min), and a **tick** (the
  relogin service loop, every 30 s).
- **Cell** — one (account × machine) square on the dashboard's Subscriptions grid.
- **Seat** — the one Playwright/Chrome helper slot a Mac has (`PlaywrightSeatLease`).
- **Helper** — the short-lived agent session that clicks through the sign-in pages
  (`skill-driven-signin-repair`).
- **Requester** — the machine whose login expired. **Peer** — the Mac doing the browser step.
  **Fronting machine** — the machine whose dashboard the operator tapped.
- **Grant** — the operator's signed permission slip (an `account-follow-me` re-mint mandate).
- **Assist** — one delegated browser step, a row on the peer.

## Problem statement

Assisted sign-in repair (spec `assisted-subscription-relogin`) detects an expired subscription and
runs a bounded repair episode. Its browser step exists in three forms, and every working one is
macOS-only: the plain-Chrome driver, the skill-driven helper session (`resolveReloginNavigation`
in `src/core/SubscriptionReloginRuntime.ts` honors `agent-session` only when
`platform === 'darwin'`), and the CDP driver — which is what a non-macOS development agent gets
today (`navigation` omitted resolves to `agent`; the server boot line prints `browser: automated`),
and which the providers' human checks stop. On the Mama PC (Windows + WSL) there is no Chrome the
agent can script and the desktop cannot be captured from WSL, so every episode there ends
operator-only. All six Claude logins sat signed out from 2026-09-25 to 2026-09-27.

On 2026-09-27 the gap was closed by hand (topic 57697; `docs/runbooks/cross-machine-subscription-signin.md`;
13 of 13 accounts, every one verified by a real authenticated call). The hand path IS the design:

- the Mama PC started each CLI login itself (its CLI holds the PKCE verifier; the token is minted
  there; nothing is copied);
- the Mac Studio opened the verification URL in that account's own normal Chrome profile, drove
  Google + Authorize through pid-targeted Apple Events (no screen, no mouse, screen locked the whole
  time), read the paste-back code, and posted it to the Mama PC;
- for Codex, the Studio typed the device code on OpenAI's page and posted nothing; the credential
  landed on the Mama PC by itself.

This spec turns that hand path into a repair episode outcome, so the browserless machine repairs
itself without an agent driving the Mac by hand.

## Proposed design (the 80/20) — and its honest cost

One new value of an existing knob, one peer-side driver that reuses the helper's seat / spawn /
kill machinery, and a small **pull-only** protocol: the requester calls the peer; the peer never
calls the requester. No new credential authority, no new store family, no new notice kind, no new
mandate action, and no inbound route on the requester.

**Complexity budget, owned.** For roughly three machines and thirteen accounts this adds six
peer-side routes, one table, one grant-acceptance path, one timeline of bounds (§Timeline), and
migration text. That is a small, hand-built lifecycle — but every piece is an existing pattern
reused (the relogin store + tick, the seat lease, the helper, machine-auth, mandate packaging,
`extendApproval`), and the alternative of a generic queue/workflow engine is rejected in
§Alternatives because Self-Heal Before Notify forbids a new engine where the existing P19
primitives suffice. Refusal and end-reason vocabularies are kept CLOSED and small on purpose: every
token has exactly one consumer (the requester's verdict mapping or the cell text).

1. **The requester keeps ownership of the episode.** The machine that needs the login (the
   *requester*) opens the repair episode, starts the CLI login (`EnrollmentWizard.start` on the
   requester — `driveLogin` runs there, exactly as today), waits for the credential, verifies
   identity + authenticated use, and closes the episode. Only the *browser step* moves.

2. **A fourth navigation value: `peer-browser`.** `assistedRelogin.navigation` gains
   `peer-browser` (the union becomes `agent | closed | agent-session | peer-browser`).
   `resolveReloginNavigation` resolves it as follows:
   - on `darwin`: `peer-browser` is honored only when explicitly set (a Mac that holds no profiles
     for its accounts); omitted keeps today's `agent-session` on a dev agent, `closed` on the fleet;
   - on any other platform: omitted ⇒ `peer-browser` on a development agent (this REPLACES today's
     `agent` / CDP-driver default there), `closed` on the fleet; explicit `agent` and explicit
     `peer-browser` are honored.
   `createSubscriptionReloginRuntime` branches on `peer-browser` explicitly: it constructs the
   requester-side assist client, never the CDP driver (a wiring test asserts this — the current
   runtime falls through to `AnthropicReloginBrowserDriver` for any value other than
   `agent-session`, so a widened type alone would be a silent no-op). The boot line prints
   `browser: peer` for this value. The episode row records `navigation` so every route below can
   branch on it.

3. **The browser step is delegated to a capable peer over the machine-authenticated mesh —
   requester → peer only.** Every route below is mounted inside `createMachineRoutes`
   (`src/server/machineRoutes.ts`, the router that exists only when the multi-machine coordinator
   is enabled and applies `machineAuthMiddleware` per route: Ed25519 machine identity,
   challenge / nonce / sequence, registry `status === 'active'`) under `/api/subscription-relogin/…`
   — NOT the Bearer-only hop the follow-me relays and `repair-cell` use today, because a Bearer
   alone cannot prove which machine is speaking. `MachineRouteContext` gains an optional
   `browserAssist` port that `setSubscriptionRelogin` binds late (the same late-binding the
   context already uses for other ports); the routes answer 503 while it is absent. The sender
   machine id is taken from the verified envelope on every request; a body field naming a machine
   is ignored. The signature covers `machineId|ts|nonce|seq|sha256(body)`, NOT the path or query,
   so: every signed body ECHOES the `assistId` / `episodeId` it targets and the peer requires path
   equality; every per-assist route requires `verified sender === row.requesterMachineId`, else
   `assist-not-yours`; every response echoes `assistId` for the requester to compare; and the two
   sensitive payloads are SEALED (below), so an unsigned path grants nothing to an on-path
   observer. On a single-machine agent the router does not exist (404); on a paired peer whose
   serve knob is off the routes answer 503 with body `serve-disabled` (§Frontloaded 9).

   **Sealing.** The mesh has three ropes: Tailscale (WireGuard-encrypted), Cloudflare (HTTPS) and
   LAN (plain HTTP — `MeshUrlAdvertiser` advertises `http://` there). So the two payloads that
   matter are sealed to the RECEIVING machine's registered X25519 key with the existing
   cross-machine secret-sync sealing primitive, AAD-bound to `assistId`: the requester seals the
   `artifact` (the login URL / device code) to the peer's key, and the peer seals `code` to the
   requester's key. A LAN observer sees signed envelopes and sealed blobs; it can neither read a
   Codex device code (and authorize it with a stranger's account, which would waste the attempt
   as `wrong-identity`) nor a Claude code (which PKCE already binds).

   - `GET  …/browser-assist/can-serve?provider=&accountId=` — lock-free read (§5); answers
     `{ canServe, reason?: 'unknown-here' | 'serve-disabled' | 'not-paired', lastVerifiedAt?,
     openAssists? }` where `openAssists` is one indexed COUNT of the peer's open assist rows
     (queued + ready + driving + code-held) — the queue-depth read the requester's admission rule
     needs.
   - `POST …/browser-assist` `{ episodeId, accountId, provider, grant, maxPosition: 3 }` —
     admission (§Authorization, §Peer admission). Answers `202 { assistId, position,
     identityHash }` or a typed refusal / typed wait. Idempotent on `(sender, episodeId)`: a repeat
     while an assist for that episode is open returns the SAME `assistId` and its current position
     and creates nothing (this is how an assist survives a requester restart). A row is created
     only on a fresh `202`; only fresh rows count toward the per-cell cap.
   - `POST …/browser-assist/:assistId/artifact` `{ assistId, sealedArtifact }` — the sealed public
     login artifact `{ verificationUrl, userCode?, workspaceHint? }`, posted only when the
     requester has read state `ready`. Field floors after unsealing: `verificationUrl` ≤ 2 KB with
     the fragment stripped; `userCode` ≤ 16 chars `[A-Z0-9-]`; `workspaceHint` ≤ 64 chars
     `[A-Za-z0-9_-]`; no control or newline characters anywhere (these fields are rendered into the
     helper's prompt, so they are an injection surface; the helper's four hard lines are the LAST
     line of defence, these floors are the first). Accepted in `ready` (spawns the helper). In
     `driving`, a DIFFERENT artifact (the login was reissued) kills and respawns the helper under
     the same `assistId` — clearing any held code — counted against the existing `maxReissues` cap
     of 2; the same artifact is a no-op `200`.
   - `GET  …/browser-assist/:assistId` — the ONE read the requester loops on:
     `{ assistId, state: 'queued' | 'ready' | 'driving' | 'code-held' | 'ended', position,
     endedReason?, challenge?: 'phone-tap' | { 'macos-permission': permission }, sealedCode?,
     codeHash? }`. `code-held` is `driving` with a posted, un-acked code: the assist stays there —
     the helper exiting does NOT end it — until the requester acks, or until `requester-unreachable`
     / the driving cap ends it. `endedReason` is a CLOSED enum: `succeeded-from-peer-view` ·
     `helper-exited` · `assist-cap` · `artifact-timeout` · `queue-expired` ·
     `requester-unreachable` · `cancelled` · `peer-restarted` · `serve-disabled` ·
     `hard-line:<wrong-identity | unexpected-page | captcha | phone-confirmation |
     permission-expansion>` (a wrong-account chooser is `wrong-identity`); anything else is
     normalized to `peer-protocol-error` at the requester's edge and audited.
   - `POST …/browser-assist/:assistId/ack` `{ assistId, codeHash }` — the requester has the code;
     the peer forgets it and ends the assist `succeeded-from-peer-view`. A mismatching hash answers
     `409 ack-hash-mismatch` and the code is retained. Idempotent.
   - `POST …/browser-assist/:assistId/cancel` `{ assistId }` — tears the helper down, releases the
     seat, ends the assist `cancelled`. Idempotent; answers the terminal state.

   **Poll rules.** Every 30 s while `queued` / `ready`, every 5 s while `driving` / `code-held`
   (so a code or a phone-tap challenge reaches the requester within 5 s); cadence is measured from
   the previous poll's completion, polls COALESCE (at most one pending per assist), and outbound
   machine-auth requests to one peer are SERIALIZED (one in flight per peer) because the
   anti-replay sequence is one monotonic counter per process and a reordered arrival is a 403. A
   403 whose body starts with the anti-replay prefix (`Anti-replay check failed`) is retried ONCE
   per poll with a fresh sequence and is never counted as a missed poll; any other 403 (de-paired)
   ends the step `peer-refused`. A 503 `serve-disabled` ends the step on first read. Three
   consecutive missed polls (timeout / transport error; worst measured gap under serialization
   ≈ 60 s) ⇒ `peer-lost`: while `queued` / `ready` the requester re-selects (the one re-selection);
   while `driving` / `code-held` the artifact is spent, so the attempt ends `transient` and the
   next attempt re-admits. Symmetric on the peer: an assist whose requester has not polled for
   90 s ends `requester-unreachable` and frees the slot. Request budget, stated honestly: one
   driving assist alone is 12 requests/min; with three queued behind it and the fan-out, ≈ 20/min
   per requester–peer pair, ≈ 30/min on a peer serving two requesters; each request costs the peer
   one registry read and one nonce append (sync, sub-millisecond at these sizes) — accepted, and a
   higher cadence must not inherit it silently.

4. **No new authority — the same floors as the local path.** The helper on the peer follows
   `/subscription-signin` section 3 unchanged: expected email checked on the account chooser, the
   consent page and the Authorize page ("Logged in as <expected email>"); the permission list must
   be the standard Claude Code set; no CAPTCHA, phone-tap or "verify it's you" work-around. A phone
   tap surfaces ONCE as the assist's `challenge`, the REQUESTER's episode notifies it once (exactly
   as a local phone tap is notified today), and if the tap does not land before the driving cap the
   helper ends `hard-line:phone-confirmation` (the parent's hard line). Secrets by vault NAME on
   the peer only; never a login, cookie or profile copied between machines. **Success is decided
   only by the requester**: pending-login completion, `verifyIdentity === 'match'`, then a real
   authenticated call. Nothing the peer reports is a success input, and nothing the peer reports
   can open the requester's security breaker (§Self-Heal `class`).

5. **Peer selection is read, never guessed.** Before the episode spends an attempt, the requester
   fans out `can-serve` to every ONLINE paired peer (parallel, 5 s per peer, 8 s total; ONE fan-out
   per requester per tick, shared across every episode waiting on that tick). A peer answers from
   its OWN state with a lock-free read (it never acquires the helper seat — the seat lease's
   `acquire` takes a 10-minute lease and its lock spins; `can-serve` reads the lease file once and
   counts open rows by index): its profile registry must resolve exactly ONE profile for the
   account's email on the provider's closed service list (the existing `profileContext` rule:
   `anthropic` or `openai`, else `google`; ambiguity ⇒ `false`), the profile directory must exist
   on its disk, its platform must be `darwin`, its navigation must resolve to `agent-session`, and
   its serve knob must be on. Seat / capacity are NOT part of `canServe` (a busy peer can still
   queue) but `openAssists` IS returned. The requester picks the ONE peer that answered `true`
   AND `openAssists ≤ 3`; two or more ⇒ the peer whose answer carries the most recent
   `lastVerifiedAt` for that account's profile (`null` sorts last), ties broken by the lowest
   machine id — deterministic, logged as an episode event; `true` but deeper than 3 ⇒ a
   requester-side pre-attempt WAIT (no admission, no row, re-fan-out next tick); zero ⇒ the
   episode ends `waiting-operator-only` / `no-browser-peer`, which surfaces the existing phone
   **Sign in** cell. Peer selection never consults a replicated projection: the profile registry
   is machine-local by design and the capability registry today holds only `model` capabilities.

   **Accepted disclosure, named:** account ids are pool-wide (the same id names the same operator
   account on every machine), so a `can-serve` probe tells every online paired peer that the
   requester currently needs THAT account's browser step — account-presence disclosure to paired
   peers. It is accepted because paired peers already share the pool's account METADATA (WS5.2's
   redacted projection carries id, email, provider, status per account) and because the answer is
   coarse: a peer that does not hold the account, or holds no unique profile for it, answers
   `false` with the same `unknown-here` — never which Google identities it holds.

6. **Expected email is bound on the peer, not carried, and checked for divergence before any
   login starts.** The peer resolves the account's email from its OWN subscription pool record for
   `accountId` (`SubscriptionPool.get(accountId)` returns `null` for an unknown OR email-less
   account ⇒ `account-unknown-here`). A confused requester can therefore never point a peer's
   Google profile at a different identity than the one the peer's own registry binds to that
   account. The `202` admission answer carries `identityHash` = `sha256:` + hex of the
   trimmed, lower-cased email (the runtime's existing per-email hash, exported for this use); the
   requester compares it with the hash of ITS pool record's email BEFORE starting the CLI login — a
   requester whose own record has no email refuses to start (`missing-expected-email`, the
   ledger's existing hold); a mismatch (divergent pools) ends the step `peer-identity-divergent`
   (recoverable: cancel, exclude that peer, re-select), never a `wrong-identity` quarantine of the
   requester's own account. Completion is recorded through the requester's existing
   `verifyIdentity` arbiter — the hand run's `missing-expected-email` hold (plain enroll carries no
   expected email) cannot happen inside an episode.

## Timeline (every bound, once)

| Bound | Value | Where it lives | When it passes |
|---|---|---|---|
| Grant validity | 15 min from the tap (as issued; never stretched; on the PEER's clock) | mandate | bounds ADMISSION only; a re-admission after it ⇒ `grant-expired` ⇒ `waiting-operator-only`, one re-tap |
| Approval window | 60 min from the tap (`extendApproval` cap, existing) | requester episode | a requester-side wait past it ⇒ `waiting-operator-only` on the peer-browser path (NOT `fail`: no failed row, no breaker count — an operator re-tap is not a repair failure) |
| Attempt budget | 3 attempts × 10 min, backoff 5/10/20 s (existing) | requester episode | terminal `failed` (counts toward the breaker) |
| Queued | ≤ 60 min per assist (`queue-expired`) | peer row | slot freed; requester re-selects |
| Ready (awaiting artifact) | ≤ 2 min (`artifact-timeout`) | peer row | seat released, next promoted |
| Driving cap (`assist-cap`) | `min(15 min, login expiry − 60 s, remaining attempt budget)` | both (peer enforces the 15-min helper cap; requester the rest) | helper killed; a held code is dropped only if unacked past `requester-unreachable` |
| Code held | until ack, or `requester-unreachable`, or the driving cap | peer memory | `succeeded-from-peer-view` / dropped |
| Requester unreachable | 90 s without a poll | peer row | slot freed |
| Poll cadence | 30 s (queued/ready), 5 s (driving/code-held), 5 s timeout, coalesced, serialized per peer | requester | 3 misses ⇒ `peer-lost` |
| Per-cell cap | 3 fresh admissions per `(requester, accountId)` per peer per 24 h | peer row | `requester-rate-limited` |
| Assist retention | 2000 rows / 180 days (`enforceCaps` / `prune`, ended rows only) | peer store | — |

Consent-time versus execution-time, stated plainly: a 15-minute grant can result in a browser
step that runs up to ~60 minutes after the tap (queued behind other assists), exactly as the local
path's one tap is honored for up to 60 minutes while an episode waits on a seat. The approval cell
says so: "Approved — may run up to an hour from now while other sign-ins finish".

## Sequence

```
requester (WSL/Linux)                                peer (Mac with the Google profile)
────────────────────────                             ──────────────────────────────────────
episode: suggested → approved
  (tap on the PEER's or a THIRD machine's dashboard mints the grant, §Authorization)
  pre-attempt (no attempt spent, no attempt clock):
  can-serve? (fan-out) ────────────────────────▶      lock-free read: profile, dir, openAssists
  ◀── { canServe, lastVerifiedAt, openAssists }       (requester admits only if openAssists ≤ 3)
  browser-assist { episodeId, accountId, grant,
                   maxPosition: 3 } ─────────────▶    admission → 202 { assistId, position,
  compare identityHash; record { assistId, peer }       identityHash }; row: queued (FIFO)
  GET assist every 30 s ───────────────────────▶      … seat frees → ready (2-min window)
  ◀── { state: ready }
attempt starts: CLI login here (PKCE verifier stays here)
  artifact { sealedArtifact } ────────────────────▶   unseal → floors → origin-exact allowlist →
                                                        Preferences edit → spawn helper
  GET assist every 5 s ────────────────────────▶      driving; helper drives Chrome by Apple Events;
  ◀── { state: driving | code-held, challenge?,        helper posts code to the PEER's loopback
        sealedCode? }                                    route (per-assist token); peer seals it to
                                                        the requester's key, holds it in memory
  ack { codeHash } ────────────────────────────▶      peer forgets the code; assist ended
unseal; settle the drive promise (one writer: finishCli types)
credential lands in own configHome
verifyIdentity → authenticated call → episode succeeded
                                                      helper killed, seat released,
                                                      helper transcript deleted (SafeFsExecutor)
```

Codex: the artifact carries `userCode` (+ optional `workspaceHint`); the peer's helper types it;
no code ever comes back; the REQUESTER's orchestrator completes a device-code login exactly as it
does locally — `credentialReady` polling on the requester (`SubscriptionReloginOrchestrator`: a
`device-code` login is `complete` when the credential file appears; no explicit
`enroll/:id/complete` call is needed inside an episode, unlike the plain enroll the runbook used).
The requester's wait is its own, bounded by the driving cap; the peer's `ended` state is
informational.

**One writer for the paste.** On the requester, a received code SETTLES the drive promise with
`pasteCode`, exactly as the local `helper.submit` path does; the orchestrator's `finishCli` then
types it through `ClaudePasteBackController.finish`, whose existing pane checks (`pane-dead` /
`pane-not-ready` / `send-failed`) are a terminal-text symbol check that ends the attempt
`uncertain-external-outcome`. The assist client never types into the pane itself. The requester
accepts a code from `driving` OR `code-held`.

**Honest verdict mapping.** Today `agent-sign-in-unfinished` (helper exited or capped without a
code) maps to a TERMINAL `failed` episode. On this path the peer-side ends `helper-exited`
(without a code), `assist-cap`, `peer-lost`-while-driving and `peer-restarted` map to `transient`
(`retry()` — the next of the 3 attempts re-admits), because the requester can prove nothing about
the peer's helper; the episode still fails, terminally, when the 3 attempts are spent.

## Authorization

- **Approval mode (forced on this path until graduation — §Maturation).** The operator's one
  dashboard tap approves the episode. Today two approve paths exist and only one mints a mandate:
  `POST /subscription-relogin/repair-cell` (the fronting dashboard, PIN — the ONLY route the
  Subscriptions grid's **Repair sign-in** button calls) issues an `account-follow-me` mandate with
  mechanism `re-mint` and bounds `{ accountId, targetMachineId: <requester>, episodeId,
  inputDigest, repairAction }`, packages it (`packageMandateForDelivery`, asymmetric issuance
  signature — R4a of `ws52-account-follow-me-security`) ONLY for a remote target, and delivers it
  to the requester, whose `approve-with-mandate` verifies and then CONSUMES it (the
  `DeliveredMandateStore` tombstone); when the fronting machine IS the target (`isSelf`),
  `repair-cell` mints an unpackaged local mandate and approves through its own
  `approve-with-mandate`. The local `POST /subscription-relogin/:episodeId/approve` (PIN) mints
  nothing at all and is not called by the grid. On this path:
  - **The grant must be issued by a machine other than the requester.** A signature from the
    requester proves only that the requester asked; the PIN evidence never reaches the peer, so a
    self-signed grant is reach dressed as authority (L15) — and it would let a compromised paired
    requester mint fresh logins onto itself for every account the peer holds, the exact hole
    §Unattended refuses. Therefore, for an episode whose `navigation` is `peer-browser`, ALL THREE
    approval entry points on the requester refuse with `409 approve-from-another-dashboard`
    BEFORE any mandate is issued or consumed: `repair-cell` in its `isSelf` branch,
    `approve-with-mandate` when the mandate was minted locally rather than delivered, and
    `/:episodeId/approve` (belt). The cell on the requester's OWN grid renders "Approve this
    sign-in from the dashboard on one of your other machines" and hides the button (the client
    knows it is the fronting machine: `c.machineId === selfMachineId`); the same cell on the
    PEER's or any THIRD machine's grid keeps the live **Repair sign-in** button. Valid taps:
    on the PEER's dashboard (`repair-cell` with the peer fronting — it delivers the packaged grant
    to the requester and later verifies the forwarded copy against its OWN mandate store, the
    strongest case) or on any THIRD paired machine (`repair-cell` there). No dead end (P8): the
    refusal always names the next action, and the pool-wide grid already shows every cell on every
    machine.
  - **`repair-cell` always packages the mandate for a `peer-browser` target**, and the requester
    keeps the PACKAGED (issuer-signed) copy on the episode row as `forwardableGrant` after its own
    consume — the consume tombstone is what stops a second APPROVAL; the retained portable copy is
    what the requester forwards as the `grant`. (`canonicalMandate` excludes `revoked`, so the
    retained copy stays verifiable after the local consume.) `forwardableGrant` is a signed public
    artifact, never a secret, and is STRIPPED from every pool projection of the episode
    (`GET /subscription-relogin?scope=pool` spreads the row today).
  - **The peer verifies the grant on a NEW acceptance path**, distinct from mandate delivery
    (`AccountFollowMeMandateDelivery` requires issuer = sender and target = self, which a forwarded
    grant can never satisfy): the issuer is resolved from the grant's `issuerFingerprint` against
    the machine registry's active signing key (the same `status === 'active'` check
    `machineAuthMiddleware` applies); the signature must verify; the issuer must NOT be the
    verified sender (`grant-invalid:self-issued`); `bounds.targetMachineId` must equal the
    verified sender (the requester); `bounds.accountId` / `bounds.episodeId` must equal the
    request; the grant must be unexpired on the PEER's clock (a peer whose
    `MachinePoolRegistry.clockSkewStatus` is not `ok` refuses `clock-skew` rather than guess);
    and every bound key must equal the request (`paramsSatisfyBounds` requires every bound key to
    equal — extra params are allowed, a differing bound key is a deny).
  - **Consent is bound to ADMISSION, and the assist carries its own validity after that**
    (§Timeline). Re-admission (peer lost, peer restarted, re-selection) needs an unexpired grant:
    after minute 15 the peer answers `grant-expired` (recoverable), and the episode goes
    `waiting-operator-only` with the **Try repair again** cell — one more tap, never a silent
    stall, never a failed row.
  - **One open assist per `(requester, episodeId)` AND one open assist per `(peer, accountId)`**
    (any requester; UNIQUE partial indexes over open rows): a terminal assist frees both. A second
    requester asking for an account whose assist is open receives the typed WAIT
    `account-assist-open` (no row) and re-fans-out next tick. Cap: 3 fresh admissions per
    `(requester, accountId)` per peer per 24 h — no aggregate per-requester cap, so a 13-account
    burst is never starved by its own size.
  - **Decision: reuse the `account-follow-me` re-mint mandate; no second action.** The operator's
    consent is "this account may be re-minted on machine X"; the browser step is part of HOW that
    re-mint happens. The peer's own profile registry already records, per Google account, whether
    the profile's owner is `agent` or `operator`, and the existing local path uses that record with
    no per-episode consent. A second mandate action would add paperwork the constitution does not
    ask for (Occam; Judgment Within Floors keeps the floors, not the ceremony).
  - **Foundation fix, in scope:** `repair-cell` (and its sibling matrix orchestrator route) issue
    with `author: 'justin'` as a hard-coded literal; the issuance author becomes the verified
    dashboard-operator principal of the PIN session that tapped (Know Your Principal).
  - **Residuals, named.** (a) The trust floor for a grant is "a paired machine other than the
    requester ran a PIN-gated issuance route" — identical to the floor follow-me mandate delivery
    already accepts. A compromised NON-requester paired machine can mint grants; it could already
    mint follow-me mandates today. Its blast radius here is one browser step for an account the
    peer already holds, minted onto a machine the operator already paired, audited on both
    machines. (b) Revocation blindness: a grant revoked on the issuing machine after delivery stays
    acceptable to the peer for the rest of its 15-minute window (the peer has no view of the
    issuer's revoke; `DeliveredMandateStore` is a separate tombstone).

- **Unattended mode (post-graduation only — refused in v1).** In v1 the peer answers
  `unattended-not-permitted-here` to any request that carries no grant. After graduation, an
  unattended delegation is admitted ONLY when the peer's own PIN-configured list
  `assistedRelogin.browserAssist.unattendedRequesters: [{ identity, requesterMachineId }]`
  contains the exact pair — "this Mac may sign THIS email in for THAT machine without a tap" —
  never the peer's existing `unattendedPolicy.identities` (that list means "repair this email ON
  THIS machine unattended"; reusing it would let any compromised paired machine mint logins for
  every listed identity onto itself with no operator signal). In v1 the key is ignored with one
  boot warning. Reach is not authority (L15): the requester's own unattended admission is never an
  input on the peer.

- **What the peer can never do.** It never learns the requester's PKCE verifier, never sees the
  minted token, never writes the requester's config home, never reads its own profile's cookies
  out (the helper drives the browser; the server never touches the profile directory beyond the
  existing `dirExists` check and the Preferences edit). It hands the sealed code only to the
  requester that polls with a verified envelope for THAT assist. **Honest residuals (named):** the
  helper is an agent session; the page text carrying the code and the login URL passes through its
  transcript on the peer's disk. At kill, the peer's assist driver resolves that transcript from
  the helper's session id inside the HELPER ACCOUNT's config home (Claude: `projects/**/<session
  uuid>.jsonl`; Codex: that account's rollout file) — never the requester's — and deletes it
  through `SafeFsExecutor` (the single funnel for destructive fs ops, L12 — a NEW step; today's
  `drive` finally-block only kills tmux and releases the lease; tmux scrollback dies with the
  kill), writing an audit row naming the outcome so a skipped delete is observable. Between read
  and kill the residual is accepted, and a MALICIOUS peer can retain the single-use artifacts and
  timing / account-presence metadata — what it cannot do is mint a credential: the code is
  single-use and PKCE-bound to the requester's own verifier, and identity is decided by the
  requester.

- **What the requester can never do.** It cannot make the peer open an arbitrary URL: after
  unsealing the `artifact` the peer applies the field floors (§3) and parses `verificationUrl`
  with `new URL()`, requiring `https:`, no userinfo, no explicit port, and `origin` EXACTLY equal
  to the provider's closed pair — `anthropic ⇒ https://claude.ai`, `openai ⇒
  https://auth.openai.com` — a NEW deterministic check (no entry-URL allowlist exists today:
  `PendingLoginStore` only requires a non-empty string; the CDP driver's `safeAllowedUrl` /
  `ANTHROPIC_ORIGINS` / `OPENAI_ORIGINS` are navigation floors for THAT driver and include
  `accounts.google.com`, which must never be an entry URL). The same check is added to the LOCAL
  helper path before spawn (foundation fix: today the helper path relies on the skill prompt's
  hard lines alone). It cannot pick the profile or the email (§5, §6). It cannot exceed one open
  assist per episode, 3 fresh admissions per `(requester, accountId)` per peer per 24 h
  (`requester-rate-limited`), one helper per peer machine (the seat lease), or the driving cap.

- **Residual risk, named: a compromised paired peer.** It can drive the wrong provider page
  variant, waste the requester's attempts, retain artifacts, or report junk. It can NEVER complete
  a login as the wrong identity (the requester's `verifyIdentity` is the arbiter), never obtain a
  credential (PKCE), never trip the requester's security breaker (peer-reported tokens are mapped
  to `transient` or `failed`, §Self-Heal), and its challenges are read at most once per kind per
  assist. A peer that repeatedly ends assists against one cell contributes ordinary failed
  episodes to the requester's existing 3-in-24h breaker like any other failure.

## Peer admission — typed refusals and waits

`POST /browser-assist` evaluates, in this order, and answers one reason token (never the body
echoed). Every REFUSAL is returned to the requester as a pre-attempt verdict `peer-refused` (a NEW
verdict beside `ok | wait | no-healthy-seat`): the requester re-selects among the remaining
`canServe` peers once, then ends `no-browser-peer`; no attempt is spent, the approval-extension
ladder applies. Every WAIT is the existing pre-attempt `wait` (approval extended 5 min per tick to
the 60-min cap from the tap — the same `extendApproval` path the local helper uses for
`helper-seat-lease-held`), and creates NO row unless stated:

- refusals: `peer-not-paired` · `serve-disabled` · `platform-unsupported` · `assist-not-yours` ·
  `grant-invalid` (signature / issuer unknown / self-issued / target ≠ sender / bounds) ·
  `grant-expired` · `clock-skew` · `unattended-not-permitted-here` · `account-unknown-here` ·
  `profile-ambiguous` · `profile-missing` · `profile-dir-missing` · `no-helper-account` (no healthy
  helper account on the peer other than the one under repair) · `requester-rate-limited`;
- waits answered `409` with NO row: `queue-deep { position }` (FIFO depth would exceed
  `maxPosition`), `account-assist-open` (another open assist for this account);
- waits answered `202` WITH a queued row (`position` = the number of assists ahead in FIFO; `0`
  means the seat is free and the assist is `ready` now): `helper-seat-lease-held`,
  `relogin-profile-in-use` (that profile's Chrome is open), `session-capacity-full`. The peer's
  30-s service tick promotes `queued → ready`, expires rows (§Timeline), and ends
  `requester-unreachable` rows;
- `artifact` refusals: `artifact-invalid` (floors) · `verification-url-not-allowed` ·
  `assist-not-ready` · `assist-ended`.

Every refusal, wait, and state change is a row in the peer's assist audit (metadata only) and is
returned to the requester, whose episode records it as an event and continues its existing
retry / breaker ladder (§Self-Heal). A refusal for a screen-capture failure does not exist: the
helper needs no screen (§Findings folded in).

## Decision points touched

| Decision point | Classification | Floor / justification |
|---|---|---|
| Which machine runs the browser step | `invariant` | Platform + `navigation` value, resolved by `resolveReloginNavigation`; never inferred from load or reachability. |
| Which peer serves | `invariant` | Deterministic rule in §5 over live `can-serve` answers (`canServe` + `openAssists ≤ 3` + `lastVerifiedAt`); zero ⇒ `no-browser-peer`, never a guess. |
| Peer admission of a browser-assist request | `invariant` | The ordered typed refusals / waits above; issuer-signed grant verified against the registry key, issuer ≠ sender, target = verified sender; deny-by-default; v1 refuses grant-less requests. |
| Approving a `peer-browser` episode | `invariant` | Only a PIN tap on a machine other than the requester; all three requester-side approval entry points refuse. |
| Getting through the sign-in pages (on the peer) | `judgment-candidate` | Unchanged from `skill-driven-signin-repair`: **floor** = the four hard lines, per-keystroke focus check, session cap, one helper per machine, server-only success, plus the artifact field floors and the origin-exact entry-URL check; **arbiter** = the REQUESTER's `verifyIdentity` + authenticated call; **default** = stop and hand off; **ladder** = operator-only → phone Sign-in cell. |
| Episode success | `invariant` | Requester-only: pending-login completion, `verifyIdentity === 'match'`, authenticated use. A peer's `ended` state is never an input. |
| Accepting a code from the poll | `invariant` | Recorded `assistId` + the assist in `driving` / `code-held` + unseals under the requester's key + shape valid (existing paste-back validator) + one writer (`pasteCode` settles the drive; `finishCli` types); the peer holds exactly one code per assist, so there is no duplicate to arbitrate. |
| Approval on this path | `invariant` | Forced to `approval` until graduation, whatever `mode` says; post-graduation unattended needs the peer's `(identity, requester)` pair list. |
| Breaker | `invariant` | The existing `isBreakerOpen` (3 failed/refused episodes since the last success in 24 h, or one security-class failure) is unchanged; waits and `waiting-operator-only` exits produce no failed episode; peer-REPORTED tokens map to `transient` (helper ended without a code) or `failed` with `peer-reported-<token>` and count only toward the 3-in-24h rule, never the security row — only the requester's OWN `verifyIdentity` can produce `wrong-identity`. |

## Multi-machine posture

- **Requester episode (incl. `navigation`, `assistId`, `peerMachineId`, `forwardableGrant`,
  `lastPeerAssistEvent`), CLI pane, config home, minted credential.**
  `machine-local-justification: physical-credential-locality`. The login is minted into this
  machine's disk; the episode describes and mutates that credential. Unchanged from
  `assisted-subscription-relogin` §13. The retained grant is a signed public artifact, not a
  secret; it is excluded from backup with the rest of `state/subscription-relogin` (already
  backup-excluded), stripped from pool projections, and a restore can never resurrect it as a live
  approval because the consume tombstone and the 15-minute expiry bound it.
- **Peer helper session, Chrome window, profile directory, seat lease, assist rows, the
  in-memory code.** `machine-local-justification: physical-credential-locality`. The Google
  session lives in the profile's cookies on the peer's disk (Chrome app-bound cookie encryption
  makes it non-relocatable; `agent-driven-relogin` names the same). Assist rows
  (`relogin_browser_assists` in the peer's `repairs.db`: assistId, episodeId, requesterMachineId,
  accountId, grant digest, state, endedReason, position, lastPolledAt, createdAt, endedAt; UNIQUE
  partial indexes on open `(requesterMachineId, episodeId)` and open `(accountId)`) exist only to
  make the peer's single-open-assist, rate-limit and queue guarantees durable across a peer
  restart; metadata only, never a code; `prune()` / `enforceCaps()` are extended to this table
  (today they delete only episodes / events) and delete ENDED rows only, with the same 2000-row /
  180-day retention.
- **Peer selection.** Proxied-on-read: a live fan-out to online peers' `can-serve`; no replicated
  projection is introduced.
- **Episode rows, dashboard cell, notices.** Episode rows are per machine and pool-readable
  (`?scope=pool`). The episode SUMMARY the pool read and the dashboard consume gains `navigation`
  and `lastPeerAssistEvent { token, peerMachineId }` (today `dashboard/subscriptions.js` derives
  cell text from `repair.state` alone and the pool read returns episodes, not events). The matrix
  cell for (account × requester) renders the tokens `peer-browser-assist-queued` / `-started` /
  `-ended:<reason>` and the fronting-machine test as fixed plain sentences ("Approved — may run up
  to an hour from now while other sign-ins finish", "Waiting for <peer nickname>'s browser",
  "Browser step running on <peer nickname>", "<peer nickname> could not help: <fixed sentence per
  closed reason>", "Approve this sign-in from the dashboard on one of your other machines") —
  never a raw token (B2). Every operator notice is sent from the REQUESTER (the episode owner)
  only — one voice; the peer emits no operator notice for an assist.
- **Single machine.** No coordinator ⇒ the machine router does not exist and `can-serve` resolves
  to nobody; `peer-browser` then ends `no-browser-peer` and the phone Sign-in cell — the same
  operator-only outcome as today. Single-machine is a supported mode, not an exception.

## Self-Heal Before Notify

This spec adds no new watcher. The existing relogin scanner + episode IS the self-heal; this spec
extends its remediation with a delegated step. The declaration below is the existing episode
declaration (`assisted-subscription-relogin` §17) with the delegated actions added:

- `remediation-actions`: select a browser peer (live read, depth-aware); admit and wait in the
  peer's queue (pre-attempt, no budget spent, polling for liveness); on a typed peer refusal,
  re-select among the remaining `canServe` peers once (`peer-refused` verdict); on
  `peer-identity-divergent`, cancel, exclude that peer, re-select; poll the assist (3 missed polls
  ⇒ `peer-lost`: re-select while queued/ready, `transient` while driving); re-observe the CLI
  attempt; refresh an expired public artifact and re-post it to the same assist (kill + respawn
  under the same `assistId`, inside the `maxReissues` cap of 2); on `grant-expired` or an expired
  approval window, end `waiting-operator-only` (one re-tap, no failed row); re-poll identity and
  authenticated use; idempotently finalize pool / ledger state; on episode exit, and on every tick
  for ANY episode state that carries a recorded open `assistId` (a NEW idempotent step — the
  existing `recoverUncertain` covers only `browser-driving` / `cli-finishing`), poll the assist
  once: if a code is held and the pane is at the prompt, complete; otherwise cancel. A requester
  restart longer than 90 s finds its assist ended `requester-unreachable`; the idempotent re-POST
  then re-admits a fresh row at the back (it counts toward the per-cell cap).
- `max-attempts`: 3 per episode (existing); at most 2 browser-assist admissions per attempt (the
  first peer + one re-selection); at most 3 fresh admissions per `(requester, accountId)` per peer
  per 24 h.
- `max-wall-clock`: see §Timeline (10-min attempt, 60-min approval window, 60-min queue, 2-min
  ready, driving cap, 90-s unreachable).
- `backoff`: existing capped exponential (5 / 10 / 20 s) between attempts; polls 30 s / 5 s,
  coalesced; one anti-replay retry per poll.
- `dedupe-key`: `(accountId, requesterMachineId)` — one live episode per cell (existing UNIQUE
  index); `(requesterMachineId, episodeId)` and `(peerMachineId, accountId)` — one open assist each.
- `breaker`: the existing durable per-account breaker (`isBreakerOpen`) — the flapping backstop
  this path rides; unchanged. Waits and `waiting-operator-only` exits produce no failed episode; a
  budget-exhausted attempt produces a failed episode that counts like any other; peer-reported
  tokens never reach the security row.
- `max-notification-latency`: `300s` (the constitutional ceiling
  `standards.selfHealBeforeNotify.recoverableLatencyCeiling` = 300 s): the approval request is
  emitted on candidate admission (before any delegation); every assist state change updates the
  requester's episode events and the matrix cell within one service tick (30 s); a phone-tap or
  macOS-permission challenge is read within 5 s while driving and notified immediately on its
  durable transition. The TERMINAL notice (succeeded / operator-only) is bounded separately: ≤ 60
  min approval window + 10 min attempt.
- `audit-location`: the requester's `state/subscription-relogin/repairs.db` (existing,
  metadata-only, excluded from backup / viewing / replication) plus the peer's
  `relogin_browser_assists` rows in the same store family; reason tokens only, never a URL with a
  code, never a code; at most one audit row per dropped duplicate challenge per assist.
- `class`: the requester's OWN `wrong-identity`, `unexpected-origin`, `permission-expansion`
  (produced only by its own arbiter / driver) are **security** class — escalated immediately AND
  healed concurrently (the assist is cancelled) — as today. On the PEER, `grant-invalid` (a bad
  signature / self-issued / wrong target from a paired machine) and `assist-not-yours` are
  security-class audit rows on the peer and a `peer-refused` verdict on the requester. Everything
  the peer REPORTS (`hard-line:*`, `helper-exited`, `assist-cap`, `peer-restarted`,
  `requester-unreachable`), plus `grant-expired`, `peer-lost`, `peer-identity-divergent`,
  `peer-protocol-error` (including a `position` that increases other than after
  `peer-restarted`), waits and provider hiccups, is `recoverable` inside the bounds above.

## Verify the state, not its symbol (P20)

- **`canServe: true` + `openAssists` from a peer.** Claimed state: this peer holds a unique,
  present profile for the account and has queue room. Corroboration: admission re-runs the same
  checks (and `queue-deep` refuses a stale count) and the helper actually spawns (`isAlive` inside
  the start grace) after `ready`; the FINAL corroboration of "can complete the browser step" is
  the requester's own success arbiter — a `canServe` is a candidate signal, never proof of
  completion. Unmeasurable (timeout / non-JSON): `false`, never a candidate.
- **`position` / `queued`.** Claimed state: the assist is held and will be served in order.
  Corroboration: the 30-s poll keeps returning the row with a non-increasing position; the peer's
  `lastPolledAt` proves the requester is alive to the peer. Unmeasurable (3 missed polls):
  `peer-lost`, re-select — never "still queued". An increasing position is `peer-protocol-error`.
- **`ready` / `driving` / `code-held`.** Claimed state: the seat is free / the helper is driving /
  a code is waiting. Corroboration: the requester's own artifact POST is accepted (`ready`); the
  poll keeps answering with the helper alive on the peer (`isAlive`) or with a sealed code that
  unseals under the requester's key. Unmeasurable: `peer-lost`, transient.
- **A sealed code in the poll response.** Claimed state: the provider issued it for THIS CLI's
  request. Corroboration: it unseals under the requester's key with AAD = this `assistId`, the
  requester's paste-back completes, and `verifyIdentity === 'match'` — PKCE binds the code to the
  requester's own verifier, so a code minted for any other request cannot complete this login.
  Unmeasurable: `ClaudePasteBackController.finish` reports the pane is not at the code prompt ⇒
  the attempt ends `uncertain-external-outcome`, never success.
- **`ended: succeeded-from-peer-view`.** Claimed state: nothing — informational. The requester's
  arbiter is the only success input; a "succeeded" assist with no credential landing ends the
  attempt `transient` and, when the attempts are spent, `failed`.
- **`identityHash` from the peer.** Claimed state: the peer will drive the same email the
  requester expects. Corroboration: it must equal the requester's own hash BEFORE any login
  starts; the final identity is still the requester's `verifyIdentity`. Unmeasurable (absent):
  `peer-protocol-error`, refuse to start.
- **The CLI reports "logged in" on the requester.** Claimed state: usable account. Corroboration:
  the poller's authenticated read (Codex: live app-server only). Unmeasurable: `unknown`, no fresh
  `active` (the ledger's existing corroboration rule; the 2026-09-27 run caught exactly this — a
  Codex account read `active` while signed out).
- **Mesh peer "online".** Claimed state: reachable for a delegated step. Corroboration: the
  `can-serve` answer itself. A registry `online` flag with no answer is not a candidate.

## Maturation plan

- **test-agent-live:** Rung 1. Two real server processes on ONE Mac (a throwaway requester agent
  home configured with `navigation: peer-browser` and platform forced non-darwin through the
  resolver's `platform` parameter; a throwaway peer agent home holding a fixture Google profile),
  paired through the real machine-identity handshake, with a throwaway THIRD home acting as the
  approving dashboard. The peer's real helper drives local fixture sign-in pages in real Chrome;
  the requester's real episode pastes the polled code into a real fixture login pane and its
  arbiter decides. Fixtures cover: a first-run window, a blocked popup, a CAPTCHA page (helper
  stops; requester ends operator-only), a wrong-account chooser (helper stops), a tap on the
  requester's own grid (`approve-from-another-dashboard` on all three entry points), a
  self-issued grant (`grant-invalid:self-issued`), a tampered / wrong-target grant
  (`grant-invalid`), an expired grant on re-admission (`grant-expired` → one re-tap, no failed
  row), an unpaired requester (refused before policy), a body/path id mismatch, an entry URL on
  `accounts.google.com` and an over-long / control-character artifact (`artifact-invalid`),
  divergent pool emails (`peer-identity-divergent`), a LAN-rope poll whose sealed code cannot be
  read on the wire, `queue-deep` at depth 4 (no row), `account-assist-open`, two requesters queued
  on one peer (second waits at `position 1`, no attempt spent, starts when the first ends), a
  `ready` assist with no artifact (`artifact-timeout`, next promoted), a requester that stops
  polling (`requester-unreachable`), a helper that posts the code and exits before the next poll
  (`code-held` survives until ack), a wrong ack hash (`409`, code retained), a peer that dies
  mid-assist (`peer-lost` then a `transient` retry within budget), a requester that restarts
  mid-assist (the tick's assist step completes a held code or cancels) and while queued
  (idempotent re-POST returns the same assist), a peer reporting `hard-line:wrong-identity`
  (requester records `peer-reported-wrong-identity`, breaker's security row untouched), a reissued
  login while driving (respawn under the same assist, held code cleared), an anti-replay 403
  retried once, a de-paired 403 ending `peer-refused`, a Codex device-code assist completing through
  the requester's `credentialReady`. No real account is touched.
- **dev-agent-live:** Rung 2. Echo's Mama PC as requester, Mac Studio as peer, Laptop (or the
  Studio itself) as the approving dashboard, approval forced, the operator watching the matrix
  cell. Both Claude and Codex accounts. Evidence counts only from a RELEASED build, never a
  hotfixed shadow install.
- **fleet:** Rung 3. Every other agent keeps today's value until graduation. Graduation is ONE
  explicit release that changes one resolver constant so that `navigation` omitted on a
  non-darwin machine resolves `peer-browser` fleet-wide (today: `closed` on the fleet), and lifts
  the forced-approval clamp so `mode: unattended` can apply under the pair list. That release is
  the run boundary; nothing in this spec flips it.
- **graduation criterion:** at least 5 delegated repairs verified by the requester's
  `verifyIdentity` + authenticated use, covering both providers and at least 2 requester/peer
  pairs, with zero `wrong-identity` and zero security-class events on this path.
- **dark-window:** at least 14 days on development agents only; any security-class event on this
  path resets it.

## Findings folded in from the hand run (2026-09-27)

- **Pop-ups.** Before spawning the helper, the peer's assist driver performs the idempotent JSON
  edit of the profile's `Default/Preferences`: `browser.allow_javascript_apple_events: true` and
  `profile.content_settings.exceptions.popups` entries (`setting: 1`) for `claude.ai`,
  `claude.com`, `auth.openai.com`, `chatgpt.com`, `accounts.google.com`. Server code does the
  edit; the skill only names it. Without the pop-up exceptions "Continue with Google" fails with
  "There was an error logging you in".
- **Authorize enables without a mouse.** `focus` on the window plus `pointerdown` / `pointerup` /
  `pointermove` / `mouseover` on the body and the button, re-checked every 3 s. No OS input, no
  screen access, so a locked peer screen is NOT a blocker — and a failed screenshot proves nothing.
  The false-blocker lesson from the run is written into the skill and into §Peer admission: no
  refusal reason exists for a screen-capture failure.
- **First launch after a Preferences edit may expose no scriptable window** (Apple Event `-1719`).
  The helper relaunches once; the peer counts it inside the assist, not as a refusal.
- **Expected email must ride the episode.** A plain enroll completes but HOLDS the pool-add; the
  delegated path runs inside the episode, and the peer binds the email from its own pool record
  (§6).
- **Codex workspace picker.** An account in more than one workspace may land on "Select a
  workspace" with a pre-selected workspace that forbids device-code sign-in. The requester reads
  `tokens.account_id` from its OWN existing `<configHome>/auth.json` at episode start (the
  expired credential still carries it) and sends it as `workspaceHint` (an opaque id); the helper
  picks the workspace whose id matches; with no hint, or a hint matching no listed workspace, it
  stops (`hard-line:unexpected-page`) rather than guess.
- **Trust `active` never.** Verification on the requester is a live check, and the operator-facing
  cell compares against the pool-wide list, not the requester's own.

## Frontloaded Decisions

1. **Scope.** Repair episodes only (an account the requester already has, whose login expired).
   Enrolling an account that is NEW to a browserless machine (the matrix **Set up** cell,
   `follow-me/enroll/start`) is the next increment: it reuses `browser-assist` unchanged with the
   enroll-start pending login as the source; it is NOT built here so the first ship stays one
   navigation value + one peer driver + one pull-only protocol. Owner: Echo; tracked under
   CMT-609, with its own commitment opened the day this spec is approved (P10 — a deferral carries
   an owner and a date, never a bare "next").
2. **Mandate shape: reuse `account-follow-me` re-mint, no new action; issuer ≠ requester**
   (§Authorization). `repair-cell` always packages for a `peer-browser` target; the requester
   retains the packaged copy as `forwardableGrant`; all three requester-side approval entry points
   refuse `peer-browser` episodes (`approve-from-another-dashboard`); the peer verifies on a NEW
   acceptance path (registry key, issuer ≠ sender, target = sender, unexpired on the peer's clock);
   consent is bound to admission; one OPEN assist per `(requester, episodeId)` and per
   `(peer, accountId)`; 3 fresh admissions per `(requester, accountId)` per peer per 24 h.
3. **Unattended delegation is refused in v1.** Post-graduation it requires the peer's own
   PIN-configured `assistedRelogin.browserAssist.unattendedRequesters: [{ identity,
   requesterMachineId }]` — never the peer's `unattendedPolicy.identities`; ignored with one boot
   warning in v1.
4. **Peer selection = live `can-serve` fan-out (with `openAssists`); deterministic tie-break;
   zero ⇒ `no-browser-peer`.** Parallel, 5 s per peer, 8 s total, one fan-out per requester per
   tick; admission POST 10 s with `maxPosition: 3`; polls per §Timeline, coalesced, serialized per
   peer; admit only when `openAssists ≤ 3`, else a requester-side wait. No new replicated
   projection, no capability-registry kind. Cheap-to-change-after: the tie-break ORDER only (ships
   behind the dev-agent gate with approval forced and changes no interface — whichever peer serves,
   the same email is driven and the same arbiter decides); the rule that selection is
   read-not-guessed is not.
5. **Transport = the existing machine-identity envelope** (`machineAuthMiddleware`, applied per
   route inside `createMachineRoutes` under `/api/subscription-relogin/…`, bound to the relogin
   runtime through a `browserAssist` port on `MachineRouteContext`); ids come from the verified
   envelope; signed bodies echo the path ids; responses echo `assistId`; the artifact and the
   code are SEALED to the receiving machine's X25519 key with the secret-sync sealing primitive,
   AAD = `assistId`; PULL-ONLY (no route on the requester). Not the Bearer-only relay hop, not
   Threadline, not chat. Request budget per §3, accepted.
6. **No new periodic expiry check.** The existing per-machine scanner (pool poll `loginCheck` +
   the ledger's corroboration floor) already detects an expired login on every platform; the Mama
   PC went unnoticed for two days because its episodes had no path, not because nothing looked.
   This spec gives them a path. Honest scope: on a machine where `assistedRelogin` itself is dark,
   nothing here turns it on.
7. **Codex device code rides the sealed `artifact` as `userCode`** (public, short-lived, already
   surfaced by `pending-logins`) with an optional `workspaceHint` read from the requester's own
   `auth.json`; the peer types it; completion is the requester's `credentialReady` poll; no return
   message.
8. **Code hand-off is a read, not a push.** The peer's loopback code route (the existing
   `/subscription-relogin/:episodeId/code` shape, keyed by a per-ASSIST token) seals the code to
   the requester's key, stores it in memory, moves the assist to `code-held`, and answers the
   helper `202`; the requester's next poll carries it; the requester acks with the hash and the
   peer forgets it and ends the assist; a never-acked code is dropped at `requester-unreachable`
   or the driving cap. A respawn (reissued artifact) clears any held code. A peer that restarts
   mid-assist marks its open assists `peer-restarted` at boot (its helper, if still alive, is
   killed by the existing `killOrphans` pass) and the requester reads that on its next poll.
9. **Config + gating + migration parity.**
   - Requester: `subscriptionPool.assistedRelogin.navigation: 'peer-browser'` (new value, read at
     episode start, no restart). `migrateConfig` adds NO default — omitted is meaningful (the
     dev-agent gate decides).
   - Peer: `assistedRelogin.browserAssist.serve: true | false | omitted` — the routes answer 503
     `serve-disabled` unless the peer's own `assistedRelogin.enabled === true` AND `serve`
     resolves on (omitted ⇒ the dev-agent gate: on for a development agent, dark on the fleet;
     explicit `false` is a kill switch). A fleet Mac never serves a requester by accident. No
     coordinator ⇒ 404 (the router is absent).
   - CLAUDE.md template (`generateClaudeMd()` in `src/scaffold/templates.ts`): one bullet in the
     existing subscription sign-in paragraph naming `peer-browser`, what it does, and the rollback,
     plus `migrateClaudeMd()` doing BOTH an append-if-missing of that bullet AND a targeted
     in-place replacement of the THREE deployed phrases that become false ("Omitted ⇒ agent on a
     development agent", "the existing driver elsewhere", and "Other platforms keep the automated
     browser until a normal-browser path exists there … Boot log shows `browser: normal`"), the way
     the sibling migration already patches text in place (Agent Awareness + Migration Parity §3).
   - Built-in skill `/subscription-signin`: one `###` marker-headed paragraph inserted by an
     idempotent `PostUpdateMigrator` migration that runs AFTER the existing agent-run skill
     migration and anchors before the `## 4. When a repair does not finish` heading, slicing the
     shipped skill content by that marker; a customized skill copy is skipped, as that migration
     path already does.
   - Rollback: requester sets `navigation` back to `agent-session` / `agent` / `closed`; peer sets
     `browserAssist.serve: false`; open assists end at the next tick on either side (`cancelled` /
     `serve-disabled`, which the requester ends on first read); the assist rows are inert metadata
     and age out.
10. **Dashboard.** No new tab, no new button: **Repair sign-in** / **Try repair again** / **Cancel
    repair** already relay by mandate. The episode summary gains `navigation` and
    `lastPeerAssistEvent`; the (account × machine) matrix cell renders the closed token set and the
    fronting-machine test as fixed plain sentences (§Multi-machine posture), including the
    "may run up to an hour from now" line on approval.
11. **Helper model on the peer.** The default model for the helper account's framework, unchanged
    from `skill-driven-signin-repair` FD8; the helper account is always a subscription-pool account
    on the peer (never a metered door), which is why this is cheap-to-change-after (dev-gated, no
    interface, no spend class change).
12. **Runtime proof.** No "existing relogin canary" exists; the claim in the first draft was wrong.
    Proof is (a) the Rung-1 two-process E2E in CI, (b) the Rung-2 ledger rows on Echo's machines
    from a RELEASED build (`succeeded` episodes with `navigation: peer-browser`, read from the
    ledger — never an `active` label, never a hand run), and (c) a NEW recurring real-path
    synthetic canary job template at
    `src/scaffold/templates/jobs/instar/relogin-peer-browser-canary.md` (front matter `enabled:
    false`, `supervision: tier1`, cron `0 4 * * *`, `perMachineIndependent: true`; development-agent
    only through the same in-prompt presence gate `doorway-scan.md` uses) that runs the Rung-1
    fixture repair between two local processes and raises ONE HIGH attention item
    (`relogin-peer-browser-canary`) on a contract failure (Runtime End-to-End Proof).
13. **Entry-URL allowlist + artifact field floors are new deterministic checks** at `artifact`
    admission and, as a foundation fix, before the LOCAL helper spawn: `https:`, no userinfo, no
    port, origin exactly `https://claude.ai` (anthropic) or `https://auth.openai.com` (openai);
    field length / charset floors per §3. The helper's navigation floors are unchanged.
14. **Preferences edit is server code** in the peer's assist driver (and the local helper path),
    idempotent, before every spawn.
15. **Foundation fixes carried by this spec:** both hard-coded `author: 'justin'` literals
    (`repair-cell` and the matrix orchestrator route) become the verified dashboard-operator
    principal; the local helper path gains the entry-URL check and field floors (13) and the
    transcript deletion via `SafeFsExecutor` with an audit row; `identityHash` is exported from the
    runtime module.
16. **Peer driver = the helper session, not the runbook scripts** (§Alternatives), per the
    operator's standing direction that live-page work is a skill, not a fixed script.

## Alternatives considered

- **Push (peer → requester routes) instead of pull.** The first two drafts had the peer POST
  events and the code to the requester. Rejected in favour of pull: the requester already polls
  for liveness, so returning the code and the challenges in that poll deletes two inbound routes on
  the requester, the verified-sender binding, the first-code-wins arbitration, the forward-retry
  machinery, and the whole "code from the wrong sender" threat class, at a latency cost bounded by
  the 5-s driving poll. The peer holds the sealed code in memory until acked instead of "forgetting
  it after one forward" — a residual it names.
- **The runbook's deterministic scripts as the peer driver.** The 13/13 hand run WAS driven by
  `signin.sh` / `codex.sh` / `runw.js`, so this is a real alternative and it is rejected for two
  reasons: (1) the operator's standing direction (2026-09-23) that work which means reading a live
  page and reacting is an agent skill, not a fixed script — the fixed relogin driver had stopped on
  unexpected pages for weeks while an agent session signed two accounts in ten minutes; (2) the
  scripts themselves stop-instead-of-guess on any unexpected page and never automated the Codex
  workspace picker. The helper session is the shipped, converged peer driver
  (`skill-driven-signin-repair`); this spec adds the deterministic floors (field floors, entry-URL
  check) in front of it rather than swapping the driver.
- **Self-issued grants (the requester's own dashboard approves).** Rejected: the peer cannot see
  the PIN; a requester-signed grant is a claim. The cost is one UX rule — approve a delegated
  sign-in from another machine's dashboard — which the pool-wide matrix already supports.
- **A queue / workflow engine for assist lifecycle.** Rejected: the assist lifecycle is one table
  + the peer's existing 30-s tick + the existing P19 primitives (seat lease, `extendApproval`,
  breaker), which is the pattern every relogin sibling uses; Self-Heal Before Notify explicitly
  forbids introducing a new external workflow engine where those primitives suffice.
- **Replicate the profile registry / add a `browser-profile` capability kind** so the requester
  could pick a peer from a projection. Rejected: it replicates Google identities across machines to
  answer a question a live read answers, and a projection can be stale while the profile's Chrome
  is in use (the hand run hit `profile in use, skip`). Live read wins on Occam and on P20.
- **Forward the delivered mandate as-is through the existing delivery path.** Rejected: mandate
  delivery binds issuer = sender and target = self, and the requester consumes the mandate at
  approval; a forwarded copy fails both checks by construction. Hence the retained packaged copy
  and the separate peer-side acceptance path.
- **Reuse the peer's `unattendedPolicy.identities` for unattended delegation.** Rejected: it
  widens a per-machine grant into a fleet-wide one (§Authorization).
- **Restrict the protocol to encrypted ropes instead of sealing.** Rejected: the Mama PC ↔ Studio
  pair has run on the LAN rope when Tailscale was stale; sealing with an existing primitive works
  on every rope and costs one call each way.
- **A remote-controlled browser (CDP / WebDriver BiDi attached to the real profile, or a
  persistent remote-browser service).** Rejected on evidence: the providers' human checks stop
  automated browsers (Claude's Authorize and "Continue with Google" sit behind hCaptcha /
  Cloudflare holds for a CDP-attached Chrome — the 2026-09-24 finding that made the local path
  switch to a NORMAL Chrome driven by Apple Events), and a remote-browser service is a new external
  dependency holding Google sessions. Apple Events into the account's own normal Chrome is the
  only path that has passed, 13 of 13.
- **Provider-native device flow only.** Rejected: Claude Code's login is url-code-paste (no device
  flow), and Codex's device flow still needs a browser click-through in a signed-in Google session
  — the browser step does not disappear, it just types a code.
- **Run the whole episode on the Mac and ship the credential back** (Mechanism A of
  `ws52-account-follow-me-security`). Rejected there for Anthropic (ToS) and rejected here: the
  proven hand path never moved a credential, and PKCE makes the requester-minted login the natural
  unit.
- **A generic "run this browser task on a peer" verb.** Rejected: the helper's floors are
  sign-in-specific (origin allowlist, expected email, standard permission list); a generic verb
  would have to re-derive them or drop them.
- **Send the artifact in the first request (no queue).** Rejected: six accounts expiring together
  on one requester with one Mac need serialized browser steps; minting login artifacts that expire
  while queued, or spending attempts on `seat-held`, is exactly the thrash the local path avoids
  with `wait`. The queue keeps the verified authority and mints the artifact when the seat is free.

## Tests (three tiers + the live proof)

- **Unit.** `resolveReloginNavigation` picks `peer-browser` on non-darwin dev agents (replacing
  `agent`), `closed` on the fleet, honors explicit values on every platform; the runtime wiring
  test asserts `peer-browser` never constructs `AnthropicReloginBrowserDriver`; peer selection:
  unique-profile rule, ambiguity ⇒ `false`, `openAssists ≤ 3` admission, `lastVerifiedAt`
  tie-break with `null` last, zero ⇒ `no-browser-peer`; admission order, every typed refusal and
  wait (row / no-row), `position` semantics, `queue-deep`, `account-assist-open`; grant acceptance
  (registry key, issuer ≠ sender, target = sender, bound keys equal, expiry on the peer's clock,
  clock-skew refusal, one open assist per episode and per (peer, account), retry after a terminal
  assist, `grant-expired` on late re-admission ⇒ `waiting-operator-only`, no failed row);
  approval-window expiry on the peer path ⇒ `waiting-operator-only`, no failed row; sealing /
  unsealing with AAD = `assistId` both directions (wrong key or AAD ⇒ refuse); artifact field
  floors and `artifact-invalid`; code acceptance from `driving` / `code-held` (recorded assistId,
  unseals, shape; settles the drive promise; never types); `ack-hash-mismatch`; respawn clears the
  held code; verdict mapping (helper-ended-without-code ⇒ `transient`; peer-reported hard lines ⇒
  `failed` `peer-reported-*`, never the security row; `identityHash` mismatch ⇒
  `peer-identity-divergent`; missing own email ⇒ `missing-expected-email`; increasing position ⇒
  `peer-protocol-error`); entry-URL check on both paths; per-cell cap counts fresh rows only;
  queue / ready / poll / unreachable TTLs; poll coalescing, serialization, one anti-replay retry,
  de-paired 403 ⇒ `peer-refused`, 503 `serve-disabled` ends on first read; retention pruning of
  ENDED assist rows only; `forwardableGrant` stripped from pool projections; `endedReason`
  normalization to `peer-protocol-error`.
- **Integration (full HTTP pipeline).** requester → peer `can-serve` / `browser-assist` /
  `artifact` / `GET assist` / `ack` / `cancel` round trips through the real `machineAuthMiddleware`
  inside `createMachineRoutes` with the `browserAssist` port bound late (503 before binding; an
  unsigned or unpaired sender is refused before policy; a body/path id mismatch and a foreign
  sender (`assist-not-yours`) are refused); the peer's loopback code route with a per-assist token
  moving the assist to `code-held`; a reordered sequence yields one retried request, not a missed
  poll; `grant-invalid:self-issued`; `grant-invalid` on tampered bounds / wrong target;
  `grant-expired`; `unattended-not-permitted-here` on a grant-less request;
  `verification-url-not-allowed` / `artifact-invalid`; two queued requesters; `queue-deep`;
  `account-assist-open`; `ready` timeout; `requester-unreachable`; peer restart mid-assist
  (`peer-restarted` read on the next poll, helper killed by `killOrphans`); requester restart
  mid-assist (the tick's assist step completes a held code whose pane is at the prompt, else
  cancels) and while queued (idempotent re-POST); all three requester-side approval entry points
  refusing a `peer-browser` episode; the episode summary carrying `navigation` +
  `lastPeerAssistEvent`; the matrix cell rendering the closed token set and the fronting-machine
  sentence with the button hidden.
- **E2E lifecycle (feature is alive).** A requester boot with `navigation: peer-browser` wires the
  delegation path (routes answer, not 503; the CDP driver is not constructed; the boot line prints
  `browser: peer`) AND a full delegated repair completes end-to-end between two real server
  processes plus a third approving process against fixture pages, ending in the requester's
  `succeeded` with `verifyIdentity === 'match'` (the Rung-1 harness; liveness alone is not proof).
- **Runtime proof.** Frontloaded Decision 12: the dark canary job template + the Rung-2 ledger
  rows from a released build.

## Open questions

*(none)*
