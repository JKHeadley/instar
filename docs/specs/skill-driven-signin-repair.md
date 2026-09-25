---
title: "Skill-driven sign-in repair — an agent session signs in like a person"
slug: "skill-driven-signin-repair"
author: "Echo"
owner: echo
topic: 33890
eli16-overview: "docs/specs/skill-driven-signin-repair.eli16.md"
parent-principle: "Judgment Within Floors and Signal vs Authority (docs/STANDARDS-REGISTRY.md): a trusted agent session judges the sign-in pages; the server alone decides success. Operator direction 2026-09-25 (topic 33890): use the best tool for the job, operating like a human user where needed; auth-sensitive flows only in a normal browser. Operator chose the simple version (2026-09-25: \"Yes, please proceed with your recommendations\")."
depends-on:
  - assisted-subscription-relogin
  - agent-driven-relogin
supersedes: "agent-driven-relogin Frontloaded Decision 1 (in-runtime model call, not a spawned session), on macOS only"
review-convergence: "2026-09-25T18:57:22.869Z"
review-iterations: 5
review-completed-at: "2026-09-25T18:57:22.869Z"
approved: true
approved-by: "Justin (verified operator, Telegram topic 33890, 2026-09-25 12:09 PDT: \"Approved\")"
review-report: "docs/specs/reports/skill-driven-signin-repair-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 8
cheap-to-change-tags: 2
contested-then-cleared: 2
---

# Skill-driven sign-in repair

## Problem statement

The automatic sign-in repair has never completed one real unattended repair. On 2026-09-25 its fixed page rules stopped both Laptop Claude accounts within 3 seconds:

- `unexpected-origin`: Chrome's first-run window was in front, and Google opened in a popup.
- `permission-expansion`: a false positive on the standard Claude Code scopes.

Each stop also opened a 24-hour lockout. An hour later, an ordinary agent session following the `/subscription-signin` skill signed both accounts in within about 10 minutes. It worked from screenshots, `cliclick`, keystrokes and pid-targeted Apple Events, and both accounts ended verified. The Mac Studio was repaired the same way on 2026-09-24.

The operator's direction was to use the best tool for the job, working like a human user where needed, in a normal browser only. `agent-driven-relogin` said a spawned session could be added "if real repairs show it is needed". Real repairs now show it: zero unattended successes and three hand-run successes. This spec supersedes that spec's Frontloaded Decision 1, on macOS only. It deliberately avoids the machinery of the 18-round design that did not converge.

A second, separate problem: three Codex accounts read `active` in the pool for days while they were signed out. The pool's status did not come from the CLI's own login state.

## Proposed design

On macOS, the browser step of a repair episode is done by **one agent session that follows `/subscription-signin` section 3**, exactly as the hand-run repairs were. The session is a **trusted local operator**, with the same trust as any agent session on the machine. The server deterministically arbitrates admission, the lease, the code hand-off and success. The helper's intermediate actions are trusted, human-equivalent authority, bounded by the skill, not by code.

### What the server does (unchanged unless noted)

1. **Admission.** Episode admission, the attempt budget, the breaker and `idx_relogin_live_cell` (one repair per account) are unchanged.
   - On this path, mode is forced to `approval` until graduation, whatever `assistedRelogin.mode` says. A trusted helper is never spawned unattended before the evidence exists.
   - Approval itself is unchanged; the operator's tap always lands.
