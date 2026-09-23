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
approved: false
---

# Agent-Held Google Passkeys

## 1. Outcome and boundary

After ONE human action per (Google account × machine), an Instar agent can sign itself into that
Google account from an empty browser profile — no password, no code, no human — and therefore repair
every subscription that signs in through Google (today: Claude Code and Codex) without operator work.

This productizes a mechanism proven live on 2026-09-21/22 across 7 accounts × 3 machines with
standalone scripts. It is an extension of `assisted-subscription-relogin`, not a parallel system:
the passkey is a new **login method** the existing repair worker can use, plus the enrollment,
storage, grant and proof machinery that method needs.

The credential is the agent's OWN WebAuthn credential registered on the account (additive — the
human's password, passkeys and second factor are never touched). It is never the human's secret.

Public, account-free write-up of the method: https://telegra.ph/Hands-Off-Sign-In-for-AI-Agents-09-22-2

## 2. Mechanism (all load-bearing facts measured live)

1. **Virtual authenticator before navigation.** Every repair/enrollment browser page — including
   popups — gets `WebAuthn.enable {enableUI:false}` + `WebAuthn.addVirtualAuthenticator
   {protocol:ctap2, transport:internal, hasResidentKey, hasUserVerification, isUserVerified,
   automaticPresenceSimulation}` BEFORE its first navigation. Without it Chrome raises the OS
   platform-authenticator sheet and the page stops processing input.
2. **Mint.** From a session the human signed in once, the worker opens Google's passkey-creation
   page; the credential lands in the virtual authenticator; `WebAuthn.getCredentials` exports it.
3. **Use.** In any fresh profile, `WebAuthn.addCredential` with the stored credential, then navigate;
   Google authenticates with the resident credential (often with no identifier typed).
4. **Reach-through.** Claude's login accepts a live Google session (`claude.ai/login` → `/new`);
   Codex's device flow offers "Continue with Google". One credential repairs both.

Known constraints (measured): Google does not enforce the signature counter, but other relying
parties do — so credentials are minted per (account × machine) for revocation granularity and never
depended on as a shared copy. An authenticated profile cannot mint a second passkey ("You're all
set!"), so the agent cannot self-propagate to another machine. Workspace domains block passkey
sign-in until the admin enables "skip password at sign-in".

## 3. Components

### 3.1 `PasskeyCredentialStore` (new)

- Stores each credential in the existing encrypted `SecretStore` under a reserved, machine-scoped
  key `passkey:google:<canonical-email>:<machineId>`. Payload: `{credentialId, rpId, privateKey,
  userHandle, signCount, mintedOnMachineId, mintedAt, schemaVersion}`.
- **Machine-scope guard:** `load()` refuses a credential whose `mintedOnMachineId` ≠ the local
  machine id, BEFORE anything reaches `WebAuthn.addCredential`. (A shared import is an explicit,
  audited operator action — §3.5 — never implicit.)
- **Excluded from cross-machine secret sync.** The reserved prefix is on the sync deny-list; a
  passkey never travels between machines through `/secrets/sync-now`.
- Values never leave the store except into the CDP call inside the browser worker process; never
  into prompts, logs, ledgers, screenshots, API responses or the supervisor input.

### 3.2 Grants (deny-by-default)

- New per-agent grant record `passkeyGrants[]`: `{email, grantedBy (verified principal), grantedAt,
  machines: 'all' | machineId[]}`. Without a grant for `(email, this machine)` the store refuses to
  mint or load, and the repair worker cannot select the passkey method.
- Grant and revoke are dashboard-PIN (or verified-topic-operator signed action) only; a Bearer token
  is insufficient.
- **Revoke deletes the credential** from the store (and records a tombstone), not just the
  permission. The UI tells the operator that removing the passkey from the Google account page is the
  authoritative revocation and links to it; the agent attempts that removal itself when it still has
  a live session, and reports honestly when it could not.

### 3.3 Login method `google-passkey`

- `PlaywrightLoginMethod` and the relogin driver request gain `'google-passkey'`. A profile tuple with
  this method carries `vaultBindingNames: [<store key>]` (a name, never a value).
- The repair worker, when the resolved tuple's method is `google-passkey`: attaches the virtual
  authenticator to every page, loads the credential via §3.1, and otherwise runs the UNCHANGED
  contract of `assisted-subscription-relogin` §6.2 — origin allowlist, exact-identity checks,
  chooser/consent/challenge refusals, Tier-1 supervisor over closed state, CLI completion, identity
  oracle veto, authenticated-use proof.
- Allowed-origin additions for this method: `accounts.google.com` (sign-in only). Google account
  settings pages are NOT in the repair allowlist; they are only reachable by the enrollment worker.
- Precedence when several methods are registered for one tuple: live session → `google-passkey` →
  password-based. A passkey failure never falls through to a method the grant does not cover.

### 3.4 Guided enrollment (the one human action)

`POST /passkeys/enroll` (dashboard-PIN) starts an episode for `(email, this machine)`:

1. **Get in once.** The worker drives Google sign-in in the account's dedicated profile using
   whatever is already available (live session, stored password) and stops at the first human-only
   gate. The dashboard shows exactly one ask ("approve the prompt on your phone" / "enter the code").
   Timing handshake: the operator taps *Ready* first; only then does the worker trigger the prompt.
2. **Mint** (§2 step 2). If Google shows a confirm dialog, the dialog's own primary button is used.
3. **Durable before store:** the exported credential is written to a 0600 file inside the agent
   state dir before the SecretStore write, and that file is deleted only after a verified store
   read-back. A crash between mint and store leaves a recoverable credential, never an orphan.
4. **Cold proof** (§3.6). Only a passing proof marks the tuple `google-passkey` and ready.

Workspace pre-check: if Google refuses creation with the admin-policy message, the episode ends in a
named state `workspace-policy-blocked` with the exact admin-console path — never a generic failure.

### 3.5 Explicit shared import (operator-only escape hatch)

When a per-machine mint is temporarily impossible (e.g. Google throttling on a passkey-first
account), the operator may import an existing credential for this machine only. It is stored with
`importedFrom` provenance, shown as *shared* in the UI, and flagged for re-mint when possible.

### 3.6 Cold proof (no warm-profile passes)

A throwaway profile directory is created, only the passkey is injected, Google sign-in runs, then
`claude.ai/login` must redirect to an authenticated page (and for Codex-linked accounts, the Google
session must be accepted on the OpenAI sign-in origin without a password prompt). The throwaway
profile is deleted afterwards. Enrollment and a periodic health check (§4) both use this proof; a
warm-profile success never counts.

## 4. Health and surfaces

- `GET /passkeys` — per (email × machine): granted?, credential present?, minted/imported, last cold
  proof result + time, workspace-blocked. Names and states only; never credential material.
- Dashboard Subscriptions grid: a passkey badge per account×machine cell; enrollment and revoke
  controls behind the PIN; mobile-complete.
- A weekly cold-proof job (off by default for the fleet, on for the dev agent) re-proves each
  credential and raises ONE attention item per failing account, never per run.
- `GET /capabilities` and the CLAUDE.md template (Agent Awareness Standard) describe the feature and
  the one-sign-in-per-machine cost.

## 5. Privacy and security

- The agent holds one revocable, phishing-resistant key per account per machine — strictly smaller
  than the password+TOTP it replaces. The human's own factors are untouched (additive only;
  "Change authenticator app"-style destructive options are never taken).
