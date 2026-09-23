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
approved: false
---

# Agent-Held Google Passkeys

## 1. Outcome and boundary

When Google accepts passkey enrollment and later passkey sign-in without a risk challenge, ONE human
action per (Google account × machine) lets an Instar agent sign itself into that Google account from
an empty browser and repair every subscription that signs in through Google (today: Claude Code and
Codex) without further operator work.

Known cases that still need a human, stated up front: a Workspace domain with passkey sign-in
disabled (one admin setting, §3.7); a Google CAPTCHA or risk review; a second-factor prompt the agent
holds no answer for; Google throttling after too many attempts (waits out, then continues); a
passkey the operator removed on Google (needs re-enrollment).

This EXTENDS `assisted-subscription-relogin` (the parent). The passkey is a new **login method** the
existing repair worker can use, plus the custody, grant, enrollment, proof and migration machinery
that method needs. Every parent guarantee (trigger admission, unattended identity allowlist, Tier-1
supervised worker, identity-oracle veto, authenticated-use proof, breakers) is unchanged.

Prior art: Dawn's *Agent Account Sharing Standard* (SageMindAI/the-portal
`docs/standards/agent-account-sharing.md`) and the account-free public write-up
(https://telegra.ph/Hands-Off-Sign-In-for-AI-Agents-09-22-2 — reviewed: no account identifiers).
Differences from Dawn's standard: §16.

### 1.1 What this credential is — stated honestly

- It is a WebAuthn key pair registered on the Google account as one more passkey, stored as
  **exportable software key material**.
- It is **origin-bound** (signs only for `google.com`), so a look-alike site cannot phish it. It is
  **not hardware-bound**: anyone who obtains the decrypted key can use it from anywhere.
- It is a **complete Google sign-in**: whoever holds it has the whole Google account — mail, drive,
  settings, and every "Sign in with Google" service — not just Claude and Codex.
- A leak is treated exactly like a leak of the account's password.
- **Local threat model:** any code running as the agent's OS user — including an agent session with
  a shell — can in principle decrypt the store, because the key-wrapping secret is reachable by that
  user. The custody rules (§3.1) prevent accidental exposure through the agent's ordinary tools,
  sync, backups, logs and prompts; they do not defend against deliberate same-user code. §17 records
  why stronger key management is deferred.
- It adds to, and does not replace, what the agent already holds for enrollment (a live session, a
  stored password, stored 2FA answers). The grant screen shows an inventory of those other
  credentials for the account, and states that they remain (§14 FD7).
- Each weekly proof is a real Google sign-in; the account owner may see sign-in notices. §4 keeps the
  device stable to minimise that.

## 2. Mechanism (measured live)

1. **Virtual authenticator before navigation.** A page that may reach Google gets
   `WebAuthn.enable {enableUI:false}` + `WebAuthn.addVirtualAuthenticator {protocol:ctap2,
   transport:internal, hasResidentKey, hasUserVerification, isUserVerified,
   automaticPresenceSimulation}` before its first navigation. Without it Chrome raises the OS
   platform-authenticator sheet and the page stops processing input.
2. **Mint.** From a session signed in to account E, the worker opens Google's passkey-creation page;
   the credential lands in the virtual authenticator; `WebAuthn.getCredentials` exports it.
3. **Use.** In a fresh session, `WebAuthn.addCredential`, then Google sign-in authenticates with the
   resident credential.
4. **Reach-through.** Claude's login accepts a live Google session; Codex's web sign-in offers
   "Continue with Google". One credential repairs both.

Measured constraints: Google does not enforce the signature counter (other relying parties do);
`signCount` is not written back, which is correct for Google only (one reason this release is
Google-only). An authenticated profile cannot mint a second passkey ("You're all set!"), so the agent
cannot self-propagate. Workspace domains block passkey sign-in until the admin enables "skip password
at sign-in".

**Compatibility contract.** The mechanism depends on Chrome's DevTools WebAuthn domain and on Google
accepting virtual-authenticator credentials. A Chrome major-version change is gated by the fixture
E2E (§8) before the passkey path is used on it. If Google rejects credentials fleet-wide (≥ 50% of
cells returning a credential-rejected class within 24h), all passkey use pauses fleet-wide, repair
reverts to refusing with `passkey-path-suspended`, and one notice goes out.

## 3. Components

### 3.1 Custody — `PasskeyCredentialStore` (new, separate file)

- **Separate encrypted file**, not the shared SecretStore: `.instar/secrets/passkeys/store.enc`,
  using the SecretStore's existing AES-GCM envelope and master-key source (no new crypto). Older
  builds never read or enumerate this file, so a rollback or a not-yet-updated machine cannot sync,
  list, back up or show it. Nothing about it enters the secret-sync payload, `secret-get.mjs`,
  `SecretManager`, backup-from-config, or the session boot self-knowledge block.
- Entry key: `<emailKey>:<machineId>`, `emailKey` = HMAC-SHA-256 of the canonical email under a
  per-store random salt (not reversible by guessing known emails). Payload: `{credentialId, rpId,
  privateKey, userHandle, signCount, canonicalEmail, mintedOnMachineId, mintedByAgent, mintedAt,
  googleCreatedAt?, provenance: 'minted' | 'legacy-adopted', schemaVersion}`.
- **Own lock.** Every write takes a cross-process `proper-lockfile` lock on the store file, re-reads
  under the lock, writes a unique temp file and renames. No other writer exists. (A separate,
  pre-existing lost-update risk in `SecretStore.write` is out of scope here and tracked separately;
  it no longer touches passkeys.)
- **Machine-scope guard (invariant):** `load()` returns a credential only when
  `mintedOnMachineId === localMachineId` or a verified adoption record for this machine exists
  (§6). It runs before anything reaches the browser. A local machine-id change yields
  `machine-id-changed`, resolved by the operator's per-key adopt/delete choice.
- **Names-only index.** A plaintext index of `{emailKey, machineId, provenance, state}` (no email,
  no key) is rebuilt on every write and at boot; `GET /passkeys` and ticks read it. Decryption
  happens only inside an enrollment or proof episode, once per episode.
- **Crash-safe mint.** Between export and the verified store write, the credential sits in
  `.instar/secrets/passkeys/pending/<emailKey>.enc` (same envelope). It is deleted after verified
  read-back; a leftover is resumed on restart (never re-minted), expires after 24h, and is deleted
  on revoke. An expired or discarded mint leaves a passkey registered on Google: the notice names
  the account, `googleCreatedAt` and Google's removal link.
- **Exclusions verified by test:** `.instar/secrets/` is refused by BackupManager, never served by
  the file viewer, and git-sync excludes it through `FileClassifier`; this spec also adds
  `secrets/` to `DEFAULT_GITIGNORE` as a second layer.
- **In the browser:** the credential is added to the virtual authenticator only while that target's
  top-level origin is exactly `accounts.google.com`, per target (including auto-attached popups), and
  removed as soon as a Google session exists or the target leaves that origin. CDP messages that
  carry credentials are never logged or traced (tested).

### 3.2 Grants (deny-by-default)

- A grant `{canonicalEmail, machineId, grantedBy (verified principal), grantedAt, seq}` authorizes
  mint and load for one (account × machine) cell. No wildcard. Granting shows the §1.1 statement,
  the inventory of other stored credentials for the account, and requires the operator to confirm
  "full Google account access, including mail and drive".
- **Authority is local.** A machine acts only on grants written on that machine, by the PIN route
  or by a verified `passkey-cell` mandate (§3.3). Grant rows are ALSO replicated through the
  replicated-store foundation as **advisory** rows so every machine can show them; a replicated row
  never authorizes anything.
- **Revoke wins, and revoke propagates.** Revoke tombstones replicate, and a machine that receives
  one deletes its local credential on receipt (the safe direction — it only removes authority).
  Ordering uses the per-machine `seq`; a later grant clears a tombstone only if it was written on
  that machine after the tombstone. The sender also keeps a durable outbox and re-sends a fresh
  mandate when an offline peer returns.
- **What revoke does and does not do.** It deletes the store entry, the pending record, and the
  profile's passkey binding; writes a tombstone; verifies by read-back. Removing the passkey on
  Google is the **operator's** action this release: the cell stays in the persistent state
  `google-side-pending-operator` (shown in the daily digest, §5) until the operator taps "I removed
  it on Google". If other cells share the same `credentialId` (legacy-shared keys), the revoke
  notice lists every machine and agent that will stop working when it is removed on Google.

### 3.3 The `passkey-cell` mandate (cross-machine actions)

- A new mandate type, separate from `account-follow-me`, bound to
  `{emailKey, targetMachineId, op, nonce}` with `op ∈ grant | revoke | enroll | adopt | delete-legacy |
  revert-method | attest-google-removed`; single-use, 15-minute expiry, verified on the receiving
  machine by its own acceptance rule and its own route (`POST /passkeys/cell-action`).
- The existing follow-me consumer ignores it, and the new route refuses `account-follow-me`
  mandates (both tested). The dashboard PIN never crosses the mesh.

### 3.4 Login method `google-passkey` and the code it touches

- `PlaywrightLoginMethod` gains `'google-passkey'`; `vaultBindings` gains a `passkey` role holding
  the store entry key. The registry validates that binding with `PasskeyCredentialStore.has()`, not
  `listVaultNames()`. The account row keeps ONE `loginMethod`; enrollment records the replaced one
  in a new `priorLoginMethod`.
- Named code changes: `SUPPORTED_LOGIN_METHODS` (`SubscriptionReloginPolicy.ts`);
  `autonomousLoginMethod()` (`SubscriptionReloginRuntime.ts`); the driver request's `loginMethod`
  union (`AnthropicReloginBrowserDriver.ts`); and **graduation evidence keyed by
  (identity, loginMethod)** in `unattendedGraduated()` — evidence resets when the method changes, so
  password-path repairs never count toward unattended passkey repair. Tests cover both sides of each.
- **No fall-through** to another method on failure; a named refusal instead. The dedicated profile's
  live Google session is tried first, as today.
- **Rollback:** an older build refuses repair for a `google-passkey` account
  (`login-method-not-autonomous`) — safe. `POST /passkeys/revert-method` (PIN or mandate) restores
  `priorLoginMethod` on a machine before a deliberate downgrade; accounts without one are left
  unchanged and listed as `no-prior-method`.
- Repair worker origin additions: `accounts.google.com` only.

### 3.5 Browser foundation changes (`ChromeCdpReloginBrowser` + `ReloginBrowserPort`)

- Passkey-method sessions use `--remote-debugging-pipe` (stdio fds 3/4) instead of a TCP port and
  `/json/new`, and launch with `--disable-extensions`. (Other modes may adopt the pipe later.)
- Every target is created at `about:blank`; the authenticator is attached; then it navigates.
  `Target.setAutoAttach {autoAttach:true, waitForDebuggerOnStart:true, flatten:true}` pauses popups
  until attached. A test fails if a Google navigation precedes the attach.
- Port additions: `attachAuthenticator()`, `addCredential()`, `removeCredential()` (per target),
  `readSignedInIdentityMatches(expected): boolean` — the email is compared inside the port and never
  leaves it (not logged, not snapshotted, not sent to the supervisor).
- **Real input clicks** (`Input.dispatchMouseEvent` at the element box) replace `element.click()` for
  Google list items, including the existing `chooseExpectedAccount` and `click('google')` paths —
  measured 2026-09-21: script clicks do not advance Google's list screens.

### 3.6 Closed page classes

New classes: `google-passkey-challenge`, `google-passkey-create`, `google-passkey-create-confirm`,
`google-already-enrolled`, `google-passkey-throttled`, `google-workspace-policy-blocked`,
`google-credential-not-recognized`, `google-account-identity`, `google-totp-entry`,
`google-backup-code-entry`. Each is matched on structural predicates (exact origin, path, element
roles/stable ids), is evaluated BEFORE the parent's existing text-regex chain (so "check your phone"
or captcha text cannot capture a passkey page), and has a redacted fixture proving that ordering.
An unmatched page is `unknown`. **Credential-affecting actions are deterministic only:** "Create a
passkey", the create-confirm button, and credential submission fire only on an exact structural
class match; the supervisor may choose among navigation actions but can never trigger these.

