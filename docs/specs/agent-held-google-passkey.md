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
- **Origin-bound** (signs only for `google.com`), so a look-alike site cannot phish it. **Not
  hardware-bound**: anyone who obtains the decrypted key can use it from anywhere.
- A **complete Google sign-in**: whoever holds it has the whole account — mail, drive, settings,
  every "Sign in with Google" service. A leak is treated exactly like a leak of the password.
- **Accepted major risk — same-user code.** Any code running as the agent's OS user, including an
  agent session with a shell, can in principle decrypt the store, because the key-wrapping secret is
  reachable by that user. The custody rules (§3.1) stop accidental exposure through tools, sync,
  backups, logs and prompts; they are not a boundary against deliberate same-user code. A broker
  running as a separate OS user with a narrow signing API is the real fix; it is a tracked follow-up
  (§17), and the grant screen names this risk explicitly.
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
on that machine refuses with `passkey-chrome-unverified` and the digest (§5) says so.

**Pool-wide suspension.** Computed only by the serving-lease holder from replicated health rows
(restrictive direction only). Triggers when, within 24h, cells returning a credential-rejection class
(§3.6 `google-credential-not-recognized`) number ≥ 3 across ≥ 2 accounts AND make up ≥ 50% of proved
cells. Effect: every machine of this agent refuses passkey use with `passkey-suspended`. While
suspended, one canary proof per 24h still runs on one cell. Exit: 2 consecutive `ready` canaries, or
an operator resume (PIN or `resume-suspension` mandate op). "Pool" means this agent's machines.

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
  removed at **navigation-request time** (`Page.frameRequestedNavigation` / Fetch interception) before
  any other document commits, and as soon as a Google session exists. A fixture test navigates to a
  different google.com subdomain and asserts no assertion is possible. CDP messages that carry
  credentials are never logged or traced (tested).

### 3.2 Grants and revokes

- A grant `{canonicalEmail, machineId, grantedBy (verified principal), grantedAt, localSeq}`
  authorizes mint and load for one (account × machine) cell. No wildcard. Granting shows §1.1 and the
  provider-policy assumption, inventories the account's other stored credentials, and requires the
  operator to confirm "full Google account access, including mail and drive".
- **Authority is local.** A machine acts only on grants written on that machine by the PIN route or
  by a verified `passkey-cell` mandate (§3.3).
- **Revoke is carried by the mandate outbox.** Revoking a peer's cell issues a `revoke` mandate naming
  the target's grant instance (`revokesGrantSeq`, read from that machine's advisory grant row). The
  sender keeps it in a durable outbox, deduplicated per (cell, op) with latest-wins, re-issued with a
  fresh nonce when the peer returns, expired after 30 days or when the peer leaves the registry
  (shown in the digest while pending). The receiver applies it only if its local grant's
  `localSeq ≤ revokesGrantSeq`; otherwise it records and ignores it (a newer re-grant wins).
- **Replicated rows are display and acceleration only.** Grant rows, revoke tombstones, health rows
  and throttle pauses replicate through the replicated-store foundation as store kinds
  `passkeyGrants`, `passkeyTombstones`, `passkeyHealth`, `passkeyPauses`, each behind
  `multiMachine.stateSync.<kind>` (shipping `{enabled:false, dryRun:true}` like every foundation
  store). A replicated tombstone deletes a local credential on receipt only if it carries the same
  signed mandate envelope a direct revoke would (verified principal, origin-machine signature,
  one cell, `revokesGrantSeq`) — an explicit, declared exception to the foundation's
  never-clobber-local rule, following the replicated TopicPin clear precedent; anything else is
  audited and ignored. While these stores are dark, the outbox alone carries revokes.
- **What revoke does.** Deletes the store entry, pending record, the proof profile and the profile
  tuple's passkey binding; writes a tombstone; verifies each by read-back. It stops **this agent's
  passkey path** only: the dedicated profile's live session and stored password remain (FD7), and the
  revoke result lists them.