2. **Pre-attempt check (new).** This runs in the orchestrator's `approved` branch, before the `approved → cli-starting` transition that counts an attempt. Three checks run in order:
   - **Lease.** Acquire the machine's `PlaywrightSeatLease`, with the episode as holder. This is the one-helper-per-machine floor. It is renewed every 2 minutes, since its 10-minute TTL is shorter than the helper cap, and released on every exit.
   - **Capacity.** `SessionManager` must have room. A spawn refused after this check (a race) comes after the attempt is counted. It returns the existing transient `seat-busy` and retries within the attempt budget. That is rare and bounded.
   - **Helper account.** There must be any healthy account on this machine, Claude or Codex, never the account under repair. "Healthy" means active, not rate-limited, passing a just-in-time CLI login check, and an authenticated read.

   If the lease is held or capacity is full, `tick` returns `waiting` with **no transition**. The episode stays `approved`, the service re-runs it next tick, and no attempt is spent. While it waits, the orchestrator extends `approvalExpiresAt` through a new store method, `extendApproval(id, expectedVersion, until)`. The method has a version check and enforces the 60-minute cap itself. The pre-attempt check runs before the orchestrator's approval-expiry check. A repair queued behind another one on the same machine, like the two Laptop accounts on 2026-09-25, therefore does not die as `approval-expired`.

   If no helper account exists, the episode moves to `waiting-operator-only` with class `no-healthy-seat`. That needs one new store transition, `approved → waiting-operator-only`. The existing operator-only notice gets a text branch linking the dashboard's phone **Sign in** cell.
3. **Start the CLI login.** Unchanged.
4. **Spawn the helper (new).** One session, `relogin-<episodeId>`.
   - **Account pinning.** It is pinned to the chosen helper account by a new spawn option, `{framework, configHome}`, for both Claude and Codex, resolved through the credential-location gate. The global headroom resolver pins Claude only and cannot exclude an account.
   - **Codex sandbox.** A Codex helper uses the existing full-access mode (`codexAllowMcpTools`), so it can reach localhost and run GUI tools.
   - **Prompt.** The prompt is fixed and server-rendered. It contains:
     - the episode id and the expected email;
     - the verification URL, and for Codex the device `userCode`;
     - the names of the account's vault bindings;
     - a per-episode token;
     - the instruction "follow `/subscription-signin` section 3, then stop."
   - **Lifetime.** It has no topic binding, is never revived, and is capped at `min(15 min, login expiry − 60 s)`.
   - **Waiting.** It is awaited inside the existing `driveBrowser` port as an in-memory promise, within `browser-driving`.
   - **Tick (new).** `SubscriptionReloginService.tick` starts `runEpisode` detached, just as `approve()` and `retry()` already do; today `tick` awaits it. The existing `inFlight` set prevents double starts, and a 15-minute helper never blocks scanning or notice delivery.
5. **One route (new).** `POST /subscription-relogin/:episode/code`.
   - **Auth.** Loopback only. It needs the episode token: 32 random bytes, compared by hash, held only in memory, and dead once the episode leaves `browser-driving`. It is never logged, and the route does not log bodies. It is accepted only while this episode's helper is live. The body is capped at 1 KB and must be `application/json`. The route sends no permissive CORS headers and rejects a non-loopback `Host`. That reduces the risk of an ambient browser POST, but the token is the real protection. A request arriving after the helper exits gets `409`.
   - **Body.** The body is a strict tagged union. Anything else is refused.
     - `{"code": "…"}` is accepted once and checked by the existing paste-back code-shape validator. It resolves the `driveBrowser` wait, and the unchanged `finishCli` → paste-back path then runs. The code is never persisted, and a second code gets `409`.
     - `{"notify": "phone-tap"}` queues the fixed phone-tap notice. It is idempotent.
     - `{"notify": "macos-permission", "permission": "screen-recording" | "accessibility" | "automation"}` resolves the wait as `operator-only` with the existing class `automation-permission`. Its notice names the permission.
   - **Codex device logins** need no code: the wait resolves when the credential appears.
6. **Arbiter.** Unchanged: pending-login completion, then `verifyIdentity === 'match'`, then authenticated use. The session's word never counts. A helper that exits, or reaches its cap, without that is `failed` / `agent-sign-in-unfinished`.
7. **Cleanup and restart.** The helper session is killed on every exit from `browser-driving`, including abort and cancel.

   After a server restart, the in-memory token and wait are gone, so the route answers `409` and the helper stops. The existing `browser-driving` recovery then applies:
   - credential ready: `identity-verifying`;
   - otherwise: `waiting-operator-only` / `uncertain-external-outcome`, with the existing operator-only notice.

   Boot also kills any `relogin-*` session whose episode is no longer driving.