### 3.7 Guided enrollment (the one human action)

`POST /passkeys/enroll {email}` (PIN) or the `enroll` mandate op. Preconditions: a grant for the
cell; a registered dedicated profile for E; a display-capable machine (the parent's
browser-availability predicate); no enrollment or repair episode owning the cell.

- **One episode per cell, idempotent**; a leftover pending record resumes at "store".
- **Rate limit:** one attempt per cell per 30 minutes, 3 per day, in a durable per-account attempt
  counter shared with proofs and real repairs (rows older than 24h pruned).
- **Account pinning:** Google's account index (`authuser`) is pinned for creation and identity
  reading, so both act on the same signed-in account.
- **Closed action set:** navigate to allowlisted pages; fill email; fill the bound password (the
  grant covers methods already bound to the tuple); submit a stored TOTP code; submit one stored
  backup code (the code is marked consumed in the store BEFORE submit, surviving a crash — a code is
  never tried twice; the notice reports how many remain); choose "Try another way"/"Enter your
  password" on passkey-first accounts; "Create a passkey"; the create-confirm button; "Not now" on a
  platform-passkey speedbump. Never "Continue" on an empty authenticator. Anything else refuses.
- **Self-unblock before asking:** the dedicated profile's live session → stored password plus stored
  TOTP/backup code → one retry in a fresh profile. Only then, a genuine second-factor prompt with no
  stored answer (`waiting-human-factor`) or a CAPTCHA/risk page produces the human ask.
