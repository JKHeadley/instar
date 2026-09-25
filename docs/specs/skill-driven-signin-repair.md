---
title: "Skill-driven sign-in repair — an agent session signs in like a person"
slug: "skill-driven-signin-repair"
author: "Echo"
owner: echo
topic: 33890
eli16-overview: "docs/specs/skill-driven-signin-repair.eli16.md"
parent-principle: "Judgment Within Floors and Signal vs Authority (docs/STANDARDS-REGISTRY.md): an agent session judges each sign-in step inside a small set of code floors and holds no authority over success. Operator direction 2026-09-25 (topic 33890): use the best tool for the job, operating like a human user where needed; auth-sensitive flows only in a normal browser."
depends-on:
  - assisted-subscription-relogin
  - agent-driven-relogin
supersedes: "agent-driven-relogin Frontloaded Decision 1 (in-runtime model call, not a spawned session) — on macOS only"
---

# Skill-driven sign-in repair

## Problem statement

The automatic sign-in repair (subscription-relogin) has never completed one real unattended repair. Every real run has ended on a fixed page rule inside `AnthropicReloginBrowserDriver`. On 2026-09-25 the Laptop's two Claude accounts stopped within 3 seconds of Chrome opening:

- `sagemind-adriana` stopped on `unexpected-origin`. The front window was Chrome's "Sign in to Chrome" first-run prompt, and the Google sign-in then opens in a popup window.
- `sagemind-justin` stopped on `permission-expansion`, a false positive: the Authorize page listed the standard Claude Code scopes.

Both are security-class failures, so each also opened the 24-hour per-account breaker.

Within the hour, an ordinary agent session on the same Laptop, working from the `/subscription-signin` skill, signed both accounts in within about 10 minutes. It used screenshots, `cliclick`, System Events keystrokes, and pid-targeted Apple Events, and both accounts ended verified. The Mac Studio repair of 2026-09-24 was done the same way, by hand.

The operator's direction (2026-09-25, topic 33890): *"The agent should use whatever the best tool is for the job, which means, when necessary, bypassing typical 'automation' tools and operating more like a human user using the same interfaces."* The earlier standing rule still holds: auth-sensitive flows use a normal browser only.

### Why not fix the two driver rules instead

The two stops are symptoms of a layer mismatch, not two isolated bugs. The driver reads one tab's page. Real sign-ins also involve Chrome's own first-run windows, popup windows, OS-level prompts, and page variants nobody listed. Each fix would be one more page rule, and the next unlisted page stops the repair again. A person-like session handles these by looking at the screen. That is what worked on all three machines.

### Reconciling with `agent-driven-relogin`

That spec (approved 2026-09-24) chose an in-runtime model call over a spawned session. It did so after an 18-round review of a spawned-session design failed to converge, and it said a spawned session could be added *"if real repairs show it is needed."* Real repairs now show it: zero unattended successes, two false stops on 2026-09-25, and three hand-run session successes. This spec supersedes its Frontloaded Decision 1 **on macOS only**.

It does **not** bring back the 18-round machinery. There is no socket actuator, no tool-boundary hook, no lock files, no daily caps, no experiment arms and no click-audit table. The new surface, counted honestly, is:

- four episode routes;
- one slot index;
- two nullable columns and three failure classes;
- two notification kinds;
- the approval gate;
- boot cleanup;
- three `SessionManager` spawn options;
- a skill section with its migration;
- the dashboard Sign-in button on a waiting cell;
- the detached tick;
- the `secret-get` refusal;
- the `navigation` config value and its validator field;
- the orchestrator's waiting-cell cancel;
- the pre-spawn permission check;
- notice-template branches.

Most of it closes restart and race gaps in the existing episode machine rather than adding a new one.

### Delivered scope

The unattended value is narrower than the motivating incident. On 2026-09-25 both Laptop Claude accounts had expired, and the session that fixed them was started by hand. Under this design, the same case repairs unattended only if the machine has a third healthy qualifying seat. Otherwise it goes to the operator's phone path (see *Seat*).

**Delivered scope:** unattended repair on a machine that meets all of these:

- it has a spare healthy `claude-code` seat;
- its console is awake and unlocked;
- it has the one-time macOS permissions (see *Machine prerequisites*).

Everything else becomes a phone-completable operator step. The 2026-09-25 evidence indicts the driver's page rules, not the choice of navigation. The previous in-runtime agent navigation would have hit the same two refusals.

### What "normal browser" means

The property the standing rule protects is a normal browser:

- the account's own Chrome, launched the ordinary way;
- no remote-debugging or automation protocol attached;
- driven by OS-level input the way a person drives it.

Allowing JavaScript from Apple Events (which the existing plain-browser path already switches on in the profile) is itself a local automation channel. Unlike a debugging protocol, it is not visible to the page. The server uses it read-only, for checks. Input is OS-level keystrokes and clicks. The hand-run successes used the same kinds of mechanism, and no provider check stopped them.

### Other options considered

- **Notify only.** Skip the session and send the operator straight to the phone Sign-in path. That is kept as the fallback, but it gives up the unattended goal the operator asked for on every machine where a spare seat exists.