- No page text is logged from Google or provider pages; only closed page classes.
- Credential export happens only inside the worker; the parent receives `{stored: true, keyName}`.
- Grants bind to verified principals (Know Your Principal); the passkey never widens which accounts
  a repair may target — the unattended identity allowlist still gates repair per account.
- Headless machines refuse browser methods rather than attempting to open a browser.

## 6. Migration parity

- `migrateConfig()` adds the `passkeys` block (disabled, dry-run) for existing agents.
- An idempotent migration offers to adopt credentials already stored by the prototype scripts
  (`google_passkey_<name>_<machine>` vault keys) into §3.1, re-validating the machine stamp and
  requiring an operator grant; nothing is adopted silently.
- CLAUDE.md template section via `migrateClaudeMd()` with a content-sniffing guard.

## 7. Rollout

Dark on the fleet, live + dry-run on the development agent (dev-agent gate). Dry-run performs
enrollment and cold proofs in throwaway profiles but does not change which login method repair uses.
Graduation: the dev fleet's 7 accounts × 3 machines complete an unattended repair via the built-in
path, then the prototype scripts are deleted.

## 8. Testing

- Unit: store machine-scope guard (refusal happens before injection), grant deny-by-default, revoke
  deletes, sync deny-list, method precedence, supervisor input excludes credential material.
- Integration: `/passkeys` routes with PIN gating; enrollment state machine including crash between
  mint and store; `workspace-policy-blocked` classification.
- E2E: feature-alive test through the production init path; a cold-proof against a local WebAuthn
  relying party fixture (no live Google in CI).
- Live proof (Live-User-Channel standard): dev agent enrolls one account on one machine through the
  dashboard from a phone, then completes a real Claude and Codex repair unattended.

## 9. Non-goals

- Relying parties other than Google in this release (the mechanism generalizes; the proof does not).
- Automatic minting on a new machine without the human's one action (impossible — §2).
- Storing or using the human's own passkeys.

## Open questions

1. Should the weekly cold proof ship enabled for the fleet once graduated, given each run is a real
   Google sign-in?
2. Should prototype-credential adoption (§6) be offered in the post-update notice, or only on the
   dashboard?