- **`google-already-enrolled`:** the profile has minted before. Retry once in a fresh throwaway
  profile through the password/human-factor path; otherwise refuse with
  `already-enrolled-needs-throwaway`.
- **The human ask:** the dashboard shows one ask; the operator taps *Ready*; only then does the
  worker trigger the prompt.
- **After mint, verify identity before storing:** `readSignedInIdentityMatches(E)` must be true;
  otherwise discard, state `identity-mismatch`, one notice (with the orphan-on-Google details). Bind
  `userHandle`.
- **Store, then cold proof (§3.8).** `ready` ⇒ tuple becomes `google-passkey`. `failed` ⇒ delete the
  credential, tombstone, notice. `unknown` ⇒ credential quarantined (not loadable) until a later
  proof returns `ready`.
- **Workspace:** `google-workspace-policy-blocked` ends the episode naming the exact admin setting.
- Enrollment and retry profiles live under `.instar/secrets/passkeys/profiles/` and are signed out
  and deleted at episode end, verified; leftovers are swept at boot through SafeFsExecutor.

### 3.8 Cold proof (identity-verified, device-stable)

- Each cell has one persistent **proof-only** profile under `.instar/secrets/passkeys/profiles/`
  (never served, not backed up). Before each proof its cookies and storage are cleared, so the
  sign-in is cold while Google sees the same device (fewer new-device notices). After the proof it
  signs out.