### What the helper does (the skill, section 3)

- It works the pages like a person: screenshots, `cliclick`, pid-targeted Apple Events. It follows popups and first-run windows.
- It types passwords itself, from the vault over stdin (never on a command line, in chat or in a file). Before **every** keystroke burst, it checks that:
  - the frontmost process is the Chrome it opened;
  - `document.activeElement` is the expected password or code field.
- It posts the Claude code to the code route.
- It stops at a hard line and reports it by exiting with the reason written to its final output. The episode events record that it exited unfinished.

**Hard lines (the skill's four, and only four):**

1. Expected account only.
2. No solving or working around a CAPTCHA or a phone or "verify it's you" check. The helper may only ask the operator to tap it (`notify: phone-tap`).
3. Passwords only on Google, Claude or OpenAI pages.
4. Never touch a Chrome window it did not open.

The skill gains a short "Agent-run repair" subsection with the steps above. Installed copies are updated through an idempotent `PostUpdateMigrator` migration, because `installBuiltinSkills` never overwrites.

### Operator contact

The helper has no chat channel. Operator notices are fixed text, sent through the existing `repair_notifications` / attention path, from the owning machine only:

- **Phone tap needed** (for example Google's "Is it you?"). The helper requests it through the code route's `{"notify":"phone-tap"}` action, using the same token. It is a new notification kind, `phone-tap`, with its own branch in `drainNotifications` and in the kind union; today unknown kinds fall through to the terminal handler. `repair_notifications` is `UNIQUE(episodeId, kind)`, so the `approved → cli-starting` transition deletes the episode's `phone-tap` and `operator-only` rows (unless mid-delivery). The notice `deliveryKey`, which is also the attention-item id, gains the attempt number (`…:<kind>:<attemptCount>`), so the re-inserted notice is not deduplicated away. Each attempt can then notify once, and a second operator-only reason in one episode (for example `no-healthy-seat`, then `macos-permission`) is not silently dropped.
- **macOS Allow needed** (Screen Recording, Accessibility or Chrome Automation). The helper reports it with `notify: macos-permission`, which leads to the existing `automation-permission` operator-only notice, reworded to name the permission.
- **Final failure or hand-off.** This goes through the existing operator-only and terminal notices, each with the dashboard link. There the operator can finish sign-in from a phone with the existing one-tap **Sign in** cell (start-cell). That cell is also shown while a repair is waiting on the operator.

### Breaker

Only server-verified `wrong-identity` (from `verifyIdentity`) opens the 24-hour lockout on this path. This needs no change to the store's breaker. The helper path simply never emits the driver's page-rule classes (`unexpected-origin`, `permission-expansion`, `captcha`, `phone-confirmation`); a helper that stops at a hard line ends as `agent-sign-in-unfinished`. So on this path the existing rule reduces to `wrong-identity`. Every other failure counts only toward the existing threshold of 3 in 24 hours. The class list stays as it is for the driver off macOS.

The store's closed `FAILURES` list and the orchestrator's result type gain `agent-sign-in-unfinished` and `no-healthy-seat`.

### Pool health from the CLI's own login status

An account's pool status must come from the CLI's own login check (`claude auth status` / `codex login status` against that account's config home) together with an authenticated read. It must not come from stale pool state.

- **Codex needs a live read.** Only a live `codex-app-server` quota read counts as an authenticated read. The rollout-file fallback is usage history, not proof of login. That fallback is why three signed-out Codex accounts read `active` for days, and the same rule applies to the arbiter's authenticated-use check.
- **Existing rules unchanged.** The poller's `transition-to-needs-reauth` paths, including Claude's exchange-corroborated single-poll path, stay as they are.
- *New, additional rule (the CLI-signed-out case, which today has no path, notably for Codex).* An account also becomes `needs-reauth` through the explicit `transition-to-needs-reauth` outcome when two things agree on two consecutive polls:
  - the CLI login check says signed out;
  - the authenticated read is refused **as an auth failure**: an unauthenticated or login-required response. A transport failure or timeout does not count, and leaves the status unchanged. For Codex, this means the live app-server read reports no or invalid auth. Today that case silently falls back to the rollout file.
- The existing absence-observation contract is unchanged. A missing credential file alone still never triggers a repair.
- A signed-out reading never overrides a successful authenticated read.
- **Identity stays with `verifyIdentity`.** `claude auth status` reads metadata, so it is not an identity oracle.
- **An unrunnable check changes nothing.** The prior status is kept, but the account is not eligible as a helper seat. It is never counted as a fresh `active`. `GET /subscription-pool` shows `loginCheck: 'unavailable'` next to the status, so the gap is visible and never silent.

### Configuration and rollback

- `subscriptionPool.assistedRelogin.navigation` gains `agent-session`, honored on macOS only. Off macOS it resolves to the existing driver.
- When the value is omitted, it resolves to `agent-session` on a macOS development agent and to the existing value elsewhere.
- **Rollback** is setting `navigation` back to `agent` or `closed`. No state, table or column is added.
- **Additive changes.** The store changes are additive:
  - the transition `approved → waiting-operator-only`;
  - the failure classes `agent-sign-in-unfinished` and `no-healthy-seat`;
  - the notice kind `phone-tap`;
  - the attempt number in the notice `deliveryKey`;
  - the store method `extendApproval`.
- **What an older binary does with the new rows.**
  - It can still cancel them, because `waiting-operator-only → cancelled` exists.
  - It rejects the new failure classes only on write, and it never writes them.
  - Its notice drain sends an undelivered `phone-tap` row to the terminal handler once. That is an intentional degraded notice, not a real terminal outcome, and a rollback-only artifact.

### Named residual risk

- **Trusted-operator trust.** The helper has the same machine trust as any agent session: shell, vault and the dashboard PIN on disk. A prompt-injected page could misuse that. It is bounded by the four hard lines, the 15-minute cap and server-only success, and rollout starts in approval mode.
- **Clicks can go astray.** `cliclick` clicks by screen position and can hit another window. The focus check guards keystrokes, not clicks.
- **Focus can change after the check.** Focus can change between the helper's check and its typing. The skill re-checks after every focus-changing action, but nothing enforces that.
- **The transcript holds single-use artifacts.** The session transcript contains the verification URL and the code, both single-use and short-lived.
- **Correlated expiry.** When every account on a machine has expired at once, there is no helper. That case goes to the operator's phone Sign-in cell.
- **Removed page-rule floors.** The driver's runtime origin, scope and destructive-control checks do not apply to the helper. Its intermediate clicks are bounded by the four hard lines and approval mode, not by code. That is the operator's explicit choice (FD2); PKCE still binds the CLI's own grant.

## Alternatives considered

- **A narrower deterministic actuator or restricted tool set.** This includes a small enforced wrapper for passwords and clicks. It is a real middle ground, smaller than the 18-round machinery. The operator chose the trusted-operator form for the first rungs; forced approval and the operator watching bound it. It can be added later if Rung 1–2 evidence shows the helper misusing a secret or a window.
- **Fixing the driver's page rules.** A rule per unexpected window keeps failing on the next unexpected window.
- **Notify-only.** This is kept as the fallback when no helper exists.

## Decision points touched

| Decision point | Classification | Notes |
|---|---|---|
| Getting through the sign-in pages | `judgment-candidate` | **Floor:** the four hard lines, the per-keystroke focus check, the session cap, one helper per machine, and server-only success. **Arbiter:** `verifyIdentity` plus authenticated use. **Default:** stop and hand off. **Ladder:** operator-only, then the phone Sign-in cell. |
| Episode success | `invariant` | Completion, `verifyIdentity === 'match'` and authenticated use. |
| Which account runs the helper | `invariant` | Any healthy account on this machine (CLI check plus an authenticated read, just in time), Claude or Codex, never the one under repair, explicitly pinned. With none: `waiting-operator-only` / `no-healthy-seat`, which leads to the phone Sign-in cell. |
| Approval on this path | `invariant` | Forced to `approval` until graduation. |
| Breaker | `invariant` | Only server-verified `wrong-identity` opens it on this path. |
| Pool status | `invariant` | The CLI login status plus an authenticated read (for Codex, the live app-server only). Recorded through the ledger's corroboration rule. Unmeasurable means no fresh `active`. |
| Transport | `invariant` | Platform plus the `navigation` value. |

## Multi-machine posture

- **Helper, Chrome window, code wait and lease.** `machine-local-justification: physical-credential-locality`. The profile's cookies and the CLI login live on this machine's disk.
- **Episode rows.** Already per machine and pool-readable (`?scope=pool`).
- **Peer cells.** The peer-cell **Repair sign-in** / **Sign in** actions are already relayed by signed mandate.
- **Notices.** Sent from the owning machine only.

## Self-heal before notify

The helper is the self-heal. The operator hears only three things:

- **A time-bound phone tap or macOS Allow.** This cannot be self-healed, so the notice goes out at once, once per attempt.
- **The final outcome.**
- **No helper available** (`no-healthy-seat`).

The latency ceiling is 20 minutes, the episode budget. The audit trail is the episode events. The flapping backstop is the existing 3-in-24h breaker.

## Verify the state, not its symbol

- **The helper says "done" or exits.**
  - Claimed state: signed in as the expected email.
  - Corroboration: pending-login completion, `verifyIdentity` and an authenticated call. The helper can write none of these.
  - If unmeasurable: `uncertain-external-outcome`, never success.
- **The CLI reports "logged in".**
  - Claimed state: the account can be used.
  - Corroboration: the poller's authenticated quota read. Identity stays with `verifyIdentity`.
  - If unmeasurable: `unknown`.
- **A posted code.**
  - Claimed state: the provider issued it for the CLI's request.
  - Corroboration: paste-back completes, then `verifyIdentity`. PKCE binds the code to the CLI's own request.

## Maturation plan

- **test-agent-live:** Rung 1. A throwaway agent's real helper drives local fixture sign-in pages in real Chrome. The fixtures cover a first-run window, a popup, a CAPTCHA page (the helper must stop) and a wrong-account chooser (the helper must stop). No real account is touched.
- **dev-agent-live:** Rung 2. Echo's macOS machines, with approval forced on this path whatever the configured mode, and the operator watching.
- **fleet:** Rung 3. Every other agent keeps today's value until graduation, then gets an explicit release.
- **graduation criterion:** at least 5 helper repairs verified by `verifyIdentity` and authenticated use. They must cover both providers and at least 2 machines, with zero `wrong-identity`.
- **dark-window:** at least 14 days on development agents only. Any `wrong-identity` on this path resets it.

## Frontloaded Decisions

1. **Scope.** macOS only. A new `navigation` value, inside the existing `browser-driving` state.
2. **Trust.** The helper is a trusted local operator that types its own passwords, with the skill's focus check. There is no server-typed-secret machinery.
3. **Hard lines.** The skill's four, and no others.
4. **Server surface.**
   - one code route, a tagged union of `code`, `phone-tap` and `macos-permission`;
   - the pre-attempt lease, capacity and helper check;
   - one store transition, `approved → waiting-operator-only`;
   - the pinned helper spawn and the kill;
   - two failure classes;
   - one notice kind;
   - one store method (`extendApproval`);
   - one operator-only text branch.
5. **Helper account.** Any healthy, explicitly pinned account, Claude or Codex, never the one under repair. Otherwise `no-healthy-seat`, and the operator gets the phone Sign-in cell.
6. **Breaker.** Only server-verified `wrong-identity` opens it on this path. The helper path never emits the driver's page-rule classes, and approval is forced until graduation.
7. **Pool health.** Status comes from the CLI's own login check. The default poll cadence is cheap to change afterwards; the rule itself is not.
8. **Helper model.** The default model for the helper account's framework. Cheap to change afterwards.

## Open questions

*(none)*
