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

On macOS, the browser step of a repair episode is done by **one agent session that follows `/subscription-signin` section 3**, exactly as the hand-run repairs were. The session is a **trusted local operator**, with the same trust as any agent session on the machine. The server keeps everything deterministic.

### What the server does (unchanged unless noted)

1. **Admission and lease.** Episode admission, the attempt budget and the breaker are unchanged, and `idx_relogin_live_cell` still prevents two repairs of one account.
   - *New, at approval, before any attempt is counted:* the episode is approved only when three things hold:
     - the machine's existing `PlaywrightSeatLease` is free. This is a pre-check only; the lease itself is acquired in step 3;
     - a healthy helper account exists (see step 3);
     - `SessionManager` has room.
   - Otherwise it stays `suggested` and is re-evaluated each tick, with no attempt spent. If it is still blocked after 3 ticks, one fixed notice links to the dashboard's phone **Sign in** cell.
   - On this path, mode is forced to `approval` until graduation, whatever `assistedRelogin.mode` says. A trusted helper is never spawned unattended before the evidence exists.
2. **Start the CLI login.** Unchanged.
3. **Spawn the helper.** *New:* spawn one session, named `relogin-<episodeId>`:
   - It runs on **any healthy account on this machine, Claude or Codex, never the account under repair**. "Healthy" means active, not rate-limited, and passing a just-in-time CLI login check plus an authenticated read before spawn.
   - The helper is pinned to that account explicitly. *New:* a spawn option carries `{framework, configHome}` for both Claude and Codex, resolved through the credential-location gate, because the global headroom resolver pins Claude only and cannot exclude an account.
   - A Codex helper is spawned with the full-access sandbox mode (the existing `codexAllowMcpTools` path), so it can reach localhost and run GUI tools.
   - The prompt is fixed and server-rendered. It carries:
     - the episode id and the expected email;
     - the verification URL (and, for Codex, the device `userCode`);
     - the names of the account's vault bindings;
     - a per-episode token;
     - the instruction "follow `/subscription-signin` section 3, then stop."
   - It has no topic binding and is never revived.
   - It is capped at `min(15 min, login expiry − 60 s)`.
   - If the helper account loses its login mid-run, the helper exits and the attempt is `agent-sign-in-unfinished`.
   - **Lease.** Before the `approved → cli-starting` transition, which counts the attempt, the runtime acquires the `PlaywrightSeatLease` with the episode as holder. If the lease is held, the episode stays `approved` with a short `nextAttemptAt` and no attempt is counted. The lease is renewed every 2 minutes, because its 10-minute TTL is shorter than the helper cap, and it is released on every exit. This is the one-helper-per-machine floor.
   - **Awaiting the helper.** The helper is awaited inside the existing `driveBrowser` port, as an in-memory promise within the `browser-driving` state. The token and the wait live only in memory.
   - *New:* `SubscriptionReloginService.tick` starts `runEpisode` detached, just as `approve()` and `retry()` already do. Today it awaits the episodes; the existing `inFlight` set prevents double starts. As a result, a 15-minute helper never blocks scanning or notice delivery, including its own phone-tap notice.
4. **Code hand-off.** *New:* one route, `POST /subscription-relogin/:episode/code`, with the episode token. The body is a strict tagged union: `{"code": "…"}` or `{"notify": "phone-tap"}`, and anything else is refused. `code` is accepted once, is checked by the existing paste-back code-shape validator, and a second one gets `409`. `notify` is idempotent and never consumes the code slot. Both are accepted only while this episode's helper is live. It resolves the episode's in-memory `driveBrowser` wait, then runs the unchanged `finishCli` → paste-back path. The code is never persisted. Codex device logins need no code: the wait resolves when the credential appears.
5. **Arbiter.** Unchanged. Success is pending-login completion, then `verifyIdentity === 'match'`, then authenticated use. The session's word never counts. A helper that exits, or reaches its cap, without that is `failed` / `agent-sign-in-unfinished`.
6. **Cleanup.** The helper session is killed on every exit from `browser-driving`, including abort and cancel. After a server restart, the existing `browser-driving` recovery applies, and boot kills any `relogin-*` session whose episode is no longer driving.

### What the helper does (the skill, section 3)

- It works the pages like a person: screenshots, `cliclick`, pid-targeted Apple Events. It follows popups and first-run windows.
- It types passwords itself, from the vault over stdin (never on a command line, in chat or in a file). Before **every** keystroke burst, it checks that:
  - the frontmost process is the Chrome it opened;
  - `document.activeElement` is the expected password or code field.
- It posts the Claude code to the code route.
- It stops at a hard line and reports it by exiting with the reason written to its final output. The episode events record that it exited unfinished.

