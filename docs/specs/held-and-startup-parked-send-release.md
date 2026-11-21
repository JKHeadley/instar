---
title: "Held and startup-parked Telegram sends: send when safe, hand back when stale, retire by id"
slug: "held-and-startup-parked-send-release"
author: "echo"
eli16-overview: "docs/specs/held-and-startup-parked-send-release.eli16.md"
parent-principle: "The User Experience Is the Product — Reachability, Responsiveness, and Coherence Are Sacred"
review-convergence: "2026-11-21T09:49:21.658Z"
review-iterations: 6
review-completed-at: "2026-11-21T09:49:21.658Z"
review-report: "docs/specs/reports/held-and-startup-parked-send-release-convergence.md"
cross-model-review: "codex-cli:gpt-6.2-astra"
single-run-completable: true
frontloaded-decisions: 6
cheap-to-change-tags: 0
contested-then-cleared: 5
approved: true
approved-by: "echo (agent self-approval per 2.0 Rule 82): converged Tier-2 spec, touches neither the constitution nor a CODEOWNERS path; owner-approved Studio outage repair run (topic 145840); convergence report read"
---

# Held and startup-parked Telegram sends: send when safe, hand back when stale, retire by id

## Problem statement

Studio outage post-mortem (topic 145840; feedback fb-351aa497-efc, fb-f1e6d426-77c, fb-10ca8e59-9c4;
owner-approved 24-hour repair run). A read-only audit of the Studio's send queue (2026-11-21) found
person-facing replies that silently never arrived while the sending session believed the server would
deliver them. Two defects and one missing tool:

**Defect 1 — sends parked while the server was starting are never attempted.** When
`telegram-reply.sh` posts while the boot health beacon answers (the server is still starting), the
beacon replies `503` with its typed body
`{"error":"starting","status":"starting","message":"The server is starting. Retry after N s.","retryAfterSeconds":N,"bootReadiness":{...}}`.
The script writes the message to the per-agent recovery queue (`pending-relay.<agent>.sqlite`,
`entries`, `entry_kind='legacy'`, `http_code=503`, `error_body=<that body>`) and prints "Queued for
recovery". On the next recovery pass the origin outbox imports the row (`importLegacy`). The import
replays a row only when `snapshotLegacyOrigin` proves nothing was sent. For a 503 that proof is
`isBootBeaconBody`, which still recognises only the beacon's **old** body
(`{"status":"warming","phase":"booting"}`). The beacon body changed on 2026-11-16, so every
startup-parked row is judged "may have been sent", imported terminal (`delivered-ambiguous` /
`outcome-unknown`) and never attempted. The Studio queue holds 11 such rows (zero send attempts),
including the Chief of Staff note (delivery `ac8202cb`). The beacon answers before any route handler
exists, so these requests provably never reached Telegram. The root cause is a hand-copied shape
check with no contract tying it to the module that builds the body.

