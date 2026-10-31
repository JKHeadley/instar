---
title: "Operator PIN gates are a willpower boundary: make the operator trust boundary structural"
slug: "feedback-feedback-233b6e22-c85f-4c06-abff-131d8315b12e"
author: "echo"
status: draft
parent-principle: "Structure beats Willpower"
feedback-initiative: "feedback-233b6e22-c85f-4c06-abff-131d8315b12e"
feedback-cluster: "cluster-every-pin-gated-operator-action-is-a-willpower-boundary-not"
severity: critical
---

# Operator PIN gates are a willpower boundary: make the operator trust boundary structural

## Problem

Many routes are documented as "a Bearer token cannot do this; only the operator PIN can".
Examples: feedback readiness approval, approver-independence acceptance, enabling the money
layer and arming caps, arming the external-hog kill, issuing and revoking mandates, accepting
the stall matrix, and the guard's load-bearing accept-fallback. The promise to the operator is
that the agent cannot do these things alone.

The promise is not kept. The agent runs as the same OS user as the server. Anything the server
can read to check the PIN, the agent can read too. Anything the server trusts as "the PIN", the
agent can overwrite. So today, each of these gates holds only because the agent chooses not to
read or change a file it has access to. The constitution names this exact pattern: a rule
written in prose is a wish, and capability is not authority.

A second, smaller problem: the operator enters the PIN to unlock the dashboard and then again
for each action. If the threat is the agent, the second entry adds nothing, because the agent
gets past both the same way. If the per-action entry is meant to defend against a stolen
browser session, that should be stated. Today it is explained to operators as protection from
the agent.

## Evidence

### From the report (one report, operator-raised 2026-10-18, filed 2026-10-19)

- `dashboardPin` is a 6-character plaintext string in `.instar/config.json`, file mode `664`.
- The file viewer is configured with `allowedPaths: ["./"]`, the whole project directory.
- The reporter says the PIN was never used and that they told the operator so in writing.
  This report is about the guarantee being false, not about misuse.
- The evidence file says part of the report set was cut, but the one report it contains is
  complete.

### Confirmed in the current source tree

1. **File-browser read path: already closed.** `src/server/fileRoutes.ts` lists
   `.instar/config.json` in `NEVER_SERVED_PREFIXES` (the "round-17 security" comment). The
   check runs before `allowedPaths` (Layer 3b) and again after symlink resolution (Layer 5e),
   so `allowedPaths: ["./"]` does not reopen it. `config.json` is also in `KEY_MATERIAL_FILES`
   (`src/core/keyMaterialPaths.ts`), so a hard link to it under another name is refused too.
   Serve-deny also implies edit-deny. On a current build, the reporter's file-browser route is
   blocked. The report may describe an older build. This spec still asks for a pinned
   regression test for the exact reported setup (see Test plan).

2. **Plaintext at rest: still open.** `dashboardPin` is written as plaintext by
   `src/commands/server.ts` (auto-generate on startup, `liveConfig.set('dashboardPin', …)`),
   `src/core/PostUpdateMigrator.ts` (auto-generate when missing) and the PIN rotation path
   (`src/commands/server.ts`, `src/monitoring/CoherenceMonitor.ts`). `SecretMigrator` moves it
   into the encrypted vault only during `instar pair`, so single-machine agents keep it in
   plaintext.

3. **The vault does not fix this on its own.** `SecretStore` lives at
   `<stateDir>/secrets/config.secrets.enc`. Its master key comes from the same user's keychain
   or a file key. Any process running as that user can decrypt it: `mergeConfigWithSecrets`,
   `src/templates/scripts/secret-get.mjs`, and therefore the agent's shell.

4. **File mode is left to the umask.** No code sets an explicit mode on `config.json` writes,
   which is why the reporter saw `664`. This exposes the PIN to other local users as well.
   Even `0600` would not stop the agent, which is the file's owner.

5. **The server pushes the plaintext PIN into channels the agent can read.** These include the
   dashboard broadcast (`TelegramAdapter` → `pickDashboardPin`), the tunnel attach
   (`TunnelManager.attachTelegram`), and the upgrade notice (`UpgradeNotifyManager`:
   `"Dashboard PIN: ${dashboardPin}"`). The agent reads its own topics.

