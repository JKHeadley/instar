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
approved: false
---

# Agent-Held Google Passkeys

## 1. Outcome and boundary

After ONE human action per (Google account × machine), an Instar agent can sign itself into that
Google account from an empty browser profile and therefore repair every subscription that signs in
through Google (today: Claude Code and Codex) without operator work.

This productizes a mechanism proven live on 2026-09-21/22 with standalone scripts. It EXTENDS
`assisted-subscription-relogin` (the parent): the passkey is a new **login method** the existing
repair worker can use, plus the enrollment, custody, grant, proof and migration machinery that
method needs. Every parent guarantee (trigger admission, unattended identity allowlist, Tier-1
supervised browser worker, identity-oracle veto, authenticated-use proof, breakers) is unchanged.

Prior art: Dawn's *Agent Account Sharing Standard* (SageMindAI/the-portal
`docs/standards/agent-account-sharing.md`) and the account-free public write-up
(https://telegra.ph/Hands-Off-Sign-In-for-AI-Agents-09-22-2, reviewed: contains no account
identifiers). Differences from Dawn's standard are listed in §15.

### 1.1 What this credential is — stated honestly

The agent's credential is a WebAuthn key pair registered on the Google account as an additional
passkey. It is stored as **exportable software key material** (a private key the agent can inject
into a virtual authenticator). Consequences, stated rather than implied away:

- It is **origin-bound** (it only signs for `google.com`), so it cannot be phished by a look-alike
  site. It is **not hardware-bound**: anyone who reads the stored key can use it from anywhere.
- It is a **complete Google sign-in**: whoever holds it has the whole Google account (mail, drive,
  settings, every "Sign in with Google" service), not just Claude and Codex.
- Its advantages over the password + 2FA route are real but narrower: the human's own password,
  passkeys and 2FA are never read or changed; it is one key per account per machine; and it can be
  removed on Google's security page without disturbing anything else.
- A leak of this key is treated exactly as a leak of the account's password. Custody (§3.1) is
  designed to that standard.
- Enrollment still uses whatever the agent already has (a live session, a stored password). This
  feature does not remove those; §14 FD7 records that keeping them is an explicit operator choice.

## 2. Mechanism (measured live)

1. **Virtual authenticator before navigation.** A page that may reach Google gets
   `WebAuthn.enable {enableUI:false}` + `WebAuthn.addVirtualAuthenticator {protocol:ctap2,
   transport:internal, hasResidentKey, hasUserVerification, isUserVerified,
   automaticPresenceSimulation}` before its first navigation. Without it Chrome raises the OS
   platform-authenticator sheet and the page stops processing input.
2. **Mint.** From a session signed in to account E, the worker opens Google's passkey-creation page;
   the credential lands in the virtual authenticator; `WebAuthn.getCredentials` exports it.
3. **Use.** In a fresh profile, `WebAuthn.addCredential`, then navigate to Google sign-in; Google
   authenticates with the resident credential.
4. **Reach-through.** Claude's login accepts a live Google session; Codex's device flow offers
   "Continue with Google". One credential repairs both.

Measured constraints: Google does not enforce the signature counter (other relying parties do); an
authenticated profile cannot mint a second passkey ("You're all set!"), so the agent cannot
self-propagate to another machine; Workspace domains block passkey sign-in until the admin enables
"skip password at sign-in". `signCount` is not written back after use; that is correct for Google
only and is one reason this release is Google-only (§9).

## 3. Components

### 3.1 Custody — `PasskeyCredentialStore` (new)

- **Key path:** `googlePasskeys.<emailKey>.<machineId>` where `emailKey` = lowercase hex SHA-256 of
  the canonical email (dot-free — `SecretStore` splits paths on `.`). Payload:
  `{credentialId, rpId, privateKey, userHandle, signCount, canonicalEmail, mintedOnMachineId,
  mintedAt, googleCreatedAt?, provenance: 'minted' | 'legacy-adopted', schemaVersion}`.
- **Never syncs.** `googlePasskeys` is added to `LOCAL_ONLY_SECRET_PREFIXES` (`src/core/SecretSync.ts`),
  which both the push filter and the receive refusal enforce. The prototype names
  (`google_passkey_*`, a single top-level segment) are added as a local-only **name pattern**
  (a new exact-prefix-of-first-segment rule alongside the existing segment rule). Unit tests push a
  real dotted email and a prototype name through `filterSecretsForSync` and the receive path.
  `AccountCredentialShare` (WS5.2) refuses both, with a test.