- **A general privileged-worker abstraction** (a reusable local workflow runner) is rejected for now. This is its only user, and the relogin-specific wiring is smaller than a general runner. If a second GUI-driving repair appears, extract it then.
- **A narrower worker without a shell.** The proven procedure *is* shell tools: `screencapture`, `cliclick` and `osascript`. A restricted tool boundary is the machinery that failed to converge last time.
- **Extending the normal-browser driver** (`PlainChromeReloginBrowser`) to handle popups, first-run prompts and consent variants. That *is* the path that stopped on 2026-09-25: it already runs in a normal Chrome, and it still needs a rule for every window it will meet.
- **Refreshing sessions before they expire.** Keeping each Google session warm (skill §4, weekly) is complementary and stays. It makes repairs rarer, but it does not remove the need for them.

## Glossary

- **Seat:** a subscription account an agent session runs on.
- **Cell:** one account on one machine.
- **Breaker:** the per-account 24-hour stop on repair retries.
- **Transport:** how a repair drives the browser (driver or agent session).
- **Rung:** a rollout stage.
- **Floor:** a limit enforced by code, not by instructions.

## Proposed design

On macOS, a repair episode's browser step is performed by **one agent session running the `/subscription-signin` skill's new "Agent-run repair" section**, on the machine that owns the account cell. Everything deterministic stays in code:

- admission and the attempt budget;
- starting the CLI login and handing the code to it;
- identity and authenticated-use verification;
- closing the incident;
- the audit trail.

### Flow (no new episode state)

The episode keeps today's states. The new transport is an implementation of the `driveBrowser` port inside the existing `browser-driving` state, and records the event class `agent-session-started`.

1. **Gate at approval (one slot, no queue).** One agent-session repair runs per machine. The slot is taken when an episode is approved. It is held in every live state and released only when the episode reaches a terminal state, `suggested` or `waiting-operator-only`. An unattended approval refused with `repair-running` waits silently; that is intended, and the other repair's session cap bounds the wait.
   - One gate function runs in `SubscriptionReloginService.approveWithAuthority`. The console and capacity checks, which may involve subprocess I/O, run before `store.approve`. Slot atomicity does not depend on ordering, because the store index enforces it. It is used by unattended auto-approval, `/approve` and `approve-with-mandate`, and also by the operator's `Service.retry`. It requires three things:
     - **the slot is free.** The store enforces this atomically. Both `store.approve` and `store.retryFailed` write the episode's `transport` (from the resolved `navigation`) in the same statement, and the runtime reads the transport from the row, never from live config. A partial unique index on `machineId` covers agent-session rows in every live state except `suggested` and `waiting-operator-only`, so a transient return to `approved` from `identity-verifying` or `auth-verifying` still holds the slot. It mirrors the existing `idx_relogin_live_cell` pattern and is created after the column migration (`ensureRepairEpisodeColumns`), not in the base schema. A constraint violation in `approve` or `retryFailed` maps to `repair-running`. It survives a restart and cannot race;
     - `SessionManager` is below `maxSessions`;
     - the console is usable (not locked, display awake).
   - An unattended episode simply waits while the console is locked. The Service counts `screen-unavailable` and `session-capacity` refusals per episode in memory. It increments the count in the tick's existing `catch` only for those two tokens, and resets it on any other outcome. A restart resets it too, which is acceptable. After 3 consecutive refusals it queues one `console-unavailable` notice per episode, so a headless or always-locked Mac never starves silently. The console state is read from the macOS session dictionary (`CGSessionCopyCurrentDictionary`: screen locked, on-console) and display sleep (`ioreg` `IODisplayWrangler`). If it cannot be read, the console counts as unavailable.
   - The error mappings of the two approve routes and the `/retry` route gain these tokens. A refused retry leaves the episode `failed`. A refused one-click (whose mandate was consumed) needs a fresh tap. An operator approve that fails this gate returns `409` with `repair-running`, `session-capacity` or `screen-unavailable`. The episode stays in its prior state and consumes no attempt.
   - This keeps a queued episode from dying of approval expiry, and keeps capacity refusals from using up attempts.
2. **Browser.** The runtime opens the profile's Chrome the normal way through the existing `PlainChromeReloginBrowser` launch. That launch already refuses with `relogin-profile-in-use` when a person has the profile open. The Chrome pid is persisted on the episode in a new nullable column, `drivePid`.
3. **Seat.** The runtime chooses the account the session runs on:
   - it must be `active`, identity-verified, not under repair, and not at its quota limit by its last reading;
   - its framework must meet a declared capability requirement: the session can reach localhost HTTP and run GUI tools (`screencapture`, `cliclick`, `osascript`). Today only `claude-code` meets it. Headless Codex runs sandboxed without localhost network. A framework that meets the requirement later qualifies with no design change. Codex *accounts* are still repaired, by a qualifying seat;
   - if there is none, the episode goes to `waiting-operator-only` with class `no-healthy-seat`, and nothing is spawned.
   - **Correlated expiry is accepted as an operator case.** When every qualifying seat on a machine has expired at once (the Laptop on 2026-09-25 had only its two Claude accounts), there is no seat to run the session. The repair then needs the operator, and the step can be done from a phone. The notice links to the account's cell on the dashboard, and the existing manual sign-in there shows the login link or code. The operator completes it in their phone's browser, and a Claude code is pasted back through the dashboard. Weekly Google-session warming (skill §4) makes this rarer but is not claimed to prevent it.
