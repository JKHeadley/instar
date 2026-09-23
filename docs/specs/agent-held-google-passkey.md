---
title: "Agent-Held Google Passkeys — One Human Sign-In, Then Hands-Off Repair"
slug: agent-held-google-passkey
parent-principle: "No Manual Work (user *or* agent)"
status: draft
owner: echo
author: echo
topic: 33890
depends-on:
  - assisted-subscription-relogin
  - playwright-profile-registry
  - subscription-account-email-invariant
  - cross-machine-secret-sync-spec
  - multi-machine-replicated-store-foundation
  - ws52-account-follow-me-security
lessons-engaged: [P17, P19, P20, P21, L11, L12, backup-codes-beat-google-2sv, claude-config-dir-probe-resets-config, name-credential-changes-in-reports, producer-evidence-is-not-consumer-effect]
approved: false
---

# Agent-Held Google Passkeys

## 1. Outcome and boundary

Under low-risk Google conditions, one successful human sign-in per (Google account × machine) lets an
Instar agent sign itself into that Google account from an empty browser and repair every subscription
that signs in through Google (today: Claude Code and Codex) without further operator work.

Setup around that sign-in is the operator granting the cell and tapping *Ready* when the prompt is
about to fire. Cases that still need a human, stated up front: a Workspace domain with passkey sign-in
disabled (one admin setting); a Google CAPTCHA or risk review; a second-factor prompt the agent holds
no answer for; Google throttling (waits out, then continues); a passkey the operator removed on Google
(re-enrollment).

**Provider-policy assumption.** This works because Google currently accepts credentials registered
through Chrome's DevTools virtual authenticator. Google can stop accepting them at any time without
any code fault on our side; the operator is told so when granting (§3.2), and §2 defines what the
system does if it happens.

This EXTENDS `assisted-subscription-relogin` (the parent): a new **login method** the existing repair
worker can use, plus custody, grants, enrollment, proofs and migration. Every parent guarantee
(trigger admission, unattended identity allowlist, Tier-1 supervised worker, identity-oracle veto,
authenticated-use proof, breakers) is unchanged.