- **Google-side removal** is the operator's action this release. The cell stays
  `google-side-pending-operator` until either (a) a read-only check of Google's passkey list
  (`google-passkey-list` class, from the dedicated profile's live session, no actions) no longer
  shows a passkey with the stored `googleCreatedAt` ⇒ `google-side-removed-verified`, or (b) the
  operator taps "I removed it on Google" and the check cannot run ⇒ `google-side-operator-attested`,
  never displayed as "removed". If other cells share the same `credentialId` (legacy-shared keys),
  the revoke notice lists every machine and agent that stops working when it is removed on Google.

### 3.3 The `passkey-cell` mandate

- A new mandate type, separate from `account-follow-me`. Ops: `grant | revoke | enroll | prove |
  adopt | delete-legacy | revert-method | attest-google-removed | resume-suspension`.
- **Signing and acceptance** reuse the WS5.2 issuance scheme: signed with the Ed25519 issuance key of
  the operator machine where the dashboard PIN was verified; the signed body carries the verified
  principal, canonical email, `targetMachineId`, op, op arguments, nonce and expiry (15 minutes,
  ±2 minutes skew). The receiver accepts only a signature from a paired machine whose fingerprint is
  in its expected-issuer set, and records the nonce in a durable per-receiver ledger before acting.
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
    gains `loginMethod`; existing rows (no method) do not count toward `google-passkey`; evidence
    resets when the method changes;
  - the admission `inputDigest` includes `loginMethod` and the passkey entry key, so an approval for
    the password path cannot authorize the passkey path;
  - **admission refusals** before `load()`: `passkey-cell-security`, `passkey-cell-breaker-open`,
    `passkey-cell-unverified-stopped`, `passkey-suspended`, `passkey-chrome-unverified`,
    `passkey-cell-quarantined`.
- In the repair path, `readSignedInIdentityMatches(E)` runs right after Google sign-in, before any
  provider page; a mismatch sets the cell to `security` and refuses.
- **No fall-through** to another method on failure; a named refusal instead. The dedicated profile's
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
`google-totp-entry`, `google-backup-code-entry`. Each matches on structural predicates (exact origin,
path, element roles/stable ids), is evaluated BEFORE the parent's text-regex chain, and has a redacted
fixture proving that ordering. Unmatched ⇒ `unknown`.

Outcome mapping: `failed` = the proof reached Google's sign-in but did not sign in and no
security-class page appeared; `security` = `google-credential-not-recognized`, or signed in as a
different account; `unknown` = transport error, outage, unmatched page, throttled.

**Credential-affecting actions are deterministic only:** "Create a passkey", the create-confirm
button, and credential or code submission fire only on an exact structural class match. The
supervisor may choose among navigation actions but can never trigger these.

### 3.7 Guided enrollment (the one human action)

`POST /passkeys/enroll {email}` (PIN) or the `enroll` mandate op. Preconditions: a grant for the
cell; a registered dedicated profile for E; a display-capable machine (the parent's
browser-availability predicate); a passing Chrome version gate; no enrollment or repair episode owning
the cell.

- **One episode per cell, idempotent**; a leftover pending record resumes at "store" (quarantined).
- **Rate limit:** one attempt per cell per 30 minutes and 3 per account per day **pool-wide** — the
  attempt counter is kept per machine and replicated as advisory rows that every machine sums before
  acting (restrictive direction only). Real repair sign-ins are counted but never refused by it. Rows
  older than 24h are pruned.
- **Account pinning:** Google's account index (`authuser`) is pinned for creation and identity reading.
- **Closed action set:** navigate to allowlisted pages; fill email; fill the bound password (the grant
  covers methods already bound to the tuple); submit a stored TOTP code; submit one stored backup code
  (only on the machine holding secret-sync push authority, whose store is the one that propagates;
  the code is marked consumed there BEFORE submit, so a crash never re-tries it; peers skip this
  rung); choose "Try another way"/"Enter your password" on passkey-first accounts; "Create a passkey";
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
  orphan details in the digest. Bind `userHandle`; capture `googleCreatedAt` from the passkey list.
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
  rate limit.

## 4. Health watcher (deterministic in-server tick)

- A deterministic tick inside the server every 5 minutes (`passkeyHealth`, tier0), not a scheduler job
  or LLM session; it calls the proof worker, which runs under the parent's Tier-1 supervision.
- Registered in `src/core/devGatedFeatures.ts` for `passkeys.enabled` and
  `passkeys.healthWatcher.enabled`, rationale: "inert without grants; enrollment is operator-initiated".
- Cadence: each cell proven once per 7 days at a per-machine jittered time; one proof at a time,
  ≥ 10 minutes apart; proofs of the same account from different machines ≥ 6 hours apart (checked
  against replicated health rows). Skip if a real repair signed in to that account in the last 24h or
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
| any → security | a `security` outcome (§3.6) in a proof or repair; no retry |
| security → healthy | re-enrollment only |

Flapping (3 healthy↔degraded flips in 30 days) sets a `flapping` flag and escalates the cell's digest
line; it is a flag, not a state.

## 5. Surfaces and notices

- `GET /passkeys` — per cell: granted, custody state (present / pending / quarantined /
  machine-id-changed / legacy-adopted / legacy-unadopted), health state, Google-side state, enrollment
  episode state, last proof result and time, Workspace blocked, Chrome gate, suspension. Reads the
  names-only index. `?scope=pool` merges peers through the shared per-peer poll cache, or direct
  per-peer queries while that cache is dark; dark peers appear as `unobserved since <t>`.
- **One digest item**, upserted by the serving-lease holder under the fixed key
  `passkey-health:digest`, listing every cell in degraded, breaker-open, unverified,
  unverified-stopped, security, quarantined, google-side-pending-operator,
  google-side-operator-attested, legacy-overdue or orphan-on-Google state, plus pending outbox
  revokes, Chrome-gate failures, suspension, and unobserved peers. A new lease holder takes over the
  same key and resolves any copy left by the previous holder. A lone machine raises it for itself.
  **Notification:** the item is updated on the same tick a cell's self-heal is exhausted or a
  security/suspension event occurs (within the 300 s ceiling). It re-notifies (buzzes) at most once
  per 24h, except for security and suspension changes; changes to the unobserved-peer list update it
  silently.
- Dashboard Subscriptions grid: passkey badge per cell; grant / enroll / prove / revoke / adopt /
  delete / attest / resume controls behind the PIN; mobile-complete.
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
dev-agent gate decides); `migrateClaudeMd()` adds the section behind a content-sniffing guard; the
registry migration adds `priorLoginMethod` and the `passkey` binding role; the gitignore patch (§3.1).
The backup manifest includes `state/passkey-grants.json`; on restore, any grant with `localSeq` at or
below the local revoke high-water mark is dropped (tested), and cells without a credential file show
`granted, credential absent`.

