# Side-Effects Review — Per-job notification opt-in for Quiet by Default

**Version / slug:** `notification-job-opt-in`
**Date:** `2026-11-06`
**Author:** `echo (builder session)`
**Second-pass reviewer:** `independent reviewer subagent (see the section at the end)`

## Summary of the change

Tier 1 by reversibility: a revert leaves inert config keys and ignored preference rows. It is at the top of Tier 1, because it adds one way past the quiet default. Size: 15 source files, about 280 added lines; review took 3 rounds (cap 3), and rounds 1 and 2 each found a real defect.

Adds `notifications.selectivity.push.jobs.<slug>` to the Quiet by Default gate. `verifiedJobEnvelope` is a new capability that only the scheduler, the origin service and `server.ts` mint. The slug comes from `scheduledJobSlug(session)` (needs the `scheduler:` mark) or from the scheduler's own `job`. `verifiedJobSlug` is sealed into the signed origin record, stripped at seal time when no capability backs it, and restored at both last-hop readers. New route `POST /notifications/jobs/:slug/push`; `NotificationPreferences.setJob` replicates with an intent older peers reject. `push.jobTopics.<slug>` holds the topic of the operator's confirming message, and only that topic keeps a report out of the hub. Migration covers the CLAUDE.md core line, the Quiet section and the scheduler skill.

## Decision-point inventory

- `NotificationSelectivityGate.decide` — modify — new `job-opt-in` branch past `quiet-default`.
- `NotificationSelectivityGate.destination` — modify — opted-in job in its operator-chosen topic is not retargeted.
- `TelegramOriginService.notificationForCurrentProducer` — modify — mints or strips job identity at seal.
- `TelegramOriginService.restoreJobEnvelope` — add — restores it at the last hop.
- `POST /notifications/jobs/:slug/push` — add — operator-confirmed write.
- `NotificationSelectivityGate.queueSummary`, `tickDigest` — modify — count opted-in jobs.

---

## 1. Over-block

- A report from a job on a send path without a verified origin stays quiet even if opted in: a script job with no session credential, a legacy relay hop, or a reply-route send with no origin runtime. Scheduler-authored notices for that job still deliver. This is deliberate: unproven means quiet.
- A session started through `POST /sessions/spawn` with a real job's slug stays quiet. Correct: it is not the scheduler's run.
- An opted-in report addressed to a topic other than the confirming one goes to the Attention topic, which can surprise an operator expecting the job's own `Job: X` topic.
- `enabled:true` for a job on a dark peer returns a retryable 503.

## 2. Under-block

- `confirmsOperator` proves the operator sent a recent message in that topic, not that it said yes, and a session can read message ids. A job session could opt itself in without consent, limited to the push budget. Same proof as the category route, and the brief set it. Filed as feedback for a consent-bound ask. Stated in the spec and ELI16.
- Session records are local files; a process running as the agent could write a `scheduler:` mark. It already holds everything the agent holds.
- The opt-in binds a job name, not its prompt, and a recreated job inherits the choice.
- With no hub topic, or on the non-origin adapter path, nothing retargets, as for every category, so an opted-in report stays where it was addressed. Budget still applies. Closing this needs seal-time state in `decide()`, out of proportion to a state where the Attention topic does not exist.
- A report sealed before a topic change delivers to the old topic. The window is one in-flight send.

## 3. Level-of-abstraction fit

Right layer. The decision sits in the existing gate, identity comes from the origin layer that already owns session credentials, and the write goes through the sole preference writer. `metadata.jobSlug` stays an observability label on the reply route, with no authority.

## 4. Signal vs authority compliance

Compliant (`docs/signal-vs-authority.md`). The gate already holds routing authority on structural provenance. This adds a structural key and no content interpretation. Message text and priority confer nothing, tested. Nothing gains power to block; the change only widens delivery under an operator's choice, and every doubt resolves to quiet.

## 5. Interactions

- The push budget bucket is shared with `job-status`, so two sends in one run (self-report plus scheduler summary) use two of three slots.
- `holdsCategory` and `categoryPushEnabled` stay category-level; their callers are attention paths with no job identity.
- A job session's `uncategorized` send is now classed `job-status`. Quiet either way unless the job-status category is on, where it now pushes as a job report.
- Scheduler notices now carry `sourceContext: <slug>`, not the module path. The funnel lint admits this in `JobScheduler.ts` only.
- The preference churn alert counts job changes too; its title is reworded to fit.
- `refreshJobs()` runs after proof on each write only, and is guarded: a bad job file answers 503, it does not reach `unhandledRejection`.
- `route()` memoises on config, so a preference change re-decides an unsent operation as before.

## 6. External surfaces

New route and new fields on `GET /notifications/selectivity`, a `reportChoice` field on a created `POST /jobs/:slug/save` response, one new line from `instar job add`, dashboard job rows, and changed agent instructions. Mesh intent shape gains a job form. The default for all users is unchanged: nothing pushes until an operator opts a job in.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

Surface: `dashboard/console/notifications.js`, job rows added to the existing preference list.

1. **Leads with the primary action?** Yes. Each job is a checkbox row, the same as a category row, with no collapse. The rows sit after the category rows, and the page order is unchanged.
2. **Zero raw internals as primary content?** Yes. Rows show the job name (`Job: 2.0 check-in`), never the slug. The message after a change is the route's plain sentence.
3. **Destructive actions de-emphasized?** Yes. There is no destructive action: unticking a job returns it to quiet.
4. **Plain language + phone width?** Yes by construction: the rows reuse the existing markup (48px minimum height, 22px checkbox, wrapping label), so tap targets and wrapping match the category rows. This was checked by reading the markup and running `tests/unit/console-notifications.test.ts`; the page has not been loaded in a browser at 390x844 with these rows. An agent with many enabled jobs gets a long list, which is plain but not grouped.

---

## 7. Multi-machine posture

Unified. The choice replicates through the `notification-preference` mesh intent with durable pending fan-out, and older peers reject a job intent rather than reading it as the category. Exhausted rows keep a slow daily retry, for about a month, for a peer upgraded in place. The job list is proxied-on-read through `readPeerJobs`. Job identity crosses machines in the signed record. Decision is taken on the executing machine; a late opt-in stays quiet or reaches the hub, and a late opt-out can push until it lands. Confirmation messages use the existing one-voice reply path. A machine paired after a choice gets it only on the next change, the same as categories.

## Class-Closure Declaration

`unbounded-self-action`, closure `n/a`: one-shot user-driven action. Reports were already being sent; only their routing changes. The preference write is operator-driven, and its replication retry is bounded at 38 attempts and 16 rows per tick, so it is not a self-triggered loop.

---

## 8. Rollback cost

Revert and release. `push.jobs` and `push.jobTopics` stay in config, inert. Older code drops job rows when loading `notification-preferences.json`. CLAUDE.md and skill text stays, pointing at a route that then returns 404. No data migration.

---

## Second-pass review

**Reviewer:** independent subagent, 2026-11-06.

Round result: "Concern raised: observation mode makes the opt-in confirmation false, `src/server/notificationRoutes.ts:131`", classed DESIGN. Resolved: the `enabled:true` outcome now has an observing arm, the skill and its migrated copy say nothing changes while observing, and a unit test covers it. Stale size and round figures in the Summary were corrected. The reviewer found the round-2 fixes real and no other false statement in the eight answers.

The reviewer re-checked that fix and answered: Concur with the review.