- The proof: add only the passkey, sign in to Google, then `readSignedInIdentityMatches(E)`. The
  worker also asserts the virtual authenticator holds exactly one credential whose id equals the
  stored `credentialId`, so a `ready` cannot come from some other session.
- Result: `ready` (identity matched), `failed` (credential rejected), `security` (signed in as a
  DIFFERENT account — custody is corrupt), `unknown` (transport, outage, unmatched page, throttled).
- Optional reach-through checks for Claude and Codex are web-origin only (no CLI, no live config
  home, no account creation — only providers the pool already maps to E); their failures are
  informational `unknown`.

## 4. Health watcher (deterministic in-server tick)

- A deterministic tick inside the server (`passkeyHealth`, tier0), not a scheduler job or LLM
  session; it calls the proof worker, which runs under the parent's Tier-1 supervision.
- Cadence: each cell proven once per 7 days at a per-machine jittered time; one proof at a time,
  ≥ 10 minutes apart. Before a proof: skip if a real repair signed in to that account in the last
  24h, or if the account is paused (below). The host-wide `PlaywrightSeatLease` is taken per proof,
  released between proofs, not taken while a repair episode is pending, and renewed or aborted past
  its 10-minute TTL. A second proof-profile slot exists only for an enrollment's cold proof running
  alongside a watcher proof; at the cap the watcher waits for the next tick.
