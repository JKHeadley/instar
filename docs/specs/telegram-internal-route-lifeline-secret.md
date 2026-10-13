---
title: "Internal Telegram routes require a lifeline-only secret"
slug: telegram-internal-route-lifeline-secret
date: 2026-10-12
author: echo
parent-principle: "Know Your Principal — An Unverified Identity Is a Guess"
parent-principle-fit: "The two internal Telegram routes take the sender's Telegram user id from the request body and everything downstream (operator auto-bind, sender re-validation, inline-button approvals) treats it as the authenticated sender. Any session holding the ordinary API token could therefore name the operator as the sender. This change makes the routes require proof that the caller is the lifeline before the body's sender id is trusted."
binding-standards: ["Know Your Principal — An Unverified Identity Is a Guess", "The Agent Is Always Reachable", "A Refusal Stays a Refusal — conservation of negative outcomes", "A Dark Feature Guards Nothing", "Verify the State, Not Its Symbol", "No Unbounded Loops — Every Repeating Behavior Carries Its Own Brakes", "Self-Heal Before Notify", "The Operator Channel Is Sacred — Critical-Path Gates Fail Toward Delivery", "No Silent Degradation", "Signal vs. Authority", "Migration Parity", "Agent Awareness"]
lessons-engaged: ["telegram-lifeline-auth (2026-04-18): the last hardening of these routes dropped every inbound message because the client was not updated — hence arm-on-proof", "lifeline-version-skew-recovery (2026-05-20): a refusal counted as a failed delivery silently dropped messages — hence the no-budget outcome for a secret refusal", "auto-updater-lifeline-coordination: the lifeline lags the server; the restart signal is the coordination channel"]
eli16-overview: telegram-internal-route-lifeline-secret.eli16.md
approved: true
approved-by: "builder brief from the supervising Echo session, 2026-10-12, plus the peer reviewer's three added requirements relayed by that session the same day. The builder saw no direct operator statement; the run ends at an unmerged PR held for peer review, and the PR states that."
review-convergence: "2026-10-13T03:20:04.765Z"
review-iterations: 4
review-completed-at: "2026-10-13T03:20:04.765Z"
review-report: "docs/specs/reports/telegram-internal-route-lifeline-secret-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 21
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Internal Telegram routes require a lifeline-only secret

## Problem statement

Two routes in `src/server/routes.ts` carry Telegram input from the lifeline process into the server:

- `POST /internal/telegram-forward` (messages) reads `fromUserId`, `fromUsername`, `text`, `topicId` and more from the request body.
- `POST /internal/telegram-callback` (inline-button taps) reads `fromUserId`, `data`, `callbackQueryId` from the body, builds a query object with `from.id = fromUserId`, and hands it to `TelegramAdapter.handleForwardedCallback`.

Both are authenticated only by the ordinary Bearer `authToken`. `SessionManager` places that token in every spawned session's environment (`INSTAR_AUTH_TOKEN`). So any session can post a message, or an Approve tap, that claims the operator's Telegram user id. Everything that reads that id is then fooled:

- both operator auto-binds (`TopicOperatorStore.setAuthenticatedOperator`: one in the forward route, one in the message pipeline in `src/commands/server.ts`),
- the inbound log row that `standing-authorization` counts as a verified-operator grant,
- the scope-accretion and matrix-acceptance ratifiers (they authorize on `senderUid === operatorUid`),
- slash commands and the topic-profile ingress in the message pipeline,
- the agent-to-agent hook (the body also says whether the sender is a bot),
- every inline-button approval, including the owner-only tunnel-consent buttons.

The server cannot tell the lifeline from a session, because both present the same credential.

## Terms

- **Lifeline**: the small always-running process that polls Telegram and forwards each update to the server over loopback HTTP. It keeps undelivered messages in a durable on-disk queue.
- **Restart signal**: `state/lifeline-restart-requested.json`, written by the server, read by the lifeline's tick (and by the launchd watchdog script when a signal is older than 60 s). A lifeline whose version equals the signal's `targetVersion` deletes it and does nothing; any other version restarts on the `plannedUpgrade` bucket, which shares a cap of three restarts a day with real version-skew restarts.
- **Drop budget**: the lifeline gives up on a queued message after 3 "bad request" rejections or 100 transient failures, and tells the user it could not be delivered.
- **Ratifier**: server code that treats an inbound Telegram message from the bound operator as an approval (of postponed work, of a coverage matrix).
- **Attention item**: an entry in the operator's attention queue, delivered into the Attention topic in Telegram.
- **Seat**: the one machine that currently polls Telegram for this bot. A seat transfer moves the poll to another machine.
- **Verified**: a request that carried the valid secret.
- **Armed**: the guard has recorded that refusing is safe (defined below).
- **Sender not trusted**: defined under "What an unverified request gets".

## Proposed design

### The secret

A value only the lifeline and the server hold: 32 random bytes, hex-encoded (64 characters), in `<stateDir>/state/lifeline-ingress-secret`, mode 0600. Module: `src/core/LifelineIngressSecret.ts`.