Prior art: Dawn's *Agent Account Sharing Standard* (SageMindAI/the-portal
`docs/standards/agent-account-sharing.md`) and the account-free public write-up
(https://telegra.ph/Hands-Off-Sign-In-for-AI-Agents-09-22-2 — reviewed: no account identifiers).
Differences from Dawn's standard: §16.

### 1.1 What this credential is — stated honestly

- A WebAuthn key pair registered on the Google account as one more passkey, stored as **exportable
  software key material**.
- **RP-bound, not origin-bound.** Its relying-party id is `google.com`, so a look-alike domain
  cannot obtain an assertion; but ANY `*.google.com` origin could technically request one from the
  virtual authenticator. This spec therefore holds the credential in the authenticator only while
  the top-level origin is exactly `accounts.google.com` (§3.1). **Not hardware-bound**: anyone who
  obtains the decrypted key can use it from anywhere.
- A **complete Google sign-in**: whoever holds it has the whole account — mail, drive, settings,
  every "Sign in with Google" service. A leak is treated exactly like a leak of the password.
- **Accepted major risk — same-user code.** Any code running as the agent's OS user, including an
  agent session with a shell, can in principle decrypt the store, because the key-wrapping secret is
  reachable by that user. The custody rules (§3.1) stop accidental exposure through tools, sync,
  backups, logs and prompts; they are not a boundary against deliberate same-user code. A broker
  running as a separate OS user with a narrow signing API is the real fix; it is required before the
  fleet rung (§7, §17), and the grant screen names this risk explicitly.
- It adds to, and does not replace, what the agent already holds for enrollment (a live session, a
  stored password, stored 2FA answers). The grant screen inventories those; they remain (FD7).
- Proofs are real Google sign-ins; the owner may see sign-in notices. §3.8 keeps the device stable
  to minimise that.

## 2. Mechanism (measured live) and compatibility contract

1. **Virtual authenticator before navigation.** A target that may reach Google gets
   `WebAuthn.enable {enableUI:false}` + `WebAuthn.addVirtualAuthenticator {protocol:ctap2,
   transport:internal, hasResidentKey, hasUserVerification, isUserVerified,
   automaticPresenceSimulation}` before its first navigation. Without it Chrome raises the OS
   platform-authenticator sheet and the page stops processing input.
2. **Mint.** From a session signed in to account E, the worker opens Google's passkey-creation page;
   the credential lands in the virtual authenticator; `WebAuthn.getCredentials` exports it.
3. **Use.** In a fresh session, `WebAuthn.addCredential`, then Google sign-in authenticates with the
   resident credential.
4. **Reach-through.** Claude's login accepts a live Google session; Codex's web sign-in offers
   "Continue with Google".

Measured constraints: Google does not enforce the signature counter (other relying parties do), so
`signCount` is not written back — correct for Google only. An authenticated profile cannot mint a
second passkey ("You're all set!"), so the agent cannot self-propagate. Workspace domains block
passkey sign-in until the admin enables "skip password at sign-in".

**Chrome version gate.** On each machine, when the installed Chrome major version differs from the
last verified one, the server runs the local WebAuthn fixture self-test (the §8 E2E fixture, shipped
with the package) before any passkey use; the result is recorded per machine. Failure ⇒ passkey use
on that machine refuses with `passkey-chrome-unverified` and the digest (§5.2) says so; the result is
recorded per (machine, Chrome major) and re-run only on a version change or the `recheck-chrome` op. The
local fixture proves only that Chrome's virtual authenticator works, not that Google accepts it, so
the first passkey use on a newly verified major is a single proof on one cell; if it is not `ready`,
the machine returns to `passkey-chrome-unverified`.

**Pool-wide suspension.** Computed only by the serving-lease holder from peer cell state read
through the pool read path (§5.1), restrictive direction only. Triggers when, within 7 days, cells
with outcome `credential-rejected` (§3.6) — excluding only cells whose Google-side removal is
VERIFIED; pending and operator-attested cells still count — number ≥ 3 across ≥ 2 accounts AND make up ≥ 50% of proved cells. Effect: every machine of
this agent refuses passkey use with `passkey-suspended` (each machine reads the lease holder's
suspension state before passkey use; if the lease holder is unreachable it uses the last-known state
up to 24h old, then refuses passkey use entirely with `passkey-suspension-unknown` — repair falls back
to the parent's approval path, so no automated sign-in runs blind while Google may be rejecting the
mechanism). While suspended, the 7-day window is frozen, so only canaries or the operator end a
suspension. **Google-risk budget:** any `google-risk-challenge` page (CAPTCHA or risk review, §3.6) during an
automated sign-in (proof, canary or repair) pauses ALL automated passkey sign-ins on that account for
7 days — repairs fall back to the parent's approval path — and 2 such pages across the pool within 7
days (counted by the lease holder through the pool read path) trigger suspension on their own. A canary that hits one moves straight to `suspended-stopped`,
and canary eligibility excludes accounts under a risk pause. (On a single-account agent a risk page
therefore ends in `suspended-stopped` quickly; that is intended.) **Canary (not a mandate):** the suspension record
(state, step, count, next-due time, last-canaried cell) is published by the lease holder and read by
every machine through the pool read path; a new lease holder continues from it (unreadable ⇒ the last-known
state is used for up to 24h, then all passkey use refuses, as below). Each machine decides deterministically whether it runs the canary:
suspension is active, the canary is due, the count is below 5, and it owns the least-recently-
canaried granted cell (preferring `rejected` cells, falling back to any granted cell). It runs under
its own local grant; that is the only exemption from the suspension refusal. Only proofs that
actually ran count; a canary refused before sign-in rotates to the next cell at the same step.
Backoff 1→2→4→7 days; after 5 non-`ready` canaries the state is `suspended-stopped` (no more
automatic sign-ins; operator resume only). Exit: 2 consecutive `ready` canaries, or an operator resume (PIN or `resume-suspension` op). **Degraded operating mode:** while
suspended, stopped, suspension-unknown, or under a risk pause, a `google-passkey` account is repaired through an explicit,
state-driven **method override** (not a fall-through): the dedicated profile's live session first,
then the account's `priorLoginMethod` admitted under that method's own `inputDigest` and graduation
evidence, in approval mode only — never unattended. An account with no `priorLoginMethod` gets only the
live session, then a named refusal (`passkey-degraded-no-prior-method`). The override ends when the
suspension or pause ends. Method selection (including this override) runs before the passkey
admission refusals. Under a risk pause the approval request states the active pause, and a risk page
hit on the override path extends the pause and counts toward suspension. The digest lists the Google-side passkeys that
now exist but are unusable, so the operator can remove them if the suspension proves permanent. No
re-suspension
within 7 days of an exit without a fresh qualifying sample (outcomes timestamped after the exit only;
canary results do not count toward it). The 50% denominator is cells with at least
one proof in the 7-day window; unobserved peers' cells are excluded from both sides. Peer-reported
outcomes are trusted as mesh-peer data (a lying peer could trigger, delay or end a suspension; triggering is restrictive, the rest is
accepted under §1.1). If every cell refuses the canary, the step and count are kept and it retries on the next due
tick, with its own brake: after 7 consecutive days in which no canary could run, the state becomes
`suspended-stopped` and the digest shows "no eligible canary cell". Each canary is stamped with the suspension
record's version; a result from a stale version is ignored. "Pool" means this
agent's machines.

## 3. Components

### 3.1 Custody — `PasskeyCredentialStore` (new, separate file)

- **Separate encrypted file**, not the shared SecretStore: `.instar/secrets/passkeys/store.enc`,
  using the SecretStore's existing AES-GCM envelope and master-key source (no new crypto). Older
  builds only read `secrets/config.secrets.enc`, so a rollback or not-yet-updated machine cannot sync,
  list, back up or show this file. Nothing about it enters secret sync, `secret-get.mjs`,
  `SecretManager`, backup-from-config or the session boot self-knowledge block.
- **Entry key** `<emailKey>:<machineId>`, `emailKey` = HMAC-SHA-256(canonical email) under a random
  per-store key held **inside** the encrypted store. Its only purpose is to keep emails out of file
  and index names; it is pseudonymisation, not secrecy — grant rows carry the canonical email in
  plaintext. **Cross-machine messages never carry `emailKey`:** mandates and replicated rows carry the
  canonical email inside their signed envelope, and each receiver derives its own local key.
- Payload: `{credentialId, rpId, privateKey, userHandle, signCount, canonicalEmail,
  mintedOnMachineId, mintedByAgent, mintedAt, googleCreatedAt?, provenance: 'minted' |
  'legacy-adopted', quarantined, schemaVersion}`.
- **Own lock.** Every write takes a cross-process `proper-lockfile` lock on the store, re-reads under
  the lock, writes a unique temp file and renames. No other writer exists. (The separate,
  pre-existing lost-update risk in `SecretStore.write` no longer touches passkeys; tracked separately.)
- **Machine-scope guard (invariant):** `load()` returns a credential only when it is not quarantined
  AND (`mintedOnMachineId === localMachineId` OR a committed adoption record for this machine exists,
  §6). It runs before anything reaches the browser. A local machine-id change yields
  `machine-id-changed`, resolved by the operator's per-key adopt/delete choice.
- **Names-only index** at `.instar/secrets/passkeys/index.json`: `{emailKey, machineId, provenance,
  custodyState}` (no email, no key), rebuilt on every write and at boot. `GET /passkeys` and ticks
  read it. Decryption happens only inside an enrollment, proof or repair episode, once per episode.
- **Crash-safe mint.** Between export and the verified store write, the credential sits in
  `.instar/secrets/passkeys/pending/<emailKey>.enc` (same envelope). Deleted after verified read-back;
  a leftover is resumed on restart and stored **quarantined** until a cold proof returns `ready`
  (never re-minted); expires after 24h; deleted on revoke. An expired or discarded mint leaves a
  passkey registered on Google; the digest names the account, `googleCreatedAt` and the removal link.
  A crash before export leaves a registered passkey whose private key died with the browser — inert
  clutter, reported the same way when detectable from the enrollment log.
- **All deletions** (store entries, pending records, profiles) go through SafeFsExecutor.
- **Exclusions, each verified by a test:** BackupManager refuses `.instar/secrets/`; the file viewer
  never serves it; git-sync excludes it via `FileClassifier`; the working-set carrier refuses it; and
  `secrets/` is added to `DEFAULT_GITIGNORE` — for existing agents through a PostUpdateMigrator
  gitignore patch with a content-sniff guard.
- **In the browser:** the credential is added to the virtual authenticator only while a target's
  top-level origin is exactly `accounts.google.com`, per target (including auto-attached popups), and
  removed at **request time**: Fetch interception at the Request stage for every Document request,
  including each redirect hop, removes the credential before any request leaves for a non-
  `accounts.google.com` origin (`Fetch.continueRequest` is called only after `removeCredential` is
  acknowledged; an interception error or timeout fails the request closed); it is also removed as soon as a Google session exists. Fixture tests:
  navigation to a different google.com subdomain, and an `accounts.google.com` 302 redirect to one;
  both assert no assertion is possible. CDP messages that carry
  credentials are never logged or traced (tested).

### 3.2 Grants and revokes

- A grant `{canonicalEmail, machineId, grantedBy (verified principal), grantedAt, localSeq,
  googleCreatedAt?}`
  authorizes mint and load for one (account × machine) cell. No wildcard. Granting shows §1.1 and the
  provider-policy assumption, inventories the account's other stored credentials, and requires the
  operator to confirm "full Google account access, including mail and drive".
- **Authority is local.** A machine acts only on grants written on that machine by the PIN route, by
  a verified `passkey-cell` mandate (§3.3), or by a backup restore (subject to the §6 high-water
  rule). The issuing machine also keeps a local, non-secret copy of each peer grant it issued,
  including `googleCreatedAt` once the peer reports it (in the enroll result and its
  `/passkeys/pool-state` rows), so a revoke can always name the Google-side
  passkey.
- **Revoke is carried by the mandate outbox.** Revoking a peer's cell issues a `revoke` mandate naming
  the target's grant instance: `revokesGrantSeq` comes from the issuer's stored copy of the grant,
  whose `localSeq` the target returned when it acknowledged the grant; for a grant written directly on
  the target, it uses the target's own `localSeq` as reported in its `/passkeys/pool-state` rows; if that
  is unknown, the revoke covers every grant for the cell that exists when the target receives it (a
  re-grant made between issue and delivery is also revoked — restrictive, and the operator re-grants).
  No cross-machine clock comparison is used. The sender keeps it in a durable
  outbox, deduplicated per (cell, op), latest-wins, and re-delivers (per the backoff below; a peer-online event only brings the next attempt
  forward, never below the backoff floor) the SAME signed revoke (same
  principal, `issuedAt` and nonce) when the peer returns. **Revoke-only acceptance rule:** a `revoke`
  is exempt from the 15-minute expiry (it only removes authority), still checked against the
  signature, `targetMachineId == self`, the nonce ledger and `localSeq ≤ revokesGrantSeq`; no other op
  gets this exemption. The nonce ledger records two states, `received` and `applied`. A duplicate
  of a `received`-but-unapplied revoke re-runs the idempotent delete; a boot sweep finishes any revoke
  left `received`. Only an `applied` nonce (set after the read-back succeeded) answers "applied", so a
  duplicate from the outbox and the replicated copy never looks like a failure. On first acceptance the
  target also stores the cutoff it applied (the grant instances it covered); a replayed revoke, or a
  re-signed copy (which names the nonce it replaces and is deduplicated on it), applies that stored
  cutoff rather than recomputing it, so a later legitimate re-grant is never removed. Revoke nonces are kept for max(60 days, the tombstone's lifetime; 60 days on a receiver without the
  tombstone store); ledger size is proportional to operator-issued revokes; `passkeyTombstones` rows are
  retained until the target's applied ack AND Google-side removal is verified or attested, then pruned. If
  the peer has not acknowledged within 30 days or leaves the registry, the entry does not silently
  expire: the cell moves to `google-side-pending-operator` with the reason "an unreachable machine
  still holds this key", naming the passkey by `googleCreatedAt`, because only removal on Google can
  now revoke it. The signed revoke itself is also replicated through
  `passkeyTombstones` (once that store is enabled — a Rung 2 precondition; during Rung 1 the outbox is
  on the issuing machine only, an accepted residual), so any surviving machine holds a copy (re-delivery itself follows the issuer/lease-holder rule
  below) — losing the issuing machine does not lose an outstanding
  revoke (a signed revoke is safe to carry:
  it can only remove authority). The operator can also re-issue a revoke from any machine. A revoke that no longer verifies (its issuer
  was removed or rotated) is re-signed by any current issuer, carrying the original principal and
  the ORIGINAL cutoff (never re-derived at re-sign time),
  or escalates straight to `google-side-pending-operator`. If the issuing machine is gone, the lease
  holder runs the 30-day escalation from the replicated copy. Re-delivery is done by the issuer or, if the issuer is unreachable, the lease holder, with
  increasing backoff per (peer, revoke) — 1h, 6h, then daily, derived from the replicated tombstone so a
  new owner continues it — and a breaker clocked from the revoke's `issuedAt`: after 30 days without an
  applied ack the entry escalates (above) and automatic re-delivery stops, apart from one attempt when
  the peer is next observed online. It also ends on the applied ack or once Google-side removal is
  verified or attested. De-pairing a lost or stolen machine is the lost-machine path: its
  cells escalate immediately, and while any revoke is pending the digest shows the Google-side removal
  link from day 0, because whoever holds that machine can use the key until it is removed on Google.
  Cells in `google-side-pending-operator` because of a lost, stolen or unreachable machine are a
  HIGH-severity incomplete revoke: the lease holder raises ONE attention item per affected machine
  (key `passkey-incomplete-revoke:<machineId>`) listing every such cell, open until the last cell's
  removal is verified or attested; a late "applied" ack does not close it, because the key still
  exists on Google. A new lease holder upserts the same key (at most one item per machine).
- **Replicated rows are display and acceleration only.** Grant rows, revoke tombstones, health rows
  and throttle pauses replicate through the replicated-store foundation as store kinds
  `passkeyGrants`, `passkeyTombstones`, `passkeyHealth`, `passkeyPauses`, each behind
  `multiMachine.stateSync.<kind>`, registered with the dev-agent gate in
  `devGatedFeatures`/`resolveStateSyncStores` like other stores (not hard-coded `enabled:false`), and
  added to both `JOURNAL_KINDS` in `CoherenceJournal.ts` and `ReplicatedKindRegistry`, covered by
  the existing wiring ratchet. A replicated tombstone deletes a local credential on receipt only if it
  carries the signed revoke under the revoke-only acceptance rule above — a NEW, explicitly declared
  exception to the foundation's never-clobber-local rule (the nearest analogue, `TopicPinFoldView`,
  lets a tombstone clear a folded view; deleting local credential material is new, justified because
  it only ever removes a credential). Anything else is audited and ignored. While these stores are dark, the
  outbox alone carries revokes and the pool read path (§5.1) supplies state.