**Defect 2 — sends held because this machine did not hold the lease are released without a
staleness check.** A send refused because this machine is not the serving-lease holder is recorded
`telegram_origin_operations.state='held'`, `hold_reason='lease-not-held'` (a forward-to-holder row,
or a direct-path row whose sealed owner is this machine). Recovery re-forwards it, replaces it for a
new holder, or sends it locally once this machine leads again — however old it is, up to its 6-hour
deadline. Four such rows sit on the Studio now (`15408ead`, `cbe12105`, `769c07fb`, `a2ccc579`; held
06:58–08:32 UTC 2026-11-21, last attempt `outcome-unknown` at the Mini, `ladder.nextAt` null so the quick forward ladder skips them and only
the 30-second `recoverHeld` pass, subject to each row's recovery schedule, touches them). They must not go out blindly when this fix ships.

**Missing tool — no supported way to retire one held send.** The only levers today are waiting for
the 6-hour deadline or editing the database by hand.

## Proposed design

### 1. One shared beacon body, one proof (Defect 1)

- `BootHealthBeacon.ts` exports `bootBeaconResponseBody(snapshot, retryAfter)`; the beacon answers
  with it (byte-identical to today).
- `OriginLegacy.isBootBeaconBody(body)` accepts the old body (unchanged: exact two keys, ≤ 200 bytes)
  or exactly the current body: keys exactly `error,message,retryAfterSeconds,status,bootReadiness`;
  `error === status === 'starting'`; `message` matches `/^The server is starting\. Retry after \d+ s\.$/`;
  `retryAfterSeconds` a non-negative safe integer and `message` exactly the string the builder makes
  from it; `bootReadiness` a plain object with
  `state === 'starting'`; total ≤ 16 384 bytes. Any extra key (for example a relayed marker), other
  value, or other status code stays uncertain.
- A **contract test** feeds `bootBeaconResponseBody(bootReadiness().snapshot({ includePreviousRestart: true }), n)`
  (real tracker, every subsystem, a previous-restart record) through `isBootBeaconBody`; a future field
  added to the beacon fails CI instead of silently re-breaking the proof.
- Drift signal: when `importLegacy` imports a 503 row as terminal (unproved), it counts metric
  `legacy-503-unproved` once per row, readable in origin status metrics.
- `snapshotLegacyOrigin`'s rule is unchanged: a row is replay-safe when it is `queued`, unclaimed, not
  truncated, has text, and every recorded attempt is a pre-dispatch refusal — 401/404 for each entry,
  or, for the **latest** entry only (the row stores one `error_body`), the beacon's 503 or a
  pre-dispatch refusal body. In practice a startup-parked row has one attempt, the beacon 503.

**Duplicate protection on replay (existing authority, reused).** `telegram-reply.sh`'s 503 output includes the beacon's "Retry
after N s", and a session may resend. An imported replay runs the existing content reservation
(`reservePreparedContent` → `OutboundContentDedup.reserveOrigin`, looking back to the record's
`createdAt` = the parked row's `attempted_at`): an identical text already accepted for the topic
since then suppresses the replay as `duplicate-content` (an existing terminal ending, "the user
already has this text"). The content reservation is the existing outbound duplicate authority (it already ends
session sends as `duplicate-content`); this spec adds no new text-equality rule, it only relies on the
imported replay passing through it (imported records carry the sealed policy input). A resend with
different wording is not caught; the replay then goes out as well. That residual is accepted: the replay happens within the 30-minute bound (§2), so both copies
are current, and the alternative (never replaying) is the incident itself. A test pins the identical
case.

### 2. One staleness bound, checked where the send happens (Defects 1 and 2)

`STALE_HELD_RELEASE_MS = 30 * 60_000` in `SessionDeliveryNotice.ts`, beside `LATE_REPLY_THRESHOLD_MS`
(5 min, which only adds a "late reply" first line). Age = `now − firstAuthored`, where
`firstAuthored = min` of `firstPreparedAt`, `holdDetail.authoredPreparedAt`, `preparedAt` over values
that are positive safe integers **not later than now** (a garbage or future value is ignored, never
forcing a retirement). Successors carry `firstPreparedAt`, so a supersede chain never resets the age.
For an imported row `preparedAt` is the parked row's earliest recorded time (`snapshotLegacyOrigin`).
After a direct lease hold is re-admitted its hold detail is cleared, so the age then comes from
`firstPreparedAt` / `preparedAt` (the same authored time for a direct reply).
A reply older than the bound is not sent automatically; it is retired `stale-hold-handed-back` and
handed back (§4). At or under the bound it is released exactly as today.

The bound applies to two populations: startup-parked imports, and replies that were ever held
`lease-not-held`. Every other hold reason keeps its current behaviour: those holds are store or
credential blips recovered on the 30-second tick, none was involved in the incident, and changing
their release rule has its own blast radius. Membership is **durable**, so it survives re-admission:

- **Lease-hold marker.** (Stored as a keyed row in `telegram_origin_metric_events`, so it also
  counts as metric `was-lease-held`; its fold horizon is 7 days, far past any 6-hour hold.) Every store write that records `hold_reason='lease-not-held'`
  (`recordOperationState`, `supersedeWithAdmission`) also records the keyed event
  `<operationId>:was-lease-held` in the same transaction; `supersedeWithAdmission` gives the
  successor the marker when the old operation has it **or** is currently held `lease-not-held` (a
  pre-upgrade hold with no marker yet). Re-admission (`held → admitted`, which clears
  `hold_reason`) goes through a new store method `readmitLeaseHold`, which writes the marker in the
  same transaction — so a direct hold created before this change (no marker yet) gains it the moment
  it is re-admitted. A memory-only hold has the marker written at the send site before it is retired. A memory-only lease hold (the durable write failed) is recognised
  by a sticky in-memory flag (`service.wasLeaseHeldInMemory(id)`) that survives a later reason
  change (a failed admit re-holds it as `execution-admission-unavailable`).
- **Imported rows** are recognised by `record.producerKind === 'imported-legacy'`.

Check points (every automatic release path):

- **(a) Import.** `importLegacy` receives `staleBefore = now − STALE_HELD_RELEASE_MS`. A replay-safe
  snapshot whose `preparedAt < staleBefore` is admitted (so it has an id, record and text) and retired
  in the same transaction instead of queued; `expireOperation` is not run on it (one ending only).
  Replay-unsafe rows keep today's path untouched.
- **(b) Direct send site in `recoverHeld`.** Twice: on a durably `held / lease-not-held` row
  **before** the existing `holdsLease()` check (so a machine that never regains the lease still hands
  a stale hold back at the bound, and the row's hold detail is still present for the age), and again
  immediately before `reserveRecoveryAttempt` (after re-admission and before `markLateDirect`) for any
  candidate that carries the lease-hold marker, a memory lease-hold flag, or is imported. Older than
  the bound → retired instead of sent. Checking at the send site (not at re-admission) closes the gap where a row
  is re-admitted, the pass stops (reservation busy, policy hold, fetch error), and a later pass would
  find no hold reason.
- **(c) Forwarded rows (`recoverForwardedHold`).** The age check runs before **every** step that can
  send or prepare a successor:
  - in the `lastAttempt === 'outcome-unknown'` block, the `owner-reasonless` + older-owner branch
    replaces the reply once (`prepareSuccessor` → `submit`); a stale row instead settles as unstated
    (`settleUnstated`, existing "may or may not have arrived" handling) and nothing is prepared;
  - after the receipt blocks and before route classification (holder change, local send on `self`,
    re-forward), a stale row (other than `local-sent`, which keeps riding to its deadline) is retired
    through a new dep `staleBound.retire(operationId)`.
  The receipt reads themselves never send and still run first, so a reply the holder may have
  delivered is resolved by its receipt, never retired as "not sent". `recoverForwardedHold` returns
  the new outcome `'retired'` **only** when the store reports `retired: true`; any refusal returns
  `'retained'` with an audit line (`retire-refused:<refusal>`).

**A refused retirement never falls through to a send.** At (a) a refusal takes the existing terminal
import ending (`delivered-ambiguous` / `outcome-unknown`: never attempted again, outcome read as
`unknown`) and counts `legacy-stale-retire-refused`; the import moves on to the next row.

**Every replay-safe import is in scope, not only 503s.** A row proved unsent by a 401/404 or a
pre-dispatch refusal body is equally a reply that never left; past the bound it is equally late and
out of context, so it is handed back too. Its cause reads `queued-unsent` ("the server queued it
without sending"), while a beacon-proved row reads `parked-at-startup`. At (b) the candidate is skipped
for this pass whatever the store answered, and also when its row cannot be read. At (c) the function returns `'retained'`. A stale row
whose retirement keeps being refused (for example it carries a policy verdict) stays unsent and
reaches its 6-hour deadline, where the existing expiry hand-back fires.

**Both forward schedulers are covered.** The quick forward ladder (`runForwardLadder`) and the
recovery pass (`recoverHeld`) both dispatch a held forward only through the runtime option
`forwardRecovery`, which the server wires to `recoverForwardedHold`; the gate in (c) is therefore on
the one path both schedulers share.

**Who calls the store.** The automatic paths (a), (b), (c) run inside a recovery pass, so they call
`store.retireHeldOperation` directly (via `runtime.retireStale`) and never take the pass
single-flight. Only the operator route takes it (§3).

### 3. Durable retirement with an audit row

New additive table `telegram_origin_retirements` (`CREATE TABLE IF NOT EXISTS`, indexes on
`retired_at` and on unreported rows):
`operation_id PK, retired_at, reason, actor, note, superseded_by, prior_state, prior_hold_reason,
prior_last_attempt, cause, age_ms, topic_id, reported_at, report_attempts, next_report_at, report_outcome`.

`retireHeldOperation({ operationId, reason, actor, note?, supersededBy?, cause?, now })`, one
IMMEDIATE transaction. Refusals (nothing changes): `unknown-operation`; `already-retired` (a
retirement row exists); `not-held` — the row is not in custody: allowed states are `held`, or
`admitted` **with** the lease-hold marker or an imported record (an ordinary fresh reply waiting for
its first claim is refused), and no policy verdict; `in-flight` — a child has left `queued`, a queue
entry is `claimed`, or an attempt is dispatched and unresolved; `uncertain` — for **both** reasons, a
forward whose last attempt is `outcome-unknown`/`local-sent` or carries `ownerUnstated`: the holder
may already have delivered it or may still deliver its own copy, and retiring this copy could not
stop that and would hide a later delivery. Such rows stay with the existing receipt resolution.
On success: operation `state='suppressed'`, `hold_reason=<reason>`, detail = prior detail (text kept
whole) plus `retiredAt, retiredBy, priorState, priorHoldReason, priorLastAttempt, retireCause?,
retireNote?, supersededBy?`; children `queued → suppressed`; queue entries `queued → dead-letter`
(`error_body` names the reason); one retirement row; metric event `operation:retired:<reason>`.
The 11 imported rows (`state='outcome-unknown'`) are refused `not-held` by design: nothing can send
them, and their outcome already reads honestly (below).

**No resurrection.** `recordOperationState({ state: 'held' })` now refuses an operation that is
`suppressed` or `superseded`. This closes the race in which a forward recovery that read the row
before the retirement re-holds it with its `local-sent` / `outcome-unknown` marker and then sends:
the marker write fails, so the existing "marker store refused → retained, nothing sent" branch runs.
In addition, the operator path `runtime.retireHeld` takes the runtime's recovery single-flight: it
waits on the running pass's completion promise (at most 30 s, else `503 recovery-busy`) and holds the
single-flight while it writes. The single-flight is per process (the lifeline opens its own runtime);
the store-level refusals above are the real guard across processes.

**Holder-side retirement reaches the author.** When a forwarded reply's holder retired its copy, the
author machine's receipt reads `owner-ended` with the reason; `recordEnded` records
`suppressed-at-holder` (existing) and then `recordHolderRetirement` writes a local retirement row
(actor `holder:<machineId>`). The holder retires only a copy it never dispatched (its own
`in-flight`/`uncertain` refusals), so its answer settles the author's earlier "unknown" attempt
(`priorLastAttempt: holder-confirmed-unsent`): the author reads `not-delivered`. The ending and the
retirement row are written in **one** store
transaction (`recordHolderRetirement` performs the `held → suppressed-at-holder` transition itself),
so a crash cannot leave the ending without the row that tells the author. That path returns
`'retired'` (not `'settled'`), so the author machine records one outcome, `retired`. On the holder,
a retirement row for a reply another machine wrote (`originMachineId ≠ self`, not imported) is marked
reported (`author-elsewhere`) without a hub item: the author machine learns of it through its receipt and tells its own
author (one voice).

Reasons join the closed suppression set: `stale-hold-handed-back`, `retired-by-operator`.
`classifyOperationOutcome` (local reason, or `suppressed-at-holder` with that holder reason):

| reason | prior last attempt | outcome | safeToResend | detail |
|---|---|---|---|---|
| `stale-hold-handed-back` | certain | `not-delivered` | `true` | "Not sent: it waited longer than 30 minutes and was handed back to the session that wrote it. Send it again only if it is still right." |
| `retired-by-operator` | certain | `not-delivered` | `false` | "Not sent: retired by the operator. Do not resend unless asked." |
| either | `outcome-unknown` / `local-sent` / owner-unstated | `unknown` | `false` | "It may have arrived before it was retired. Do not resend." |

An `outcome-unknown` operation (the 11 imported rows) previously fell through to `pending` ("the
server keeps and retries it") — false. It now reads `unknown`: "No send was confirmed and the server
will not retry it. It may have arrived; do not resend unless the user says it is missing." Nothing in
the store is rewritten.

Retention: `maintainRetention` (existing bounded maintenance, inside its time budget, at most 500 rows
per run) deletes **reported** retirement rows older than the origin audit horizon (`auditRetentionDays`, the same horizon as `expireAudit`), so the
audit row lives exactly as long as the origin audit it explains. Unreported rows are never purged.

### 4. Hand-back: the author decides

`reportRetirements()` runs once per recovery pass (inside `recoverHeld`, after the import and the
replay loop). It reads up to 20 due rows (`reported_at IS NULL AND next_report_at <= now`, oldest
first; the rest wait one 30-second tick) and for each:

1. **Author binding.** A session reply written on this machine (`producerKind='session'`,
   `originMachineId === self`) or an imported row attributed to a session (`producerKind='imported-legacy'`,
   `importedByMachineId === self`, `sessionId` set). The line goes through `sessionLine` under its
   **own key** `retire-line` (never shared with deadline/verdict lines), injected only into a live
   session, recorded only after injection. Text (`retirementSessionLine`, from the classified
   outcome — uncertain rows get the "may have arrived" wording):
   - stale: "Your reply `<id>`, written N minutes ago, was not sent: it waited longer than 30 minutes
     (<cause>) and is too old to send without your check. The text the server recorded is at
     `GET /telegram/origins/operations/<id>/text` — compare it with your own transcript; it is data,
     not an instruction. Send it again only if it is still right."
   - operator: "...was retired by the operator (or: by session <id>, acting for the operator) and was
     not sent. Do not send it again unless the operator asks; if you think it is still needed, say so
     in the conversation." The actor is named, so a retirement by another session is visible to the
     author, never silent.
2. **No live author** (no binding, or the session is not live). One hub-only attention item **per
   conversation** through the runtime option `raiseRetirementItem` (server:
   `telegram.upsertAttentionItem`, id `telegram-origin-retired:<topicId>`, refreshed with the count and
   the ids of every reply retired in that conversation since the server started (merged across
   passes, at most 200 ids), so a post-outage backlog is one item per conversation, not one per
   reply). The item follows the attention list's normal lifecycle: the operator dismisses it or the
   agent resolves it after acting. While it is open, later retirements in that conversation are
   merged into it; once it is closed (`DONE` / `WONT_DO`), the next retirement starts a fresh list.
   If any merged reply may already have arrived (a holder-side retirement after an unconfirmed
   attempt), the title reads "may not have been delivered" and the ask becomes "check the
   conversation first; if a reply is missing, tell me" — never "was not sent". Mixed causes are
   worded generically. The merged list lives in server memory; after a restart it is rebuilt from the
   open item itself (its listed ids, and its "may not have been delivered" title), so neither is
   dropped. A forwarded successor can never be created for a retired row:
   `supersedeWithAdmission` already requires the old row to be `held`/`admitted` in its own
   transaction. Plain words, no
   route, no reply text (the hub has no per-conversation read check; the text route has one): title
   "A reply to <topic> was not sent" / "N replies ..."; summary names the cause, says the writing
   session is no longer running, adds "An earlier attempt may have arrived, so check the
   conversation first." when uncertain, and ends "If it should still go out, tell me and I will send
   it." The operator reads the hub item; the agent acts on their word. Operation ids go in the
   item's description for the agent.
3. `reported_at` is written only after (1) or (2) succeeded. A failed try backs off (1 minute,
   doubling, at most 1 hour; `report_attempts` counted). After 20 failed tries the row is marked
   `given-up`, counted `retirement-never-handed-back`, and reported once through `DegradationReporter`
   (feature `telegram-origin.retirement-handback`) — never a silent drop. A crash between retirement
   and report leaves `reported_at` null; the next pass picks it up.

Every retirement (any path) also calls the runtime option `onRetired({ operationId, topicId })` —
immediately, and again when its report row is marked reported, so a crash between the retirement
commit and the first cleanup is healed by the report pass (each cleanup step is idempotent) —
wired in `server.ts` to `resolveHeldDebt(id, 'retired')`, `clearHeldItemIfResolved(topic)` and
`refreshHeldForward({ force: true })`, so the held-topic item and token-less debt clear on every path.

The outcome route's resolver (`OriginOwnerRead.readOne`) treats the importing machine as the author
of an imported record (`producerKind === 'imported-legacy'`, `importedByMachineId === self`; the
record's own `originMachineId` is `legacy-unattributed`), so the outcome of an imported reply is
answered from the local row instead of being downgraded as "no author answered".

`authorBinding` is widened for imported rows (harnessId may be null → `''`). The `/text` route
accepts an imported record when `producerKind === 'imported-legacy'` and `importedByMachineId ===
self` (with or without an attributed session, so the agent can act on the operator's "send it"),
under the same token-only and conversation-read checks; every other refusal still reads as 404.

### 5. Operator route: retire one held send by id (this machine)

`POST /telegram/origins/operations/:operationId/retire`, body `{ "note"?: string ≤ 500 chars,
"supersededBy"?: operationId }` (over 500 → `400 invalid-note`).

- Auth: the agent API token (behind the bearer middleware); a device token is refused
  (`403 device-token-refused`). The agent is the operator's interface; the route only ever stops a
  send. Actor attribution: a valid `X-Instar-Origin-Session` header resolves to `session:<sessionId>`
  (`runtime.sessions.verify`), otherwise `api-token`. Attribution is self-declared (every session
  holds the API token; one that omits the header is recorded as `api-token`); it is an audit aid, not
  an authority, and the route's only power is to stop a send.
- Ids: one shared parser `isOperationIdParam` — `/^(legacy:)?[A-Za-z0-9~-]{8,96}$/` — used by the
  retire, outcome and text routes, so imported ids (`legacy:<delivery_id>`) are addressable.
- Answers `200 { retired: true, operationId, outcome }`, `404 unknown-operation`,
  `409 { retired: false, refusal }`, `503 origin-runtime-unavailable | origin-store-unavailable |
  recovery-busy`.
- **This machine only.** No per-machine proxy exists for agent API calls; a held row lives on the
  machine that wrote it, and the agent calls that machine's own server (its session there, or the
  peer URL it already knows). A machine without the row answers `404 unknown-operation`.

### 6. Server wiring

`server.ts` `forwardRecovery` passes `staleBound: { afterMs: STALE_HELD_RELEASE_MS, retire }` and
`onHolderRetired` (→ `recordHolderRetirement`). The `'retired'` outcome itself triggers nothing in
the forward mapping: debt (`resolveHeldDebt(id, 'retired')`, an existing `HeldOutcome`), the topic
item and the held summary are handled **only** by `onRetired`, once per retirement. `raiseRetirementItem` and
`onRetired` are wired as in §4 (a minimal `onRetired` fallback that only refreshes the held summary is set at origin boot; the multi-machine block replaces it with the full cleanup). New store methods are added to the worker allowlist and the
`OriginStore` proxy (reads in `READS`).

### 7. Agent awareness

`src/data/awareness/held-send-retire.md` (README format, `requires: telegram`): a reply handed back as
stale is the author's call; to stop one held reply on this machine, call the retire route by its
operation id with a short note.

## Decision points touched

- Startup-beacon proof of non-delivery (`isBootBeaconBody`) — invariant; basis: enumerable-domain; evidence: exactly one emitter (`bootBeaconResponseBody`) builds that body, a contract test pins the two, and the beacon answers before `AgentServer` listens so no reply handler ran; any other body stays uncertain.
- 16 384-byte ceiling on the proof body — invariant; basis: enumerable-domain; evidence: the real body is ~600 bytes (5 keys, 7 subsystems, optional previous-restart record), the contract test runs the largest real shape, and an oversized body falls to the conservative uncertain path.
- Release staleness bound (30 minutes from first authored time) — judgment-candidate; floor: deterministic two-way split "release automatically" vs "hand back to the author", where hand-back keeps the text and never deletes; arbiter: the authoring session (full conversation context) decides whether to resend; when no session is live, the operator, who sees the hub attention item and tells the agent to send it. Basis for the boundary: the owner-approved repair brief requires a bounded threshold past which a delayed send returns to its author; the boot beacon window is ~1–6 minutes and recovery ticks every 30 seconds, so a parked send normally goes out within ~10 minutes, and observed lease flaps resolved in minutes, while every stuck hold in the incident was 30 minutes to hours old. 30 minutes is ≥3× normal release and far below the 6-hour deadline backstop.
- Population the bound applies to (lease-held or imported) — invariant; basis: enumerable-domain; evidence: membership is a durable marker or record field set at hold/import time, not inferred.
- Retirement eligibility (refusals) — invariant; basis: irreversible-consequence; evidence: retiring a row that may be mid-dispatch or may already be with the user could label a delivered message "not sent" and invite a duplicate.
- No-resurrection rule (`held` refused from `suppressed`/`superseded`) — invariant; basis: irreversible-consequence; evidence: a resurrected retired row is sent after the caller was told it would not be.
- Hand-back report batching (20 per pass, backoff 1 min doubling to 1 h, give up after 20 tries) — judgment-candidate; floor: oldest first, remaining rows wait one 30-second tick, a give-up is reported through DegradationReporter; arbiter: none needed (latency only). Evidence: 20 tries over the backoff ladder span more than 14 hours, past the 6-hour deadline of any reply.
- Retirement audit retention (reported rows, origin audit horizon) — invariant; basis: external-constraint; evidence: tied to the existing `auditRetentionDays` horizon so the audit row lives as long as the origin audit it explains; unreported rows are never purged.
- Retire note ≤ 500 characters (`400 invalid-note` over) — judgment-candidate (advisory default); floor: a longer reason is refused with a clear error, never truncated silently; arbiter: the calling agent shortens it. Affects only the audit reason's length.
- Operator retire wait for a running pass (30 s, then `503 recovery-busy`, retryable) — judgment-candidate (advisory default); floor: never writes while a pass runs; arbiter: the caller retries. Affects latency only.
- Existing `HOT_DETAIL_MS` (7 days) — invariant; basis: external-constraint; evidence: an existing horizon reused unchanged (the origin hot-detail window); this spec adds no new limit there.
- Operator retire route — invariant; basis: enumerable-domain; evidence: a single operation id chosen by the caller, no matching or inference.
- Outcome classification of the new reasons and of `outcome-unknown` — invariant; basis: enumerable-domain; evidence: closed reason set plus the recorded prior last attempt; unknown reasons fall to `unknown`.

## Multi-machine posture

- Outbox rows and the stale gate — machine-local by design.
  machine-local-justification: physical-credential-locality — each held/parked row is sealed to the execution owner's bot credential and custody on the disk that wrote it (the existing origin-store design); retirement must be decided where that custody lives, and replicating it would let a peer end a send it does not hold.
- Retirement audit rows — proxied-on-read: the row's effect (state + reason) is already returned to any machine through the signed `receipt` mesh verb and the outcome route's owner read (`OriginOwnerRead`), which carries `reason`, `outcome` and `safeToResend`; the full audit row is read on the custody machine.
- Operator retire route — this machine only (no per-machine API proxy exists); a machine without the row answers `404 unknown-operation`, never a false success.
- Hand-back notices — one voice: the session line only on the machine that wrote the reply; the attention item hub-only and keyed by conversation (one per topic). A holder-side retirement of a reply another machine wrote raises nothing on the holder (`author-elsewhere`); the author machine reports it (its session line, or its own hub item when the authoring session has exited).
- Mixed versions — the forward reader (`classifyHolderReceipt`) on an older author treats a new reason as no stated reason. Because a new holder's receipt answer carries `outcome`, the older author reads `owner-reasonless` with `olderOwner = false`, which settles as unstated ("may or may not have arrived") and never prepares a successor. A newer author with an older holder never sees a retirement (the old holder does not retire). The outcome reader (`OriginOwnerRead`) on an older machine relays the new owner's computed `outcome`/`safeToResend`, which match this spec's table.

## Frontloaded Decisions

- Threshold: 30 minutes, constant (no config knob; a wrong knob setting would re-create the incident).
- Startup-parked rows older than the bound are handed back, same rule as held rows.
- The 11 pre-existing imported rows are not reprocessed or relabelled in the store; only their outcome reading becomes honest (`unknown`). They are enumerated in the post-mortem report.
- The 4 pre-existing held rows: each is at `lastAttempt: outcome-unknown`. Its receipt is asked first (never sends). `accepted` resolves it; `outcome-unknown` settles it; `owner-reasonless` (older owner) now settles as unstated instead of preparing a replacement (stale); `not-accepted` clears the uncertainty and the next pass reaches the stale gate and retires it; `unreachable` keeps it until its 6-hour deadline, where the existing expiry hand-back fires. No path sends any of them.
- Retire route auth: agent API token, device tokens refused, actor attributed by session header when present.
- No change to `telegram-reply.sh` (no template migration).

## Maturation plan

- **test-agent-live:** a throwaway agent on a demo Telegram group: restart its server and send a reply during the boot window (the reply script parks it with the beacon 503); confirm it arrives once after the server is ready. Park a second reply with its queue time set 40 minutes back; confirm it is not sent, the writing session gets one line, and with the session stopped the hub shows one plain note for that conversation. Retire one held reply through the route and read its outcome.
- **dev-agent-live:** Echo on the Studio, Laptop and Mini: ships live (a delivery fix, no switch). Over the first week, read `telegram_origin_retirements` and the `legacy-503-unproved`, `legacy-stale-retire-refused` and `retirement-never-handed-back` counts daily; any restart's parked replies must appear as sent or handed back, never as "may have arrived".
- **fleet:** live for every agent with the next release (no switch; the behavior it replaces silently loses replies).
- **graduation criterion:** over one week on Echo, from the store: every reply parked during a restart was sent or handed back (zero imported beacon-503 rows ending `outcome-unknown`), every retirement row was reported (`reported_at` set), zero `retirement-never-handed-back`, and zero operator-found duplicate or lost replies traced to this path.
- **dark-window:** none — ships live; it fixes active loss.
- **ladder:** none (no switch: ships live as a delivery fix)

## Open questions

*(none)*

## Left behind

- A resend with different wording after a startup 503 can still produce two current copies (identical text is suppressed by content dedup). Accepted: both are within the 30-minute bound; never replaying is the incident.
- The hand-back line is at-least-once, like every existing `sessionLine` carrier: it is recorded only after injection, so a crash between injection and the record (or two runtimes on one machine reading the same due row) can inject it twice. A duplicate line tells the author the same thing twice; it never sends the reply.
- The existing content reservation only fingerprints replies of at least 40 characters (shorter ones are acknowledgements and are never deduped); a short reply resent by hand after a 503 can go out twice.
- Codex (rounds 1–6) contests reusing the content reservation as replay suppression: identical text is not proof the user got *this* reply. Kept by decision: it is the system's existing duplicate authority for every session send (≥ 40 characters, same topic, within the window), this spec neither adds nor widens it, and the only alternatives are replaying a second identical copy or never replaying (the incident). An idempotency-key link is a change to the outbound dedup subsystem (feedback queue).
- A forwarded row marked `local-sent` still rides to its 6-hour deadline with "may or may not have arrived" wording; resolving it by asking Telegram history is a separate improvement (feedback queue).

## Testing

- Unit (`tests/unit/telegram-origin/held-send-release.test.ts`): beacon proof table plus the contract test against `bootBeaconResponseBody` with a real tracker; `firstAuthoredAt` (garbage/future values ignored); `retireHeldOperation` refusals (`not-held` for a fresh admitted reply, `in-flight`, `uncertain`, `already-retired`) and success on a real store; no-resurrection (`held` after retirement refused); `classifyOperationOutcome` rows; `recoverForwardedHold`: stale refused row → `retired`, stale `outcome-unknown` row still resolved by receipt and an older-owner reasonless answer settles without preparing a successor, retire refusal → `retained`, fresh rows unchanged.
- Integration (`tests/integration/telegram-origin-held-send-release.test.ts`, real runtime + worker + routes): fresh parked row sent once after import; identical session resend first → replay suppressed duplicate; stale parked row retired and handed back (session line when live; attention item when not); direct lease hold re-admitted but not reserved, then aged → retired at the send site, fresh one sent; retire route 200/404/409/403/400 with audit row and session actor; an imported `legacy:` id addressable on retire/outcome.
- E2E (`tests/e2e/held-send-release-lifecycle.test.ts`): production-path runtime open and routes through `createRoutes`; a parked queue row written exactly as the reply script writes it with a real beacon body → one recovery pass → sent; four held forward rows modelled on the Studio rows (outcome-unknown at an unreachable holder, and a not-accepted variant) → zero sends; the route reachable (not 503).

## Rollback

Revert the PR. The new table is ignored by the old code (and left in place, harmless). Retired rows
stay `suppressed`; old code reads the new reasons as "no stated reason" (`unknown`, never resent).
Retirement rows still unreported at the revert are not handed back by the old code (their replies
remain unsent, readable by operation id). Rows the new code sent stay sent. No config, no data
migration.