- **Creation** is atomic and exclusive. Whichever of the lifeline or the server needs it first writes the full value to a private temp file (`wx`, 0600) and hard-links it to the final name. `link` fails with `EEXIST` if the other process won, and the loser reads the winner's value. A reader can never see a half-written file.
- **Replacement** happens only when the file was read successfully and is not 64 hex characters. A file that could not be read (any error other than "does not exist") is never replaced; creation throws instead.
- **Where it lives.** In the file and in a module-private variable of the two processes. Never in `process.env`, never a tmux `-e` flag, never logged, never returned by any route. The server spawns sessions and children inherit its environment, so "not in the environment" is the property that keeps it out of sessions. `SessionManager` does not import the module.
- **Holder.** Each process caches the value; the server uses one holder per state dir, shared by the guard and by the server's own call, so they cannot disagree. A re-read that fails keeps the last good value. A first load that fails is retried at most every 30 s. On a mismatch the server re-reads the file (creating it if absent) at most every 5 s.
- **Never served, never editable.** The path prefix `state/lifeline-ingress-secret` is added to `KEY_MATERIAL_PATHS`, the one list that feeds the file routes' deny (list, read, download, link, save, hard-link inode check), the backup exclusions, the gitignore entries written at init and by `PostUpdateMigrator`, and the git-sync secret classifier. The guard's state file is named `state/lifeline-ingress-secret.guard.json` so the same prefix covers it; `state/telegram-callback-seen.json` is listed too. Those two are not keys. They are listed because the file editor is reachable with the Bearer token alone, and a session that could rewrite `armedAt` through it would disarm the guard without touching the filesystem.
- **Tool hooks.** The repo has no tool hook that refuses reads of key material: no hook template names `identity.json` or any other key path. The existing floor is the list above. No hook template changes, so no hook migration is needed.
- **Rotation.** The value is replaced only when malformed, and both processes keep their cached copy when a re-read fails. To rotate a secret that may have leaked: delete the file, then restart the server and the lifeline. The first to start creates a new value and the other reads it. Messages sent in between are held by the lifeline and delivered after.
- **Why a shared-secret header.** A Unix socket at a 0600 path, or request signing with the same key, would give the same guarantee under one OS user and cost more change to the lifeline's transport. The header is the smallest change that an older lifeline simply omits.

### The check

The routes require the header `X-Instar-Lifeline-Secret`. `LifelineIngressGuard` (`src/server/LifelineIngressGuard.ts`) compares it to the secret in constant time (both sides SHA-256 hashed, then `timingSafeEqual`). The check runs before any effect of the request. The Bearer check in the server middleware is unchanged and still required. No existing check is removed, including the callback handlers' `answerCallbackQuery` rejections.

A request without a valid secret has reason `missing` (no header) or `mismatch` (wrong value).

### Callers updated

- `TelegramLifeline.forwardToServerClassified` (first forward, the legacy-strict retry, and therefore queue replay) and `TelegramLifeline.forwardCallbackQuery` send the header.
- The server's own re-injection call in `src/commands/server.ts` (`injectionDropped` handler) sends the header from the shared holder, and `X-Instar-Ingress-Caller: server-self`. The label is read only after the secret verified and can only remove evidence: such a request does not arm the guard and does not count as lifeline traffic. Its body carries no `fromUserId`.
- `POST /internal/slack-forward` is a misdirected-route stub that injects nothing; unchanged. No other caller of either route exists in `src/`, `scripts/`, the hook and script templates, or the skills.

### Arming: no message is refused without proof

The lifeline can lag the server by many patch versions, because it restarts only on drift or a major.minor skew. A lifeline on older code sends no header. If the server simply refused, every Telegram message would bounce (this happened in April 2026).

The guard therefore refuses no message until it is **armed**; `armedAt` is persisted. It arms in one of two ways:

1. **The lifeline proved itself** (`armedBy: 'lifeline-proof'`). A verified request arrived that was not the server's own call. A current lifeline does this through a new route, `POST /internal/lifeline-proof` (Bearer + secret; body carries only `lifelineVersion`; no effect beyond the guard; answers `{ ok, verified, mode }`), on server-up and on its 15-second tick whenever the last proof is older than 15 minutes, which includes the first tick after it starts. Arming does not wait for a Telegram message, and a current standby lifeline that never polls still arms its own server.
2. **There is no lifeline to wait for** (`armedBy: 'no-lifeline-ingress'`). The server's adapter is polling Telegram itself, or Telegram is not configured (then no lifeline can exist). The guard arms without any request: at the boot nudge below, and whenever `/health` or the guard-posture row is read. A configured Telegram whose adapter object is absent is treated as unknown and waits for proof.

**Boot nudge.** A lifeline on older code does not know it should restart, and on a quiet machine no request would tell it. So 60 seconds after the server's routes are built (a current lifeline has normally proven itself by then; if it has not, it receives a signal it ignores because its version matches), the guard: creates the secret if absent; persists its state, which pins `observingSince`; arms if there is no lifeline to wait for; and, if a lifeline is expected and the guard is still unarmed, writes the restart signal once through the persisted budget below. One lifeline restart per machine, after which the lifeline proves itself.

### What an unverified request gets

**Sender not trusted** means: in the forward route, immediately after the check and before anything else reads them, the body's identity claims are dropped: `fromUserId` and `fromUsername` become undefined, `fromFirstName` becomes `Unverified sender`, and the bot fields (`senderIsBot`, `senderChatId`, `senderBotId`) are cleared. The message is delivered with `metadata.senderUnverified: true` and no sender id. Every consumer listed in the problem statement then sees no first-party identity: neither auto-bind runs (the pipeline's bind also checks the flag), the inbound log row has no operator uid, the ratifiers get no sender uid, commands and the topic-profile ingress receive sender id 0, the agent-to-agent hook is told the sender is not a bot, and the session sees the message as from "Unverified sender". Such a request also does not claim a key in the exactly-once ledger: it chose its own `updateId` and `messageId`, and could otherwise pre-claim the id of a real message yet to arrive.

What "sender not trusted" does **not** remove is authority that never reads the sender. The emergency-stop intercept acts on the message text, and a few slash commands (`/interrupt`, `/restart`, `/link`, `/unlink`, `/claim`, `/local-model`) ignore the sender id. A Bearer holder already has route equivalents for these, so nothing is gained through this path. The inbound log row is still written (the message was delivered and belongs in the topic history), with a caller-chosen `messageId` and no uid.

