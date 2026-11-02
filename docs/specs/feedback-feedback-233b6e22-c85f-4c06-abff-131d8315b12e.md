---
title: "Dashboard PIN as a structural operator boundary — stop handing out the secret, one unlock per visit, and a credential the agent cannot produce"
slug: "feedback-feedback-233b6e22-c85f-4c06-abff-131d8315b12e"
author: "echo"
status: "draft"
parent-principle: "Structure beats Willpower"
lessons-engaged: "Structure beats Willpower; Self-Unblock rung FLOOR (capability is not authority); Know Your Principal; L15 Authorization Policy; Verify the State Not Its Symbol; Archiving May Never Mean Deleting; Migration Parity; Maturation Path"
related-feedback: "feedback-233b6e22-c85f-4c06-abff-131d8315b12e (cluster-every-pin-gated-operator-action-is-a-willpower-boundary-not); fb-bc5da66f-f46 (same measurement, cited by telegram-button-approval.md G1–G2)"
related-specs: "docs/specs/telegram-button-approval.md (§4 names this as the sibling spec `dashboard-pin-structural`, ACT-113's deliverable); docs/specs/telegram-callback-class-map.md; docs/specs/mobile-pairing-link.md (§2.1, §2.6); docs/specs/money-layer-operator-enable-surface.md (plan/commit nonce); docs/specs/DASHBOARD_ACCESS_SPEC.md (PIN Handling section, superseded here)"
---

# Dashboard PIN as a structural operator boundary

**Answer in one paragraph.** The report is right about the shape of the problem and partly out of date about
one mechanism. On a single-machine install the dashboard PIN is a six-character plaintext field in
`.instar/config.json` (mode 664), the agent reads it with ordinary tools, and every route whose instructions
say "a Bearer token cannot do this; only the operator PIN can" is in fact gated by the agent choosing not to
read a file it can read. The file-browser half no longer reproduces on current `main`: `.instar/config.json`
has been in the file viewer's hard-coded never-served list since PR #1905, and a unit test pins it. But the
PIN also reaches the agent through five other emitters (Telegram broadcast, boot log, upgrade notice, the
`fix dashboard` reply, and the agent's own instructions telling it to read the PIN from config), so closing
the file viewer alone would not have changed the boundary. This spec (the sibling spec that
`telegram-button-approval.md` §4 calls `dashboard-pin-structural`) does three things in order: **R1** stops
every emitter, rotates the PIN and the API token once, migrates the PIN into the vault on every install,
announces every PIN-approved operator act to the operator so a forged approval is visible, moves the P-class
Telegram taps to the dashboard in the same release, and rewrites the agent instructions to say what the PIN
does and does not protect. **R2** lets one dashboard unlock cover a visit's approvals (the operator's actual
complaint) through one shared operator-proof chokepoint that replaces the 31 `checkMandatePin` callers and
the seven direct comparisons. **R3** moves P-class authority onto a WebAuthn passkey on the operator's own
device, which no session on the host can produce, and makes PIN-minted sessions view-only for P-class
routes. What none of this achieves is also stated: on one OS user, an agent that rewrites the checking code
or its state can still pass; the measure is how deliberate and how visible that has to be.

## 1. Problem statement

The operator said (2026-10-18) that entering the PIN per action feels redundant because he already typed it to
open the dashboard. The reporting agent verified why the friction buys nothing against the one party it is
described as excluding:

- `dashboardPin` is a 6-character plaintext string in `.instar/config.json`, file mode 664.
- The file-viewer config has `allowedPaths: ["./"]`, the whole project directory.
- Therefore the agent can read the PIN directly, and (on the reporter's build) also through its own
  file-serving surface.

The consequence is that every route documented as structurally beyond the agent is not: feedback readiness
authority approval, approver-independence acceptance, money-layer enable and cap arming, external-hog kill
arming, mandate issue and revoke, stall-matrix acceptance, guard load-bearing accept-fallback. Each is gated by
prose ("do not read that file"), which the constitution says is a wish, not a guarantee. The reporter did not
misuse it and said so to the operator in writing. The report is that the guarantee is not real and the
operator has been told it is.

The second, smaller point: the double entry (unlock, then re-enter per action) is explained to operators as
protection from the agent. If it is in fact defending against a stolen browser session, that should be said.

## 2. Evidence

### 2.1 From the report (untrusted text, one report, not truncated)

Quoted facts: plaintext PIN, mode 664, `allowedPaths ["./"]`, the list of PIN-gated routes above, and the
reporter's own three directions (store a verifier, bind high-authority acts to something the agent cannot
produce, exclude the config file from served paths). The evidence file notes nothing missing.