Config: `passkeys: { enabled: <absent → dev-agent gate>, repairUsesPasskey: false,
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
- **Rung 2 — development agent:** Echo's fleet with `repairUsesPasskey: true`. `google-passkey` is a
  new provider path under the parent's graduation rule — its own 30-day dark window and 10
  identity-correct repairs per provider, enforced by the method-keyed evidence (§3.4).
- **Rung 3 — fleet:** on-by-default only after Rung 2 graduates; watcher fleet cadence decided then.

## 8. Testing

- Unit: separate store file invisible to older builds; HMAC key inside the envelope; cross-machine
  messages carry email not `emailKey`; own lock under concurrent writers; pending record encrypted,
  resumed quarantined, expired; machine-scope guard before CDP; grants deny by default and local;
  mandate isolation both ways, non-operator signer, replay, expiry; outbox dedupe/expiry; revoke seq
  rule; replicated tombstone accepted only with a signed envelope; method refusal without
  fall-through; method-keyed graduation evidence and `inputDigest`; admission refusals; backup code
  consumed before submit and only on the push-authoritative machine; supervisor input and logs exclude
  credentials and emails; page-class ordering fixtures; outcome mapping.
- Integration: `/passkeys`, `/passkeys/enroll`, `/passkeys/prove`, `/passkeys/cell-action`,
  `/passkeys/revert-method` with PIN and mandate gating; enrollment state machine (crash between mint
  and store, identity mismatch, already-enrolled, rate limit pool-wide, Workspace); secret-sync
  mixed-version batch; restore high-water rule.
- Named behavioral tests: **P19 sustained-failure** — a watcher against a target that always returns
  `unknown` reaches `unverified-stopped` and stops; **P17 burst** — N failing cells across machines
  produce exactly one digest item and at most one buzz per 24h; **suspension** — triggers only at the
  minimum sample and exits on canaries or operator resume; **stale session** — a proof whose profile is
  not signed out returns `unknown`, and a sign-in without an observed assertion is never `ready`.
- E2E: feature-alive through the production init path; pipe transport, about:blank-then-attach, popup
  auto-attach and navigation-time credential removal against a local WebAuthn fixture; cold proof
  against the fixture; Chrome version gate.
- Live (Live-User-Channel standard): on the dev agent, enroll one cell from a phone through the
  dashboard, prove it, then complete a real Claude and a real Codex repair unattended, including one on
  a peer machine started through a `passkey-cell` mandate.

## 9. Non-goals

- Relying parties other than Google.
- The agent deleting anything on Google's account pages.
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
| Repair method selection and admission refusals | invariant | One method per tuple; named refusals on cell state; no fall-through. |
| Unattended passkey repair admission | invariant | Parent's graduation rule, evidence keyed by login method. |
| Credential-affecting browser actions | invariant | Exact structural class match only. |
| Navigation choices on Google/provider pages | judgment-candidate | Floor: closed page classes (§3.6), closed action set (§3.7), exact-origin allowlist, confidence ≥ 0.95. Arbiter: parent's Tier-1 supervisor over redacted closed state. Ladder: self-unblock steps → `waiting-human-factor` → deterministic stop. |
| Identity and assertion checks | invariant | In-port equality; observed assertion for the stored credential id. |
| Proof verdict and outcome mapping | invariant | §3.6 mapping; only `ready` counts. |
| Cell state transitions | invariant | §4 table, terminal precedence. |
| Pool-wide suspension and exit | invariant | Minimum sample, 50% threshold, canary or operator exit. |
| Chrome version gate | invariant | Fixture self-test result per machine. |
| Legacy key adopt/delete | invariant | Operator choice per key; adoption commits only on a verified `ready`. |

## 11. Symbols, states and corroboration (P20)

| Symbol | Claimed state | Independent corroboration | Unmeasurable ⇒ |
|---|---|---|---|
| Store entry present | this machine can sign in as E | Proof `ready` (below) | `unknown` → `unverified` |
| `getCredentials` returned a credential | Google registered the passkey for E | In-port identity match; then a proof with only that credential | `mint-unverified`; pending record (encrypted, 24h) |
| Proof `ready` | the passkey signs in as E | Signed out before the proof; observed assertion for the stored id; single-credential authenticator; identity match; the parent's oracle on the next real repair (recorded) | `unknown` |
| Grant row | operator authorized this cell | Written locally by PIN or verified mandate | deny |
| Adoption record | this legacy key belongs to E and works here | Verified `ready` proof on this machine | uncommitted |
| Revoke read-back | the passkey path can no longer sign in as E here | Entry, pending record, proof profile and binding absent; tombstone present | report exactly which location could not be verified |
| Google-side removal | Google no longer accepts the key | Read-only passkey-list check | `google-side-operator-attested` (never "removed") |
| Workspace blocked | admin setting is off | Exact structural class match | `unknown` |
| Chrome gate passed | this Chrome supports the mechanism | Fixture self-test on this machine | `passkey-chrome-unverified` |
| Peer health/pause/attempt rows | that peer's state | Used only restrictively (pause, gap, suspension, rate limit); never to grant or load | treated as unobserved |
| Suspension | Google stopped accepting the mechanism | Minimum sample across accounts; canary proofs | stays suspended until canary or operator |

## 12. Multi-machine posture

- Passkey credentials, pending records, and proof/enrollment profiles: machine-local.
  `machine-local-justification: operator-ratified-exception` — ref: decision-journal entry
  `sessionId=agent-held-google-passkey-spec`, `timestamp=2026-09-23T01:41:56.680Z` (GET
  /intent/journal), recording the operator's 2026-09-20 ratification quoted in the-portal
  `docs/standards/agent-account-sharing.md` §2. The key is exportable, so relocation is possible; the
  per-machine design is chosen for revocation granularity. Each machine works on its own.
- Grants: local authority; `passkeyGrants` replicated as advisory rows.
- Revokes: mandate outbox (authoritative) + `passkeyTombstones` replicated (signed, accelerator).
- Health, pauses, attempt counts: `passkeyHealth` / `passkeyPauses` replicated advisory rows, acted on
  only restrictively.
- `logs/passkey-health.jsonl` and `logs/passkey-legacy-reads.jsonl` (states only, 30-day rotation):
  proxied-on-read through `GET /passkeys?scope=pool`.
- `GET /passkeys`: proxied-on-read.
- Notices: one voice (serving-lease holder's digest).
- Config: per-machine, by the existing `.instar/config.json` convention.

## 13. Self-heal before notify (health watcher)

- `recoverable`: a `failed` proof. Self-heal: one confirming proof 1h later in the same device-stable
  profile (single retry; security-class outcomes are excluded). `unknown` results are handled only by
  the §4 backoff and its terminal `unverified-stopped`.
- Brakes: `max-attempts: 2`, `max-wall-clock: 90m`, `backoff: 1h, then 7/14/28 days`,
  `dedupe-key: passkey-health:digest` (one item, per-cell lines),
  `breaker: 3 weekly confirmed failures ⇒ breaker-open; 3 unknowns at cap ⇒ unverified-stopped`,
  flapping flag, `max-notification-latency: 300s` measured from self-heal exhaustion (the digest is
  updated on that tick), `audit-location: logs/passkey-health.jsonl`.
- Remediation is read-only toward the account (sign-in attempts only) and idempotent.
- `security` and suspension update the digest on the same tick, no heal gate.

## 14. Frontloaded Decisions

1. **Default access:** none; per-(account × machine) operator grant; revoke deletes locally.
   (Operator, topic 33890, 2026-09-22.)
2. **Human cost accepted; per-machine keys for revocation granularity.** (Operator, 2026-09-20;
   decision-journal ref in §12.)
3. **Google-side removal:** operator action; verified read-only where possible, otherwise attested and
   labelled as such. (Author.)
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
   `repairUsesPasskey: true` and adding emails to the unattended allowlist for Rung 2; the live proof;
   graduation. (Author.)
10. **Relying party:** Google only. **Crypto:** the existing SecretStore envelope in a separate file.
    (Author.)
11. **Backup codes:** consumed only on the secret-sync push-authoritative machine, one per attempt,
    marked consumed before submit; the enrollment result reports the remainder. (Author.)
12. **Mandate signing:** the WS5.2 Ed25519 issuance scheme with an expected-issuer set, nonce ledger,
    15-minute expiry and ±2-minute skew. (Author.)
13. **Suspension:** minimum 3 cells across 2 accounts and 50%; exit by 2 canaries or operator resume.
    (Author.)

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
  target", with origin enforcement and rate limits inside it. Tracked follow-up before Rung 3; this
  release records the risk as accepted (§1.1).
- **Non-exportable hardware credential (Secure Enclave / TPM):** Chrome's virtual authenticator needs
  an exportable key, so it cannot be used with this mechanism. Out of scope.

## Open questions

*(none)*
