---
title: "Per-job notification opt-in for Quiet by Default"
slug: "notification-job-opt-in"
status: "draft"
tier: 1
author: "echo"
parent-principle: "Near-Silent Notifications"
eli16-overview: "notification-job-opt-in.eli16.md"
extends:
  - "docs/specs/notification-selectivity.md"
provenance:
  - "Justin, Telegram topic 102965 message 139842, 2026-11-06 08:07 PST: 'Obviously, I don't want every single job report sent to me. However, when the user creates a job or automated process like this one, the INSTAR agent should give them the opportunity to determine whether that message will come through. In this case, yes I want to see this message but not the other ones'."
review-convergence: "2026-11-06T16:46:40.708Z"
review-iterations: 3
review-completed-at: "2026-11-06T16:46:40.708Z"
review-report: "docs/specs/reports/notification-job-opt-in-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 7
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Per-job notification opt-in for Quiet by Default

## Problem statement

Quiet by Default (`src/messaging/NotificationSelectivityGate.ts`) keeps automated
reports out of chat. Push is opt-in per category, and `job-status` covers every
scheduled job, so the only choices are all job reports or none. The operator wants
one job's report (live example: `instar2-checkin`) and not the others, and wants the
agent to offer that choice when a job is created.

Facts checked against main at v1.3.1693 and the live decision ledger:

1. A session job's report reaches the gate through `POST /telegram/reply/:topicId`.
   The route writes `sourceContext: metadata.jobSlug`. **`metadata.jobSlug` is
   caller-supplied**, so `sourceContext` alone is a claim, not proof. The live row
   for `instar2-checkin` has this shape (`record`, `quiet-default`).
2. The verified identity is the origin session credential: the
   `X-Instar-Origin-Session` middleware binds a producer to a session. A session's
   `jobSlug` alone is NOT proof, because `POST /sessions/spawn` accepts a caller-supplied
   `jobSlug` and issues a real credential. `triggeredBy: 'scheduler:<reason>'` is the
   scheduler's own mark; that route does not pass it.
3. Scheduler-authored notices (`JobScheduler` completion summary, failure alert,
   silence alert) carry `sourceContext: 'src/scheduler/JobScheduler.ts'`, not a slug,
   though the scheduler holds the `job` object.
4. The envelope is sealed into the signed origin record, then read back after a
   `structuredClone`/JSON round trip at the last hop
   (`TelegramOriginService.classifyPreparedNotification`, and the lifeline's
   `POST /notifications/internal/classify`). An in-memory capability does not survive
   that trip, so it must be restored from the sealed record.
5. On the origin path, `gate.destination()` retargets an enforced automated send to its
   category's hub topic at seal time (not edits, not conversation categories, and only
   when a hub exists). The non-origin adapter path never retargets. Left alone, an
   opted-in report addressed to topic 102965 would land in the hub. Simply skipping the
   retarget would be worse: a job session picks its own topic, so one opt-in would let a
   misbehaving job post in any conversation, or through the browser route to any peer.
6. `NotificationPreferences` replicates `{category, enabled}` intents to peers. An
   older peer ignores unknown fields, so `{category: 'job-status', job: slug}` would
   turn on the WHOLE category there.

## Proposed design

### D1. Verified job identity

A new capability in the gate module, mirroring `verifiedReplyEnvelope`:

- `verifiedJobEnvelope(slug, base?)` returns an automated `job-status` envelope with
  `sourceContext: slug` and a new field `verifiedJobSlug: slug`, and registers the
  object in a module-private `WeakSet`.
- `isVerifiedJobEnvelope(value)` is true only for a registered object whose
  `verifiedJobSlug` equals its `sourceContext` and whose category is `job-status`.
- The lint (`scripts/lint-notification-selectivity.mjs`) restricts callers to
  `NotificationSelectivityGate.ts`, `TelegramOriginService.ts`, `JobScheduler.ts`, and
  `src/commands/server.ts`.

Minting sites, all holding server-side truth:

1. `TelegramOriginService.notificationForCurrentProducer()`: when the producer is a
   session the scheduler started (new hook `notificationJobSlug(sessionId)`, wired in
   `server.ts` through `scheduledJobSlug(session)`, which requires both `jobSlug` and the
   `scheduler:` mark), and the notification is an automated `job-status` or
   `uncategorized` envelope, the session's own slug is minted. This overrides whatever
   `metadata.jobSlug` claimed. The reply route is unchanged.