- **Throttle safety:** a `google-passkey-throttled` page pauses that account for 24h and that
  machine's proofs for 1h. The account pause is published as advisory pool state that every machine
  reads before proving.

State per cell:

| From → to | Rule |
|---|---|
| healthy → degraded | a `failed` proof, confirmed by a second `failed` proof 1h later |
| degraded → healthy | a later `ready` proof |
| degraded → breaker-open | 3 consecutive weekly confirmed failures; proofs stop for the cell |
| breaker-open → healthy | a successful re-enrollment, or an operator-triggered proof returning `ready` |
| any → unverified | 3 consecutive `unknown` results, or no `ready` for 21 days; backoff doubles each further `unknown` (7→14→28 days, cap 28) |
| unverified → healthy | a `ready` proof |
| any → security | first `google-credential-not-recognized` or a `security` proof result — no retry |
| security → healthy | a successful re-enrollment only |

Flapping (3 healthy↔degraded flips in 30 days) sets a `flapping` flag on the cell and escalates its
notice to critical; it is a flag, not a state.

## 5. Surfaces and notices

- `GET /passkeys` — per cell: granted, custody state (present / pending / quarantined /
  machine-id-changed / legacy-adopted / legacy-unadopted), health state, `google-side-pending-
  operator`, enrollment episode state, last proof result and time, Workspace blocked. Reads the
  names-only index. `?scope=pool` merges peers through the shared per-peer poll cache, or direct
  per-peer queries while that cache is dark; dark peers appear as `unobserved since <t>`.
- **Health rows replicate** as content-free advisory rows (cell id, state, timestamps) so any
  machine can see pool health.
- **One daily digest item:** the serving-lease holder upserts a single attention item keyed
  `passkey-health:digest`, listing every cell in degraded, breaker-open, unverified, security,
  google-side-pending-operator, legacy-overdue or orphan-on-Google state, plus unobserved peers. It
  re-notifies only when that set changes. A lone machine raises it for itself. Security and
  fleet-wide-suspension changes update the same item immediately.
- Dashboard Subscriptions grid: passkey badge per cell; grant / enroll / revoke / adopt / delete /
  attest controls behind the PIN; mobile-complete.
- Every grant, mint, adoption, deletion and revoke notice names what changed and which agents and
  sessions depend on that account.
- `GET /capabilities` and the CLAUDE.md template describe the feature, its per-machine cost, and the
  §1.1 statement.

## 6. Migration parity (including today's prototype keys)

Live state at spec time: seven prototype keys in the shared SecretStore —
`google_passkey_{echo,dawn,adriana,justin,gearfinity}_studio` (minted on the Studio by Echo),
`google_passkey_amrch` (minted on the Studio by Echo, unsuffixed) and
`google_passkey_headley_shared` (a copy of a credential **minted by another agent, Dawn**). All were
pushed to the Mini and Laptop through secret sync. Their consumers are Echo's operator-run
prototype scripts; production repair cannot use them (`autonomousLoginMethod()` refuses the method).

Ordering, so nothing working breaks:

1. **Increment 1 (fleet-wide, ungated):** stop further spread. The secret-sync SENDER filters
   `google_passkey_*`; the RECEIVER drops and audits `google_passkey_*` keys and stores the rest of
   the batch (instead of rejecting the whole batch as it does for `machineIdentityRecovery`, which
   keeps its existing behavior). A receive refusal never deletes a copy already held. A test covers
   an old-build sender pushing to a new-build receiver. Generic reads of prototype keys stay allowed
   (and are logged) — the prototype scripts keep working.