6. **Write path: the agent can also grant itself the PIN.** Because `config.json` (and the
   vault) are writable by the same user, the agent can set `dashboardPin` to a value it knows
   and wait for a reload or restart. No read is needed at all.

7. **About ten separate PIN checks.** `src/server/routes.ts` compares against
   `ctx.config.dashboardPin` at roughly 9 call sites (lines ~12116, 13853, 15584, 28972, 30021,
   30051, 34906, 35349), plus `src/server/AgentServer.ts` (~1287/1313). They differ in
   lockout handling (`checkMandatePin` uses `PinAttemptStore`; some sites do a plain compare).
   Any change to how the PIN is stored has to be made in every one of these places.

### Reproduction (test environment)

1. Start a test agent with default config. Confirm `dashboardPin` is plaintext in
   `.instar/config.json` and note its mode.
2. `GET /api/files/read?path=.instar/config.json` with the Bearer token. **Expected on current
   build: 403.** (This half is closed.)
3. As the same OS user, run `node -e` with `JSON.parse(fs.readFileSync('.instar/config.json'))`.
   The PIN is returned.
4. `POST /mandates` (or any `checkMandatePin` route) with Bearer plus the recovered PIN.
   **Today: 200.** The operator-only action is authorized by the agent.
5. Variant: overwrite `dashboardPin` in `config.json`, trigger a live-config reload, then use
   the chosen PIN. **Today: 200.**

## Proposed fix

No storage scheme on its own closes a same-user boundary. If the server can check the secret
using only data that user can read, the agent can obtain or replace that data. So the fix comes
in tiers. Each tier states plainly what it stops. Tiers 0 and 1 can ship without operator
decisions. Tier 2 needs an operator choice (see Open questions).

### Tier 0: correct the claims and close cheap leaks (ship first)

- **One verifier.** Replace every direct `ctx.config.dashboardPin` comparison with one
  `verifyOperatorCredential(req, { action, tier })` in a new `src/server/operatorAuth.ts`. It
  handles the timing-safe compare, the durable `PinAttemptStore` lockout, and an audit row per
  attempt. A lint/test guard fails the build if `dashboardPin` is read anywhere in
  `src/server/` outside this module. Later tiers depend on this.
- **Owner-only modes.** Write `config.json` and `secrets/` with `0600` / `0700` and fix the
  mode on startup if it is looser. This stops other local users, not the agent.
- **Keep the PIN out of agent-readable channels.** Stop putting the plaintext PIN into
  messages the agent's sessions read: the upgrade notice, and the dashboard broadcast's PIN
  line. Send the operator a link to the dashboard's "reveal PIN" view, which itself needs an
  unlocked session, or a one-time Secret-Drop-style reveal.
- **Keep the file-viewer deny pinned** with the regression test below. No behaviour change.
- **Honest wording.** Update the scaffolded agent instructions (`src/scaffold/templates.ts`,
  the matching `PostUpdateMigrator` block) and route error strings. "Mandate issuance is a
  human action, not an agent action" should become a description of what the gate actually
  protects against at the current tier, until Tier 2 ships. The operator should not be told
  these gates protect them from the agent while they do not.

**Stops:** other local users, a stolen Bearer token used from off-machine, casual or
accidental use by the agent. **Does not stop:** an agent shell running as the same user.

### Tier 1: store a verifier, not the PIN

- Replace `dashboardPin` with `dashboardPinVerifier`: a salted, memory-hard hash (scrypt or
  argon2id, about 250 ms per check), versioned so it can be upgraded later. Migrate on first
  start: hash the existing PIN, show it to the operator once through the unlocked dashboard,
  then delete the plaintext from `config.json` **and** the vault.
- The server no longer knows the PIN after it is set, so Tier 0's channel removal becomes
  mandatory. Rotation shows the new PIN once, to the operator only.