| Guard state | Message | Button tap | Startup proof |
|---|---|---|---|
| Unarmed, observe (any age) | accepted as before this change (sender trusted), counted `would-refuse` | accepted as before, counted | accepted `{ verified: false }`, counted |
| Unarmed, enforce, within the 24 h allowance | accepted as before, counted | accepted as before, counted | accepted, counted |
| Unarmed, enforce, after those 24 h | delivered, **sender not trusted**, counted | **refused** 401 | accepted, counted |
| Armed, observe | delivered, **sender not trusted**, counted | **refused** 401 | accepted, counted |
| Armed, enforce | **refused** 401 | **refused** 401 | **refused** 401 |

The 401 body is `{ ok: false, error: 'lifeline-secret-required', refused: true, reason }`.

- **A message is never refused before arming**, in any mode. That is the no-lost-message rule.
- **An unarmed guard in observe changes nothing**, for as long as it stays unarmed. Observe is the fleet default, and a fleet agent's real messages and taps are never degraded by this change before a development agent has run the strict behaviour (the maturation path). The cost is stated plainly: on a fleet agent whose lifeline never updates, the original hole stays open. It is not silent: the unarmed guard is reported hourly, raises an operator attention item after a day, and reads off on `/guards`; and such an agent can never graduate to enforce, because graduation needs arming.
- **In enforce, the unarmed state is a bounded migration allowance** of 24 hours (`PRE_ARM_TRUST_MS`) from when the feature first ran on the machine. After that an unproven message is still delivered but carries no identity, and an unproven tap is refused. The clock starts at the earlier of the guard's persisted `observingSince` and the secret file's own timestamp, so a lost or corrupt guard state file does not buy a fresh 24 hours. On a normal update the allowance is used for about a minute: the boot nudge restarts the lifeline, which then proves itself.
- **When that allowance ends with the lifeline still not updated** (its restart failed, or the restart cap was already spent, or it runs older code under the same version string, as a source checkout rebuilt in place can), real messages arrive as from "Unverified sender" and real taps fail. That is the intended trade on an enforcing agent: delivered and loud, instead of the hole staying open.
- **With the server's secret unreadable**, a tap is refused with 503 in every row (see "Failure of our own side").
- **A tap is refused rather than delivered untrusted** because a tap is nothing but a privileged act (it can be an approval); there is no identity-free form of it. Taps are not queued by the lifeline; the user sees "Failed to process — please try again".
- **Wrong secret, accepted**: the response carries `X-Instar-Lifeline-Secret-Stale: 1`, and a current lifeline re-reads its file. Without that, a lifeline with a stale copy would never learn of it in observe, because it re-reads only on a refusal.

### Modes and the two config keys

`telegramIngress.lifelineSecret.enforce` (boolean, shipped omitted) chooses observe or enforce:

| `enforce` | Development agent | Other agents |
|---|---|---|
| omitted | `enforce` | `observe`, until the exit rule below is met; then `enforce` |
| `true` | `enforce` (still only once armed) | `enforce` (still only once armed) |
| `false` | `observe` (held) | `observe` (held) |

Where there is no lifeline ingress (`armedBy: 'no-lifeline-ingress'`) the default is `enforce` on every agent class: observe exists to watch a real lifeline's traffic, and there is none. `enforce: false` still holds observe there.

`telegramIngress.lifelineSecret.bypass: true` is the **full rollback**: every request is accepted with its sender trusted and taps accepted, whatever the guard's own state. Two things from this change still apply under bypass, because they are not about the secret: a tap id must be a string or a number, and a tap delivered twice is applied once. The check still runs and counts; each unverified request is reported and raises an attention item; the guard-posture row reads off.

Both keys are read through the live config reader when one exists (so setting and removing them take effect without a restart). Neither is in `PATCHABLE_CONFIG_KEYS`, and the config file is not editable through the file routes: they are changed by editing the config file on the machine, and a Bearer holder cannot change them over HTTP.

The agent class comes from the repo's `resolveDevAgentGate` convention; the feature is registered in `DEV_GATED_FEATURES`.

Note on naming: "observe" is not "nothing changes" once the guard is armed. Observe never refuses a *message*, and while unarmed it changes nothing at all; once armed it drops unproven sender identity and refuses unproven taps. `bypass` is the setting for "nothing changes".

### Observe has a defined exit

With `enforce` omitted on a non-development agent, the guard switches to `enforce` by itself when either arm holds:

- **Quiet window.** Armed, 24 hours since the later of observation start / the last `would-refuse` / the last refusal, and at least 10 verified Telegram requests from the lifeline (forwards and taps; startup proofs and server-self calls excluded) since the last `would-refuse`.
- **Deadline.** 7 days since arming (`enforceDeadlineAt`, recorded at arming), whatever the counts say.

The deadline exists because a caller holding only the Bearer token can keep the quiet window from closing by sending one unverified request a day. The quiet window is the early exit when traffic is clean; the deadline is the bound. Graduating by deadline uses no traffic evidence, by design: by then the guard has been armed for a week, in which unverified requests were reported (at most one report an hour) and raised operator attention items (at most one a day).