2. `JobScheduler`: completion summary (both sends), failure alert and silence alert use
   `verifiedJobEnvelope(job.slug)`. The topic-creation intro and the reflection stay on
   the plain stamper: they are not job reports.
3. `server.ts` pane-result send: the same `scheduledJobSlug` check on the session from
   `state.findSessionByTmux()`.

The lint also admits `verifiedJobEnvelope` as a `withNotificationEnvelope` argument in
`JobScheduler.ts` only; `trustedComposition` is not widened.

Accepted limit: session records are local files, and a process running as the agent can
write them. This closes every API route to a false identity, not a local-file attacker,
who already holds everything the agent holds. The opt-in also binds a job name, not its
prompt: editing an opted-in job keeps the opt-in.

Seal rule: `notificationForCurrentProducer()` strips `verifiedJobSlug` from any envelope
that lacks the capability, so the sealed field exists only if a mint site produced it.

Last-hop rule: new method `TelegramOriginService.restoreJobEnvelope(record, envelope)`,
called from both `classifyPreparedNotification` (after the `relayedOrigin` spread) and
the lifeline classify route. For an automated `job-status` envelope, the slug is
`notificationJobSlug(record.sessionId)` for a session record from this machine, otherwise
the sealed `verifiedJobSlug` (branching on `originMachineId`, so a coincident session id
on another machine cannot rename a peer's job). A slug re-mints the capability, keeping the envelope's other fields.
Peer records reach this point only after `verifyOriginAttestation`, and they are the
same agent.

A send without a verified origin (legacy relay hop, no origin runtime on the reply
route, script job without a session credential) stays quiet. Scheduler-authored notices
keep working on the non-origin path because the capability object reaches the gate
in-process.

### D2. Gate decision

`SelectivityConfig.push` gains `jobs?: Record<string, boolean>`. In `decide()`, the
quiet-default test also lets through `isVerifiedJobEnvelope(envelope) &&
settings.push?.jobs?.[slug] === true`, using `Object.hasOwn`-safe lookup. The push then
passes the existing `category` (3 per 10 minutes, key `job-status`) and global (10)
budgets, and its reason is `job-opt-in`. A category opt-in keeps its reason
`category-opt-in`. Message text and priority play no part.

`destination(envelope, addressedTopicId)` returns null only when the job is opted in AND
the addressed topic equals `push.jobTopics.<slug>`, the topic where the operator said
yes. On the origin path with a hub, any other topic and every browser-route send (which
passes no topic) go to the hub. That includes the scheduler's own notices, addressed to
the job's `Job: X` topic, so a report the job addresses to the chosen topic arrives there
and the rest arrive in the hub. The confirmation says so, and the skill tells the agent to
make the job name the topic. A dashboard opt-in names no topic, so its reports use the
hub, as category pushes do (parent FD-5). Both outcomes are existing conversations, per
P23. With no hub, or on the non-origin adapter path, nothing retargets, as for every
category: an opted-in report stays where it was addressed, within the budget. Last hop still decides,
so a report sealed before an opt-out is recorded.

Inventory and summaries:

- `holdsCategory` and `categoryPushEnabled` stay category-level. Their only callers are
  attention paths, which have no job identity.
- The digest's inventory adds `Pushed jobs: <slugs>`.
- `queueSummary`'s re-check counts an opted-in job, so a job that overruns the budget
  still gets its "N more in the feed" line. Without this the overflow line would vanish
  silently, since `push.categories['job-status']` is false.

### D3. Route and persistence

`POST /notifications/jobs/:slug/push`, body as the category route. Same confirmation:
dashboard PIN session, or `operator-conversational-confirm` with
`gate.confirmsOperator(topicId, confirmingMessageId)`.

Accepted limit, inherited from the category route: this proves the operator sent a recent
message in that topic, not that the message said yes, and a session can read message ids.
The server therefore enforces "the operator spoke recently", and the instruction to the
agent carries "only on a yes". This spec does not claim more. A consent-bound ask (a
server-issued one-time button) would fix both routes and is queued as its own feedback
item rather than built here, because the brief set this proof.

After proof the route calls `ctx.scheduler.refreshJobs()`, because the in-memory list
lags a job written seconds ago. A job file that fails to parse answers 503 for
`enabled:true` and is ignored for `enabled:false`; it must not escape the async handler. `enabled:true` then needs the slug in this machine's jobs
or in a peer's (`readPeerJobs`, bounded and credential-guarded like the feed's pool
read): 404 when every machine answered and none has it, 503 when a peer is dark.
`enabled:false` skips the check, so a deleted job's choice stays removable. Refusals: 503
no preferences; 400 bad body or bad confirmation.