4. **Machine prerequisites (checked before spawn).** Three one-time macOS permissions are needed:
   - **Screen Recording** for the session, so `screencapture` works.
   - **Accessibility** for the session (`cliclick`, System Events) and for the server (posting key events).
   - **Automation of Google Chrome**, which the existing plain-browser path already needs.

   Before spawning, the runtime runs a small probe command **inside the session's own launch context** (the same tmux server), because macOS grants these permissions to the responsible process. The probe uses `CGPreflightScreenCaptureAccess` and `AXIsProcessTrusted`. It does not rely on a test screenshot, which succeeds without permission and shows only the wallpaper. A missing permission maps to the existing `automation-permission` class, and the notice names which permission is missing.

   Granting a macOS permission cannot be done from a phone. These are one-time setup per machine, like installing Chrome, though macOS may periodically ask to re-confirm Screen Recording. The per-spawn probe catches a lapse. Until they are granted, that machine's repairs go to the phone-completable Sign-in path.
5. **Spawn.** One session is spawned through `SessionManager` with:
   - **a fixed, server-rendered prompt** containing the episode id, the expected email, the provider, a per-episode token, and the instruction "follow the skill's Agent-run repair section, then stop". It never contains a secret, a verification URL or a code.
   - **`INSTAR_RELOGIN_EPISODE=<id>`** in its environment.
   - **An explicit seat pin**: `{accountId, configHome, framework}`.
   - **`disableProjectMcp: true`**, so no Playwright or other MCP servers are loaded.
   - **`maxDurationMinutes` equal to the session cap.**
   - **A deterministic name, `relogin-<episodeId>`,** so incident review can find it from the episode.
   - **No topic binding and no job slug.** The resume queue already skips sessions that have neither. In addition, the runtime's own kill is recorded as a completed stop, never as mid-work, so the session is never revived.

   Three spawn options are new work in `SessionManager`: an `extraEnv` map, an explicit seat pin that bypasses the global account resolver, and the completed-stop record.
6. **Session cap.** The cap is `min(15 min, artifact expiry − 60 s)`, so the session can never outlive the login it is approving. If that leaves less than 5 minutes, nothing is spawned; the result is the existing transient `artifact-expired`, which reissues the login.
7. **Brief.** The session reads `GET /subscription-relogin/:episode/agent-brief` with its token. The brief holds:
   - the verification URL;
   - the Codex `userCode`, when there is one;
   - the expected email;
   - the Chrome pid;
   - the names of the vault bindings, never their values.
8. **Sign-in.** The session works the pages the way a person would: screenshots, `cliclick` and pid-targeted Apple Events. It types secrets only through the type-secret route (see *Code floors*).
9. **Result hand-off.**
   - **Claude.** The session posts the paste-back code to `POST /subscription-relogin/:episode/code`. This resolves the in-memory wait of the episode's `driveBrowser` with `{ outcome: 'approved', pasteCode }`. From there the existing `finishCli` → `ClaudePasteBackController` path runs unchanged. The code is never persisted. A wrong code follows today's `cli-finishing` handling, and the episode budget bounds it. It never produces success.
   - **Codex (device code).** There is no code to hand back. `driveBrowser` resolves when `credentialReady` sees a credential. That shows *a* credential exists, not *whose*: `verifyIdentity` still decides.
10. **Stops.** The session calls `POST /subscription-relogin/:episode/agent-report` with a closed enum:
   - `needs-physical-action` (a tap on the operator's phone, for example Google's "Is it you?" prompt, which the operator completes on that phone): the server queues one fixed-template notice per attempt, as a new `repair_notifications` kind, `physical-action`. `repair_notifications` is `UNIQUE(episodeId, kind)`, so `store.transition` deletes not-yet-delivering `physical-action` and `operator-only` rows whenever an episode enters `approved`. That covers the orchestrator's retry, `retryFailed` and an operator resume. A notice still mid-delivery is kept, and the next attempt's notice is dropped as a duplicate; that edge case is accepted. The notice names the machine, the expected email and what to tap. The episode continues. The operator has until the session cap, and that limit is intentional.
   - A macOS permission prompt is not a `needs-physical-action`. The Automation permission is a one-time per-machine prerequisite that the existing `automation-permission` path already handles. A session that meets a macOS prompt reports `other`, which hands off to the phone-completable Sign in cell path.
   - `captcha`, `phone-check`, `wrong-account` or `other`: the episode goes to `waiting-operator-only` with class `agent-handoff`. The value is recorded as the reason token.
11. **End.** `driveBrowser` also resolves when the session exits or its cap passes.
    - If the session never fetched its brief, the seat was unusable. The result is transient `seat-busy` with reason `agent-seat-unresponsive`, which keeps it distinct from a held profile.
    - Otherwise the attempt ends as `failed` / `agent-sign-in-unfinished`.
    - `driveBrowser` catches its own errors after the spawn and returns `agent-sign-in-unfinished`. A thrown error never reaches the transient retry.
    - **Session count.** There is at most one session per *attempt*. The existing orchestrator retry paths (verification unavailable, artifact expiry, an unreachable target, a seat that never fetched its brief) can start another attempt. They are bounded by `maxAttempts` (default 3) and the 20-minute episode budget. The type-secret use counters are keyed on the episode, not the attempt.
    - The session and the Chrome window the runtime opened are closed in `driveBrowser`'s `finally`, including on abort, cancel or service stop.
