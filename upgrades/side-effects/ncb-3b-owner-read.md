# Side-Effects Review — the outcome route gives the execution owner's verdict (native-conversation-base slice 3b)

**Version / slug:** `ncb-3b-owner-read`
**Date:** `2026-11-11`
**Author:** `Echo`
**Second-pass reviewer:** `independent general-purpose subagent (see below)`

## Summary of the change

Tier 2 (spec `docs/specs/native-conversation-base.md`, converged in 6 rounds and approved; this PR builds slice 3b only). 11 source files changed or added (~560 added lines, one new module), 5 new or extended test files across all three tiers. One build pass; spec review rounds belong to the spec, not this slice.

`GET /telegram/origins/operations/:id/outcome` used to answer from the local store and downgrade a remote owner's local `not-delivered` to `unknown`. It now:

- `src/messaging/telegram-origin/OriginOperationOutcome.ts`: the classifier reads the closed suppression-reason set (§3a item 9) and the failure-cause set (`refused` / `never-left` / `deadline`); a `suppressed` row with no stated reason is `unknown` (was `not-delivered, safeToResend: true`); a duplicate ending is `delivered`; quiet / historical / caller endings are `not-delivered, safeToResend: false`; a `superseded` row names its successor; a held row with `ownerUnstated` is `unknown`. New pure `resolveOutcome(local, owner, author)` implements table rows 1 to 11.
- `src/messaging/telegram-origin/OriginOwnerRead.ts` (new): `parseReceiptAnswer` (closed-set validation; an answer with no `outcome` is `old-version`, so a raw `suppressed` state is never read as an ending), `OriginOwnerReader` (one in-flight ask per machine and id, 2 s timeout memo per machine, LRU of terminal owner verdicts, per-ask budget `min(budgetMs, time left)`, counters), and `readOperationOutcome` (local shortcuts, lease-holder ask when there is no local row, parallel owner + author asks, supersession following with a visited set, one 4 s route deadline).
- `src/messaging/telegram-origin/OriginMesh.ts`: the `receipt` handler accepts `reader: true` (relaxes only "the asker wrote it" and "this machine owns it"; agent, operation id, origin id, digest and key-epoch checks stay) and answers by `role`; every owner answer also carries `outcome`, `safeToResend`, `reason`, `failure`, `supersededBy`, `duplicateOfMessageId`, `originMachineId`, and `holding` when the owner also wrote it. The raw `state` the forward ladder reads is unchanged.
- `src/messaging/telegram-origin/OriginStoreBackend.ts`: `getOperation` exposes the hold detail of a `superseded` row even when it has no hold reason, so the successor id is readable.
- `src/messaging/telegram-origin/OriginConfig.ts`, `types.ts`: `messageOrigin.ownerRead` (`enabled`, `budgetMs`, `cacheEntries`), read inline, never written.
- `src/messaging/telegram-origin/TelegramOriginRuntime.ts`: `ownerReader` slot; `status().ownerRead` counters (`state: unknown` when not wired).
- `src/commands/server.ts`: builds the reader on the same signed peer sender as the existing receipt peer, with the lease holder and both switches read live.
- `src/server/telegramOriginRoutes.ts`: the route delegates to `readOperationOutcome`; the store-failure 503 is unchanged.
- `src/templates/scripts/telegram-reply.sh` + `PostUpdateMigrator.TELEGRAM_REPLY_PRIOR_SHIPPED_SHAS`: the script reads `safeToResend` and never prints "safe to send it again" for a `not-delivered` answer with `safeToResend: false`.
- `src/messaging/telegram-origin/OriginAwareness.ts` + `PostUpdateMigrator`: one CLAUDE.md paragraph ("Outcome from the sending machine:") for new agents through the template, for existing agents through a content-sniffed migration, mirrored to the framework shadow.