2. **Per key, operator choice on the dashboard (never in a post-update notice), per machine:**
   - *Adopt as legacy-shared:* the operator picks the account email from the pool's rows. The key is
     copied into the passkey store with `provenance: 'legacy-adopted'` and quarantined; adoption
     commits only after an identity-verified cold proof on that machine returns `ready` (mismatch ⇒
     reverted). Keys minted by another agent are recorded as cross-agent. Adopted keys carry a
     90-day re-mint target; past it they appear as `legacy-overdue` in the digest (never
     auto-deleted).
   - *Delete:* removed locally, reported with `google-side-pending-operator` (and every machine or
     agent still holding the same credential).
   - After either choice, that prototype key is removed from the shared SecretStore and generic
     reads of that name are refused.
3. **Re-mint cost, stated:** ending shared custody takes one human sign-in per (account × machine)
   for the peers — up to 14 on today's fleet. The dashboard shows the count; re-minting is optional
   and gradual.
4. Prototype scripts are deleted at Rung 2 exit (§7).

`migrateConfig()` adds the `passkeys` block with `enabled` left ABSENT (so the dev-agent gate
decides); `migrateClaudeMd()` adds the section behind a content-sniffing guard; the registry migration
adds `priorLoginMethod` and the `passkey` binding role. The backup manifest includes
`state/passkey-grants.json` and tombstones; after a restore without the credential file, cells show
`granted, credential absent`.

Config: `passkeys: { enabled: <absent → dev-agent gate>, repairUsesPasskey: false,
healthWatcher: { enabled: <absent → dev-agent gate>, intervalDays: 7, minGapMinutes: 10 },
enrollment: { maxPerCellPerDay: 3, minIntervalMinutes: 30 }, legacyRemintDays: 90 }`.

## 7. Rollout

- Enrollment is always a real, grant-gated, operator-initiated write to a Google account; it has no
  dry mode. The account row's `loginMethod` is the per-account selector; `repairUsesPasskey` is the
  machine-wide kill switch (false ⇒ repair never uses a passkey).
- **Rung 1 — test agent:** a throwaway agent, the local WebAuthn fixture, and one disposable Google
  account registered in the owned-identities registry: enroll, cold proof, revoke, restart-mid-mint
  resume, legacy adoption. Exit: all pass.
- **Rung 2 — development agent:** Echo's fleet with `repairUsesPasskey: true`. `google-passkey` is a
  new provider path under the parent's graduation rule — its own 30-day dark window and 10
  identity-correct repairs per provider, enforced by the (identity, loginMethod) evidence key.
- **Rung 3 — fleet:** on-by-default only after Rung 2 graduates; the watcher's fleet cadence is
  decided then (FD8).

## 8. Testing

- Unit: separate store file; older-build simulation never reads it; HMAC key path; own lock under
  concurrent writers; pending record encrypted/resumed/expired; machine-scope guard before CDP;
  grants deny by default, local authority, replicated rows advisory, revoke tombstone deletes on
  receipt, seq ordering; mandate type isolation both ways; method refusal without fall-through;
  graduation evidence keyed by login method; backup-code consumed-before-submit; supervisor input
  and logs exclude credentials and emails; page-class ordering fixtures.
- Integration: `/passkeys` and `/passkeys/cell-action` with PIN and mandate gating; enrollment state
  machine (crash between mint and store, identity mismatch, already-enrolled, rate limit, Workspace);
  secret-sync mixed-version batch; watcher state table including unverified, security and digest
  upsert (N failing cells ⇒ 1 item, re-notify only on set change).
- E2E: feature-alive through the production init path; pipe transport, about:blank-then-attach and
  popup auto-attach against a local WebAuthn fixture; cold proof against the fixture; Chrome
  version gate.
- Live (Live-User-Channel standard): on the dev agent, enroll one cell from a phone through the
  dashboard, prove it, then complete a real Claude and a real Codex repair unattended, including one
  on a peer machine started through the `passkey-cell` mandate.

## 9. Non-goals