12. **Verification.** Unchanged. Success needs pending-login completion, `verifyIdentity === 'match'` and authenticated use. Nothing the session says can produce it.

**The four episode routes** are the brief, `code`, `agent-report` and `type-secret`. The skill treats any `409` from them as terminal: stop immediately. The `agent-report` route drains the notification queue immediately for `physical-action`.

- A route accepts a request only while its episode's in-memory wait exists (the episode is in `browser-driving` with this transport) and only with that episode's token.
- The token and the wait live only in the runtime's memory, and the token is compared by hash. After a server restart both are gone, so every route answers `409`.
- `/code` accepts one code, checked with the existing paste-back code-shape validator.

### Code floors

**Secrets are typed by the server, not the session.** The session calls `POST /subscription-relogin/:episode/type-secret {ref}`. `ref` must be one of this account's vault bindings: `password`, `totp` or `backupCode`. Per episode, the route allows at most one backup code and at most two uses each of `password` and `totp`. After that it refuses, and the episode goes to `agent-handoff`.

The server then does all of the following, in order:

1. It brings the front window of the recorded Chrome pid forward.
2. Through that pid's Apple Events JavaScript runner (the one `PlainChromeReloginBrowser` already uses), it reads the active tab's origin. It refuses unless the origin is in the driver's existing allowlist (`ANTHROPIC_ORIGINS` / `OPENAI_ORIGINS`, which include `accounts.google.com`).
3. In the same call, it refuses when the page URL or its `continue` parameter points at a Google account-settings destination (`myaccount.google.com`); that is a narrow code floor against a settings re-auth. It requires `document.hasFocus()`, which is false when the address bar has focus. It also requires the focused element to be the expected kind of field:
   - an `<input type=password>` for `password`;
   - a one-time-code or numeric input for `totp` / `backupCode`.
4. It confirms the console is unlocked and the frontmost process is the recorded pid.
5. It confirms the focused field is empty, so an autofilled field or split single-digit boxes refuse as `secret-field-refused` before typing.
6. It resolves the value (`resolveSecret`, `generateTotp` or `takeBackupCode`).
7. It types the value with real key events through `CGEventPostToPid` to the recorded pid, which cannot reach another app. A System Events fallback is used only through an explicit config opt-in (`assistedRelogin.secretTyping: 'system-events'`). Without it, if Chrome ignores pid-posted events, type-secret refuses and the attempt hands off.
8. It repeats checks 2–4. The origin must still be allowlisted, the page focused, and the same kind of field focused. The focused field's `value.length` must equal the typed length; the server reads the length only, never the value. If the page has navigated away on an allowlisted origin after a full-length type (for example, an auto-submitting code field), the result is `typed-unverified`. It is not treated as a misdirection, but it is audit-only. It is never evidence that the right field received the secret. A second `typed-unverified` in the same episode hands off. Only a present field with the wrong length, or an off-allowlist origin, is a misdirection.

The response is either `typed` or a named refusal, and never contains the value. Before typing, a refusal is `secret-origin-refused`, `secret-field-refused` or `secret-focus-refused`. Anything unmeasurable also refuses. If the post-typing check fails, the keystrokes may have gone elsewhere and cannot be recalled. This is recorded as `secret-focus-lost`, and the episode goes to `agent-handoff` so the operator can decide whether to rotate the secret. The post-check detects a misdirected secret; it does not prevent one (see residual risk).

New reason tokens are recorded under the store's existing `agent` prefix (`agent-report-<value>`, `agent-secret-origin-refused`, and so on), so they are never collapsed to `unclassified`.

**Grants cannot exceed the CLI's own request.** The Claude code is bound by PKCE to the authorization request the CLI started, so a code from any other request fails paste-back. The Codex device code approves only the CLI's own device request. An over-broad consent on the CLI's grant is therefore excluded structurally, and the driver's page-level `permission-expansion` check is not needed on this path.

**Why keystrokes, not setting the field's value.** The server could assign the verified field's value through the same in-tab JavaScript channel. That would remove the misdirected-keystroke residual, but provider sign-in forms react to real key events and can reject or flag programmatically set values. The only proven path is real keystrokes. The approval-mode rung means the operator approves each episode that types a real secret, until the per-identity unattended floors are met on this transport.

**Success is decided only by server verification.**

**What the session cannot do is not a floor.** `secret-get.mjs` refuses every name when `INSTAR_RELOGIN_EPISODE` is set. This is a speed bump on the ordinary path, not a floor: the session can unset the variable or read vault files directly. It is named as residual risk below. The script change ships through the existing script-template refresh.

### Enumerated schema and type changes

- **Store.**
  - Nullable columns `transport` and `drivePid`, added the same way `loginMethod` was.
  - `FAILURES` gains `agent-handoff`, `agent-sign-in-unfinished` and `no-healthy-seat`.
  - Notification kinds `physical-action` and `console-unavailable`, each with a branch and callback in `drainNotifications`.
  - A partial unique index for the agent-session slot, created after the column migration.
  - `store.approve` and `retryFailed` write `transport`.
  - `store.transition` into `approved` deletes that episode's not-yet-delivering `physical-action` and `operator-only` rows.
  - `getUnattendedEvidence` gains the `transport` filter.