### 2.2 Verified in this tree (`preserve/2026-09-unlanded-evolution-memory-metrics`, v1.3.1577)

| # | Claim | Finding | Where |
|---|---|---|---|
| E1 | PIN is plaintext in config on a single-machine install | **Holds.** The only caller of `migrateSecrets()` is machine pairing. `PostUpdateMigrator` and the server boot generate the PIN straight into config when missing. `Config.ts` writes config with the default mode (umask-dependent, 664 on the reporter's host). | `src/commands/machine.ts:365`, `src/core/PostUpdateMigrator.ts:15163`, `src/commands/server.ts:30955`, `src/core/Config.ts:1190` |
| E2 | File browser serves config.json | **Does not reproduce on current main.** `.instar/config.json` is in `NEVER_SERVED_PREFIXES`, config-immune, case-folded, checked before and after symlink resolution, and the prefix match also covers `config.json.bak*`. Listing omits it. A regression test exists. The reporter's install predates PR #1905 or the report describes an older build. | `src/server/fileRoutes.ts:151`, `:161`, `:293`, `:406`; `tests/unit/grok-build-round17-security.test.ts:19` |
| E3 | Backups copy config.json | **No.** `BackupManager` blocks `config.json`, `secrets`, `machine` regardless of user config. | `src/core/BackupManager.ts:24` |
| E4 | The agent is told the PIN by the system itself | **Holds, five emitters.** (a) Telegram dashboard broadcast writes `PIN: <value>` into the Dashboard topic, which the agent reads and which lands in message history; (b) boot prints `Auto-generated dashboard PIN: <value>` to the server log; (c) `PostUpdateMigrator` records `generated dashboard PIN (<value>)` in its result; (d) `UpgradeNotifyManager.buildPrompt` injects `Dashboard PIN: <value>` into a prompt handed to a session; (e) the `fix dashboard` chat command replies with the PIN; (f) the tunnel manager posts the rotated PIN after a relay episode; (g) the agent's instructions say "Read the PIN from your config.json". | `src/messaging/TelegramAdapter.ts:2450`; `src/commands/server.ts:30961`, `:484`, `:13248`; `src/core/PostUpdateMigrator.ts:15167`, `:12467-12469`; `src/core/UpgradeNotifyManager.ts:233`; `src/scaffold/templates.ts` Dashboard section |
| E5 | PIN-gated routes compare against the plaintext | **Holds.** `checkMandatePin` (31 callers: mandates, guard accept-fallback, external-hog arm, green-PR enable, pairing, every feedback-factory mutation including readiness authority) plus direct comparisons in money-layer plan/commit, `/passkeys/revert-method`, class-review outcome and lifecycle, subscription re-login, and `/dashboard/unlock`. All compare `ctx.config.dashboardPin` with a typed body `pin`. | `src/server/routes.ts:14121`, `:15890`, `:29608`, `:30680`, `:30710`, `:35662`; `src/server/AgentServer.ts:1497` |
| E6 | An operator-session proof already exists | **Holds, partially used.** `/dashboard/unlock` issues a random 32-byte in-memory token (15 min, cleared when the PIN changes) and the console sends it as `X-Instar-Operator-Session`. Several route groups accept it (desktop access, topic-profile defaults, identity-change reads, Playwright profile provision, subscription re-login, Telegram origin operator routes); the 31 `checkMandatePin` routes do not. The mobile pairing spec deliberately refuses to issue it from a code. | `src/server/DashboardOperatorSessionStore.ts`, `src/server/AgentServer.ts:1519-1528`, `dashboard/index.html:4470`, `docs/specs/mobile-pairing-link.md` §2.1 |
| E7 | The vault does not exclude the agent | **Holds.** On a paired install the PIN sits in the encrypted vault, which the agent reads by design (`secret-get.mjs`); the master key is in the user keychain or a 0600 file, both reachable by any process running as that user. | `src/core/SecretStore.ts:1-7`, `src/core/dashboardPin.ts` |
| E8 | The PIN is the door to the API token | **Holds.** Unlock returns the full `authToken`; `POST /sessions/spawn` is Bearer-only. So an off-host holder of the PIN plus a reachable dashboard gets a credential that spawns a session that can do everything the agent can. | `src/server/AgentServer.ts:1524`, `telegram-button-approval.md` G11 |
| E9 | PIN posts into Bearer-readable history | **Holds (ACT-113).** Route detail stays out of this public document until the fix lands, per the public-document discipline in `telegram-button-approval.md`. | ACT-113 in the evolution action queue |

The reported routes (readiness authority, approver independence, money layer, external hog, mandates, stall
matrix, guard accept-fallback) all appear in E5. The report is therefore reproduced in substance on current
main, with E2 the one half that is already closed.

## 3. What "structural" can mean on this host

Three attackers, from `telegram-button-approval.md`: **T1** is off the host and holds only the Bearer token;
**T2** is the agent, using its ordinary tools as the same OS user; **T3** holds the operator's Telegram
account. Today the PIN stops none of them (T1 spawns a session that reads it, T2 reads it, T3 reads it from
the chat).

Every process on the host, including the server that checks the PIN, runs as one user, and the
instar-developing agent writes and merges the code that performs the check. No host-local check is absolute
against T2. Two things can still be made true, and this spec claims only these:

1. **Resistance to extraction with ordinary tools.** No file, log, route, chat message or prompt on or
   reachable from the host yields the P-class secret. Forging an approval then requires deliberately
   modifying the checking code or its state.
2. **Visibility.** Every P-class approval is announced to the operator on a channel he reads, naming the
   proof that satisfied it. An approval he did not make is seen, not silent. Suppressing the notice is a
   second deliberate modification.

Against T1 and T3, the design is a real boundary once R1 lands (the secret is no longer anywhere they can
read) and R3 lands (what they could read no longer buys P-class authority).

**Classification used below.** `telegram-button-approval.md` §1 defines S (less action, undoable), R
(re-grant within an envelope), and P (everything else; unclassified points are P). "P-class route" here
means every route in E5 that grants, widens, arms, publishes, accepts risk, or restores, plus any future
route that consults the chokepoint in §4.2.

## 4. Proposed design

The work ships in three releases. R1 is the urgent part and is independent of R2 and R3. R2 is small and
is the operator's actual complaint. R3 is the structural change and carries the operator decisions in §12.

### 4.1 R1 — Stop handing out the secret

**R1-a. Every emitter stops (E4).** One pure helper `describeDashboardAccess({ url, isNamed, pinAvailable })`
replaces every message that currently carries the PIN value. The Telegram broadcast, the tunnel-rotation
notice, the `fix dashboard` reply and the upgrade-notify prompt say where to read the PIN (R1-b) and never
contain it. The boot log line and the migrator result line say `generated dashboard PIN` with no value. The
upgrade-notify prompt loses its `Dashboard PIN:` line entirely: a prompt is handed to a session, so this
emitter told the agent the PIN directly. A unit test runs each emitter with a known PIN and asserts the value
is absent from every string produced.

**R1-b. Where the operator reads the PIN instead.** Two places, both outside the agent's message history:

- **At the keyboard:** `instar dashboard pin` prints it once to the terminal (no log line) and
  `instar dashboard pin --rotate` replaces it. The CLI runs as the same user, so this is not hidden from T2;
  it is hidden from T1 and T3, which is the point of removing the chat copies.
- **On the phone:** the existing mobile pairing link (`mobile-pairing-link.md`) already puts the API token on
  a phone without typing the PIN. It issues no operator proof by design, so it remains a view path.

The Dashboard topic broadcast keeps the URL and gains one line: "Your PIN has not changed. Run
`instar dashboard pin` on the machine if you need it." On first install the PIN is shown once in the
`instar init` terminal output, as the API token already is not. `DASHBOARD_ACCESS_SPEC.md` "PIN Handling"
(which calls the Telegram copy acceptable because "the PIN is already stored in plaintext") is superseded by a
dated note pointing here.

**R1-c. One-time rotation of PIN and API token, ending operator sessions.** On the first boot after this
release, `PostUpdateMigrator` rotates both through the path the tunnel manager already uses after a relay
episode (`liveConfig.set('authToken'|'dashboardPin')`, in-memory mutation, `dashboardOperatorSessions.clear()`
via the existing PIN-version check). Without this, anyone who read the exposed PIN earlier keeps what it bought
(E8). The migrator marks `dashboardPin.rotatedForLeak: <iso>` in state so it runs once. Side effects named in
the upgrade note: every paired phone needs a new pairing link (the mobile spec §2.6 already handles this with
the rotation notice sentence), every open dashboard tab re-unlocks, and the operator reads the new PIN per
R1-b. Historical copies in message history are not rewritten (*Archiving May Never Mean Deleting*); rotation
makes them a dead value, and ACT-113's redaction on read covers the display.

**R1-d. The PIN leaves config.json on every install.** `PostUpdateMigrator` calls `migrateSecrets()` for
`dashboardPin` and `authToken` on single-machine installs too, with the file-key fallback when no keychain
is available (the path `SecretStore` already has for headless servers). Config then holds
`{ "secret": true }` and `loadConfig` merges the vault, as on paired installs today. This is not a boundary
against T2 (E7); it removes the value from a git-adjacent, 664, support-bundle-prone file and makes every
accidental copy path (backups, file viewers on older builds, pasted configs) carry a placeholder. All shell
and script templates already guard the placeholder for `authToken`; the test plan adds the same assertion for
`dashboardPin` in the three scripts that read it. Config writers set mode 0600 on `config.json` whether or
not migration has run (`Config.ts` and `LiveConfig` writes), which answers the 664 in the report directly.

**R1-e. Every PIN-satisfied P-class approval is announced.** When the chokepoint (§4.2, or until R2 lands,
`checkMandatePin` and the seven direct comparisons) accepts a typed PIN for a P-class act, the server appends
`{ at, route, act, proof: 'pin-typed', sourceIp, userAgentHash }` to `.instar/state/operator-approvals.jsonl`
(append-only, 0600, never served; added to `NEVER_SERVED_PREFIXES`) and raises an attention item on the
operator's attention hub: "Operator action approved with the PIN: <act> at <time> from <ip>." Approvals
within one five-minute window from one source collapse into one item listing the acts. The operator sees
approvals he did not make. This is visibility (§3 point 2), not a block, and costs nothing when only the
operator approves things. Failed PIN attempts already lock out per IP through `PinAttemptStore`; a lockout also
raises one attention item, because five wrong PINs at a P-class route from `127.0.0.1` is a session guessing.

**R1-f. The file-viewer guarantee is pinned, not re-done.** E2 is closed. R1 adds to the existing round-17
test: `.instar/config.json.bak`, `.instar/config.json.1`, a symlink inside an allowed directory pointing at
config, and the new `operator-approvals.jsonl`, each refused on `list`, `read`, `download`, `link` and
`save`. No change to `allowedPaths` defaults: the never-served list is the mechanism, and it is config-immune,
which is what the report asked for.

**R1-g. P-class taps move to the dashboard in this release.** `telegram-button-approval.md` §2 bound the
pairing approve/finish, tunnel-consent grant and prompt-gate permission/plan taps to the event "the PIN stops
being posted into Telegram and is rotated", because after that event T3 can no longer read the PIN but can
still tap, so a tap becomes weaker than the PIN. That event is R1-a plus R1-c. Therefore in the same release:
the pairing approve and finish buttons become links to the Threadline tab (already a PIN route); the
tunnel-consent message becomes a link to a new dashboard confirmation that calls the existing grant route
through the chokepoint; prompt-gate keyboards stop rendering permission and plan-approval options (plain
questions and pickers stay). The three exception records in `telegram-callback-class-map.md` are deleted and
its test asserts the map holds no exception once this release's flag is on. The fail-open owner checks are
ACT-115 and are not changed here.

**R1-h. The agent instructions tell the truth.** The Dashboard section of `generateClaudeMd()` and its
Codex/Gemini shadows, plus the migrator's refresh copies, replace "Read the PIN from your config.json" and
every "a Bearer token cannot do this; only the operator PIN can" with one paragraph, keyed on its own marker
so Migration Parity applies:

> The dashboard PIN is the operator's door to the dashboard from a phone or another machine. It is not a
> boundary against you: your tools can read it, and so could a session started with your API token. Routes
> that ask for an operator proof are recording that a human chose the act, and the server tells the
> operator every time such a proof is used. Supplying the PIN yourself is forbidden by *capability is not
> authority* and would be visible. Never put the PIN in a message, a log, a file or a prompt; tell the
> operator to run `instar dashboard pin` on the machine.

This is written once, together with the emitter change, so the instructions never name a PIN source the
system no longer uses (the reason `telegram-button-approval.md` §4 deferred it).

### 4.2 R2 — One unlock covers a visit (the operator's complaint)

**One chokepoint.** `src/server/operatorProof.ts` exports
`requireOperatorProof(ctx, req, res, { act, classification: 'P' | 'S', nonce? })`, returning
`{ ok: true, proof: 'operator-session' | 'pin-typed' } | { ok: false }` (response already sent). It
replaces `checkMandatePin`, `moneyLayerPinValid`, `requireReloginOperatorPin` and the four inline
comparisons in E5, so there is one place to audit. Order of checks:

1. `X-Instar-Operator-Session` header present and `verifyDashboardOperatorSession` true → `operator-session`.
2. Otherwise body `pin` → the existing sha256 + `timingSafeEqual` + `PinAttemptStore` lockout → `pin-typed`,
   and a fresh operator session is issued in the response header `X-Instar-Operator-Session` so the next act
   in the same visit does not re-prompt.
3. Otherwise `403 { error: 'operator proof required', hint: 'unlock the dashboard' }`.

Every accepted proof is appended to `operator-approvals.jsonl` (R1-e) with its kind. The per-act plan/commit
nonce where one exists (money layer, routing spend) stays mandatory: the session replaces only the typed
secret, never the confirmation that binds the act to the plan the operator saw.

**Where the session token can and cannot be read.** It is random, in memory only, stored hashed, 15 minutes,
cleared on PIN change and on server restart. It is returned only by `/dashboard/unlock` and in the
`X-Instar-Operator-Session` response header of a successful `pin-typed` proof. No Bearer route returns it; no
log, state file or history row contains it; the console keeps it in a JavaScript variable (as today), not in
`localStorage`. A test greps every captured log line and every state file after a full unlock-and-approve
flow for the token value. The mobile pairing code continues not to issue it (`mobile-pairing-link.md` §2.1).

**Console.** Each PIN prompt in the console (about 22 sites across `dashboard/`) becomes "use the current operator session if present,
else prompt once, then cache the returned session". The prompt text stops saying the PIN protects against
the agent and says: "Confirm this action as the operator. Your unlock lasts 15 minutes."

**Honest statement of what per-action entry defends (the report's second point).** After R2, the per-visit
operator session defends against a stolen or shared browser tab that has only the API token, and against the
agent acting by mistake. It does not defend against the agent acting deliberately until R3. The console's
help text and the instructions in R1-h say so.

**Lifeline callback ledger (item 8 of the sibling list).** On installs with a lifeline, the lifeline appends
every `callback_query.id` it actually received from Telegram to `.instar/state/lifeline-callbacks.jsonl`
(rolling, 0600, never served). The `/internal/telegram-callback` handler, when the ledger is present, refuses a
forwarded callback whose id is absent and raises an attention item: a forwarded tap the lifeline never saw is
a detected forgery. Cooperative (the agent can write the ledger), but visible. Installs where the adapter
polls Telegram itself have no forwarder and get no ledger; nothing changes there.

### 4.3 R3 — A credential the agent cannot produce

**Choice: WebAuthn passkey over GitHub-as-enforcer.** GitHub can enforce review on code merges and nothing
else; the P-class routes here are runtime levers (arming spend, issuing mandates, accepting risk) that GitHub
never sees. GitHub remains the right enforcer for the per-PR floor and is handled in
`feedback-triage-and-execution.md`. A passkey assertion with user verification from the operator's own device
is something no session on the host can produce, whatever token it holds.

**Mode and gating.** `dashboard.operatorCredential: 'pin' | 'passkey'`, default `pin`. In `passkey` mode a
P-class route accepts only an operator session **minted by a passkey assertion** (`proof: 'passkey'`);
PIN-minted sessions remain valid for the dashboard and for S-class acts. The operator session store records
the minting proof per session. Switching the mode to `passkey` clears every existing session (legacy sessions
are invalidated at migration). Switching back to `pin` is itself a P-class act in `passkey` mode (it needs a
passkey), or the break-glass path below.

**Relying-party identity.** WebAuthn binds a credential to an RP ID. Quick tunnels change hostname every
restart, so enrollment is refused on a `*.trycloudflare.com` origin with the same plain-words reason the mobile
pairing spec gives (`stable-address-required`). On a named tunnel the RP ID defaults to the registrable parent
of `tunnel.hostname` when every active machine of the agent shares it (so one passkey works on every machine's
dashboard), else the hostname itself. `localhost` is accepted as an RP ID for the desktop case. The RP ID is
written to `dashboard.passkey.rpId` at first enrollment and changed only by a passkey-proved act.

**Enrollment.** `POST /dashboard/passkeys/enroll/options` and `/enroll/verify` (Bearer plus operator
session). Credentials require `userVerification: 'required'` and `residentKey: 'preferred'`.

- *First credential.* Requires a PIN-minted operator session (nothing stronger exists yet) and opens a
  **24-hour cooling window**: the credential is stored `pending`, an attention item and a Dashboard-topic
  message announce "A passkey was enrolled from <user agent family> at <time>; it becomes active at
  <time+24h>; cancel with your PIN if this was not you", and the dashboard shows a banner with a cancel
  button (PIN-proved) for the whole window. Only after the window does the mode switch to `passkey`.
- *Later credentials* require an existing active passkey's assertion, not the PIN. The same announcement is
  sent; no window.
- *Why an agent-enrolled software authenticator is refused, honestly.* In a browser flow attestation cannot
  distinguish a platform authenticator from a virtual one (Apple and Google platform passkeys return `none`
  attestation on the web). So a software credential enrolled by a session is not refused cryptographically.
  It is refused by the process: the first enrollment is announced on two channels and cancellable for 24 hours
  with the PIN the operator holds; after the operator's own passkey is active, no further credential can be
  added without an assertion from the operator's device. The agent's window is therefore "before the operator
  ever enrolls", during which the operator is told. This is the limit stated in §11.

**Assertion bound to the rendered plan.** `POST /dashboard/passkeys/assert/options` returns a challenge
`sha256(serverNonce || planHash)` where `planHash` is the hash of the server-rendered plan or act description
the console displays (the money layer's plan/commit nonce already exists; other P-class routes gain a one-line
server-rendered act summary). `/assert/verify` checks the signature, the RP ID hash, user-verification flag,
the sign-count monotonicity, and that `clientDataJSON.challenge` equals the challenge issued for *that*
plan. Success mints an operator session with `proof: 'passkey'` and `planHash` recorded, and the P-class
route checks the session's `planHash` against the act it is about to perform. A passkey session therefore
authorises the act the operator looked at, not any act for 15 minutes.

**Unlock scope (item 3 of the sibling list).** In `passkey` mode `POST /dashboard/unlock` with the PIN keeps
returning the API token. Changing that means a scoped dashboard credential and a route-by-route scope audit,
which this spec does not have the measurements to do safely; it is listed as the first open question with the
recommendation that a later spec introduce a `dashboard` principal that cannot call host-control routes
(`/sessions/spawn`, file save, config patch, secret routes). Until then E8 stands and is written down.

**Break-glass.** Losing every passkey must not lock the operator out, and the recovery must not be a path T2
can take silently. `instar dashboard passkey reset` (CLI, on the machine) opens a 72-hour window during which
the mode will fall back to `pin` and all credentials will be removed. The request is announced on every
configured attention channel and in the Dashboard topic immediately, at 24 hours, and at 1 hour before
completion; any active passkey assertion cancels it; no route shortens it. The agent can run the CLI, so this
is visibility again, not prevention; the window is long so that an operator who reads Telegram daily sees it.

**Storage.** Credential public keys, sign counts, RP ID and the pending window live in
`.instar/state/dashboard-passkeys.json` (0600, never served, included in the key-material lists in
`src/core/keyMaterialPaths.ts` so backup, gitignore, sync classification and the file viewer stay in step).
Multi-machine: the file syncs through the existing key-material sync so any machine's dashboard verifies the
same passkeys; sign-count checks tolerate the per-machine lag by refusing only a decrease.

### 4.4 Decision points touched

- **Which proof satisfied a P-class route** — `invariant`: exact match on header-verified session, then
  typed PIN; nothing else; every acceptance is recorded with its kind.
- **PIN never in an emitted string** — `invariant`: one helper builds every dashboard-access message; a test
  asserts absence of the value for each emitter.
- **One-time rotation** — `invariant`: runs once, keyed on a state marker; both credentials rotate together;
  sessions cleared.
- **Approval notice** — `signal`: raised on every `pin-typed` acceptance and on lockout; collapsed per source
  per five minutes; never blocks.
- **Passkey mode gate** — `invariant`: in `passkey` mode a P-class route accepts only a session whose minting
  proof is `passkey` and whose `planHash` matches the act.
- **Enrollment window** — `invariant`: first credential inactive for 24 hours; cancel is PIN-proved; later
  credentials need an active passkey.
- **RP ID on quick tunnels** — `invariant`: enrollment refused; reason given in plain words.
- **Break-glass window** — `invariant`: 72 hours; no route shortens it; any passkey cancels it.
- **Unlock still returns the API token** — `judgment`, recorded as open question 1.

## 5. Multi-machine posture

- The PIN and API token are per agent, shared through config and the vault (`SecretSync`); the rotation in
  R1-c runs on the machine that first boots the release and syncs like any secret; the other machines' running
  servers learn it through the existing PIN-version check and clear their sessions.
- Operator sessions are per process and never cross machines (as today).
- Passkey credentials sync through the key-material sync so every machine's dashboard verifies them; the RP ID
  rule prefers a shared registrable parent so one passkey covers the agent's machines. A machine whose hostname
  does not share the parent gets its own enrollment.
- The approval ledger and the lifeline callback ledger are machine-local by design; `?scope=pool` reads can
  merge them later if wanted.

## 6. Safety floors

- **Secrets:** the PIN value, the API token and the operator-session token never appear in a log line, a
  served file, a route response other than the ones named, a Telegram message, a prompt or a state file other
  than the vault. Tests assert absence after a full flow.
- **Durable intake, no duplicate sends, spend cap, stop:** untouched. P-class routes that gate spend keep their
  plan/commit nonce.
- **Archiving:** history rows that already contain the old PIN are not deleted or rewritten; rotation makes them
  dead and ACT-113 redacts on read.
- **Fail-closed:** a route that calls the chokepoint with no classification is treated as P.

## 7. Rollback

Each release reverts independently. R1: revert the release; the rotated credentials stay valid (they are
just credentials), and emitters return. R2: revert; routes fall back to typed PIN, the session header is
ignored. R3: `instar dashboard passkey reset` (break-glass) or revert the release; in either case the mode
returns to `pin` and PIN-minted sessions satisfy P-class routes again.

## 8. Maturation plan

- **test-agent-live:** R1 and R2 fully; R3 through the WebAuthn fixture already in the tree
  (`src/core/PasskeyWebAuthnFixture.ts`) acting as a software authenticator, which also serves as the positive
  control for the enrollment-window test (a software credential *is* accepted into `pending` and *is*
  cancellable).
- **dev-agent-live:** Echo on the Mac Studio after R1: no PIN value in the Dashboard topic, server log,
  migrator output or any history route; one rotation recorded; an operator-approved mandate shows one
  attention item naming the act. After R2: one unlock, then three P-class acts, one prompt. After R3: operator
  enrolls a real passkey on his iPhone against the named-tunnel hostname; a P-class act with a PIN-minted
  session is refused; with the passkey session it passes; a second enrollment from a laptop requires the phone.
- **fleet:** R1 ships to the fleet (the rotation runs once per agent; upgrade note names the phone re-pair).
  R2 ships to the fleet. R3 ships dark (`operatorCredential: 'pin'`) and is turned on per agent by the
  operator's first enrollment.
- **graduation criterion:** thirty days on Echo with at least ten P-class approvals in the ledger, none with
  `proof: 'pin-typed'` after R3, and no approval notice the operator did not recognise.
- **dark-window:** R3 only; it stays dark until an operator enrolls.

## 9. Test plan

- **Unit** — `describeDashboardAccess`: no PIN value in any variant. Each emitter in E4 run with a known PIN:
  value absent. `requireOperatorProof`: session accepted; PIN accepted and session issued; neither → 403;
  lockout path; S routes never consult the PIN; unclassified → P; approvals ledger row per acceptance.
  `DashboardOperatorSessionStore`: minting proof and `planHash` recorded; `passkey` mode refuses `pin-typed`
  sessions on P routes; mode switch clears sessions. Passkey: enrollment refused on quick-tunnel origin; first
  credential pending 24h; cancel with PIN; second credential needs assertion; challenge mismatch refused;
  sign-count decrease refused; break-glass window cannot be shortened. `isNeverServed` for the new state
  files and the `.bak` variants. Config writers produce 0600.
- **Integration** — the 31 former `checkMandatePin` routes and the seven direct-comparison routes each:
  session header passes, typed PIN passes and returns a session header, nothing fails. Migration: single
  machine install boots, config holds `{secret:true}` for both fields, vault holds them, scripts that read
  the PIN handle the placeholder. Rotation runs once across two boots. Class map holds no exception with the
  R1 flag on.
- **E2E** — boot the real `AgentServer` with Telegram and history fakes: PIN absent from every outbound message,
  log line, history route and state file after a full unlock → approve → rotate flow; one attention item per
  PIN-typed approval; a forwarded callback with no ledger entry refused and announced; a full WebAuthn fixture
  flow in `passkey` mode including the plan-bound challenge.

## 10. Rollout order and relation to tracked work

R1 is ACT-113's deliverable together with the history redaction; ACT-113's route detail stays in that action
record until it lands. R1-g deletes the three exceptions in `telegram-callback-class-map.md`. ACT-115
(fail-open owner checks) and ACT-120 (always-approve row) remain their own items; R1-g makes ACT-120 moot for
Telegram permission prompts. The supersession note in `DASHBOARD_ACCESS_SPEC.md` ships with R1.

## 11. What this does not achieve

- It does not stop an agent that edits `routes.ts`, the session store, the passkey file or the ledgers and
  ships the change. On one OS user nothing on the host can. It makes that bypass a deliberate code or state
  modification instead of a `cat`, and it puts a notice in front of the operator for every proof used.
- It does not make a hashed PIN a boundary: a six-digit space falls to offline search in seconds, which is why
  R1-d moves the value rather than hashing it, and why R3 exists.
- Until open question 1 is decided, the PIN still exchanges for the full API token, so T1 with the PIN and a
  reachable dashboard still gets a session-spawning credential (E8). R3 removes P-class authority from that
  credential; it does not remove host control.
- The 24-hour enrollment window protects the operator who reads his attention channel within a day. An
  operator away longer should enroll before leaving, which the R3 upgrade note says.

## 12. Open questions (operator decisions, non-blocking for R1 and R2)

1. Should `POST /dashboard/unlock` stop returning the full API token in `passkey` mode, in favour of a
   dashboard-scoped credential that cannot reach host-control routes? Recommendation: yes, in a follow-up spec
   with a route-by-route scope audit; not in this one.
2. Which RP ID for Echo: the shared parent of the machines' named-tunnel hostnames (one passkey for all
   machines) or per hostname? Recommendation: shared parent.
3. Should R3 be required (no `pin` mode) on installs whose operator has an iPhone with the Instar app?
   Recommendation: no; it stays opt-in by enrollment, and the upgrade note recommends it.