- Offer a longer operator-chosen passphrase. A 6-digit PIN has only 10^6 possible values, so a
  verifier slows offline guessing (about 3 CPU-days at 250 ms per guess) but does not prevent
  it. A passphrase of 10+ characters makes guessing impractical.
- **Tamper evidence for the write path.** Keep the verifier's hash (plus a counter) in a
  second, append-only audit record. Any change that did not come from the operator rotation
  route sets a "credential changed outside the operator flow" alarm on the dashboard and
  refuses PIN-gated actions until the operator re-confirms. This does not prevent a determined
  same-user rewrite, but it makes one visible rather than silent.

**Stops:** reading the secret out of a file, and silent overwrite. **Does not stop:** a
same-user agent that brute-forces a short PIN offline, or that rewrites the verifier and the
audit record together.

### Tier 2: anchor high-authority actions outside the agent's OS user (needs operator decision)

Only these give a structural guarantee. Pick one, or both in combination:

- **A. Operator passkey (WebAuthn, user verification required)** for actions classed
  `tier: "operator-only"`. The agent cannot produce a signature without the operator's device
  and biometric or PIN. To stop the agent from registering its own key, the trusted credential
  list must be **anchored**. A new credential can only be added with an assertion from an
  existing one, or the first one is enrolled with a code shown on the server console. Every
  change is announced to the operator. (The existing `Passkey*` modules are for the
  *agent-held* Google passkey. They are a different trust direction, but their WebAuthn
  plumbing may be reused.)
- **B. Privilege separation.** Run the operator-authority verifier (and ideally the server
  binary and its config) as a separate OS user, or behind a macOS Keychain item whose ACL
  needs user presence. The agent's user has no read or write access. This is the only option
  that also covers the agent editing server code.

Remaining risk, stated plainly: as long as the agent can modify the server's code and restart
it as the same user, A is strong but not absolute. B closes that gap at an operational cost.

### Double PIN entry (the operator's original complaint)

Name the threat model for each gate in the action registry that `verifyOperatorCredential`
consumes:

- **Session-scoped actions** (low or medium authority): unlocking the dashboard grants a short
  elevation window (for example 10 minutes, bound to that session cookie). No re-entry inside
  the window. This defends against a stolen or left-open session through the expiry, which is
  the only thing a second entry of the same PIN ever defended against.
- **Operator-only actions** (money, mandates, kill arming, approver independence): need the
  Tier 2 factor on every action. Until Tier 2 ships, they keep per-action PIN entry, with the
  honest wording from Tier 0.

## Test plan

- `tests/integration/file-routes-config-never-served.test.ts`: with `allowedPaths: ["./"]`,
  `read`, `download`, `list` and `link` on `.instar/config.json`, a case variant, a symlink and
  a hard link all return 403 and never include the PIN in the body. (Pins the half that is
  already closed.)
- `tests/unit/operator-auth-single-verifier.test.ts`: a source scan fails if
  `config.dashboardPin` is read in `src/server/**` outside `operatorAuth.ts`.
- `tests/unit/config-file-mode.test.ts`: after init, auto-generating the PIN and rotating it,
  `config.json` has mode `0600`.
- `tests/unit/upgrade-notify-no-pin.test.ts`: the upgrade notice and dashboard broadcast never
  contain the PIN.
- Tier 1: after migration, neither `config.json` nor the decrypted vault holds the plaintext
  PIN. The verifier accepts the right PIN and rejects a wrong one. A verifier changed outside
  the rotation route sets the alarm and refuses gated actions.
- Tier 2A: an operator-only route refuses PIN-only requests. It accepts a valid WebAuthn
  assertion from an anchored credential. It refuses a credential added without an existing
  credential's assertion.

## Open questions for the operator

1. Tier 2: passkey (A), privilege separation (B), or both? Which actions count as
   operator-only?
2. Is moving to an operator-chosen passphrase (instead of an auto-generated 6-digit PIN)
   acceptable for operator-only actions?
3. Elevation window length for session-scoped actions.

## Out of scope

- Multi-operator or delegated approvers.
- Redesigning Approval Links / Authorization Requests. Both call `checkMandatePin` and inherit
  the fix through the single verifier.