Why a window at all after arming: arming shows the *lifeline* sends the secret. The window is for a caller this change did not find (an operator's own script) to show up as a `would-refuse`, a report and an attention item before it starts being refused. A legitimate caller that calls less often than the window can still be refused after graduation; it then gets the typed 401, which names the cause.

The rule is evaluated on every request and when `/health` is read. Meeting it records `graduatedAt` and `graduatedBy` (`quiet-window` or `deadline`).

The evidence is persisted in the guard state file (tmp + rename; single writer, the server): `observingSince`, `verified`, `verifiedServerSelf`, `wouldRefuse`, `refused`, `secretUnavailable`, per-reason and per-route counts, `lastVerifiedAt`, `lastWouldRefuseAt`, `lastRefusedAt`, `verifiedSinceLastWouldRefuse`, `armedAt`, `armedBy`, `enforceDeadlineAt`, `graduatedAt`, `graduatedBy`, `lastSignalAt`, `attentionAt`. A server restart loads it, so the window, the deadline and the counts carry over. Verified requests write through. Unverified requests can arrive at any rate, so their writes are bounded: five per second write through, the rest are coalesced into one trailing write per second, and their log line is limited to one per 10 s.

`enforce: false` holds observe regardless of the rule; `/health` reports `observeExit.pinnedObserveByConfig: true`. Held observe still drops unproven identity, refuses unproven taps and reports every unverified request.

### If a refusal reaches a real lifeline, the message is held, not lost

This needs an armed, enforcing server and a lifeline that cannot present the secret (its copy is stale; it cannot read the file; it was rolled back alone).

1. A current lifeline treats a 401 `lifeline-secret-required` as "my copy is stale": it re-reads the file once per forward and the existing retry delivers the message on the next attempt. The callback path re-reads and retries once.
2. If the server still refuses, the lifeline stops retrying that forward (`ForwardSecretRefusedError`) and returns the same replay outcome as a version skew: the message is put in, or stays in, the durable on-disk queue and **no drop budget is burned**. It is never dropped as "server unreachable".
3. That state carries its own brakes: queue replay is single-flight; a pass stops at the first secret refusal (the rest would be refused identically); while refused, replay backs off (one minute, doubling, capped at fifteen; a server-up event or a newly arrived message probes at once); the lifeline logs at most one line a minute, including whether it can read the secret itself.
4. It is not silent to the user. At the first refused attempt after ten minutes in this state (with the backoff, about fifteen minutes on a quiet queue), the lifeline, which holds the bot token and does not depend on the server, sends a fixed notice to its alert topic (the Agent Updates topic, else the Lifeline topic): messages are being held, not lost, and `/lifeline restart` usually resolves it. The notice is recorded as sent only when the send succeeded; a failed send is tried again at the next refusal. One per episode per lifeline process; the episode ends on the first delivered forward. On the server side such requests raise the `unproven-after-arming` report and attention item (below).
5. The queue has no size bound of its own in this state; it grows by the user's messages until the fault is fixed.

A lifeline from **before this change** has none of 1–4. It handles the 401 generically: a transient failure, so the message goes to the durable queue, and it restarts if the restart signal is written. If it comes back on pre-change code and stays there, its transient budget (100 replay attempts at one per 15 s, about 25 minutes) drops the message with the existing user-visible "could not be delivered" notice. That needs an armed, enforcing server and a lifeline pinned to pre-change code, which the update path does not produce. See Rollback.

### The restart-signal budget

Any Bearer holder can produce an unverified request, and a restart on this signal shares the daily cap of three with real version-skew restarts. So every signal write caused by an **unverified** request is bounded, and the bound is persisted (`lastSignalAt`):

- before arming: at most one write per 12 hours (the rollout nudge for a lifeline on older code);
- after arming: at most one write per 24 hours;
- never when the server's own running version is unknown (a target no lifeline can match would restart an up-to-date one); a declined write does not spend the budget;
- the forward route's existing HTTP 426 version-skew handler writes the same signal file; when the request is unverified, that write goes through this same budget (a verified lifeline's 426 writes as before). The guard evaluates first and usually spends the budget itself, writing an equivalent signal (same file, same target version), so for an unverified lifeline the 426 handler's own write rarely happens; the 426 response still drives that lifeline's in-process restart as before.
- the signal file itself is in the never-served list, so the file editor cannot be used to write it around the budget.

A session can therefore cause at most one lifeline restart a day after arming and cannot exhaust the cap. A lifeline restart loses nothing (durable queue).

### Idempotency

- **Messages.** The check precedes every effect of the forward route. A refused request has had no effect of any kind, so its replay is the first and only application. A request that was accepted and whose response was lost is the existing exactly-once-ingress concern (`MessageProcessingLedger`, where enabled); this change does not alter it.
- **Button taps.** Telegram gives each tap a unique `callback_query.id`. `TelegramCallbackDedupe` (`src/server/TelegramCallbackDedupe.ts`) claims the id before the handler runs.
  - The claim is recorded as `pending` before the handler runs, then `done` or `failed` after it. A claim is never released (at-most-once: a person who wants to retry taps again, which is a new id).
  - A second delivery answers by what is known, and is never re-applied: `done` → `{ ok: true, deduped: true }`; `failed` (the handler threw) → 409 `{ ok: false, deduped: true, error: 'callback-previously-failed' }`; `pending` (the server stopped between claim and outcome, or the first delivery is still running) → 409 with `error: 'callback-outcome-unknown'`. A failure or an unknown outcome never reads as success.
  - The claim is taken after the secret check, so a refused tap is not claimed and its retry is processed.
  - The guarantee is bounded by retention: a tap redelivered after its claim has aged out (7 days) or been evicted (more than 2000 newer taps) is not recognised. Telegram does not redeliver updates that old.
  - The id must be a string or a number (else 400).
  - Verified taps are claimed in a persisted store (`state/telegram-callback-seen.json`, bounded to 2000 ids and 7 days; at most about 100 KB, rewritten twice per tap: at claim and at outcome). Taps accepted without proof (possible only while unarmed, or under `bypass`) are claimed in a separate in-memory store, so an unproven caller can neither fill nor evict the durable record. A verified tap is also checked against the in-memory store, so a tap accepted unproven and then re-polled after the lifeline restarts is still applied once; that check does not survive a server restart in between, and it means an unproven caller who knew a tap's id in advance could suppress that tap (Telegram's callback ids are long and not predictable).
  - A tap redelivered while its first delivery is still `pending` answers 409, so the user can see "please try again" for a tap that then succeeds. The lifeline never sends one tap concurrently; this needs a lifeline restart in the middle of a tap.
  - No callback dedupe existed before this change.

### Failure of our own side