- **Service.** `tick` also passes `waiting-operator-only` episodes to the orchestrator. That call is cheap and makes no external calls.
- **Orchestrator.**
  - A new incident check is added ahead of the early `waiting` return, for `waiting-operator-only` only. The wall-clock budget, `authorityReady` and `recoverUncertain` never apply to that state. When the source incident has closed or is missing, the episode is cancelled with `source-incident-closed`, which frees the cell and the per-account live index. The cancel also deletes the episode's undelivered `operator-only` rows, except a `secret-focus-lost` warning, which is always delivered. The terminal notice repeats its rotation warning. `suggested` is unchanged. A failed ledger read is logged once per episode, not on every tick.
  - A manual sign-in closes the incident when the ledger next observes the account as active (its next cell observation), so the cancel follows within one poll interval.
  - The `BrowserRepairResult` failure classes gain the three new classes.
- **Notice templates** (`src/commands/server.ts`).
  - **Operator-only:**
    - `no-healthy-seat`: "No signed-in account on this machine can run the repair. Use Sign in on this account's cell."
    - `agent-handoff`: names the reason. For `secret-focus-lost` it names which binding (password, authenticator code or backup code) may have been typed elsewhere, and says rotating it may be needed.
  - **Terminal:** a `source-incident-closed` cancel picks its wording from the ledger's recorded outcome, never claiming verification. `resolved` gives a NORMAL "sign-in restored; repair closed". `cancelled` or a missing incident gives a NORMAL "repair closed; this account is no longer tracked". Neither sends the HIGH "repair ended in cancelled" text. The notice code tells this cancel apart from an operator cancel by the episode's last event class.
    - `automation-permission`: variants for Screen Recording, Accessibility and Chrome Automation, each ending "…or tap Sign in on this account's cell from your phone."
    - `console-unavailable`: points at the cell's Sign in.
- **Dashboard** (`dashboard/subscriptions.js`). A cell whose agent-session repair is `waiting-operator-only`, `suggested` or `failed` also shows the existing **Sign in** (start-cell) button, so a refused approval (a locked screen, no capacity, a running repair) always leaves a phone path.
  - start-cell reuses the episode's pending login while it is alive, and otherwise mints a fresh one.
  - It acts on the machine the operator is working on; a peer's cell goes through that machine's own start flow.
  - Tapping **Try repair again** during a half-done manual sign-in abandons that login, and the link or code stops working. That is documented.
- **Service/Orchestrator wiring.** The approval gate is wired into `Service.approveWithAuthority` and `Service.retry`.
- **Config.**
  - `navigation` accepts `agent-session`.
  - The `/configure` validator gains a `navigation` field.

### Service change

`SubscriptionReloginService.tick` stops awaiting running episodes. It starts each runnable episode detached, with a `.catch` that logs the error. The episode itself is left in its persisted state for the next tick's normal recovery. `runEpisode` keeps its existing controller lifecycle and terminal-notification drain, and `stop()` still aborts every controller. The existing `inFlight` set prevents a double start. Scanning, approvals and notification drains therefore keep running during a session. Driver episodes behave as before, except that they no longer hold up the tick.

### Budgets

- In practice, one attempt that runs to its session cap uses most of the 20-minute budget. Attempts 2–3 exist for early failures: a seat that never answered, an expired artifact or a transient verification error. That is intended.
- If the helper seat walls or loses its login mid-session, the session stalls or exits. That ends the attempt as `agent-sign-in-unfinished`, or as `seat-busy` if the brief was never fetched. The helper seat's quota spend is bounded by the session cap.

- When `navigation` resolves to `agent-session`, the runtime passes `maxWallClockMs: 20 min`, within the existing 30-minute ceiling.
- The budget is checked only when a tick starts, so it never interrupts a wait in progress. The session cap is what actually bounds a drive.
- **Before the spawn**, the runtime re-checks the console and the session capacity. A failure is transient `seat-busy` and no session is spawned. The approval gate makes this rare.
- **A session that never fetched its brief** (for example, a seat that was walled despite its last reading) is `seat-busy`. That is transient and not a breaker class. Repeated `seat-busy` still uses up `maxAttempts`, and the resulting `attempt-budget-exhausted` failure counts toward the 3-in-24h breaker. That is an accepted, bounded effect.
- **Type-secret counters** live in memory per episode. They reset on an operator retry (`retryFailed` resets the attempt budget too) and on restart, which also ends the session. With two password uses and three attempts, a third attempt may be unable to type a password. That is intended: it hands off rather than keep typing a password that failed twice.
- **Every other post-spawn ending is typed:**
  - `agent-sign-in-unfinished` is failed;
  - `agent-handoff` and `no-healthy-seat` are operator-only.

### Restart and rollback