- Relying parties other than Google.
- The agent deleting anything on Google's account pages (operator action this release).
- A general "import a credential" route (only the one-time legacy adoption, §6).
- Minting on a machine without the human's one action.
- Storing or using the human's own passkeys.
- Hardware-backed or OS-keychain-bound key wrapping (§17).

## 10. Decision points touched

| Decision point | Class | Justification / floor + arbiter |
|---|---|---|
| Machine-scope guard in `load()` | invariant | Provenance fact: minted here, or a verified adoption record. |
| Grant check before mint/load/selection | invariant | Local recorded operator fact; replicated rows never authorize; unreadable ⇒ deny. |
| Revoke tombstone application | invariant | Removal-only; applied on receipt. |
| Repair method selection | invariant | One method per tuple; no fall-through. |
| Unattended passkey repair admission | invariant | Parent's graduation rule, evidence keyed by (identity, loginMethod). |
| Credential-affecting browser actions (create, confirm, submit) | invariant | Fire only on exact structural class match. |
| Navigation choices on Google/provider pages | judgment-candidate | Floor: closed page classes (§3.6), closed action set (§3.7), exact-origin allowlist, confidence ≥ 0.95. Arbiter: parent's Tier-1 supervisor over redacted closed state. Ladder: self-unblock steps → `waiting-human-factor` → deterministic stop. |
| Identity match after mint and in proofs | invariant | In-port exact canonical-email equality; unreadable ⇒ `unknown`. |
| Proof verdict | invariant | §3.8 vocabulary; only `ready` counts. |
| Cell state transitions | invariant | §4 table. |
| Fleet-wide passkey suspension | invariant | ≥ 50% of cells credential-rejected in 24h. |
| Legacy key adopt/delete | invariant | Operator choice per key; adoption commits only on identity-verified `ready`. |

## 11. Symbols, states and corroboration (P20)

| Symbol | Claimed state | Independent corroboration | Unmeasurable ⇒ |
|---|---|---|---|
| Store entry present | this machine can sign in as E | Identity-verified cold proof (§3.8) | `unknown` → `unverified` after 3 |
| `getCredentials` returned a credential | Google registered the agent's passkey for E | In-port identity match, then a cold proof with only that credential | `mint-unverified`; pending record (encrypted, 24h) |
| Proof `ready` | the passkey signs in as E | Authenticator holds exactly the stored `credentialId`; identity match; the parent's oracle on the next real repair (recorded) | `unknown` |
| Grant row | operator authorized this cell | Written locally by PIN or verified mandate, with principal | deny |
| Adoption record | this legacy key belongs to E and works here | Identity-verified cold proof on this machine | adoption stays uncommitted |
| Revoke read-back | agent can no longer sign in as E here | Entry, pending record and binding absent; tombstone present | report exactly which location could not be verified |
| Google-side removal | Google no longer accepts the key | Operator attestation (not observed by the agent) | `google-side-pending-operator` persists |
| Workspace blocked | admin setting is off | Exact structural class match | `unknown` |
| Health row from a peer | that peer's cell state | Advisory display only; never acted on | `unobserved since <t>` |

## 12. Multi-machine posture

- Passkey credentials, pending records, proof/enrollment profiles: machine-local.
  `machine-local-justification: physical-credential-locality` — each key is minted into one
  machine's browser authenticator, lives on that disk, and is never moved; every machine gets the
  same capability by minting its own (operator-ratified per-machine design: FD2).
- Grant rows: unified as advisory replicated rows; authority is applied locally (§3.2).
- Revoke tombstones: unified; applied on receipt.
- Health state: unified as content-free advisory replicated rows; the audit log
  (`logs/passkey-health.jsonl`, states only, 30-day rotation) is machine-local.
  `machine-local-justification: physical-credential-locality` — each line records attempts made
  with that machine's credential.