- **Server cannot read or create its secret and has never held one in this process.** Nobody can be verified. A message is delivered with the sender not trusted; a tap is refused with 503 `{ ok: false, error: 'lifeline-secret-unavailable', refused: true }`. Refusing every message for a local disk fault would make the agent unreachable; trusting a sender without proof would restore the problem this change fixes. The load is retried every 30 s; if a retry fails too, it is reported.
- **Server's re-read fails but it holds a value.** It keeps the value and keeps checking against it. The server's own call uses the same held value.
- **Lifeline cannot read or create its secret.** It sends no header. Before arming nothing changes. After arming, in enforce, its messages are held as described above (brakes, user notice after ten minutes); in observe they are delivered as from "Unverified sender"; its taps are refused. The server reports and raises the attention item.
- **Guard state file unwritable.** Counting continues in memory; `stateWriteFailures` is on `/health`.
- **Guard state file absent**: a quiet fresh start. **Corrupt**: reset to unarmed and the default mode, reported once, `stateCorruptAtLoad: true` on `/health`. A current lifeline re-arms it at its next proof.
- **Tap claim store corrupt**: starts empty, `callbackDedupe.corruptAtLoad: true` on `/health`.

### Reports

Reports go through `DegradationReporter`, feature `TelegramIngress.lifelineSecret`, at most one per kind per hour. A degradation is a log line, a persisted record and a feedback submission; it is a user alert only where `monitoring.degradationReporter.notifyUser` is set. Three kinds additionally raise an operator attention item (category `security`, priority HIGH, source `telegram-ingress-lifeline-secret`, id `telegram-ingress:<kind>:<date>`), so they reach the operator by default. Each kind has its own throttle of one item per 24 hours, persisted in the guard state (`attentionAt`), so a recoverable notice cannot use up the slot a security notice needs; the dated id means a later day's item is new even if an earlier one was resolved; and if the item could not be created the throttle is released so the next occurrence tries again. Each machine raises its own.

| Kind | Class | Raised when | Self-heal first | Reaches the operator |
|---|---|---|---|---|
| `unproven-after-arming` | security | any unverified request (missing or wrong secret) after arming, on that request | none, by design: after the server's own re-read it is not a healthy lifeline | attention item |
| `bypassed` | security | an unverified request accepted because `bypass` is set | none | attention item; the guard-posture row |
| `secret-mismatch` | recoverable | before arming: 3 wrong-secret requests in a row, at any spacing, with no verified or header-less request between them (the count is in memory and restarts with the server) | the server re-reads its file (at most every 5 s); the lifeline re-reads on a refusal or a stale hint | degradation |
| `unarmed` | recoverable | an unverified request while still unarmed 1 h after the feature first ran on the machine (checked independently of `secret-mismatch`) | the restart signal, written by the boot nudge (so the heal precedes the report by about an hour) | degradation; the guard-posture row; an attention item once 24 h have passed, in either mode |
| `secret-unavailable` | recoverable | a retried load failed too (at least 30 s after the first failure) | the load retry every 30 s | degradation |
| `state-corrupt` | loss of rollout state | at load | a current lifeline's next proof re-arms; graduation is not restored | degradation |

Lifeline side: the "messages are being held" notice after ten minutes of secret refusal, one per episode.

Audit location: the persisted guard state and the degradation record. Neither contains the secret.

### Observability

The authed `/health` gains:

- `telegramIngress.lifelineSecret`: `mode`, `modeSource`, `armed`, `armedBy`, `bypassedByConfig`, `refusing` (messages: enforce, armed, a secret held), `refusingTaps` (armed, or the pre-arm allowance over, or no secret held), `preArmTrustEndsAt`, `secretAvailable` (the file is readable now; a read, never a create), `observeExit` (`rule`, `pinnedObserveByConfig`, `deadlineAt`, `graduatedAt`, `graduatedBy`, `quietSince`, `quietHours`, `verifiedSinceLastWouldRefuse`), `observingSince`, `armedAt`, the counters, `lastSignalAt`, `stateCorruptAtLoad`, `stateWriteFailures`.
- `telegramIngress.callbackDedupe`: `tracked`, `duplicatesDropped`, `writeFailures`, `corruptAtLoad`.

The unauthenticated `/health` does not carry them. Nothing in them contains the secret.

`refusing` needs a secret held in memory, which is loaded by the first request or by the boot nudge, so it can read false for the first minute after a server start.

**Guard posture.** The guard is in `GUARD_MANIFEST` as `telegramIngress.lifelineSecret` (code-default on, load-bearing, critical path "operator identity on Telegram ingress (operator binding, button approvals)", `declaredLoadBearingAt: 2026-10-12`, 30-day soak) with a runtime getter:

- `enabled` is true only when the guard is armed and not bypassed. Reading the row arms a machine with no lifeline ingress, so such a machine is never reported unarmed.
- `dryRun` is true only when observe is **held by config** (`enforce: false`). Default observe is not reported as a dry run: once armed it already drops unproven identity and refuses unproven taps, which is the declared critical path, and it ends by itself. Reporting it as a dry run would raise a "critical path unguarded" alarm on every healthy fleet agent once the manifest's calendar soak window passes.

What the operator sees: an unarmed guard with a lifeline expected, and a bypassed guard, both derive `off-runtime-divergent` on `/guards` and alert after two consecutive probe ticks, with no request needed. The probe's generic remediation text says to restart the component or its server; for this guard the fix is restarting the lifeline (unarmed) or removing `bypass`. A held observe derives `on-dry-run`: soaking until 2026-11-11, a load-bearing gap after.

### Agent awareness

`generateClaudeMd` and `migrateClaudeMd` gain one section, "Telegram internal routes need the lifeline secret", with identical wording. It must state: what the secret is and where it lives; that I never call the routes or read the file; that no message is refused before arming, that an unarmed guard in observe changes nothing, and the 24-hour allowance in enforce; what an unproven tap and an unproven message get once armed; the two modes and the default per agent class; the exit rule with its numbers; the two config keys (`enforce` true or false, and `bypass`) and that they are file-only; where to read the state, naming `refusing` and `refusingTaps` and telling the reader to compare `lastWouldRefuseAt` / `lastRefusedAt` with `armedAt` because the counters are running totals; the limit; and the proactive trigger.