**Hard lines (the skill's four, and only four):**

1. Expected account only.
2. No working around a CAPTCHA or a phone check.
3. Passwords only on Google, Claude or OpenAI pages.
4. Never touch a Chrome window it did not open.

The skill gains a short "Agent-run repair" subsection with the steps above. Installed copies are updated through an idempotent `PostUpdateMigrator` migration, because `installBuiltinSkills` never overwrites.

### Operator contact

The helper has no chat channel. Operator notices are fixed text, sent through the existing `repair_notifications` / attention path, from the owning machine only:

- **Phone tap needed** (for example Google's "Is it you?"). The helper requests it through the code route's `{"notify":"phone-tap"}` action, using the same token. It is a new notification kind, `phone-tap`, sent at most once per episode because `repair_notifications` is `UNIQUE(episodeId, kind)`. It gets its own branch in `drainNotifications` and the notification kind union. Today unknown kinds fall through to the terminal handler.
- **macOS Allow needed** (Screen Recording, Accessibility or Chrome Automation). This goes through the existing `automation-permission` notice, reworded to name which permission.
- **Final failure or hand-off.** This goes through the existing operator-only and terminal notices, each with the dashboard link. There the operator can finish sign-in from a phone with the existing one-tap **Sign in** cell (start-cell). That cell is also shown while a repair is waiting on the operator.

### Breaker

Only server-verified `wrong-identity` (from `verifyIdentity`) opens the 24-hour lockout on this path. This needs no change to the store's breaker. The helper path simply never emits the driver's page-rule classes (`unexpected-origin`, `permission-expansion`, `captcha`, `phone-confirmation`); a helper that stops at a hard line ends as `agent-sign-in-unfinished`. So on this path the existing rule reduces to `wrong-identity`. Every other failure counts only toward the existing threshold of 3 in 24 hours. The class list stays as it is for the driver off macOS.

The store's closed `FAILURES` list and the orchestrator's result type gain `agent-sign-in-unfinished`. Nothing else is added: no new state, table or transition.

### Pool health from the CLI's own login status

An account's pool status must come from the CLI's own login check (`claude auth status` / `codex login status` against that account's config home) together with an authenticated read. It must not come from stale pool state.

- **Codex needs a live read.** Only a live `codex-app-server` quota read counts as an authenticated read. The rollout-file fallback is usage history, not proof of login. That fallback is why three signed-out Codex accounts read `active` for days, and the same rule applies to the arbiter's authenticated-use check.
- *New rule (the ledger has none today).* An account becomes `needs-reauth` through the ledger's explicit `transition-to-needs-reauth` outcome only when two things agree on two consecutive polls:
  - the CLI login check says signed out;
  - the authenticated read is refused **as an auth failure**: an unauthenticated or login-required response. A transport failure or timeout does not count, and leaves the status unchanged. For Codex, this means the live app-server read reports no or invalid auth. Today that case silently falls back to the rollout file.
- The existing absence-observation contract is unchanged. A missing credential file alone still never triggers a repair.
- A signed-out reading never overrides a successful authenticated read.
- **Identity stays with `verifyIdentity`.** `claude auth status` reads metadata, so it is not an identity oracle.
- **An unrunnable check changes nothing.** The prior status is kept, but the account is not eligible as a helper seat. It is never counted as a fresh `active`.

### Configuration and rollback

- `subscriptionPool.assistedRelogin.navigation` gains `agent-session`, honored on macOS only. Off macOS it resolves to the existing driver.
- When the value is omitted, it resolves to `agent-session` on a macOS development agent and to the existing value elsewhere.
- Rollback is setting `navigation` back to `agent` or `closed`. No state, table or transition is added.

### Named residual risk

- **Trusted-operator trust.** The helper has the same machine trust as any agent session: shell, vault and the dashboard PIN on disk. A prompt-injected page could misuse that. It is bounded by the four hard lines, the 15-minute cap and server-only success, and rollout starts in approval mode.
- **Clicks can go astray.** `cliclick` clicks by screen position and can hit another window. The focus check guards keystrokes, not clicks.
- **The transcript holds single-use artifacts.** The session transcript contains the verification URL and the code, both single-use and short-lived.
- **Correlated expiry.** When every account on a machine has expired at once, there is no helper. That case goes to the operator's phone Sign-in cell.
- **Removed page-rule floors.** The driver's runtime origin, scope and destructive-control checks do not apply to the helper. Its intermediate clicks are bounded by the four hard lines and approval mode, not by code. That is the operator's explicit choice (FD2); PKCE still binds the CLI's own grant.

## Alternatives considered

- **A narrower deterministic actuator or restricted tool set.** This is the machinery that failed to converge over 18 rounds, and the operator chose against it.
- **Fixing the driver's page rules.** A rule per unexpected window keeps failing on the next unexpected window.
- **Notify-only.** This is kept as the fallback when no helper exists.

## Decision points touched

| Decision point | Classification | Notes |
|---|---|---|
| Getting through the sign-in pages | `judgment-candidate` | **Floor:** the four hard lines, the per-keystroke focus check, the session cap, one helper per machine, and server-only success. **Arbiter:** `verifyIdentity` plus authenticated use. **Default:** stop and hand off. **Ladder:** operator-only, then the phone Sign-in cell. |
| Episode success | `invariant` | Completion, `verifyIdentity === 'match'` and authenticated use. |
| Which account runs the helper | `invariant` | Any healthy account on this machine (CLI check plus an authenticated read, just in time), Claude or Codex, never the one under repair, explicitly pinned. With none, the episode waits in `suggested`. |
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
- **No helper available** (after 3 ticks).

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
   - one code route, with one `notify` action;
   - the approval-time lease, helper and capacity check;
   - the pinned helper spawn and the kill;
   - one failure class;
   - one notice kind.
5. **Helper account.** Any healthy, explicitly pinned account, Claude or Codex, never the one under repair. Otherwise the episode waits, and the operator gets the phone Sign-in cell.
6. **Breaker.** Only server-verified `wrong-identity` opens it on this path. The helper path never emits the driver's page-rule classes, and approval is forced until graduation.
7. **Pool health.** Status comes from the CLI's own login check. The default poll cadence is cheap to change afterwards; the rule itself is not.
8. **Helper model.** The default model for the helper account's framework. Cheap to change afterwards.

## Open questions

*(none)*