`NotificationPreferences.setJob(slug, enabled, confirmedBy, topicId?)` is the same transaction as
`set()`. A job intent is `{job: slug, topicId?, enabled, version, issuer, confirmedBy,
confirmedAt}` with **no `category` field**, so an older peer's `validIntent` rejects it
(fact 6) and it stays pending. A peer upgraded in place shows no offline edge to re-arm
on, so `drain()` gives rows past their 8 attempts a slow retry (about daily, for about a month) instead of
dropping them. It is keyed `job:<slug>` in `desired`,
`versions` and `pending`. `validIntent` requires `isNotificationJobSlug` (the
`^[a-zA-Z0-9_-]{1,100}$` job slug rule, excluding `__proto__`, `constructor`,
`prototype`). A new `applyJob` option writes
`notifications.selectivity.push.jobs.<slug>` and `push.jobTopics.<slug>`; job slugs hold
no dots, so the dotted path is exact. If `applyJob` is not wired, the transaction throws rather than dropping the
choice. `enabled:false` stores `false`: an explicit no, distinguishable from never asked. Each intent replaces the whole choice, so an omitted `topicId` clears an earlier binding.

`GET /notifications/selectivity` gains `jobs: [{slug, name, enabled, push, decided}]`,
this machine's jobs by default and the pool's with `?scope=pool` (the dashboard's call),
plus `jobsScope` and `jobsUnavailable`. If the `job-status` category is on, turning one
job off changes nothing, and in observation mode every report is delivered anyway. The
response carries `categoryPush`, `enforcing` and a `message` that the chat confirmation and
the dashboard both show, saying what will really happen rather than promising silence.

### D4. Ask at creation

No blocking prompt; the default stays quiet. Asking first is an instruction to the agent; the server enforces recent operator participation (see D3).

Agents mostly create jobs by writing `jobs.json` directly, the path the skill documents,
and no response exists there. So the always-loaded instructions carry the ask, and the
responses cover the rest:

- CLAUDE.md template: the `Need periodic checks?` line in the core adds the ask, plus a
  Feature Proactivity line and the per-job sentence in
  `QUIET_NOTIFICATIONS_CLAUDEMD_SECTION`.
- `skills/instar-scheduler/SKILL.md`: new section `## Who sees this job's reports`. It
  reconciles with "not ask for permission": adding the job needs no permission, and this
  question is only about who sees the reports. It names where to find the message id, and
  warns that a default `on-alert` job says nothing after a good run unless its prompt
  reports, so a yes alone may deliver nothing.
- `instar job add` prints the advice; `POST /jobs/:slug/save`, when it created the job,
  returns it as `reportChoice`. The save response is read by the dashboard today, so it
  is a reach-the-agent surface only for an agent calling the route. Shared helper
  `jobReportChoice(slug, {enforcing, categoryPush})` states what will really happen:
  `quiet`, `pushed-by-category`, or `delivered-while-observing`.
- `PostUpdateMigrator`: content-sniffed patches for the core line and the Quiet section,
  and the skill section inserted into an installed `instar-scheduler/SKILL.md` that lacks
  it. All idempotent. Reference-layout agents get the template text through the canonical
  build.

Honest limit: this is instruction, not enforcement, on the `jobs.json` path. A scheduler
diff that raises an "unasked" item at session start would be the structural version; it
is queued as a feedback item, sized as its own change. `jobs[].decided: false` shows the
gap meanwhile.

### D5. Dashboard

`dashboard/console/notifications.js` already renders category checkboxes. Job rows reuse
the same loop body, listing enabled jobs from the pool read, so it is included.

## Decision points touched

| Decision point | Classification | Justification |
|---|---|---|
| `decide()` job opt-in branch | invariant | Keys on a server-derived capability and an operator-confirmed boolean. There are no competing signals to weigh; it is the same structural routing the gate already holds for categories. Text and priority never enter. |
| `destination()` opted-in job stays in the operator's topic | invariant | Same inputs plus an equality check on the operator's topic. Changes where a permitted push lands, not whether it is permitted. |
| Seal-time strip and last-hop restore of `verifiedJobSlug` | invariant | Provenance plumbing. Fails toward quiet. |
| Route confirmation | invariant | Reuses the category route's existing proof, unchanged. |
| Agent asking the user at creation | judgment-candidate, argued exemption | An agent-side conversational choice. The write needs operator proof, within the limit D3 states. Floor: no ask means quiet. |

## Signal vs. authority

The gate's authority is unchanged in kind. It widens one structural key and adds no
content judgment.

## Evidence (Verify the State, Not Its Symbol)

- **Symbol:** `verifiedJobSlug` on a sealed record. **State claimed:** this notice came
  from that job. **Corroboration:** the local session record when the session is local;
  the signed record plus the seal-time strip when it is a peer's. **Unmeasurable:** no
  session and no sealed field means no job identity, and the notice stays quiet.
- **Symbol:** `push.jobs.<slug> === true`. **State claimed:** the operator asked for this
  job. **Corroboration:** a PIN session, or a recent operator message, plus the audit row
  in `logs/notification-preferences.jsonl` written before the config changes. The message
  check proves the operator spoke, not what they said (see D3). A hand edit of config has
  the same standing as a category key.

## Multi-machine posture

- Per-job choice: **unified**, replicated through the `notification-preference` mesh
  intent with durable pending fan-out, same as category choices.
- Decision: taken on the machine that executes the send, from that machine's replicated
  config. An opt-in that has not landed keeps the report quiet, or sends it to the hub if
  only the holder has it. An opt-out that has not landed can push until it replicates;
  the pending row stays visible in `preferences.peersPending`.
- Job identity across machines: sealed in the signed origin record. `notificationJobSlug`
  reads local sessions only, so a peer's job relies on the sealed field.
- Job list: job definitions are not replicated, so the route and `?scope=pool` read
  peers (proxied-on-read through `readPeerJobs`), and dark peers are named, never assumed
  absent.
- Slug identity: a slug names one logical job across the agent's machines, as every other
  per-slug record does. Same-slug jobs on two machines share the choice.

No machine-local surface is introduced. A machine paired after a choice gets it only on
the next change; that gap is existing category behaviour and is noted in the report.

## Migration and rollback

- Config: no default needed; absent `push.jobs` reads as quiet.
- A revert leaves inert `push.jobs` keys, and older code ignores job rows in
  `notification-preferences.json` (`validIntent` drops them on load).
- CLAUDE.md and skill text remain after a revert, pointing at a route that returns 404.
  Harmless.
- Backup: as with category choices, `config.json` and `notification-preferences.json` are
  outside the backup set. A restored lone machine loses job choices and reports go quiet,
  the safe direction.

## Maturation plan

- **test-agent-live:** the end-to-end test runs a real `AgentServer` with a real scheduler reading a job file, and the unit tier drives the sealed origin path. A live proof with a real job session on a throwaway agent is still owed before calling this done for users.
- **dev-agent-live:** live on Echo, where Quiet by Default enforces, from the release that carries it. Evidence: an operator yes for `instar2-checkin`, its next report delivered with reason `job-opt-in` in `logs/notification-selectivity.jsonl`, and another job's report recorded with `quiet-default`.
- **fleet:** the same release. Nothing changes until an operator opts a job in, and an agent still in observation mode delivers every report anyway. The choice takes effect when that agent starts enforcing.
- **graduation criterion:** the dev-agent evidence above, plus one week on Echo with no report from an unchosen job delivered and no operator report of a missing opted-in report.
- **dark-window:** none. There is no switch to hold dark: the default is unchanged and the feature acts only on an operator's choice.
- **ladder:** not applicable: no off-by-default switch, an operator choice inside Quiet by Default

## Frontloaded Decisions

1. Per-job `false` under a category `true` does not silence that job. Brief asks for
   opt-in only; the response states it honestly.
2. Reports the job addresses to the topic where the operator said yes land there;
   everything else from an opted-in job lands in the hub. The job's own `Job: X` topic is
   not an allowed target: permitting it would need a job-to-topic hook in the gate for a
   topic few operators read.
3. Budget stays the `job-status` category bucket. A per-job bucket would let many
   opted-in jobs exceed the bound the spec set.
4. The completion summary, failure and silence notices count as this job's reports. A
   job that sends its own report and also has `telegramNotify` on sends both, using two
   budget slots. The reflection and the topic intro do not count.
5. Unknown slugs are refused only after checking every reachable machine; a dark peer
   gives a retryable 503. `enabled:false` is never refused for an unknown slug.
6. A recreated job with an old slug inherits the old choice: same slug, same job.
7. Opt-in does not change a job's notify mode. The skill tells the agent to check the job
   really reports.

## Open questions

*(none)*