## The limit, stated plainly

Every process here runs as one OS user. This is a cooperative boundary. It stops a session forging a message or a tap with the token it normally holds. It does not stop a session that deliberately reads the secret file, deletes or rewrites the state file directly on disk, or edits the config file. Closing that needs sessions to run as a separate OS user or in a sandbox; nothing in this change attempts it. The only barrier to a session reading the file is the instruction in CLAUDE.md, which is a request, not a structure.

Two neighbouring surfaces are unchanged:

- `POST /sessions/:name/input` lets a Bearer holder type raw text into a session, including text shaped like an injected Telegram message. That reaches the session's eyes only; it does not reach operator binding, the inbound log, the ratifiers or the tap handlers.
- `POST /a2a/inbox` (the same-machine agent-to-agent entry) lets a Bearer holder hand the agent-to-agent hook a message with a body-supplied bot claim. It reaches that hook only, and never operator binding or the user-message path.

All three time rules (the 24-hour allowance, the quiet window, the 7-day deadline) read the wall clock. A clock set forward ends them early; a clock set back extends them.

## Decision points touched

| Decision point | Classification | Justification |
|---|---|---|
| Is the request verified (header equals the secret) | `invariant` | Exact credential compare. No competing signals; a judgment here would add a way to be talked into accepting a forgery. |
| Replace the secret file when malformed, never when unreadable | `invariant` | Two fixed outcomes keyed on the read result. |
| Is the guard armed by proof | `invariant` | A recorded fact: a verified lifeline request was seen. |
| Is the guard armed because there is no lifeline ingress | `invariant` | A deterministic read of the adapter's polling state or the config; unknown waits for proof. Its worst case (misdetected) is a held message and a lifeline restart. |
| Skip the exactly-once ledger claim for an unverified message | `invariant` | A caller-chosen id from an unproven caller must not occupy a real message's key. |
| Exclude `server-self`-labelled requests from arming and traffic counts | `invariant` | Fixed rule; the label is honoured only after the secret verified and only removes evidence. |
| Mode resolution (explicit setting, else development agent, else no-lifeline-ingress, else graduated) | `invariant` | Fixed precedence. |
| Bypass | `invariant` | A single operator-set boolean; restores prior behaviour exactly. |
| Refuse an unverified message (armed and enforce only) | `invariant` | Follows mechanically from the two facts. |
| Refuse an unverified tap (armed, or enforce with the 24 h allowance over, or no secret held) | `invariant` | A tap is only ever a privileged act. |
| Drop sender identity from an unverified message (armed, or enforce with the 24 h allowance over, or no secret held) | `invariant` | Identity needs proof; delivery does not. |
| Observe exit (quiet window or deadline) | `invariant` | Fixed arithmetic over persisted timestamps and counts; absent or corrupt evidence stays in observe. |
| Write the restart signal (on an unverified request, or once at the boot nudge while unarmed), within the budget | `invariant` | Fixed persisted budget; it acts on another process, so the bound is the safety property. |
| Lifeline: classify a secret refusal (one re-read, then no-budget requeue, back off, notify after ten minutes) | `invariant` | Fixed sequence; the refusal says nothing about the message. |
| Duplicate callback id; claim kept on handler failure | `invariant` | Exact id equality; at-most-once is the safe direction for an approval. |

## Verify the State, Not Its Symbol

| Detector | Symbol read | State it claims | Corroboration | Symbol present, state absent | State present, symbol absent | Unmeasurable |
|---|---|---|---|---|---|---|
| Request verified | header equals the secret | the caller can read a file only the lifeline and server are meant to read | none stronger exists on one OS user | a session that read the file (the stated limit) | a lifeline with a stale or unreadable copy: refused or untrusted, re-reads, held with a user notice | server holds no secret: message delivered untrusted, tap refused, reported |
| Armed (`lifeline-proof`) | one verified request that is not server-self | the running lifeline's code sends the secret | the request carried the real secret, which pre-change code cannot produce | `armedAt` outlives the process that proved it: a lifeline later rolled back alone is refused (see Rollback) | a current lifeline whose proof failed and has no traffic: unarmed until its next proof, at most 15 minutes | absent or corrupt state: unarmed, no message refused |
| Armed (`no-lifeline-ingress`) | the server's adapter reports it is polling; or no adapter and no Telegram in config | no lifeline forwards on this machine | the adapter's own state, set by the code that polls; the config | a lifeline that forwards anyway (misdetected ownership): a current one is verified regardless; a pre-change one is refused, queued, restarted by the signal | a self-polling server whose poll never started: read as lifeline-is-ingress, so the guard stays unarmed and `/guards` alarms although no lifeline exists | Telegram configured but no adapter object: treated as lifeline-is-ingress (waits for proof) |
| Pre-arm allowance over (enforce) | 24 h since the earlier of persisted `observingSince` and the secret file's timestamp | the lifeline has been asked to restart and has had ample time | the boot nudge wrote the restart signal 60 s after the server started (visible as `lastSignalAt`) | a lifeline that could not restart for a day (restart failed, cap spent), or one on older code under the server's own version string (the signal is a no-op for it): its messages arrive as "Unverified sender", its taps fail, reported hourly, attention item, `/guards` | none | both the state file and the secret file lost: a fresh 24 h (direct file removal is the stated limit); server version unknown at the nudge: no signal written, the budget stays unspent and the first unverified request writes it |
| Lifeline "messages held" notice | the send to the alert topic succeeded | the user was told | Telegram's own send result | none: the flag is set only on success | sent, but to a topic the user does not watch | no alert topic configured: nothing is sent; the lifeline log and the server's attention item remain |
| Observe exit | quiet window (time + count) or deadline (time since arming) | it is safe to start refusing | the count shows traffic existed; the deadline needs none by design, bounded by a week of reports and attention items | a real unfound caller still active at the deadline, or one that calls less often than the window: refused from then on with the typed 401 | clean traffic but fewer than 10 requests: waits for the deadline | absent or corrupt state: fresh window, observe |
| Restart-signal trigger | an unverified request, within the budget | the lifeline may be on older code | none (any Bearer holder can produce it), which is why the action is budgeted and is a no-op for a lifeline on the server's version | a session's request: at most one lifeline restart a day | an old lifeline that sends nothing at all: no signal, and nothing to refuse either | server version unknown: no write |
| Secret-refusal episode (lifeline) | 401 `lifeline-secret-required` after a re-read | the two processes disagree about the secret | the server's typed error body | none: only the server produces that body | the server is down instead: the existing transient handling | none |
| Duplicate tap | callback id present in a claim store | this tap was already handed to the handler | Telegram assigns the id; the claim is written before handling | claimed but never completed (handler threw or the server died): not retried; a redelivery answers 409; the user taps again | handled on another machine whose store this machine does not have (see Multi-machine) | store unwritable or corrupt: in-memory dedupe for the process lifetime, flagged on `/health` |