Not in this slice (the spec's 3a): writing suppression reasons, `ownerVerdict` / `ownerUnstated` detail, the late mark, the session lines, the receipt-mapper change in the forward ladder. This slice reads `ownerVerdict` / `ownerUnstated` when present so it is correct once 3a lands, and it does not depend on the ladder mapper's fold of `suppressed` into `not-accepted` (`server.ts` receipt mapper): its own parser reads the raw `state` together with `outcome`.

## Decision-point inventory

- `safeToResend` on the outcome route — modify — now true only for row 6 (owner's classified non-delivery plus an author that answered it no longer holds the reply and did not deliver it itself) and row 9 (on the author's own machine: owner answered no-record / not-admitted and the local row is terminal with nothing dispatched). Every missing answer forces false.
- Classifier verdict for `suppressed` rows — modify — a null or unknown reason is `unknown`, not `not-delivered`.
- `receipt` verb admission — modify — `reader: true` lets any active same-agent machine read state, reason and ids. The forward ladder never sends `reader`.

---

## 1. Over-block

No block/allow surface in the usual sense: the route does not block sends; it answers a question a session uses to decide whether to resend. The cautious direction is the risk here: answers that were `not-delivered, safeToResend: true` become `unknown` in three cases: (a) a pre-release `suppressed` row with no reason (correct: it may be a duplicate the user already has), (b) a remote owner that is silent, old or switched off (row 11), (c) a third machine whose owner answers `no-record` (row 10). In (c) the author's own machine still answers row 9, which is where the session that would resend runs. A session that gets `unknown` is told not to resend; the reply's text is preserved by the existing hold and its author is told by 3a's lines once 3a ships. Until 3a, a real non-delivery on an older owner reads `unknown` instead of `not-delivered`. That is the accepted cost of FD-5.

## 2. Under-block

- A `safeToResend: true` from row 6 trusts the author's `holding: false`. An author that delivered the reply itself after a lease return answers `holding: false` too; row 6 still needs the owner's own classified `not-delivered` first, and an owner that never admitted it answers `no-record`, which is row 10 off the author's machine. Covered by the "third machine, owner no-record, author holding false gives unknown" test.
- A terminal owner verdict is cached per process. A `not-delivered` that later becomes delivered is impossible at one owner (terminal states do not change), so the cache cannot hide a delivery.
- The 4 s deadline bounds the route. An owner answering after the deadline is lost for that call; the next call asks again (or gets the 2 s timeout memo). No resend is invited by a timeout.

## 3. Level-of-abstraction fit

The verdict stays where the evidence is: the owner classifies its own row (the existing `classifyOperationOutcome`), and the asking machine only combines answers in one pure table. The transport is the existing signed `receipt` verb, not a new verb or a new HTTP route. The owner-read wiring reuses the receipt peer's sender. The reply script is the consumer and was changed only to honour the field it already received.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

The route is a read. It produces a structured answer; the authoring session decides what to do. The `safeToResend` field is an invariant (spec, Decision points touched: basis irreversible-consequence), computed deterministically from enumerable evidence. It never blocks a send and never sends.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The table is an enumerable domain (an owner either answered with a classified verdict, answered no-record, or did not answer; an author either holds the reply or not), declared as invariants in the spec's Decision points touched. The two numeric values (2 s per ask, 4 s route deadline, 1024 cache entries) are judgment-candidates with stated floors and the 2026-11-25 review as arbiter; the `ownerRead` counters on the status route are the evidence that review reads.

---

## 5. Interactions

- **Shadowing:** the forward ladder's receipt mapper (`server.ts`) is untouched and still reads only `state`; the extra fields are ignored by it. `originDeliveryConfirmed` (notification batcher) is untouched.
- **Double-fire:** the route never submits, re-forwards or sends. `reader: true` is only sent by the route, never by the ladder, so a reader answer cannot free a re-forward.
- **Races:** coalescing shares one in-flight ask per (machine, id); the timeout memo and cache are per process and bounded. Concurrent route calls during a lease change can read different owners only if the envelope differs, which it cannot for one operation id; a superseded row is followed to its successor's own owner.
- **Feedback loops:** none. The classifier change affects one other caller, `confirmedRecoveredForward`, which only reads `delivered` (unchanged).
- **Reply script:** a `not-delivered` with `safeToResend: false` now exits 1 with "ended on purpose ... Do NOT resend"; before, it said "safe to send it again". All other branches unchanged.

---

## 6. External surfaces

- Other machines of the same agent: the `receipt` verb answers `reader` asks from any active same-agent key with state, reason and Telegram message ids, never message text (unchanged envelope checks). An older machine ignores `reader` and refuses a third-party ask (`origin-receipt-unavailable`), which this side reads as `refused`.
- Sessions: the outcome route's JSON gains fields; existing fields keep their meaning except that `not-delivered` may now carry `safeToResend: false`. The shipped reply script reads it; the CLAUDE.md paragraph tells sessions only `safeToResend: true` permits a resend.
- Persistent state: none written. The store change only widens what `getOperation` returns for superseded rows.
- Timing: the route can now take up to 4 s when a remote owner is slow (the reply script waits 5 s). A one-machine agent and a held, never-forwarded reply make no network call.
- Operator surface: no operator-facing action added. The switch is a config value with a kill criterion in the spec's maturation plan.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**proxied-on-read.** The execution owner's origin-store row is the source; every other machine reads its verdict over the signed `receipt` verb (`reader: true`), and the author's own row supplies `holding`. Nothing is replicated. `messageOrigin.ownerRead.enabled` is per-machine configuration: it only stops this machine asking and cannot change another machine's answer. No user-facing notices. No durable state. No URLs.

**Status surfaces:** `GET /telegram/origins/status` gains `ownerRead`; it is this machine's counters only (asks this machine made, its latency), with `state: unknown` where the reader is not wired. The pool view is read per machine at the 2026-11-25 review, as the spec states.

---

## 8. Rollback cost

Pure code change. Switch-off without a release: `messageOrigin.ownerRead.enabled: false` on the asking machine (answers fall to row 11, more cautious only). Full back-out: revert and ship a patch. No data migration. The reply script's prior version stays registered, so a rollback that ships the old script replaces the new one on update the normal way. During a rollback window sessions see the old answers (local-only, `not-delivered` for unreasoned suppressions).

---

## Conclusion

The slice builds the whole of §3b: the reader branch, the classified `receipt` answer, the 11-row table, owner and author checks, coalescing, caching, the 4 s deadline, the switch, the counters the maturation row's kill criteria need, migration parity and the CLAUDE.md paragraph. One addition beyond the spec text, made during the build: the reply script now honours `safeToResend`, because without it the new "ended on purpose" answers would have printed "safe to send it again". Clear to ship once the second pass concurs.

---

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent (fresh context; read the diff, the spec section 3b and this artifact)
**Independent read of the artifact: concur** (after one concern round, resolved)

First read: "Concern raised: row 6 can return `safeToResend: true` for a reply the author itself delivered after the owner's own attempt failed." I had found the same sequence while the review ran. Findings and resolutions:

- **Row 6 and a self-delivered reply (real).** The author forwards, the owner admits it and ends `known-failed`, the lease returns and the author's ladder sends it locally (`recordForwardedAcceptance` on the same id, state `accepted`). The author used to answer `holding: false`, so a third machine read row 6, "safe to resend". Fixed: the author's answer is now a statement built by `authorStatement`: a reply it delivered itself is reported as `delivered: true` with its message ids, and `resolveOutcome` matches that at row 1 before any owner failure. Test: integration "the owner failed, then the author delivered it itself" (delivered on all three machines, never safe to resend), plus unit cases.
- **Unnamed replacement (narrow, real).** A `superseded` author row with no readable successor answered `holding: false`. Fixed: it answers `holding: null` (cannot tell), which the asker treats as no answer (row 8 / row 10 unknown).
- **Unreadable author id on the owner (narrow, real).** The local shortcut passed the owner's own verdict through when the envelope's author id was unreadable. Fixed: the shortcut now needs this machine to be both owner and author; anything else asks or falls to missing evidence.
- **"has an unresolved forward" (spec mismatch).** Fixed: an author row whose last forward went to some machine other than the envelope's owner with its answer lost, or whose own local send is unresolved (`local-sent`), or whose verdict is `unknown`, or is `accepted`/`partial` with no readable receipt, answers `holding: null`. A lost forward to the envelope's own owner is settled by that owner's verdict, which every asker reads, so it answers `holding: false` (this keeps the spec's integration case "then not-delivered once the author ends its row").
- **Dependency on 3a (stated plainly).** No writer exists yet for `ownerVerdict`, `ownerUnstated`, `holderReason`, `duplicate-content` or `suppressed-at-holder`; only `quiet-notification-recorded` is written today. Until 3a ships, every held author row reads as holding and every unreasoned suppression reads `unknown`. Both err cautious. The tests for those paths use the hold-detail shapes 3a specifies.
- **Cache and coalescing ignored `expected` (nit, fixed).** The key now includes the envelope digest, and when the envelope is known locally an answer that does not name the same origin id and digest is refused.
- **Older owner refusing a third machine reads `why: 'refused'`, not `old-version` (nit, kept).** An older owner cannot be told apart from a refusing one on that path; the answer is safe either way.
- **The 4 s deadline bounds the mesh asks, not local store reads (nit, kept).** `routeOverBudget` and `routeP95Ms` on the status route measure it; the maturation row's kill criterion reads them.