- **Server restart mid-session.** The in-memory wait and token are gone. Boot recovery for `browser-driving` is unchanged: `recoverUncertain` moves the episode to `identity-verifying` when the credential is ready, and otherwise to `waiting-operator-only` / `uncertain-external-outcome`.
- **Leftovers at boot.** Boot also kills any tmux session named for a relogin episode that is no longer waiting on it. It closes the recorded `drivePid` Chrome only if `findProfilePid(userDataDir)` still returns that same pid. Otherwise a window left open would block every later repair of that account as `relogin-profile-in-use`.
- **Rollback.** Setting `navigation` back to `agent` or `closed` restores the driver. No state or transition is added.
  - The new nullable columns (`transport`, `drivePid`) and the new failure classes are read, never written, by older binaries, so an older binary can still cancel these rows.
  - An older binary that hits the slot index gets a raw constraint error (500 on approve, 409 with the raw message on `/retry`). That is a rollback-only artifact.
  - One exception: an older binary's notification drain sends an unknown kind to `onTerminal`. A pending `physical-action` notice would then go out as a terminal notice once.
  - An older binary that retries a row tagged `agent-session` runs the driver under that tag, which puts one driver outcome into this transport's evidence. That is accepted as a rollback-only artifact.

### Breaker and graduation evidence

- **No change to the breaker's class set.** The driver still runs off macOS and emits those classes.
- **Reports never open the breaker.** `agent-handoff`, `no-healthy-seat` and `seat-busy` are not security classes. The only security class this transport produces is `wrong-identity`, which is server-measured.
- **Unfinished sessions count.** `agent-sign-in-unfinished` counts toward the existing 3-failures-in-24h threshold.
- **Old rows are driver rows.** Episodes record `transport`, and `NULL` means driver.
- **Graduation evidence.** `getUnattendedEvidence` scopes the success count and the oldest success by `transport`, the same way it already scopes them by login method. A success on the driver path proves nothing about this path. `wrong-identity` stays unscoped: it counts across every transport and method, as today, so a switch never erases bad history. For the agent-session transport, the driver-only `unexpected-origin` / `permission-expansion` rows are not counted. They are verdicts of the driver's fixed page rules, which this path does not have, and 2026-09-25 showed those rules misfiring. Server-measured escapes (`wrong-identity`) stay counted everywhere. Unattended mode on this transport therefore needs its own track record under the existing per-identity floors, which remain the only enforcement for unattended mode. The Maturation plan's graduation criterion gates the fleet flip only.
- **Existing breakers.** The breakers the 2026-09-25 false stops opened expire on their own.

### Platforms and configuration

- **New value.** `subscriptionPool.assistedRelogin.navigation` gains `agent-session`, honored on macOS only. Off macOS it resolves to the driver.
- **Default when omitted.** `agent-session` on a macOS development agent, and today's value everywhere else. The resolver becomes platform-aware.
- **New work.** The config type and `POST /subscription-relogin/configure`'s validator both need to learn the value. The validator has no `navigation` field today.
- **Session model.** The seat framework's default.

### Skill, awareness and migration

- **New skill section.** `/subscription-signin` gains **"Agent-run repair (spawned by the runtime)"**:
  - read the brief;
  - raise the recorded pid's window and act only in that pid's windows;
  - follow popups and first-run prompts;
  - type secrets only through the type-secret route;
  - the stop rules and the report enum;
  - post the code;
  - stop.
- **Existing skill text.** Section 3's "the repair types the password" rows name the route. The "stop after two attempts" line is aligned with the attempt budget (`maxAttempts`).
- **Migration.** A `PostUpdateMigrator` migration, guarded by the old content's hash, updates installed copies of the skill, because `installBuiltinSkills` never overwrites.
- **CLAUDE.md.** The template's "Agent-navigated sign-in" bullet names `agent-session`. `migrateClaudeMd` gets a replace-existing-bullet guard; today's guard only checks that the bullet is absent.

### Named residual risk

- **Prompt injection.** The session reads provider pages through screenshots, and it keeps Bash and the agent's server access token. The session has **operator-equivalent authority on this machine**: the dashboard PIN is readable in `.instar/config.json`, so PIN-gated routes do not bound it. This is the same trust any agent session on the machine already has, and it amounts to granting a trusted local operator session. That is why the rollout starts in approval mode with the operator watching. The real bounds are that it reads only provider sign-in pages, has no topic, is killed at its cap, and cannot produce success, which only the server's verification decides.
  - Mitigations: it has no topic, its secrets reach only allowlisted, focused password or code fields, success is server-verified, and it is killed at its cap.
  - A deliberately subverted session could still read vault files from disk, which is the same trust as any agent session on the machine.