## Multi-machine posture

Each machine runs its own lifeline and its own server; the routes are loopback calls between them. Cross-machine message forwarding does not use these routes. Every machine's server arms independently: by its own lifeline's proof (a standby lifeline that never polls still proves itself), or as `no-lifeline-ingress`.

- Secret file: machine-local. `machine-local-justification: physical-credential-locality` — a credential shared by two processes on one disk; copying it to another machine would widen who can read it and serve no purpose.
- Guard state: machine-local. `machine-local-justification: physical-credential-locality` — it records whether *this* machine's lifeline has proven itself with *this* disk's secret; it is meaningless against another machine's secret.
- Tap claim store: machine-local. `machine-local-justification: physical-credential-locality` — it is channel-seat state: the record of which updates this machine's poll of the Telegram bot token has consumed, the same question the poll offset answers, and the state-coherence registry already classes the Telegram poll offset and adapter state as machine-local with "failover = seat transfer, not state merge". **This key is contestable** (a callback id is global to the bot, not bound to a disk), and the residual is real: if a tap is handled on machine A and A stops before confirming its poll offset to Telegram, and the seat then moves to machine B, Telegram redelivers the tap to B, whose store has not seen it, so it can be applied a second time. Asking A at takeover does not close that window, because in this scenario A has stopped; closing it would need every claim replicated to the other machines before the handler runs. Before this change there was no tap dedupe on any machine. The PR names this as the one posture the operator may want to ratify or reject.
- A restored backup carries none of the three files, so a restored machine starts unarmed with a new secret and re-arms at its lifeline's first proof.
- User-facing notices: the lifeline's existing notices are reused, and one new fixed notice is added (messages held after ten minutes of secret refusal). The lifeline that emits it is the one holding undelivered messages, which is the poll-owning machine, so there is one voice. No URL is generated. No state is keyed on a topic.

## Frontloaded Decisions

1. **Header names**: `X-Instar-Lifeline-Secret`; caller label `X-Instar-Ingress-Caller: server-self`; stale hint `X-Instar-Lifeline-Secret-Stale: 1`.
2. **Paths**: secret `state/lifeline-ingress-secret`; guard state `state/lifeline-ingress-secret.guard.json`; claim store `state/telegram-callback-seen.json`. All three never served, edited, backed up or committed; registered machine-local with a fixed-cardinality retention policy.
3. **Config keys**: `telegramIngress.lifelineSecret.enforce` and `.bypass` (top-level block; `messaging` is an array of adapters). File edit only.
4. **Defaults**: enforce on a development agent, observe with the exit rule elsewhere.
5. **Exit rule**: 24 hours and 10 verified Telegram requests, or 7 days after arming, whichever comes first.
6. **Pre-arm allowance**: in enforce, 24 hours from the earlier of the guard's persisted first run and the secret file's timestamp; in observe an unarmed guard changes nothing. **Boot nudge**: 60 seconds after the routes are built.
7. **Refusal shapes**: 401 `{ ok: false, error: 'lifeline-secret-required', refused: true, reason }`; 503 `{ ok: false, error: 'lifeline-secret-unavailable', refused: true }` for a tap while the server holds no secret; 409 `{ ok: false, deduped: true, error }` with `error` `callback-previously-failed` or `callback-outcome-unknown`.
8. **Startup proof**: `POST /internal/lifeline-proof`; on server-up and whenever the last proof is older than 15 minutes; classified machine-local in the write-domain registry so a standby admits it.
9. **Arming without a lifeline**: when the server polls Telegram itself or Telegram is not configured; armed eagerly (boot nudge, `/health`, posture read); default mode there is enforce on every agent class.
10. **Once armed (either mode), or in enforce after the allowance**: an unverified tap is refused; an unverified message loses every identity claim.
11. **Server holds no secret**: message delivered untrusted, tap refused.
12. **Secret refusal on the lifeline**: one re-read per forward, then re-queue with no budget burned; replay single-flight, stops at the first refusal, backs off from one minute doubling to fifteen; one user notice per episode after ten minutes, to the Agent Updates topic or else the Lifeline topic, recorded as sent only on success.
13. **Callback claim**: `pending` → `done` / `failed`, never released; a redelivery of a failed or unknown outcome answers 409; unproven taps claimed in memory only; verified taps also checked against the in-memory store.
14. **Restart-signal budget**: 12 hours before arming, 24 hours after, persisted; never with an unknown target; the 426 handler's write for an unverified request uses the same budget.
15. **Reports**: the kinds, classes and thresholds in the Reports table. Attention items: category `security`, priority HIGH, source `telegram-ingress-lifeline-secret`, dated id, one per kind per 24 h, throttle persisted and released on failure.
16. **Persist bound**: five write-throughs per second for unverified requests, then one trailing write per second.
17. **Guard posture**: registered in `GUARD_MANIFEST` with a runtime getter, load-bearing, `declaredLoadBearingAt: 2026-10-12`, 30-day soak; `dryRun` means held observe only.
18. **Tool hooks**: none changed; the key-material list is the floor.
19. **Tap claim store posture**: machine-local, with the seat-move residual named under Multi-machine. Chosen and built. The PR asks the operator to ratify or reject it at review; that is not a build stop.
20. **An unverified message does not claim an exactly-once ledger key.** Its inbound log row is still written, without a uid. Consequence: a real lifeline whose messages are being treated as untrusted (enforce with the allowance over, or the server holding no secret) loses exactly-once protection for those messages and can have one delivered twice if a response is lost.
21. **The restart-signal file** `state/lifeline-restart-requested.json` joins the never-served list.

