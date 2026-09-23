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

## 10. Decision points touched

| Decision point | Class | Justification / floor + arbiter |
|---|---|---|
| Passkey store `load()` machine-scope guard (refuse if `mintedOnMachineId` ≠ local id) | invariant | A credential-provenance fact, not competing signals. Deterministic by design; the only override is the audited operator import (§3.5). |
| Grant check before mint/load/method-selection | invariant | Authorization is a recorded operator fact; no inference. Missing/unreadable grant record ⇒ deny. |
| Repair method precedence (live session → passkey → password) | invariant | Fixed ordering over methods the grant already covers; no signal competition. A failed method never falls through to an ungranted one. |
| Enrollment page-state classification (which Google screen is showing, which action to take) | judgment-candidate | Floor: the existing `assisted-subscription-relogin` §6.2 contract — closed page-class set, closed allowed-action set, exact-origin allowlist, confidence ≥ 0.95 else refuse. Arbiter: the Tier-1 supervisor over redacted closed state. Fallback ladder ends at the deterministic rung `waiting-operator-only` (stop and ask for the one human action). |
| `workspace-policy-blocked` classification | invariant | Matched on Google's closed policy-refusal page class, not prose interpretation; an unmatched refusal falls to the generic `waiting-operator-only` state, never to success. |
| Cold-proof verdict (ready / not ready) | invariant | Pass requires the authenticated-destination origin+path (§11). Anything else, including timeouts, is not-ready. |

## 11. Symbols, states and corroboration (P20)

| Symbol read | State it claims | Independent corroboration | When unmeasurable |
|---|---|---|---|
| Store key present | "this machine can sign in as E" | Cold proof (§3.6) from an empty profile; the key alone never marks a tuple ready | `unknown` — tuple stays at its previous method; repair does not select `google-passkey` |
| `WebAuthn.getCredentials` returned a credential after mint | "Google registered the agent's passkey" | Cold proof signs in with ONLY that credential | Enrollment ends `mint-unverified`; the backup file is kept for operator inspection |
| Cold proof reached `claude.ai` authenticated path | "Google session from the passkey is accepted by Claude" | The repair's own identity oracle + authenticated-use proof (unchanged from the parent spec) on the next real repair | `unknown`; the weekly health check reports it, it is never reported as healthy |
| Grant record | "the operator authorized this account on this machine" | Grant written only by the PIN/verified-operator route, with principal recorded | Unreadable grant store ⇒ deny |
| Revoke deleted store entry | "the agent can no longer sign in as E here" | Read-back shows the key absent AND a tombstone present; the Google-side passkey removal is reported separately as `removed` / `not-removed` | Report `local-deleted, google-side-unknown` — never "revoked" alone |

## 12. Multi-machine posture

- Passkey credentials: machine-local. `machine-local-justification: physical-credential-locality` — each credential is a per-machine WebAuthn key minted for revocation granularity; replicating it would recreate the cloned-authenticator shape this design exists to avoid.
- Grants: unified — replicated through the existing replicated-store foundation (operator decisions follow the agent); each machine still enforces its own `machines:` scope.
- `GET /passkeys`: proxied-on-read via `?scope=pool` (merged per-machine rows, dark-peer tolerant, same pattern as `/subscription-pool?scope=pool`).
- Enrollment episodes: machine-local. `machine-local-justification: physical-credential-locality` — the episode drives the browser profile that physically lives on that machine. The dashboard starts it on the target machine through the existing signed cross-machine action relay, as the Subscriptions grid already does for repairs.
- Cold-proof health notices: one voice — raised by the machine that owns the credential, deduped per (account × machine) episode.

## 13. Self-heal before notify (weekly cold-proof watcher)

- Degradation class: `recoverable` (a stale session or transient Google error). Self-heal: re-run the cold proof once after a backoff; if the credential itself is rejected, re-attempt with a fresh throwaway profile. Remediation actions are read-only with respect to the account (sign-in attempts only); nothing is minted or deleted by self-heal.
- Brakes: `max-attempts: 2`, `max-wall-clock: 30m`, `backoff: 10m`, `dedupe-key: passkey-proof:<email>:<machineId>`, `breaker: 3 failed weeks for the same key ⇒ critical, stop retrying`, `max-notification-latency: 24h` (≤ the registry ceiling), `audit-location: logs/passkey-health.jsonl` (states only).
- A credential Google reports as removed/revoked is `security` class: notify on the same tick, no heal gate.
- Throttle safety: a proof never presses "Continue" on an empty authenticator and stops on Google's "too many attempts" page class (counted as a failed week, not retried).

## 14. Frontloaded Decisions

1. **Default access:** none. Per-account, per-machine operator grant; revoke deletes the credential. (Operator, topic 33890, 2026-09-22.)
2. **Cost accepted:** one human sign-in per (account × machine). (Operator, topic 33890, 2026-09-20.)
3. **Weekly cold proof:** ships enabled only on development agents; fleet default off until graduation (§7). Each proof is a real Google sign-in, so fleet-wide cadence is decided at graduation on measured throttle data, not now.
4. **Prototype-credential adoption:** offered on the dashboard only, never in a post-update notice (a notice would invite adoption without the grant flow).
5. **Relying party scope:** Google only this release.
6. **Where credentials live:** the existing encrypted SecretStore under a reserved prefix, excluded from secret sync. No new crypto.

## Open questions

*(none)*