- **Clicks can hit the wrong window.** `cliclick` works in screen coordinates. The skill directs the session to the recorded pid's windows; that is guidance, not a floor.
- **The navigation origin floor is gone.** Both predecessor designs checked the origin of every step. Here only type-secret is origin-checked, and the session can browse anywhere. This is an explicit regression, accepted under Frontloaded Decision 11 and bounded by approval mode.
- **Third-party consent screens.** The PKCE bound covers the CLI's own grant only. A misled session could approve another app's consent screen on an allowlisted origin. The skill's stop rule is to report `other` on any consent page that is not the CLI's request; that is guidance, not a floor.
- **Account-setting controls are no longer blocked by code.** The old driver refused sign-out, password-change and recovery controls in code. Here that is skill guidance. type-secret refuses a URL (or top-level `continue` target) on `myaccount.google.com`, but nested redirects and other settings re-auth shapes are not recognised. Approval mode is the bound until the per-identity unattended floors are met on this transport.
- **Type-secret checks the page, not the account.** A session misled onto another account's password page could send the expected account's password to that login attempt. It stays with Google, and at most two password uses are allowed per episode.
- **A spent backup code.** `takeBackupCode` removes the code before typing, so a post-check failure spends one code that was never used. That is bounded at one per episode, and the event reason records it.
- **Where unattended value exists.** Unattended repair works only on a machine that has another healthy qualifying seat and a console that is awake, unlocked and not in use in that Chrome profile. A machine kept screen-locked by policy gets the `console-unavailable` notice and the phone path instead. That is a deliberate trade-off: the design does not unlock screens.
- **A kill that fails.** If the `finally` kill fails without a restart, the slot frees while the old session lives on. The failed kill is recorded as an episode event (`agent-session-kill-failed`), and the next boot cleans it up.
- **The session transcript holds the verification URL and the paste-back code.** Both are single-use, PKCE-bound and short-lived.
- **A gap between check and keystroke.** A page could change between the checks and the typing. The focus check after typing detects this but cannot undo it. With the System Events fallback, a focus change in that gap could also send keystrokes to another app; `CGEventPostToPid` cannot.

### Shadow evidence (Judgment Within Floors)

- **The deterministic default** (the fixed driver) has zero real successes.
- **The judgment path** (a person-like session following the skill) has three verified hand-run successes: the Mac Studio on 2026-09-24, and the Laptop's two accounts on 2026-09-25. All three were verified by the same server checks this spec keeps. That is the shadow evidence for giving the judgment path authority on development agents, in approval mode first.
- **What those runs did not cover.** They did not use the type-secret route. For that route, Rung 1's fixture pages are the only evidence before a real account is touched.

## Decision points touched

| Decision point | Classification | Notes |
|---|---|---|
| How to get through the sign-in pages | `judgment-candidate` | **Floor (code):** secrets only through the type-secret route, which checks origin, focused field and frontmost pid, with per-episode use limits. The grant is bounded by the CLI's own PKCE or device request. The session cap is tied to the artifact's expiry. One agent-session repair per machine (store index). At most one session per attempt, bounded by `maxAttempts`. Only the server decides success. The floor bounds the decision's *authority outputs* (typing a secret, granting consent, declaring success), not the session's general tools, which are the agent's existing machine trust (see residual risk). **Guidance (skill):** expected account only; no working around a CAPTCHA or phone check; act only in the recorded pid's windows; do not use `secret-get` (a speed bump). **Arbiter:** `verifyIdentity` plus authenticated use. **Conservative default:** report and hand off. **Fallback ladder:** `agent-handoff`, then operator-only (deterministic). |
| Episode success | `invariant` | Unchanged: completion plus `verifyIdentity === 'match'` plus authenticated use. |
| Approval gate | `invariant` | A free slot, session capacity and a usable console. Otherwise `409`, with no attempt consumed. |
| Type-secret admission | `invariant` | Token; a ref in this account's bindings; per-episode limits; an allowlisted origin with no `myaccount.google.com` URL or `continue` target; `document.hasFocus()`; a focused, empty field of the right kind; the frontmost pid. A post-type length check maps to `secret-focus-lost`; post-type navigation is audit-only `typed-unverified`. If anything is unmeasurable, refuse. |
| Agent-report mapping | `invariant` | Closed enum. `needs-physical-action` sends a fixed notice and the episode continues. Everything else goes to `agent-handoff` and operator-only, without the breaker. |
| Whether a failure opens the breaker | `invariant` | The store's class set is unchanged. This transport emits only the server-measured `wrong-identity` as a security class. |
| Which seat runs the session | `invariant` | A seat whose framework meets the capability requirement (today `claude-code`), active, identity-verified, not under repair and not quota-walled. With none, `no-healthy-seat`. |
| Which transport runs | `invariant` | Platform plus the `navigation` value. |

## Multi-machine posture

- **Session, Chrome window, repair slot and in-memory code wait.** `machine-local-justification: physical-credential-locality`. The Chrome profile's cookies and the CLI login live on this machine's disk.
- **Episode rows.** Kept per machine and already pool-readable (`GET /subscription-relogin?scope=pool`).
- **Repair sign-in from a peer's cell.** The operator's one-click **Repair sign-in** on a peer's cell is already relayed by signed mandate.
- **Notices.** Notices come from the owning machine only, through its `repair_notifications` queue.

## Self-heal before notify

The agent session is the self-heal step. The operator hears from it in only three cases:

1. **A tap on the operator's phone is needed** (a Google "Is it you?" prompt), which the operator completes from that phone. This cannot be self-healed and must happen within the session's window, so the fixed notice goes out at once, at most one per attempt.
2. **The repair ends without success.** The existing terminal or operator-only notice goes out.
3. **The repair cannot start.** After 3 consecutive `screen-unavailable` or `session-capacity` refusals, one `console-unavailable` notice goes out per episode.

Parameters:

- `max-notification-latency`: 20 min, the episode budget, for notices about a running repair. The `console-unavailable` notice fires outside the budget, after 3 refused ticks, about 90 seconds at the default tick.
- Audit: the episode events, which carry closed reason tokens only.
- Flapping backstop: the existing 3-in-24h breaker.