None of these is tagged cheap-to-change-after. The numbers in 5, 6, 14 and 16 are constants in one file, but 5 and 6 decide when an agent starts refusing, so they are decided here.

## Testing

- Unit: `lifeline-ingress-secret`, `lifeline-ingress-guard` (both sides of every boundary: modes, arming by proof and by no-lifeline-ingress, the 24-hour allowance at minus 1 ms, sender trust, taps, bypass, the quiet window at 24 h minus 1 ms and at 9 verified, the deadline at 7 days minus 1 ms and under a secretless request every 6 hours, restart persistence, the signal budget including the shared writer, each report's threshold, the attention item, the posture row, write coalescing), `telegram-callback-dedupe`, `session-spawn-no-lifeline-secret` (a real `SessionManager` spawn: the secret is in no tmux argument, no child env object, and not in `process.env`), `PostUpdateMigrator-lifelineIngressSecret`, `lifeline/forwardErrors`.
- Integration: `telegram-internal-routes-lifeline-secret` (real `createRoutes`, both agent classes; every identity claim removed from an unverified message), `telegram-unverified-sender-pipeline` (the real message pipeline binds no operator and gives commands sender id 0 for a flagged message).
- End to end: `telegram-internal-routes-lifeline-secret-lifecycle` (a real `AgentServer` with middleware and a real `TelegramLifeline`: proof, refusal, held message, restart, single delivery, the bounded refusal path with its user notice, the file routes).

Not covered by a test: a lifeline process built from a previous release. The end-to-end test removes the header from current lifeline code. The pre-change lifeline's handling of a 401 was checked by reading `origin/main` (`forwardToServerClassified`: any status other than 426, 503 and 400 throws `ForwardTransientError`, which queues the message), and the arming rule means a pre-change lifeline's messages are not refused during an update at all.

## Maturation plan

- **test-agent-live:** the end-to-end test is the throwaway agent: a real `AgentServer` with middleware and a real `TelegramLifeline` on a temporary state dir. Proof arms the server; a Bearer-only request is refused; a lifeline without the header is refused, holds the message, is told to restart, and the restarted lifeline delivers it once; a lifeline that stays refused backs off and notifies.
- **dev-agent-live:** live in enforce on a development agent from the release that carries it. Read the authed `/health` → `telegramIngress.lifelineSecret` on that agent: `armed: true` with `armedBy: 'lifeline-proof'` within two minutes of the first server start on the new release, then for seven days `refused` and `wouldRefuse` stay at their value at arming (no `lastWouldRefuseAt` or `lastRefusedAt` later than `armedAt`) while `verified` grows with real Telegram traffic, and no operator message arrives as "Unverified sender".
- **fleet:** the same release, in observe. Each agent graduates itself by the exit rule (24 hours and 10 verified requests with zero would-refuse, or 7 days after arming). An agent whose lifeline has not updated stays unarmed and unchanged, and reports it.
- **graduation criterion:** the dev-agent evidence above, plus one deliberate test on the development agent of each refusal: a Bearer-only forward gets the typed 401 and raises the attention item; a Bearer-only tap is refused. A zero count of verified requests is not a pass.
- **dark-window:** none for development agents. For the fleet the observe period is at most 7 days after arming per agent. If the dev-agent evidence is not in hand within 14 days of the release, the reason and a new date are recorded on this spec, and the fleet default stays as shipped (it is self-ending, so there is no fleet flip to perform).

## Rollback

- **Restore the previous behaviour**: set `telegramIngress.lifelineSecret.bypass: true` in the config file. No restart. This is the lever to use before rolling a lifeline back by itself. (Two things stay on under bypass: the tap-id type check and one-tap-one-effect.)
- **From a phone.** The two keys are file-only on purpose, so there is no dashboard switch. The operator asks the agent, in any channel that is working, to set the key. If Telegram itself is the thing being held (messages queued by the lifeline), `/lifeline restart` in Telegram is handled by the lifeline without the server and restarts the server, which re-reads the secret; that resolves a stale copy. A lifeline that cannot read the secret file at all needs access to the machine.
- **Stop refusing messages only**: `enforce: false`. Unproven taps stay refused and unproven messages stay identity-free once armed.
- Both keys take effect on the next request where a live config reader is wired (the running server has one); a message the lifeline is already holding is delivered at its next retry, which can be up to 15 minutes away unless a new message arrives or the server restarts.
- **Revert the release (server and lifeline together)**: safe. An older server ignores the header and the new files.
- **Revert and later re-release, or roll the lifeline back alone**: `armedAt` and `graduatedAt` persist in the state file. A pre-change lifeline under an armed, enforcing server is refused: its messages queue, and are dropped with the existing notice after about 25 minutes if it stays on pre-change code; its taps fail with "please try again"; across a major.minor boundary it now receives the 401 before the 426, so its own skew handling does not run. Set `bypass: true` first. A re-release needs no step if the lifeline updates with the server, because a current lifeline presents the secret.
- Deleting the state file has no effect on a running server (it rewrites it from memory); it resets the guard only across a server restart.

## Open questions

*(none)*