- **Not readable by generic paths.** The `googlePasskeys` prefix and the prototype pattern are
  refused by `secret-get.mjs`, `SecretManager`'s generic get, backup-from-config, and every generic
  `SecretStore` read API; only `PasskeyCredentialStore`, constructed once by the server and handed
  to the passkey worker, can decrypt them. Their names are omitted from the session boot
  self-knowledge block. Tests prove each generic path refuses.
- **Machine-scope guard (invariant):** `load()` returns a credential only when
  `mintedOnMachineId === localMachineId`, or an operator-confirmed adoption record for this machine
  exists (§6). The check runs before anything reaches CDP. A local machine-id change (reinstall /
  identity recovery) yields the named state `machine-id-changed`, never a silent load.
- **Writes are serialized.** All store writes take a cross-process lock (`proper-lockfile`, the
  pattern `AgentRegistry` uses) around read-modify-write of the encrypted store, then re-read after
  release to verify. This also protects against the existing secret-sync receiver writing
  concurrently.
- **Crash-safe mint without plaintext on disk.** Between export and the verified store write, the
  credential is held in a pending record at `.instar/secrets/passkey-pending/<emailKey>.enc`,
  encrypted with the SecretStore master key (same AES-GCM envelope). `.instar/secrets/` is already
  excluded from BackupManager, git-sync, the file viewer and publishing; tests assert the pending
  directory is covered. The pending record is deleted after verified read-back; a leftover is
  resumed on restart (never re-minted), expires after 24h (deleted, one aggregated notice), and is
  deleted on revoke.
- **In-memory lifetime.** The credential is decrypted once per worker episode. It is added to the
  virtual authenticator only while the top-level page origin is exactly `accounts.google.com`, and
  removed (`WebAuthn.removeCredential`) as soon as a Google session is established or the page
  leaves that origin.
- **Debug channel.** A browser that holds a passkey is launched with `--remote-debugging-pipe`, not
  a TCP debugging port, so another same-user local process cannot attach and call
  `WebAuthn.getCredentials`. Threat model: a process running as the same OS user with arbitrary
  file access can still read the encrypted store's key material through the master key; this
  feature does not claim protection against a fully compromised user account.

### 3.2 Grants (deny-by-default, machine-local authority)

- A grant `{canonicalEmail, machineId, grantedBy (verified principal), grantedAt}` authorizes mint
  and load of that one (account × machine) cell. No `'all'` wildcard.
- **Authority is machine-local.** Each machine enforces only grants recorded in its own
  `state/passkey-grants.json`, written by: the dashboard-PIN route on that machine, or a
  signed cross-machine action (`passkey-grant` / `passkey-revoke`) through the existing signed
  repair relay (`/subscription-relogin/repair-cell` action set, extended), which verifies the
  operator mandate on the receiving machine. The PIN never crosses the mesh. Other machines' grant
  rows are visible only through the proxied read (§12); they carry no authority.
- **Revoke always wins.** A revoke is applied even if a grant for the same cell arrives later with an
  older timestamp.
- **Revoke deletes locally, and says what it didn't do.** Revoke deletes the store entry, the
  pending record, and the profile tuple's passkey binding, writes a tombstone, and verifies by
  read-back. Removing the passkey from the Google account is the **operator's** action in this
  release: the revoke result shows the credential's `googleCreatedAt` and a link to Google's
  passkey page, and reports `local-deleted, google-side-pending-operator`. An offline target
  machine reports `pending-remote-delete` until the signed action lands. The agent never deletes
  anything on Google's pages in this release (§9).
- Every grant, mint, adoption and revoke notice names what changed and which agents or sessions
  depend on that account (from the pool and profile registry).

### 3.3 Login method `google-passkey` and the code it touches

- `PlaywrightLoginMethod` gains `'google-passkey'`; `vaultBindings` gains a `passkey` role holding
  the store key name (never a value). The account row keeps ONE `loginMethod`. Enrollment records
  the replaced method in a new `priorLoginMethod` field.
- Changes required (named so the build cannot miss one): `SUPPORTED_LOGIN_METHODS` in
  `SubscriptionReloginPolicy.ts`; `autonomousLoginMethod()` in `SubscriptionReloginRuntime.ts`;
  the driver request's `loginMethod` union in `AnthropicReloginBrowserDriver.ts`. A test drives a
  `google-passkey` tuple through the runtime (not just the type).