A spec-text consequence for the spec owner: §3b item 3 says the author's answer carries "`holding` and `supersededBy` and nothing else". This build adds `delivered` + `messageIds` (only when the author delivered it itself) and allows `holding: null`. Both only make answers more cautious or more exact; neither can produce `safeToResend: true`.

**Re-check (same reviewer, after the fixes): "Concur with the review."** It confirmed findings 1 to 3 and the cache nit fixed, and the ladder mapper and reader-branch checks unchanged. Two defensive nits from the re-check were applied: the author's answer sends `holding: null` whenever it reports `delivered` (so a filtered-empty id list can never fall through to "not holding"), and an author row ended on purpose (`suppressed`, e.g. its own send recorded quietly) answers `holding: null` instead of `false`. The older-owner `why` wording stays as noted.

After the fixes the full three-tier set for this slice passes (unit 78, integration 22 including the mesh suite, e2e 1).

## Evidence pointers

- Unit: `tests/unit/telegram-origin/held-reply-outcome.test.ts`, `tests/unit/telegram-origin/origin-owner-read.test.ts`, `tests/unit/telegram-origin/origin-delivery-resolution.test.ts`, `tests/unit/telegram-origin-owner-read-migration.test.ts`, `tests/unit/telegram-reply-held-outcome.test.ts`.
- Integration: `tests/integration/telegram-origin-outcome-owner.test.ts` (three runtimes, signed mesh), `tests/integration/telegram-origin-mesh.test.ts`.
- E2E: `tests/e2e/telegram-origin-owner-read-alive.test.ts`.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. The route is not a self-triggered controller: it acts only when called.