## Verify the state, not its symbol

- **The session's "done" or its exit.**
  - State claimed: signed in as the expected email.
  - Corroboration: pending-login completion, `verifyIdentity` on the config home, and an authenticated quota read. The session can write none of these.
  - Unmeasurable: `unknown`. The episode never becomes `succeeded` on that basis; it goes to `uncertain-external-outcome`.
- **Codex `credentialReady`.**
  - State claimed: a credential exists.
  - It is not identity. `verifyIdentity` decides, and a result it cannot resolve becomes `uncertain-external-outcome`.
- **An agent report.**
  - State claimed: the provider wants a human.
  - Uncorroborated, so it carries no authority. It only routes to the operator.
- **Type-secret.**
  - Symbols: the active tab's origin, `document.hasFocus()`, the focused element's type, and the frontmost pid.
  - State claimed: the keystrokes will land in a provider's password or code field.
  - Corroboration: the pid is the Chrome that the runtime itself launched for this profile.
  - Unmeasurable: refuse.
- **A posted code.**
  - State claimed: the provider issued a code for the CLI's request.
  - Corroboration: paste-back completes, then `verifyIdentity`.

## Maturation plan

- **test-agent-live:** Rung 1. A throwaway agent's real spawned session drives local fixture sign-in pages through real Chrome. The fixtures cover:
  - a first-run window;
  - a popup where a password must be typed;
  - an off-allowlist page and an address-bar focus, where type-secret must refuse;
  - a CAPTCHA page;
  - a wrong-account chooser;
  - a main window plus a popup of the same Chrome pid, proving that the window type-secret checks is the window that receives the keystrokes;
  - a sign-in page whose `continue` target is `myaccount.google.com`, where type-secret must refuse.

  No real account is touched.
- **dev-agent-live:** Rung 2. Echo's macOS machines, where an omitted `navigation` resolves to `agent-session`. Repairs start in approval mode, with the operator tapping and watching. Unattended mode follows the existing per-identity evidence floors, counted on this transport only. Before graduation counting starts, one real run must show that the Apple Events JavaScript channel reaches a real provider popup (`accounts.google.com`) that `document.hasFocus()` behaves as the fixtures showed, and that the real password and code fields are top-level inputs, not inside an iframe. An iframe would make type-secret refuse every time, which fails safe but blocks the path. Rung 2 also records the time from a `physical-action` notice to the operator's tap, to test whether the session-cap window is long enough. These are empirical preconditions checked at Rung 2, not operator decisions.
- **fleet:** Rung 3. Every other agent keeps today's value until the graduation criterion passes. The fleet default flips in a later, explicit release. The phone fallback depends on the dashboard's start-cell flow, which today is behind `multiMachine.accountFollowMe` (dark on the fleet). The fleet flip must confirm start-cell is enabled there, or name another phone path.
- **graduation criterion:** at least 5 agent-session repairs verified by `verifyIdentity` and authenticated use, across both providers and at least 2 machine roles (a stationary machine and a laptop). Zero `wrong-identity`. Zero `secret-*-refused` or `secret-focus-lost` events that the fixtures did not cause.
- **dark-window:** at least 14 days on development agents only. Any `wrong-identity` or `secret-focus-lost` on this transport resets the window.

## Frontloaded Decisions

1. **Where it runs.** macOS only, as a new `navigation` value, inside the existing `browser-driving` state. There is no new state or table, only two nullable columns.
2. **The code channel.** An episode-token route resolves the in-memory `driveBrowser` wait. The code is never persisted. Codex has no code route.
3. **Secrets.** The server types them after checking the origin, the focused field and the pid, with per-episode use limits. The session's `secret-get` refusal is a speed bump, not a floor.
4. **Operator contact.** A fixed-template `physical-action` notice through `repair_notifications`. The session has no topic binding.
5. **Seat.** A healthy seat on a framework that meets the capability requirement (today `claude-code`), not quota-walled, and not the account under repair. Otherwise `no-healthy-seat`. Correlated expiry of every qualifying seat is accepted as an operator case, completed from the phone through the dashboard cell's Sign in.
6. **Admission and budgets.**
   - The one slot, session capacity and a usable console are checked at approval, with no queue.
   - At most one session per attempt, bounded by `maxAttempts`, with the slot enforced by a store index.
   - Session cap `min(15 min, artifact expiry − 60 s)`.
   - A 20-minute episode budget.
7. **Breaker.** Its class set is unchanged, and reports never open it. Graduation evidence is scoped by transport.
8. **Rollout.** As in the Maturation plan. The dev default is a gated rung (approval mode first), not a cheap flip.
9. **Session model.** The seat framework's default. This is cheap to change later and touches no identity, money or interface.
10. **The non-macOS driver** is untouched, including its `permission-expansion` check. The CDP driver has never passed Claude's Authorize, so tuning its scope rule is out of scope. Its known scope false positive is explicitly accepted there.
11. **Trust decision.** The spawned repair session is a trusted local operator session. The code floors bound its authority outputs, not confidentiality against the session itself. There is no OS or user-account isolation; that is the explicit trade-off for staying inside the proven, person-like path.

## Open questions

*(none)*