- **No fall-through.** A passkey failure never falls back to another method. It ends in a named
  refusal. The live Google session in the dedicated profile is used first, as today, because it is
  the same account and the same method's normal path.
- **Rollback.** An older build reading `google-passkey` refuses repair for that account
  (`login-method-not-autonomous`) — safe, not silent. `POST /passkeys/revert-method` (PIN) restores
  `priorLoginMethod` for all accounts on a machine before a deliberate downgrade; the release note
  says so.
- **Origin allowlist additions** for the repair worker: `accounts.google.com` only. Google account
  settings pages are reachable only by the enrollment worker, and only the passkey-creation page.

### 3.4 Browser foundation changes (`ChromeCdpReloginBrowser`)

The current browser creates tabs with `/json/new?<url>`, which navigates immediately, on one socket
with no popup handling. That cannot satisfy §2.1. Required changes:

- create every target at `about:blank`, attach the virtual authenticator, then navigate;
- `Target.setAutoAttach {autoAttach:true, waitForDebuggerOnStart:true, flatten:true}` so popups are
  paused until the authenticator is attached, then resumed;
- a test fails if any navigation to a Google origin happens before the attach completes;
- **real input clicks** (`Input.dispatchMouseEvent` at the element's box) for Google choice-list
  items — measured 2026-09-21: script-level `element.click()` does not advance Google's list screens;
- password fields filled and read back to verify length before submit (existing driver rule, kept);
- `--remote-debugging-pipe` for passkey-method sessions (§3.1).

### 3.5 Closed page classes (new, with fixtures)

The parent's closed page-class set gains: `google-passkey-challenge`, `google-passkey-create`,
`google-passkey-create-confirm` (the dialog whose button repeats "Create a passkey"),
`google-already-enrolled` ("You're all set"), `google-passkey-throttled` ("too many attempts"),
`google-workspace-policy-blocked`, `google-account-identity` (the page from which the signed-in
email is read). Each class is matched on structural predicates (origin, path, element roles and
stable identifiers) with text only as a secondary signal, has a redacted fixture in the canary
corpus, and an unmatched page is `unknown` — never success. Class drift (a fixture no longer
matching a live page) is reported by the parent's supervisor-disagreement metric.

### 3.6 Guided enrollment (the one human action)

`POST /passkeys/enroll {email}` (dashboard PIN; or the signed `passkey-enroll` relay action for
another machine). Preconditions: a grant for the cell, a registered dedicated profile for E, a
display-capable machine (the parent's browser-availability predicate), no enrollment or repair
episode already owning the cell.

- **One episode per cell, idempotent.** A second call returns the existing episode. A leftover
  pending record resumes at "store" rather than re-minting.
- **Rate limit.** At most one enrollment attempt per cell per 30 minutes and 3 per day, counted in a
  durable per-account attempt counter shared with the proof watcher.
- **Closed action set:** navigate to the allowlisted page, fill the account's email, fill the
  stored password (only if the tuple already binds one — the grant covers methods already bound to
  the tuple), choose "Try another way"/"Enter your password" on a passkey-first account, click
  "Create a passkey", click the create-confirm dialog's own button, click "Not now" on a
  platform-passkey speedbump. Anything else refuses. Never "Continue" on an empty authenticator.
- **Self-unblock first.** Before asking the human, the worker tries, in order: the dedicated
  profile's live session; the stored password plus any stored TOTP or backup codes; a fresh
  throwaway profile (one retry). Only a genuine second-factor prompt the agent holds no answer for
  (`waiting-human-factor`) or a CAPTCHA/risk page produces the human ask.
- **The human ask.** The dashboard shows exactly one ask ("approve the prompt on your phone" /
  "enter the code"). The operator taps *Ready*; only then does the worker trigger the prompt.
- **Mint, then verify identity before storing.** After mint, the worker opens the
  `google-account-identity` page and reads the signed-in email; it must equal E exactly (the same
  canonical form as `subscription-account-email-invariant`). Mismatch ⇒ discard the credential,
  state `identity-mismatch`, one notice; nothing stored. `userHandle` is bound into the record.
- **Store, then cold proof (§3.7).** Only a passing proof sets the tuple to `google-passkey`.
- **Workspace:** `google-workspace-policy-blocked` ends the episode with the exact admin-console
  path in plain words.

### 3.7 Cold proof (identity-verified, no warm passes)

- A throwaway profile under `.instar/state/passkey-proof/` (0700, capped at 2 concurrent, swept at
  boot and every tick through SafeFsExecutor) gets only the passkey. The worker signs in to Google,
  then reads the signed-in email on `google-account-identity`; it must equal E. That is the proof.
- Optional per-framework reach-through (Claude, Codex) is a separate, informational check; an
  outage, challenge or timeout there is `unknown`, not a failure, and never creates provider
  accounts (it is only run for providers the pool already maps to E).
- Proofs never run a provider CLI and never touch a live config home.
- Result vocabulary: `ready` (identity-verified), `failed` (credential rejected / identity
  mismatch), `unknown` (transport, outage, unmatched page, throttled). Only `ready` counts as ready.

## 4. Health watcher (deterministic in-server tick)

- Not a scheduler job and not an LLM session: a deterministic tick inside the server
  (`passkeyHealth`, tier0 — it only calls the Tier-1-supervised proof worker, whose supervision is
  the parent's).
- Cadence: each cell proven once per 7 days at a per-machine jittered time; cells run one at a time,
  ≥ 10 minutes apart; each proof acquires the host `PlaywrightSeatLease` for that cell only, yields
  to any pending repair, and never holds the seat across a wait.
- **Throttle safety:** a `google-passkey-throttled` page pauses all proofs for that account for 24h
  and all proofs on that machine for 1h. A proof never presses "Continue" on an empty authenticator.

State per cell: `healthy → degraded → breaker-open`.

| Transition | Rule |
|---|---|
| healthy → degraded | a `failed` proof after self-heal is exhausted |
| degraded → healthy | a later `ready` proof |
| degraded → breaker-open | 3 consecutive weekly `failed` proofs; proofs stop for that cell |
| breaker-open → healthy | a successful re-enrollment or an operator-triggered `ready` proof |
| any → security | `google-passkey-challenge` rejecting a credential on 2 consecutive attempts with a closed "passkey removed/unknown" class; no retry, immediate notice |

`unknown` results never advance any transition.

## 5. Surfaces and notices

- `GET /passkeys` — per cell: granted, custody state (present/pending/machine-id-changed/
  legacy-adopted), health state, last proof result and time, Workspace blocked. Names and states
  only. `?scope=pool` merges peers through the shared per-peer poll cache (WS4.4(f)), dark-peer
  tolerant.
- Dashboard Subscriptions grid: a passkey badge per cell; grant / enroll / revoke / adopt controls
  behind the PIN; mobile-complete.
- **Bounded notices:** the serving-lease holder raises at most ONE aggregated attention item per
  sweep, listing all degraded cells (count + list); security-class cells raise one aggregated item
  on the same tick. Per-cell detail lives only on `GET /passkeys`.
- `GET /capabilities` and the CLAUDE.md template (Agent Awareness Standard) describe the feature,
  the one-sign-in-per-machine cost, and the §1.1 security statement.

## 6. Migration parity (including today's prototype keys)

Live state at spec time: seven prototype keys — `google_passkey_{echo,dawn,adriana,justin,
gearfinity}_studio` (minted on the Studio), `google_passkey_headley_shared` (a copy of Dawn's
credential) and `google_passkey_amrch` (minted on the Studio, unsuffixed). All were pushed to the
Mini and Laptop through secret sync, and the fleet's current hands-off repairs depend on those copies.

- **Stop the spread first:** the local-only name pattern (§3.1) ships in the first increment, so no
  further copies move.
- **Never delete silently, never break working repairs:** on each machine, the migration lists the
  prototype keys present and shows them on the dashboard. The operator chooses per key:
  *adopt as legacy-shared* (copied into `googlePasskeys.*` with `provenance: 'legacy-adopted'` and an
  operator-confirmed adoption record for this machine; keeps working; flagged for re-mint) or
  *delete*. Nothing is adopted or deleted without that choice. Prototype keys are removed from the
  generic store once adopted or deleted.
- **Re-mint cost, stated:** ending shared custody means one human sign-in per (account × machine)
  for the peers: up to 14 on today's fleet. The dashboard shows this count; re-minting is optional
  and can happen gradually.
- `migrateConfig()` adds the `passkeys` block (below); `migrateClaudeMd()` adds the section with a
  content-sniffing guard; the registry migration adds `priorLoginMethod` and the `passkey` binding
  role.

Config (`.instar/config.json`): `passkeys: { enabled: <dev-agent gate>, repairUsesPasskey: false,
healthWatcher: { enabled: <dev-agent gate>, intervalDays: 7, minGapMinutes: 10 },
enrollment: { maxPerCellPerDay: 3, minIntervalMinutes: 30 } }`.

## 7. Rollout

- **What "dry-run" means here:** enrollment is always a real, grant-gated, operator-initiated write
  to a Google account — it has no dry mode. `repairUsesPasskey: false` means the repair worker never
  selects `google-passkey` even for enrolled accounts; the health watcher still proves cells.
- **Rung 1 — test agent:** a throwaway agent, the local WebAuthn relying-party fixture, and one
  disposable Google account: enroll, cold proof, revoke, restart-mid-mint resume. Exit: all pass.
- **Rung 2 — development agent:** Echo's fleet, `repairUsesPasskey: true` per account.
  `google-passkey` is a NEW provider path under the parent's graduation rule — its own dark window
  (30 days) and its own 10 identity-correct repairs per provider; evidence from password-path
  repairs does not carry over.
- **Rung 3 — fleet:** flags flip to on-by-default only after Rung 2 graduates. The prototype scripts
  are deleted at Rung 2 exit.

## 8. Testing

- Unit: key path with real dotted emails; local-only enforcement on push AND receive for both the
  new prefix and the prototype pattern; generic read paths refuse; boot block omits names; machine-
  scope guard runs before CDP; grants deny by default, revoke wins, no wildcard; locked writes with
  concurrent writers; pending record encrypted, resumed, expired; method refusal without
  fall-through; supervisor input excludes credential material.
- Integration: `/passkeys` routes with PIN gating; relay actions verify the mandate; enrollment state
  machine including crash between mint and store, identity-mismatch discard, rate limit,
  Workspace class; watcher aggregation (N failing cells ⇒ 1 item).
- E2E: feature-alive through the production init path; about:blank-then-attach ordering and popup
  auto-attach against a local WebAuthn fixture; cold proof against the fixture.
- Live (Live-User-Channel standard): on the dev agent, enroll one cell from a phone through the
  dashboard, prove it, then complete a real Claude and a real Codex repair unattended, including one
  on a peer machine started through the relay.

## 9. Non-goals

- Relying parties other than Google.
- The agent deleting anything on Google's account pages (operator action in this release).
- A general "import a credential from elsewhere" route (only the one-time legacy adoption in §6).
- Minting on a new machine without the human's one action (impossible — §2).
- Storing or using the human's own passkeys.

## 10. Decision points touched

| Decision point | Class | Justification / floor + arbiter |
|---|---|---|
| Machine-scope guard in `load()` | invariant | Provenance fact (minted here, or operator-confirmed adoption record). No inference. |
| Grant check before mint/load/method-selection | invariant | Recorded operator fact on this machine; unreadable ⇒ deny. Revoke wins. |
| Generic secret-read refusal for passkey paths | invariant | Namespace rule; no exceptions. |
| Repair method selection | invariant | The tuple has one method; no precedence, no fall-through. |
| Enrollment/proof page-state → action | judgment-candidate | Floor: closed page-class set (§3.5), closed action set (§3.6), exact-origin allowlist, confidence ≥ 0.95. Arbiter: parent's Tier-1 supervisor over redacted closed state. Ladder: self-unblock steps (§3.6) → `waiting-human-factor` → deterministic stop. |
| Identity match after mint and in every proof | invariant | Exact canonical-email equality read from Google's own identity page; unreadable ⇒ `unknown`, never ready. |
| Proof verdict (`ready`/`failed`/`unknown`) | invariant | `ready` only on identity match; transport/outage/unmatched ⇒ `unknown`. |
| Security-class escalation | invariant | Closed rejection class on 2 consecutive attempts; anything else stays recoverable. |
| Legacy key adoption or deletion | invariant | Operator choice per key; no default action. |

## 11. Symbols, states and corroboration (P20)

| Symbol | Claimed state | Independent corroboration | Unmeasurable ⇒ |
|---|---|---|---|
| Store entry present | this machine can sign in as E | Identity-verified cold proof (§3.7) | `unknown`; not ready |
| `getCredentials` returned a credential | Google registered the agent's passkey for E | Signed-in email read on Google's identity page equals E; then a cold proof using only that credential | `mint-unverified`; pending record kept (encrypted, 24h) |
| Cold proof `ready` | the passkey signs in as E | The parent's identity oracle + authenticated-use proof on the next real repair (recorded, not required for `ready`) | `unknown` |
| Grant record | operator authorized this cell | Written only by the PIN route or a mandate-verified relay action, with principal | deny |
| Revoke read-back | agent can no longer sign in as E here | Store entry, pending record and binding absent; tombstone present | report exactly which location could not be verified |
| Google-side passkey state | whether Google still accepts it | Not observed by the agent in this release | reported as `google-side-pending-operator` |

## 12. Multi-machine posture

- Passkey credentials and pending records: machine-local. `machine-local-justification: physical-credential-locality` — each is a per-machine key whose value is copying-sensitive by design.
- Grant records: machine-local authority. `machine-local-justification: physical-credential-locality` — a grant authorizes loading a machine-local credential; cross-machine management goes through signed relay actions, and a read-only merged view is proxied (below).
- Enrollment episodes and proof profiles: machine-local. `machine-local-justification: physical-credential-locality` — they drive the browser profile that physically lives on that machine.
- Health state and `logs/passkey-health.jsonl` (states only, 30-day rotation): machine-local. `machine-local-justification: physical-credential-locality` — describes one machine's credential.
- `GET /passkeys`: proxied-on-read (`?scope=pool`).
- Notices: one voice — the serving-lease holder aggregates.
- Config block: per-machine by design, like the rest of `.instar/config.json`.

## 13. Self-heal before notify (health watcher)

- Class `recoverable` for a `failed` proof. Self-heal: one retry after 10 minutes with a fresh
  throwaway profile, only for transport-level failures. A credential rejection is not retried
  (retries add failed attempts on Google's side).
- Brakes: `max-attempts: 2`, `max-wall-clock: 30m`, `backoff: 10m`,
  `dedupe-key: passkey-health:<emailKey>:<machineId>`, `breaker: 3 consecutive failed weeks ⇒
  breaker-open` plus flapping (3 degraded↔healthy flips in 30 days ⇒ critical),
  `max-notification-latency: 24h` (the first confirmed failure after self-heal notifies within 24h),
  `audit-location: logs/passkey-health.jsonl`.
- Remediation actions are read-only toward the account (sign-in attempts only); idempotent.
- `security` class notifies on the same tick (aggregated), no heal gate.

## 14. Frontloaded Decisions

1. **Default access:** none; per-(account × machine) operator grant; revoke deletes locally.
   (Operator, topic 33890, 2026-09-22.)
2. **Human cost accepted:** one sign-in per (account × machine). (Operator, topic 33890, 2026-09-20.)
3. **Google-side removal:** operator action via link in this release; the agent does not delete on
   Google's pages. (Author, conservative; revisit only with a new spec.)
4. **Grants:** machine-local authority + signed relay actions; no replicated-authority grants.
   (Author, per the replicated-store foundation's advisory-only rule.)
5. **Legacy adoption:** dashboard only, operator chooses per key; never in a post-update notice.
   (Author.)
6. **Import route:** not in this release. (Author.)
7. **Keeping stored passwords after a passkey exists:** unchanged by this feature; removing them is a
   separate operator decision. The grant screen states that both are kept. (Author; no behavior
   change.)
8. **Health-watcher fleet cadence:** decided at Rung 3 on measured throttle data; until then the
   watcher runs only where the dev-agent gate enables it. (Author; fleet side-effect-free until
   decided.)
9. **Run boundary for the autonomous build:** the build run ends at dark code plus unit,
   integration and fixture E2E green. The live proof, adding emails to the unattended allowlist,
   legacy adoption choices and graduation are operator-involved steps after the run, tracked by a
   commitment. (Author.)
10. **Relying party scope:** Google only. **Where credentials live:** the existing SecretStore
    envelope, no new crypto. (Author.)

## 15. Differences from Dawn's standard

- `defaultBackupEligibility/State` flags are optional here (both variants measured working on Google).
- Credential ranking is the same (agent's own passkey preferred); this spec adds custody rules the
  standard leaves to the implementer (§3.1).
- Dawn's vault naming (`Google Passkey - <email> @ <machine>`) is replaced by the hashed key path;
  the email is inside the encrypted payload.
- Handoff over stdin only (Dawn) is satisfied more strictly: the credential never leaves the server
  process except into CDP over a pipe.

## Open questions

*(none)*