- **What revoke does.** Deletes the store entry, pending record, the proof profile, any enrollment or
  retry profile from an in-flight episode (the episode is cancelled first), and the profile tuple's
  passkey binding; writes a tombstone; verifies each by read-back. It stops **this agent's
  passkey path** only: the dedicated profile's live session and stored password remain (FD7), and the
  revoke result lists them.
- **Google-side removal** is irreversible and happens on a page that lists the human's own passkeys
  beside the agent's, and Google's list does not expose a stable per-entry identifier the agent can
  match with certainty. So the operator removes it — the floor is one tap-level action, not hands-on
  work: the digest and revoke result give a direct link to Google's passkey page plus the entry's
  `googleCreatedAt`. It is a short manual step (find the entry by date; Google may ask the operator to
  sign in again). The agent never deletes anything on Google's pages. The cell stays
  `google-side-pending-operator` until either (a) a read-only check of Google's passkey list, under the same `authuser` pin and identity read as
  enrollment,
  (`google-passkey-list` class, from the dedicated profile's live session, no actions) is
  positively classified, still shows every OTHER entry from the pre-creation snapshot, and no longer
  shows the one matching the stored `googleCreatedAt` ⇒ `google-side-removed-verified`, or (b) the
  operator taps "I removed it on Google" and the check cannot run — including when
  `googleCreatedAt` is absent (legacy keys) or ambiguous (two passkeys with the same timestamp) ⇒
  `google-side-operator-attested`, never displayed as "removed". While a revoke is pending, the
  peer's grant row displays `revoke-pending`. If other cells share the same `credentialId` (legacy-shared keys),
  the revoke notice lists every machine and agent that stops working when it is removed on Google.

### 3.3 The `passkey-cell` mandate

- A new mandate type, separate from `account-follow-me`. Ops (identical to the PIN route names):
  `grant | revoke | enroll | prove | adopt | delete-legacy | revert-method | attest-google-removed |
  resume-suspension | issuer-add | issuer-remove | exclude-peer | include-peer | recheck-chrome`.
- **Signing** uses the WS5.2 Ed25519 issuance key of the machine where the dashboard PIN was
  verified; the signed body carries the verified principal, canonical email, `targetMachineId`, op,
  op arguments, `issuedAt`, nonce and expiry (15 minutes, ±2 minutes skew; revokes per §3.2).
- **Acceptance is new code** beyond WS5.2 (which trusts any registered peer and keeps no nonce
  ledger): the receiver keeps an **expected-issuer set** in `state/passkey-issuers.json`, listing
  machines on which the operator has verified the dashboard PIN. A machine's first local PIN check adds
  itself; other changes travel as `issuer-add` / `issuer-remove` ops signed by an existing issuer.
  **Bootstrap:** there is no trust-on-first-use. On a multi-machine agent, a machine refuses its first
  grant until its peer issuers are confirmed, and a revoke refused because its issuer is not trusted appears
  on that machine's own dashboard as "unconfirmed revoke request: apply here with your PIN, or dismiss";
  it escalates to `google-side-pending-operator` only if the operator applies it and it cannot complete.
  "Peer issuers" means the registered peers that are online, with dark peers handled through
  `exclude-peer`; a machine that has grants but no confirmed peer issuer gets a digest line. A receiver adds a peer as an issuer only when the
  operator confirms it from the receiver's OWN dashboard with its PIN (reachable from a phone through
  that machine's tunnel), which the receiver verifies itself — a locally entered PIN only, never an authentication vouched for
  by another machine (such as a proxied link assertion); the screen shows the peer's name and key
  fingerprint from the receiver's own paired-machine registry, never peer-supplied text. This is a one-time step per machine,
  done together with that machine's first enrollment, and is shown to the operator as part of the
  per-machine setup cost (§12). After bootstrap, existing issuers can add or remove others with signed
  ops. The asserted principal inside any
  mandate is vouched for by the issuing machine (inherited from WS5.2); a compromised issuer falls
  under the accepted same-user risk (§1.1). These conditions are checked when each mandate is verified (not by
  listening for events, which the existing components do not emit): an issuer whose machine identity is
  `revoked` is refused and lazily removed from the set; one with a `pending` identity-recovery
  quarantine, or whose registry status is `missing` or `unreadable`, is refused (fail closed) but not
  removed. (While identity re-announce is dark, `revoked` is the only removal signal.) De-pairing is represented by the identity's `revoked` status; wiring the currently unused
  `PairingEpochManager.rotateOnDepair()` into the de-pair flow (called by the machine that stays, after
  `revokeMachine()`) is code this spec builds; it serves sealed-credential invalidation, not issuer
  membership. A newly paired machine is not an issuer until added. The receiver records the nonce in a durable ledger
  before acting and prunes entries older than expiry plus skew (revoke nonces per §3.2).
- Transport: the existing mesh-authenticated peer channel; the signature is the authority.
- Received at its own route, `POST /passkeys/cell-action`. The follow-me consumer ignores
  `passkey-cell` mandates and this route refuses `account-follow-me` mandates. Tests: both
  directions, a mandate signed by a non-operator peer, a replayed nonce, an expired mandate.
- The dashboard PIN never crosses the mesh.

### 3.4 Login method `google-passkey` and the code it touches

- `PlaywrightLoginMethod` gains `'google-passkey'`; `vaultBindings` gains a `passkey` role holding the
  store entry key, validated by `PasskeyCredentialStore.has()`. The account row keeps ONE
  `loginMethod`; enrollment records the replaced one in `priorLoginMethod`.
- Named code changes, each with a test through the runtime:
  - `SUPPORTED_LOGIN_METHODS` (`SubscriptionReloginPolicy.ts`);
  - `autonomousLoginMethod()` (`SubscriptionReloginRuntime.ts`);
  - the driver request's `loginMethod` union (`AnthropicReloginBrowserDriver.ts`);
  - **graduation evidence** — `store.getUnattendedEvidence(accountId, machineId, provider, framework)`
    gains `loginMethod` (an `ALTER TABLE repair_episodes ADD COLUMN loginMethod` migration guarded by a
    `PRAGMA table_info` check in a module-level `ensure…Columns(db)` helper run right after the schema
    (the pattern `InboundDeliveryStore` uses), with `getUnattendedEvidence` adding `AND loginMethod = ?`, since `CREATE TABLE IF NOT
    EXISTS` never adds columns; tested on an existing database); existing
    rows (no method) do not count toward `google-passkey`; evidence resets when the method changes;
  - the admission `inputDigest` includes `loginMethod` and the passkey entry key, so an approval for
    the password path cannot authorize the passkey path;
  - **admission refusals**, evaluated in the pure policy (the cell's passkey state is added to the
    policy input, so `revalidate` at approve and retry sees them) and again before `load()`: `passkey-cell-security`, `passkey-cell-breaker-open`,
    `passkey-cell-unverified-stopped`, `passkey-suspended`, `passkey-chrome-unverified`,
    `passkey-cell-quarantined`, `passkey-cell-rejected`. (`passkey-pool-state-unavailable` applies only
    to enrollment and proofs, never to repair.)
- In the repair path, `readSignedInIdentityMatches(E)` runs right after Google sign-in, before any
  provider page; a mismatch sets the cell to `security` and refuses. If the parent's identity oracle
  later disagrees with a cell's last `ready`, the cell moves to `security` and that `ready` is void.
- **No fall-through** to another method on failure (except the §2 degraded-mode override, which is
  state-driven and approval-only); a named refusal instead. The dedicated profile's
  live session is tried first, as today.
- **Rollback:** an older build refuses repair for a `google-passkey` account
  (`login-method-not-autonomous`) — safe. `POST /passkeys/revert-method` (PIN or mandate) restores
  `priorLoginMethod`; accounts without one are left unchanged and listed as `no-prior-method`.
- Repair-worker origin additions: `accounts.google.com` only.

### 3.5 Browser foundation changes (`ChromeCdpReloginBrowser` + `ReloginBrowserPort`)

- Every session that can hold or export a passkey — enrollment, proof and passkey repair — uses
  `--remote-debugging-pipe` (stdio fds 3/4) instead of a TCP port and `/json/new`, and launches with
  `--disable-extensions`.
- Every target is created at `about:blank`; the authenticator is attached; then it navigates.
  `Target.setAutoAttach {autoAttach:true, waitForDebuggerOnStart:true, flatten:true}` pauses popups
  until attached. A test fails if a Google navigation precedes the attach.
- Port additions: `attachAuthenticator()`, `addCredential()`, `removeCredential()` (per target),
  `observedAssertion(credentialId): boolean` (from `WebAuthn.credentialAsserted`), and
  `readSignedInIdentityMatches(expected): boolean` — the email is compared inside the port and never
  leaves it (not logged, snapshotted or sent to the supervisor).
- **Real input clicks** (`Input.dispatchMouseEvent` at the element box) replace `element.click()` for
  Google list items, including the existing `chooseExpectedAccount` and `click('google')` paths.

### 3.6 Closed page classes

New: `google-passkey-challenge`, `google-passkey-create`, `google-passkey-create-confirm`,
`google-already-enrolled`, `google-passkey-throttled`, `google-workspace-policy-blocked`,
`google-credential-not-recognized`, `google-account-identity`, `google-passkey-list` (read-only),
`google-totp-entry`, `google-backup-code-entry`, `google-risk-challenge` (CAPTCHA or risk review). Each matches on structural predicates (exact origin,
path, element roles/stable ids), is evaluated BEFORE the parent's text-regex chain, and has a redacted
fixture proving that ordering. Unmatched ⇒ `unknown`.

Outcome mapping: `credential-rejected` = `google-credential-not-recognized` (the identity was never
reached); `failed` = reached Google's sign-in, did not sign in, no rejection page; `security` =
signed in as a DIFFERENT account (custody is corrupt); `unknown` = transport error, outage, unmatched
page, throttled. For a cell whose Google-side removal is pending or attested, `credential-rejected`
is recorded as `removed-on-google` and never counts toward suspension.

**Credential-affecting actions have a structural floor:** "Create a passkey", the create-confirm
button and credential or code submission appear in the supervisor's
`allowedActions` ONLY on an exact structural class match — the same shape as the parent driver, where
structure computes the allowed list and the Tier-1 supervisor chooses from it. The supervisor must
still choose the action and may decline it; it can never add one. Why keep the supervisor at all:
Google reorders interstitials and varies labels without a stable versioned DOM, so a pure selector
state machine would refuse too often; the supervisor only maps redacted closed state onto the
structurally computed allowed list, and its only extra power over a deterministic machine is to
decline — which is the safe direction. (Keeping the floor structural is a
security requirement: the supervisor must not be able to cause a credential action on its own.)

### 3.7 Guided enrollment (the one human action)

`POST /passkeys/enroll {email}` (PIN) or the `enroll` mandate op. Preconditions: a grant for the
cell; a registered dedicated profile for E; a display-capable machine (the parent's
browser-availability predicate); a passing Chrome version gate; no enrollment or repair episode owning
the cell.

- **One episode per cell, idempotent**; a leftover pending record resumes at "store" (quarantined).
- **Rate limit:** one attempt per cell per 30 minutes and 3 per account per day **pool-wide**. Before
  acting, a machine reads every peer's attempt rows through the pool read path (§5.1); if any peer is
  unobserved on a multi-machine agent, enrollment and proofs refuse (`passkey-pool-state-unavailable`).
  Residual, stated honestly: two machines checking at the same instant can both proceed, so the worst
  case is 3 × machine-count per day; enrollment is operator-initiated, which bounds it further. A
  fresh-profile retry or an already-enrolled retry is part of the same attempt. Real repairs, watcher
  proofs and canaries are counted toward the daily figure but never refused by it. Rows older than
  24h are pruned.
- **Account pinning:** Google's account index (`authuser`) is pinned for creation and identity reading.
- **Closed action set:** navigate to allowlisted pages; fill email; fill the bound password (the grant
  covers methods already bound to the tuple); submit a stored TOTP code; submit one stored backup code
  (only when exactly one machine has secret-sync `pushEnabled` — read from each peer's
  `/secrets/sync-status` through the pool read path; an unobserved peer makes it ambiguous — and only on that machine — its store
  is the one that propagates; with secret sync off on a single-machine agent, that machine; in any
  other configuration the rung is skipped with `backup-code-authority-ambiguous`. The code is marked
  consumed BEFORE submit, so a crash never re-tries it; residual: the pre-existing SecretStore
  lost-update race can resurrect a spent code, which Google rejects and which lands as `failed`); choose "Try another way"/"Enter your password" on passkey-first accounts; "Create a passkey";
  the create-confirm button; "Not now" on a platform-passkey speedbump. Never "Continue" on an empty
  authenticator. Anything else refuses.
- **Self-unblock before asking:** the dedicated profile's live session → stored password plus stored
  TOTP/backup code → one retry in a fresh profile. Only then does a second-factor prompt with no
  stored answer (`waiting-human-factor`) or a CAPTCHA/risk page produce the human ask.
- **`google-already-enrolled`:** retry once in a fresh throwaway profile through the
  password/human-factor path; otherwise refuse with `already-enrolled-needs-throwaway`.
- **The human ask:** the dashboard shows one ask; the operator taps *Ready*; only then does the worker
  trigger the prompt.
- **After mint:** `readSignedInIdentityMatches(E)` must be true, else discard, `identity-mismatch`,
  orphan details in the digest. An enrollment log entry that reached `google-passkey-create-confirm`
  with no pending record is reported as a probable orphan on Google. Bind `userHandle`; capture `googleCreatedAt` from a passkey-list snapshot taken before creation and
  one after (the snapshot — metadata about the human's own passkeys too — is kept only inside the
  encrypted store entry) — the single new entry. If there is not exactly one, store nothing for it and record
  `google-created-at-unresolved` (removal then follows the attested path). Episode steps are logged,
  states only, to `logs/passkey-enrollment.jsonl`.
- **Store, then cold proof (§3.8):** `ready` ⇒ tuple becomes `google-passkey`; `failed` ⇒ delete +
  tombstone; `unknown` ⇒ stays quarantined until a later `ready`; `security` ⇒ delete, cell
  `security`.
- **Workspace:** `google-workspace-policy-blocked` ends the episode naming the exact admin setting.
- Enrollment and retry profiles live under `.instar/secrets/passkeys/profiles/`, are signed out and
  deleted at episode end (verified), and leftovers are swept at boot.
- Per-event outcomes (identity mismatch, orphaned passkey, backup codes remaining, Workspace blocked)
  are reported in the enrollment result and the digest; nothing else notifies.

### 3.8 Cold proof (identity-verified, assertion-verified, device-stable)

- Each cell has one persistent **proof-only** profile under `.instar/secrets/passkeys/profiles/`.
  Before each proof its cookies, storage and cache are cleared; it then must be **confirmed signed
  out** (Google shows a sign-in page) before the credential is added — otherwise the result is
  `unknown`. After the proof it signs out. The profile is deleted on revoke.
- `ready` requires all of: `observedAssertion(storedCredentialId)` is true (Google actually asked for
  and received a WebAuthn assertion from our credential); the virtual authenticator holds exactly
  that one credential; and `readSignedInIdentityMatches(E)` is true.
- Optional reach-through checks for Claude and Codex are web-origin only (no CLI, no live config home,
  no account creation, only providers the pool already maps to E); their failures are informational.
- Operator-triggered proof: `POST /passkeys/prove` (PIN or `prove` mandate op), subject to the same
  rate limit and pool read path.
- Proofs, canaries and enrollments are registered with `SelfActionGovernor` as the observe-only class
  `passkey-signin`: `resource: 'pool-shared'` (the Google account is shared across machines), target
  key = the HMAC entry key (never the email), ceilings = the §3.7 and §4 limits.

## 4. Health watcher (deterministic in-server tick)

- A deterministic tick inside the server every 5 minutes (`passkeyHealth`, tier0), not a scheduler job
  or LLM session; it calls the proof worker, which runs under the parent's Tier-1 supervision.
- Registered in `src/core/devGatedFeatures.ts` for `passkeys.enabled` and
  `passkeys.healthWatcher.enabled`, rationale: "inert without grants; enrollment is operator-initiated".
- Cadence: each cell proven once per 7 days at a per-machine jittered time; one proof at a time,
  ≥ 10 minutes apart; proofs of the same account from different machines ≥ 6 hours apart (checked
  through the pool read path, §5.1; an unobserved peer ⇒ skip this tick). Skip if a real repair signed in to that account in the last 24h or
  the account is paused.
- The host-wide `PlaywrightSeatLease` is taken per proof, released between proofs, not taken while a
  repair episode is pending, and renewed or aborted past its 10-minute TTL. A second proof-profile
  slot exists only for an enrollment's cold proof; at the cap the watcher waits for the next tick.
- **Throttle safety:** a `google-passkey-throttled` page pauses that account for 24h (restrictive-only
  advisory pool state, read by every machine before proving) and that machine's proofs for 1h.

State per cell (terminal states take precedence over every other row):

| From → to | Rule |
|---|---|
| healthy → degraded | a `failed` proof confirmed by a second `failed` proof 1h later |
| degraded → healthy | a later `ready` proof |
| degraded → breaker-open | 3 consecutive weekly confirmed failures; proofs stop |
| breaker-open → healthy | re-enrollment, or an operator-triggered proof returning `ready` |
| healthy/degraded → unverified | 3 consecutive `unknown`, or no `ready` for 21 days; backoff doubles per further `unknown` (7→14→28 days, cap 28) |
| unverified → healthy | a `ready` proof |
| unverified → unverified-stopped | 3 further `unknown` at the 28-day cap; automatic proofs stop |
| unverified-stopped → healthy | an operator-triggered proof returning `ready`, or re-enrollment |
| healthy/degraded/unverified → rejected | a `credential-rejected` outcome in a proof or repair; no immediate retry |
| rejected → healthy | a `ready` proof (weekly retry with the unverified backoff, a canary, or operator-triggered) |
| any → security | a `security` outcome (§3.6) in a proof or repair, or the parent oracle disagreeing; no retry |
| security → healthy | re-enrollment only |

**Pool read degraded.** While the pool read path is degraded for a cell's account, the 21-day and
unknown-count clocks pause and the cell shows "not proved: pool degraded" instead of moving toward
`unverified`. Peers are classified with the existing rope-health signal (`RopeHealthMonitor`): `ok` and `degraded`
= observed; `peer-offline` (heartbeat stopped, e.g. a closed laptop) = excluded from pool checks,
its last-known rows still counted with their own timestamps and expiring normally (attempts after
24h, pauses at their end); `urgent`, `auth-rejected`, `unknown`, or rope health absent (it is itself
dev-gated) = treated as partitioned, which blocks enrollment and proofs, with the digest saying why.
`peer-offline` also covers a live peer whose first post-onset heartbeat has not landed yet. Residual:
rope health takes 30–90 minutes to confirm a partition, so a live partitioned peer can
briefly look offline; its worst-case last-known rows still bound the rate limit. A peer unobserved
for more than 72h produces one digest buzz offering "exclude machine X from pool checks" (PIN, this
agent's pool) or "wait"; exclusion (stored per machine in `state/passkey-peer-exclusions.json`;
the dashboard sends `exclude-peer` to every observed machine) treats the peer like `peer-offline` and
clears automatically when it is observed again, or by `include-peer`. Rope health being live is a Rung 3 precondition (§7).

Flapping (3 healthy↔degraded flips in 30 days) sets a `flapping` flag and escalates the cell's digest
line; it is a flag, not a state.

## 5. Surfaces and notices

### 5.1 Pool read path

All pool-wide restrictive checks (rate limit, same-account gap, throttle pauses, suspension inputs,
`revokesGrantSeq`, outbox rows) read peer state through the replicated rows when those stores are
enabled, and otherwise by direct per-peer queries (the same fallback `GET /passkeys?scope=pool`
uses): a mesh-authenticated `GET /passkeys/pool-state` returning, per cell, custody and health state,
attempt rows, pauses, suspension record, outbox rows, grant `localSeq` values and grant echoes,
`googleCreatedAt`, and `pushEnabled`; 5 s
timeout per peer; one query per peer per tick, shared by every check and by `?scope=pool`. A peer
that answers neither way is `unobserved` (classified per §4 as offline or partitioned): enrollment and proofs refuse on a
multi-machine agent; repair is unaffected; the digest shows "pool checks degraded". A single-machine
agent has no peers and is never degraded. Rung 2 requires the four store kinds enabled on the dev
agent (§7). A peer's rows are audited per origin machine. They can only restrict enrollment, proofs and pauses;
for suspension they count as trusted mesh-peer data (§2). The route refuses de-paired, revoked or
recovery-quarantined machines, rows carry canonical emails (each machine derives its own keys), and
failures use the pool fan-out classification (never a peer URL). Peers are queried in parallel with
a 5 s overall limit per tick; `?scope=pool` is always served from the tick memo, marked with its age.

### 5.2 Routes and notices

- `GET /passkeys` — per cell: granted, custody state (present / pending / quarantined /
  machine-id-changed / legacy-adopted / legacy-unadopted), health state, Google-side state, enrollment
  episode state, last proof result and time, Workspace blocked, Chrome gate, suspension. Reads the
  names-only index. `?scope=pool` merges peers through the shared per-peer poll cache, or direct
  per-peer queries while that cache is dark; dark peers appear as `unobserved since <t>`.
- **One digest item**, upserted by the serving-lease holder under the fixed key
  `passkey-health:digest`, listing every cell in degraded, breaker-open, unverified,
  unverified-stopped, rejected, security, quarantined, google-side-pending-operator,
  google-side-operator-attested, legacy-overdue or orphan-on-Google state, plus pending outbox
  revokes, Chrome-gate failures, suspension, and unobserved peers. A new lease holder takes over the
  same key and resolves any copy left by the previous holder. A lone machine raises it for itself.
  **Notification:** the machine that observes a cell's self-heal exhaustion or a security event
  updates its own copy of the same key on that tick (within the 300 s ceiling); the pool attention
  view coalesces copies by key, and the lease holder's copy is the complete list. It re-notifies (buzzes) at most once
  per 24h, except for security and suspension changes, which buzz at most once per tick however many
  cells change; changes to the unobserved-peer list update it
  silently.
- PIN routes: `POST /passkeys/{grant,revoke,enroll,prove,adopt,delete-legacy,revert-method,
  attest-google-removed,resume-suspension,issuer-add,issuer-remove,exclude-peer,include-peer,
  recheck-chrome}`, each also a `passkey-cell` mandate op for another machine; received mandates
  arrive at `POST /passkeys/cell-action`.
- Dashboard Subscriptions grid: passkey badge per cell; the same controls behind the PIN;
  mobile-complete.
- Every grant, mint, adoption, deletion and revoke result names what changed and which agents and
  sessions depend on that account.
- `GET /capabilities` and the CLAUDE.md template describe the feature, its per-machine cost, the §1.1
  statement and the provider-policy assumption.

## 6. Migration parity (including today's prototype keys)

Live state at spec time: seven prototype keys in the shared SecretStore —
`google_passkey_{echo,dawn,adriana,justin,gearfinity}_studio` (minted on the Studio by Echo),
`google_passkey_amrch` (minted on the Studio by Echo, unsuffixed) and
`google_passkey_headley_shared` (a copy of a credential **minted by another agent, Dawn**). All were
pushed to the Mini and Laptop through secret sync. Their consumers are Echo's operator-run prototype
scripts; production repair cannot use them (`autonomousLoginMethod()` refuses the method).

1. **Increment 1 (fleet-wide, ungated):** stop further spread. A new first-segment glob matcher
   (separate from the dot-segment `isLocalOnlySecretPath`) makes the secret-sync SENDER filter
   `google_passkey_*` and the RECEIVER drop and audit such keys while storing the rest of the batch
   (`machineIdentityRecovery` keeps its existing reject-batch behavior). A receive refusal never
   deletes a copy already held. Test: an old-build sender pushing to a new-build receiver. Generic
   reads of prototype keys stay allowed and are logged to `logs/passkey-legacy-reads.jsonl`, so the
   prototype scripts keep working.
2. **Per key, operator choice on the dashboard, per machine (never in a post-update notice):**
   - *Adopt as legacy-shared:* the operator picks the account email from the pool's rows; the key is
     copied into the passkey store quarantined with `provenance: 'legacy-adopted'`; adoption commits
     only after an identity- and assertion-verified cold proof on that machine returns `ready`
     (otherwise reverted). Keys minted by another agent are recorded as cross-agent. Adopted keys
     carry a 90-day re-mint target; past it they are `legacy-overdue` in the digest (never
     auto-deleted).
   - *Delete:* removed locally, reported as `google-side-pending-operator` with every machine or agent
     still holding the same credential.
   - After either choice, that prototype key is removed from the shared SecretStore and generic reads
     of that name are refused.
3. **Re-mint cost, stated:** ending shared custody takes one human sign-in per (account × machine) for
   the peers — up to 14 on today's fleet. Re-minting is optional and gradual.
4. Prototype scripts are deleted at Rung 2 exit (§7).

`migrateConfig()` adds the `passkeys` block with `enabled` and `healthWatcher.enabled` left ABSENT (the
dev-agent gate decides), and ConfigDefaults gains `multiMachine.stateSync.{passkeyGrants,
passkeyTombstones,passkeyHealth,passkeyPauses}` with `enabled` omitted (backfilled through
`applyDefaults`, as the existing seven stores are) with `dryRun: false` for `passkeyGrants`, `passkeyHealth` and `passkeyPauses` (like the existing stores)
and `dryRun: true` for `passkeyTombstones` until FD9's post-run step flips it, because it deletes
credentials. The foundation does not enforce `dryRun` (emission reads only `enabled`), so the
tombstone RECEIVER reads the flag itself and, while true, only logs a would-delete (tested); `migrateClaudeMd()` adds the section behind a content-sniffing guard; the
registry gains `priorLoginMethod` and the `passkey` binding role as additive optional fields that older
builds ignore (the registry has no schema version or migrator); the gitignore patch (§3.1).
The backup manifest includes `state/passkey-grants.json`; on restore, any grant with `localSeq` at or
below the local revoke high-water mark is dropped (tested) — the mark lives in
`.instar/secrets/passkeys/revoke-hwm.json`, outside the backup manifest, so a restore cannot roll it
back — and cells without a credential file show
`granted, credential absent`.

Config (cheap-to-change defaults: dev-gated and inert without grants, so they cause no Google-side
effect during the build run): `passkeys: { enabled: <absent → dev-agent gate>, repairUsesPasskey: false,
healthWatcher: { enabled: <absent → dev-agent gate>, intervalDays: 7, minGapMinutes: 10,
sameAccountGapHours: 6, tickSeconds: 300 }, enrollment: { maxPerAccountPerDay: 3,
minIntervalMinutes: 30 }, legacyRemintDays: 90 }`.

## 7. Rollout

- Enrollment is always a real, grant-gated, operator-initiated write to a Google account; it has no
  dry mode. The account row's `loginMethod` is the per-account selector; `repairUsesPasskey` is the
  machine-wide kill switch.
- **Rung 1 — test agent:** a throwaway agent, the local WebAuthn fixture, and one disposable Google
  account registered in the owned-identities registry: enroll, cold proof, revoke, restart-mid-mint
  resume, legacy adoption, Google-side removal check. Exit: all pass.
- **Rung 2 — development agent** (operator-ratified, FD16): Echo's fleet with `repairUsesPasskey: true` and the four passkey
  store kinds enabled. Running without the broker is accepted here because the status quo on this
  fleet is worse: the same keys already sit in the generic SecretStore, readable by every session and
  synced to every machine; Rung 2 strictly narrows that exposure. `google-passkey` is a
  new provider path under the parent's graduation rule — its own 30-day dark window and 10
  identity-correct repairs per provider, enforced by the method-keyed evidence (§3.4).
- **Rung 3 — fleet:** on-by-default only after Rung 2 graduates AND the separate-OS-user signing
  broker (§17) ships and rope health is live on the fleet; watcher fleet cadence decided then.

## 8. Testing

- Unit: separate store file invisible to older builds; HMAC key inside the envelope; cross-machine
  messages carry email not `emailKey`; own lock under concurrent writers; pending record encrypted,
  resumed quarantined, expired; machine-scope guard before CDP; grants deny by default and local;
  mandate isolation both ways, non-operator signer, replay, expiry; outbox dedupe/expiry; revoke seq
  rule; replicated tombstone accepted only with a signed envelope; method refusal without
  fall-through; method-keyed graduation evidence and `inputDigest`; admission refusals; backup code
  consumed before submit and only on the push-authoritative machine; supervisor input and logs exclude
  credentials and emails; page-class ordering fixtures; outcome mapping.
- Integration: every §5.2 PIN route, `/passkeys/cell-action` and `/passkeys/pool-state`, with PIN,
  mandate and mesh gating; issuer add/remove and automatic removal on de-pair; enrollment state machine (crash between mint
  and store, identity mismatch, already-enrolled, rate limit pool-wide, Workspace); secret-sync
  mixed-version batch; restore high-water rule.
- Named behavioral tests: **P19 sustained-failure** — a watcher against a target that always returns
  `unknown` reaches `unverified-stopped` and stops; **P17 burst** — N failing cells across machines
  produce exactly one digest item and at most one buzz per 24h; **suspension** — triggers only at the
  minimum sample, excludes removed-on-google cells, canaries back off and stop at
  `suspended-stopped`, exits on canaries or operator resume; **dark peer** — a `peer-offline` machine does not block proofs or push cells to `unverified`;
  **canary authority** — a canary runs only on the owning machine when the published record says it
  is due, and refused canaries do not count; **dark stores** — with the four stores
  off, the pool read path enforces the pool-wide limits and an unobserved peer refuses enrollment;
  **degraded override** — approval-only, never unattended, `passkey-degraded-no-prior-method`, risk
  pause stated and extended; **revoke re-delivery** — backoff, 30-day breaker, one attempt when next
  online, received/applied ledger with boot sweep, stored cutoff on replay; **issuer bootstrap** — a
  multi-machine grant refused before peer issuers are confirmed, and `pending`/`missing`/`unreadable`
  issuers failing closed without removal; **incomplete-revoke item** aggregated per machine;
  **revoke durability** — an offline peer returning after 20 days applies the original signed
  revoke, and one gone past 30 days moves the cell to `google-side-pending-operator`; **stale session** — a proof whose profile is
  not signed out returns `unknown`, and a sign-in without an observed assertion is never `ready`.
- E2E: feature-alive through the production init path; pipe transport, about:blank-then-attach, popup
  auto-attach and navigation-time credential removal against a local WebAuthn fixture; cold proof
  against the fixture; Chrome version gate.
- Live (Live-User-Channel standard): on the dev agent, enroll one cell from a phone through the
  dashboard, prove it, then complete a real Claude and a real Codex repair unattended, including one on
  a peer machine started through a `passkey-cell` mandate.

## 9. Non-goals

- Relying parties other than Google.
- The agent deleting anything on Google's account pages (§3.2 explains why).
- A general "import a credential" route (only the one-time legacy adoption, §6).
- Minting on a machine without the human's one action.
- Storing or using the human's own passkeys.
- The separate-OS-user signing broker (§17 follow-up).

## 10. Decision points touched

| Decision point | Class | Justification / floor + arbiter |
|---|---|---|
| Machine-scope guard in `load()` | invariant | Provenance fact plus quarantine flag. |
| Grant check before mint/load/selection | invariant | Local recorded operator fact; unreadable ⇒ deny. |
| Revoke application (outbox or signed tombstone) | invariant | Signed envelope + `localSeq ≤ revokesGrantSeq`. |
| Mandate acceptance | invariant | Expected-issuer Ed25519 signature, nonce ledger, expiry. |
| Repair method selection and admission refusals | invariant | One method per tuple; named refusals on cell state; no fall-through except the approval-only degraded-mode override. |
| Unattended passkey repair admission | invariant | Parent's graduation rule, evidence keyed by login method. |
| Credential-affecting browser actions | invariant | Exact structural class match only. |
| Navigation choices on Google/provider pages | judgment-candidate | Floor: closed page classes (§3.6), closed action set (§3.7), exact-origin allowlist, confidence ≥ 0.95. Arbiter: parent's Tier-1 supervisor over redacted closed state. Ladder: self-unblock steps → `waiting-human-factor` → deterministic stop. |
| Identity and assertion checks | invariant | In-port equality; observed assertion for the stored credential id. |
| Proof verdict and outcome mapping | invariant | §3.6 mapping; only `ready` counts. |
| Cell state transitions | invariant | §4 table, terminal precedence. |
| Suspension failure direction | invariant | A false positive sends repairs to named refusals and the parent's approval path, reversible by resume; a false negative means repeated rejected sign-ins across accounts, raising Google risk on the human's accounts. Restriction is the less harmful direction, so it is chosen. |
| Pool-wide suspension and exit | invariant | A restrictive-only circuit breaker on this agent's own automated sign-ins — it can only withhold, never act, and judges no content; inputs are structurally classified outcomes and risk pages; minimum sample, 50% threshold, frozen window, canary or operator exit. |
| Chrome version gate | invariant | Fixture self-test result per machine. |
| Legacy key adopt/delete | invariant | Operator choice per key; adoption commits only on a verified `ready`. |
| Backup-code consumption | invariant | Exactly one push-authority machine; consumed before submit. |
| Pool-wide rate limit and gaps | invariant | Pool read path; unobserved peer ⇒ refuse. |
| Canary eligibility and backoff | invariant | Published suspension record; least-recently-canaried granted cell; 1→2→4→7 days; stop after 5; refusals do not count. |
| Expected-issuer membership | invariant | Local PIN; peers confirmed on the receiver's own dashboard; signed issuer ops; removal checked at mandate verification. |
| Degraded-mode method override | invariant | Suspension/stop/risk pause ⇒ live session, then prior method in approval mode under its own digest; never unattended. |
| Google-side removal confirmation | invariant | Positively classified list check with all other snapshot entries present, else labelled attested. |
| Dark-peer classification | invariant | Rope-health `peer-offline` vs partitioned. |
| Digest raise and buzz cap; throttle pause; 30-day outbox escalation; Workspace classification | invariant | §5.2, §4, §3.2, §3.6 rules. |

## 11. Symbols, states and corroboration (P20)

| Symbol | Claimed state | Independent corroboration | Unmeasurable ⇒ |
|---|---|---|---|
| Store entry present | this machine can sign in as E | Proof `ready` (below) | `unknown` → `unverified` |
| `getCredentials` returned a credential | Google registered the passkey for E | In-port identity match; then a proof with only that credential | `mint-unverified`; pending record (encrypted, 24h) |
| Proof `ready` | the passkey signs in as E | Signed out before the proof; observed assertion for the stored id; single-credential authenticator; identity match; the parent's oracle on the next real repair (recorded) | `unknown` |
| Grant row | operator authorized this cell | Written locally by PIN, verified mandate, or a restore checked against the revoke high-water mark | deny; `restored-unconfirmed` without the mark |
| Adoption record | this legacy key belongs to E and works here | Verified `ready` proof on this machine | uncommitted |
| Revoke read-back | the passkey path can no longer sign in as E here | Entry, pending record, proof profile and binding absent; tombstone present | report exactly which location could not be verified |
| Google-side removal | Google no longer lists the key | Positively classified list check with every other snapshot entry present | `google-side-operator-attested` (never "removed") |
| `credential-rejected` | Google no longer accepts this key | Single page-class match — errs toward restriction; canaries and the list check back it up | `unknown` |
| `removed-on-google` exclusion | the operator really removed it | Positively classified list check with all other snapshot entries present | attested only ⇒ still counted as rejected (not excluded) |
| Google risk page | Google is scoring our sign-ins as risky | Single-source structural match; errs toward restriction (pause, suspension) | treated as a risk page |
| Workspace blocked | admin setting is off | Single-source (structural class match only); stated as such in the result | `unknown` |
| Chrome gate passed | this Chrome's virtual authenticator works (not that Google accepts it) | Fixture self-test, then a first real proof on the new major | `passkey-chrome-unverified` |
| Peer health/pause/attempt rows | that peer's state | Used only restrictively (pause, gap, suspension, rate limit); never to grant or load | treated as unobserved |
| Suspension | Google stopped accepting the mechanism | Minimum sample across accounts, excluding verified removed-on-google; canary proofs | lease holder unreachable: last-known state ≤ 24h, then all passkey use refuses (repair falls back to the approval path) |
| Issuer membership | this peer may send mandates here | The receiver's own local PIN confirmation record | not an issuer |
| Degraded mode active | passkey path must not be used now | Suspension record / risk pause read through the pool read path | treated as active |
| Incomplete-revoke item closed | Google no longer accepts the key | Verified or attested removal for every listed cell | stays open |
| `priorLoginMethod` still works | the override can repair | Parent identity oracle + authenticated-use proof | named refusal |
| Unconfirmed-issuer revoke | a real operator revoke | None until the operator applies it locally | no Google-side prompt |
| Outbox revoke pending | the peer will stop using the key | Peer acknowledgement | after 30 days: `google-side-pending-operator` |

## 12. Multi-machine posture

Per-machine custody is an operator ratification (FD2), conditional on "truly one-time" setup. The
operator's own words are in Dawn's standard (the-portal `docs/standards/agent-account-sharing.md` §2,
2026-09-20), a private repository CI cannot read; the refs below are the verifiable copies, the decision-journal row is the
substantive evidence (the commit ref only shows FD2's text), and this spec's operator approval is the
binding ratification. FD16 (rollout order, not posture) has its own journal row
(agent-held-google-passkey-spec, 2026-09-23T02:22:00.856Z). The
re-enrollments this spec can require — after `breaker-open` or `security`, a machine-id change, a
Google-side removal, or the optional legacy re-mint — are failure-recovery cases outside that
one-time cost, and are presented to the operator as such. The one-time per-machine setup also includes
confirming that machine's trusted issuers from its own dashboard (§3.3).

- Passkey credentials (`.instar/secrets/passkeys/store.enc`):
machine-local-justification: operator-ratified-exception ref https://github.com/JKHeadley/instar/blob/a44e64c82/docs/specs/agent-held-google-passkey.md FD2, decision-journal agent-held-google-passkey-spec 2026-09-23T01:41:56.680Z
- Pending mint records (`.instar/secrets/passkeys/pending/`):
machine-local-justification: operator-ratified-exception ref https://github.com/JKHeadley/instar/blob/a44e64c82/docs/specs/agent-held-google-passkey.md FD2, decision-journal agent-held-google-passkey-spec 2026-09-23T01:41:56.680Z
- Proof and enrollment profiles (`.instar/secrets/passkeys/profiles/`):
machine-local-justification: physical-credential-locality permanence=permanent impossible-because=a live Google browser session's cookies are bound to one Chrome profile on one disk
- Nonce ledger, expected-issuer set, index, revoke high-water mark, Chrome-gate result, episode state
  and the authoritative `state/passkey-grants.json`: proxied-on-read through
  `GET /passkeys?scope=pool` (each describes or authorizes one machine's credential; the merged view
  is the pool surface).
- Grant rows, tombstones, health, pauses, attempt counts: unified through the four replicated store
  kinds (§3.2), with the pool read path (§5.1) as the fallback while they are dark; acted on only
  restrictively, except the signed revoke.
- Outbox: the signed revokes are unified through `passkeyTombstones` (§3.2), so any surviving machine
  can re-deliver them; delivery status is proxied-on-read.
- Suspension state: computed by the lease holder, read by peers through the pool read path.
- Backup-code consumed state: the synced SecretStore on the single push-authority machine (§3.7).
- `logs/passkey-health.jsonl`, `logs/passkey-legacy-reads.jsonl`, `logs/passkey-enrollment.jsonl`
  (states only, state changes rather than every tick, 30-day rotation):
  proxied-on-read.
- Notices: one digest key, coalesced across machines (§5.2).
- Config: per-machine, by the existing `.instar/config.json` convention.

## 13. Self-heal before notify (health watcher)

- `recoverable`: a `failed` proof. Self-heal: one confirming proof 1h later in the same device-stable
  profile (single retry; security-class outcomes are excluded). `unknown` results are handled only by
  the §4 backoff and its terminal `unverified-stopped`.
- Brakes: `max-attempts: 2`, `max-wall-clock: 90m`, `backoff: 1h, then 7/14/28 days`,
  `dedupe-key: passkey-health:digest` (one item, per-cell lines),
  `breaker: 3 weekly confirmed failures ⇒ breaker-open; 3 unknowns at cap ⇒ unverified-stopped;
  5 non-ready canaries ⇒ suspended-stopped`,
  flapping flag, `max-notification-latency: 300s` measured from self-heal exhaustion (the digest is
  updated on that tick), `audit-location: logs/passkey-health.jsonl`.
- Remediation is read-only toward the account (sign-in attempts only) and idempotent. The heal is
  implemented inside the watcher, not through `SelfHealGate`, because `SelfHealGate` v1 refuses
  pool-shared controllers and this class is pool-shared.
- `security` and suspension update the digest on the same tick, no heal gate.

## 14. Frontloaded Decisions

1. **Default access:** none; per-(account × machine) operator grant; revoke deletes locally.
   (Operator, topic 33890, 2026-09-22.)
2. **Human cost accepted; per-machine keys for revocation granularity.** (Operator, 2026-09-20;
   decision-journal ref in §12.)
3. **Google-side removal:** the operator removes it via a direct link (a short manual step); the
   agent never deletes on Google's pages, because the list mixes the human's own passkeys with no
   stable identifier to match; confirmation by a positively classified read-only list check,
   else labelled attested. (Author; Self-Unblock considered — the risk of deleting the human's own key
   outweighs saving one tap; revisit only if Google exposes a stable identifier.)
4. **Grants and revokes:** local authority; revokes via signed mandate outbox; replicated rows advisory
   except the signed tombstone accelerator. (Author, per the foundation's advisory-only rule.)
5. **Legacy keys:** spread stopped fleet-wide first; per-key operator choice on the dashboard; generic
   reads refused only after the choice. (Author.)
6. **Import route:** none this release. (Author.)
7. **Other stored credentials for the account remain;** the grant screen inventories them. (Author.)
8. **Watcher fleet cadence:** decided at Rung 3 on measured throttle and notice data. (Author; no fleet
   side-effect before then.)
9. **Run boundary:** the autonomous build ends at code that is live-but-inert on the dev agent (no
   grants ⇒ nothing happens) with unit, integration and fixture E2E green. After the run, as
   operator-involved steps tracked by a commitment: creating and registering the disposable Google
   account and running Rung 1; enrolling cells; per-key legacy choices; setting
   `repairUsesPasskey: true`, enabling the four passkey stores and flipping `passkeyTombstones` to
   `dryRun: false`, and adding emails
   to the unattended allowlist for Rung 2; the live proof;
   graduation; and the separate-OS-user broker increment (§17), which gates Rung 3. (Author.)
10. **Relying party:** Google only. **Crypto:** the existing SecretStore envelope in a separate file.
    (Author.)
11. **Backup codes:** consumed only on the secret-sync push-authoritative machine, one per attempt,
    marked consumed before submit; the enrollment result reports the remainder. (Author.)
12. **Mandate signing:** the WS5.2 Ed25519 issuance scheme with an expected-issuer set, nonce ledger,
    15-minute expiry and ±2-minute skew. (Author.)
13. **Suspension:** minimum 3 cells across 2 accounts and 50% within 7 days, excluding
    removed-on-google; canary backoff with a terminal `suspended-stopped`; exit by 2 canaries or
    operator resume. (Author.)
14. **Pool state while stores are dark:** the pool read path, refusing enrollment and proofs when a
    peer is unobserved; Rung 2 requires the stores enabled. (Author.)
15. **Revokes never silently expire:** signed revokes are re-delivered unchanged; past 30 days the
    cell escalates to Google-side removal. (Author.)
16. **Rung 2 before the broker, Rung 3 after it.** (Operator-ratified: Justin, topic 33890,
    2026-09-22 PDT, chose option A — the built-in feature signs in hands-off on our own machines before
    the broker ships, because the keys today are stored less safely than this design; other agents do
    not get it until the broker exists. Justified in §7.)
17. **Canary authority:** deterministic per-machine eligibility from the published suspension record,
    run under the local grant; never a mandate. (Author.)
18. **Issuer set:** self-add on first local PIN; peers confirmed from each receiver's own dashboard;
    signed `issuer-add`/`issuer-remove` afterwards; removal checked when a mandate is verified. (Author.)
19. **Dark peers:** rope-health `peer-offline` peers are excluded (worst-case last-known rows); only
    partitioned peers block; 72h operator exclude option. (Author.)
20. **Stale suspension state refuses repairs too** (falls back to the parent's approval path); **Google
    risk pages** pause and can trigger suspension. (Author.)
21. **Issuer bootstrap:** no trust-on-first-use; each machine's first peer issuers are confirmed with
    the PIN on that machine's own dashboard, once. (Author, per Know Your Principal.)

## 15. Rollback and downgrade

- Older builds ignore `.instar/secrets/passkeys/` and refuse repair for `google-passkey` accounts
  rather than acting wrongly. Before a deliberate downgrade, `revert-method` restores prior methods.
- Increment 1's sync filter is harmless to older peers (they stop receiving prototype keys).

## 16. Differences from Dawn's standard

- `defaultBackupEligibility/State` flags are optional (both variants measured working on Google).
- Credential ranking is the same (the agent's own passkey first); this spec adds custody rules (§3.1).
- Vault naming `Google Passkey - <email> @ <machine>` is replaced by an HMAC'd entry key; the email is
  inside the encrypted payload.
- The credential never leaves the server process except into CDP over a pipe.

## 17. Alternatives considered for key custody

- **SecretStore envelope in a separate file (chosen):** no new crypto; works on every supported
  platform; honest same-user threat model (§1.1).
- **OS keychain item per credential:** the master key is already read from the keychain unattended, so
  a per-credential item adds no protection against same-user code. Rejected.
- **Separate-OS-user signing broker:** the real boundary against same-user code — a small process
  under its own OS user holding the keys and exposing only "sign in to Google as E in this browser
  target", with origin enforcement and rate limits inside it. Required before Rung 3 (§7); this
  release records the risk as accepted for Rungs 1–2 (§1.1, §7).
- **Broker plus one durable workflow as the core architecture now** (suggested by the outside
  reviewer to shrink the composed state space): deferred to the broker increment before Rung 3. This
  release reuses the parent's existing durable episode state machine for enrollment and repair rather
  than adding a second orchestration engine; the broker increment is where custody, signing and
  episode orchestration consolidate.
- **Non-exportable hardware credential (Secure Enclave / TPM):** Chrome's virtual authenticator needs
  an exportable key, so it cannot be used with this mechanism. Out of scope.

## Open questions

*(none)*