- Account throttle pauses: unified advisory pool state.
- `GET /passkeys`: proxied-on-read (`?scope=pool`).
- Notices: one voice (serving-lease holder's digest).
- Config: per-machine by the existing `.instar/config.json` convention.

## 13. Self-heal before notify (health watcher)

- `recoverable`: a `failed` proof. Self-heal: one confirming proof 1h later in the same device-stable
  profile (a single retry; credential-rejected classes are excluded — they go to `security`).
  `unknown` results are retried only through the backoff in §4.
- Brakes: `max-attempts: 2`, `max-wall-clock: 90m`, `backoff: 1h then weekly`,
  `dedupe-key: passkey-health:digest` (one item) with per-cell rows,
  `breaker: 3 consecutive weekly confirmed failures ⇒ breaker-open`, flapping flag,
  `max-notification-latency: 24h` (a confirmed failure appears in the digest within 24h),
  `audit-location: logs/passkey-health.jsonl`.
- Remediation is read-only toward the account (sign-in attempts only) and idempotent.
- `security` and fleet-wide suspension update the digest on the same tick, no heal gate.

## 14. Frontloaded Decisions

1. **Default access:** none; per-(account × machine) operator grant; revoke deletes locally.
   (Operator, topic 33890, 2026-09-22.)
2. **Human cost accepted:** one sign-in per (account × machine); per-machine keys for revocation
   granularity. (Operator, topic 33890, 2026-09-20.)
3. **Google-side removal:** operator action + attestation this release. (Author, conservative.)
4. **Grants:** local authority; replicated rows advisory; tombstones replicate and act. (Author, per
   the replicated-store foundation's advisory-only rule.)
5. **Legacy keys:** per-key operator choice on the dashboard only; spread stopped fleet-wide first;
   generic reads refused only after the choice. (Author.)
6. **Import route:** none this release. (Author.)
7. **Other stored credentials for the account remain;** the grant screen inventories them;
   removing them is a separate operator decision. (Author; no behavior change.)
8. **Watcher fleet cadence:** decided at Rung 3 on measured throttle and notice data; until then it
   runs only where the dev-agent gate enables it. (Author; no fleet side-effect before the decision.)
9. **Run boundary:** the autonomous build ends at code that is live-but-inert on the dev agent (no
   grants ⇒ nothing happens) with unit, integration and fixture E2E green. After the run, as
   operator-involved steps tracked by a commitment: creating and registering the disposable Google
   account and running Rung 1; enrolling cells; per-key legacy choices; adding emails to the
   unattended allowlist; the live proof; graduation. (Author.)
10. **Relying party:** Google only. **Crypto:** the existing SecretStore envelope in a separate file.
    (Author.)
11. **Backup codes:** enrollment may consume one stored code per attempt; the notice reports the
    remainder. (Author; within the operator's grant.)

## 15. Rollback and downgrade

- Older builds ignore `.instar/secrets/passkeys/`; they refuse repair for `google-passkey` accounts
  rather than acting wrongly. Before a deliberate downgrade, `revert-method` restores prior methods.
- Increment 1's sync filter is harmless to older peers (they simply stop receiving prototype keys).

## 16. Differences from Dawn's standard

- `defaultBackupEligibility/State` flags are optional (both variants measured working on Google).
- Credential ranking is the same (the agent's own passkey first); this spec adds custody rules the
  standard leaves open (§3.1).
- Vault naming `Google Passkey - <email> @ <machine>` is replaced by an HMAC'd entry key; the email
  is inside the encrypted payload.
- The credential never leaves the server process except into CDP over a pipe (stricter than the
  standard's stdin-only handoff).

## 17. Alternatives considered for key custody

- **Existing SecretStore envelope in a separate file (chosen):** no new crypto; works on every
  platform Instar supports; honest about the same-user threat model (§1.1).
- **OS keychain item per credential:** on macOS it would add a per-item access prompt that an
  unattended agent cannot answer, or be configured "always allow", which gives no more protection
  against same-user code than the chosen design. Deferred.
- **Non-exportable hardware credential (Secure Enclave / TPM):** would be the real boundary, but
  Chrome's virtual authenticator requires an exportable private key, so it cannot be used with this
  mechanism. Would need a different mechanism; out of scope.

## Open questions

*(none)*
