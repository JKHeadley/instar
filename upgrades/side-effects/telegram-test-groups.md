# Side-Effects Review — Telegram test groups through the browser broker

**Version / slug:** `telegram-test-groups`
**Date:** `2026-11-08`
**Author:** `echo (builder session echo-telegram-test-groups, Mac M5 Pro)`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Adds three typed operations to the Telegram origin browser broker so an agent can make, list and delete Telegram forum groups for live proofs on the operator's enrolled web Telegram profile, without copying or driving the profile and without asking the operator. Spec: `docs/specs/telegram-test-groups.md` (converged in 6 rounds). Tier 2: it acts on the operator's real Telegram account.

Files: `src/messaging/telegram-origin/TelegramTestGroups.ts` (new: grant parser, title rule, issuer-keyed marker, audit log, page-result parsers, orchestrator), `TelegramWebKDriver.ts` (three static page scripts; the build probe takes an optional deadline), `BrowserTypes.ts` (three optional driver methods; `canary(deadlineMs?)`), `TelegramBrowserBroker.ts` (`runTestGroupOperation`, `isBusy`), `OriginBrowserExecutor.ts` (claim renewal while a reply waits; in-flight counter), `TelegramOriginBoot.ts` (wrapper forwards the new methods; one `TelegramTestGroups` per Web K profile; grant on the config snapshot; `webKDriverFactory` test seam), `TelegramOriginRuntime.ts` (entry type), `types.ts` (config type), `server/telegramOriginRoutes.ts` (three routes), `OriginLocalPaths.ts` and `core/keyMaterialPaths.ts` (registration), `data/state-coherence-registry.json` (audit log entry), `OriginAwareness.ts` and `core/PostUpdateMigrator.ts` (agent awareness and migration).

Size: about 900 lines of source and 700 lines of tests. Effort: 6 spec rounds (the Tier 2 cap; round 3 forced a redesign), commit attempts recorded in the PR.

## Decision-point inventory

- Create gate (agent-held grant, lease, bot allowlist, title rule) — add — invariant scope limits on an irreversible action.
- Delete gate (live read, creator-owned forum supergroup, issuer-keyed marker verified in Node, exact title re-checked in the page) — add — invariant.
- Caps (5 verified live counted on the account, 20 unverified, 10 creates per 24 h, flood and damage holds) — add — invariant ceilings.
- Busy rule and live-read spacing/rate (admission refuses while any broker work is queued or a reply is in flight) — add — invariant.
- `authorizePreparedChild` (existing send authority) — modify — refuses a child whose claim renewal failed, before `markDispatched`.

---

## 1. Over-block

- A legitimate test group whose name uses characters outside `[A-Za-z0-9 ._:#()/-]` is refused at the route (400). Callers choose names; the closed alphabet is deliberate so exact-title checks stay reliable.
- A group made under a lost marker key shows as `unverified` and cannot be deleted here. Accepted risk in the spec; it needs loss of the agent's own state.
- A test-group request arriving while any reply is in flight gets `429 test-groups-busy` with `retryAfterMs`. Intended: replies first.
- On an account where `getAllChats` returns a slice, create refuses (`read-incomplete`); delete still proceeds when the target is in the partial read.
- Existing sends (disclosed per second-pass review): a reply whose claim renewal is definitively refused by the store, or whose renewals keep failing until less than one renewal interval of lease remains, is refused before dispatch and recorded known-failed. Before this change such a reply could have been sent after its lease expired and then been reaped as delivered-ambiguous; now it fails closed and visibly. One transient renewal error with lease headroom left is tolerated (tested).
- Holds: a Telegram flood wait holds create, list and delete; the audit-damage hold applies to create only, so it can never strand cleanup.

## 2. Under-block

- An issued marker copied onto another creator-owned forum group by someone with account access would pass the delete check (accepted risk in the spec: that actor can delete the group directly).
- A lost audit log lowers the daily count to the number of live groups made in the last 24 h (accepted risk; the live cap is still counted on the account and Telegram's own flood replies still apply).
- The page scripts trust the Web K build only after the reviewed build probe passes in the same evaluation, as `invoke` does; an unreviewed build holds.

## 3. Level-of-abstraction fit

Right layer. The broker is the only owner of the profile, so new account actions belong there as typed operations, sharing its queue, exclusive-ownership check, build canary and recovery latch. The orchestrator holds policy (grant, caps, audit); the broker holds transport safety; the page scripts hold the identity predicate and are data-only. Authority comes from the account plus a keyed marker rather than a local file, which removed a whole class of drift (reconcile, adoption, lost records) found in review.

## 4. Signal vs authority compliance

The new gates are deterministic scope limits on irreversible actions against an enumerable domain (exact grant, closed bot set, exact title marker, exact rights set). They are floors, not judgment calls about competing signals, and each is classified `invariant` with its basis in the spec. No brittle check gains authority over anything outside these three routes. The one change to an existing authority (`authorizePreparedChild`) only adds a refusal when a claim could no longer be kept alive, which changes one outcome for existing sends: a reply that could not keep its claim is refused (known-failed) instead of being sent after its lease lapsed (see §1). That is fail-closed, and a transient store error with lease headroom is tolerated.

## 4b. Judgment-point check (Judgment Within Floors standard)

No competing-signals decision point is added. Whether a proof needs a group is the calling agent's judgment; these routes only bound what that judgment can do.

## 5. Interactions

- Shares the broker queue with sends. Admission refuses while anything is queued or a reply is in flight; a reply that arrives during an operation waits at most one operation (45 s plus a cold start if the operation began cold). Claim renewal (every 20 s, 60 s lease, until the broker call settles) makes that wait safe; before this change, any long queued read could already expire a waiting reply and the reaper would record it delivered-ambiguous.
- Uses `verifiedReadDriver` with an operation deadline; a canary failure goes through the same durable recovery latch and hold as sends. Ordinary test-group failures never set the broker's `held` status.
- The existing `invoke` probe is byte-for-byte unchanged when no deadline is passed (the deadline parameter is only used by test-group scripts and the test-group canary).
- `KEY_MATERIAL_PATHS` and `ORIGIN_LOCAL_PREFIXES` additions flow to the file routes (never served), backup exclusions, gitignore and the sync classifier through their existing single lists.

## 6. External surfaces

- Three new HTTP routes under `/telegram/browser/:profileId/test-groups`, authenticated like `send` (Bearer + origin session token).
- New Telegram groups on the operator's account, only when Echo writes the grant. Each has a visible `[itg-…]` marker in its title.
- Agent instructions gain one paragraph (new and existing agents, including Codex/Gemini shadow files).
- Depends on Telegram's Web K API shapes (`channels.createChannel` with `megagroup`/`forum`, `chatAdminRights` pFlags, `messages.getAllChats`); verified against the tweb serializer source and pinned by vm tests; the live proof is the runtime check.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

Not applicable: no dashboard, approval page or form is touched.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design (`physical-credential-locality`): the operator's web session is enrolled exclusively to one broker-owned profile on one machine, and the marker key and audit log serve only that profile. Other machines answer 503 like `send`. Authority lives on the account, so nothing strands when a conversation moves. No notices are added.

**Status surfaces:** `GET /telegram/browser/:profileId/test-groups` is scoped to the machine that owns the profile.

## 8. Rollback cost

Dark until Echo writes the grant; removing or expiring the grant stops creates within one config refresh. Code rollback: Echo deletes remaining groups through the routes, removes the key and audit log, reverts, and ships a follow-up migration removing the awareness paragraph. The claim-renewal change reverts cleanly with the rest.

## Conclusion

Ready for the second-pass review. The change adds a narrow, typed capability on the operator's account with deterministic scope limits, a structural reply-safety improvement, and full agent awareness.

## Second-pass review (if required)

**Reviewer:** independent cold general-purpose reviewer subagent (claude-opus-5-5, fresh context, given only the worktree path and the spec; no builder conclusions), finishing session on the M5 Pro, 2026-11-08
**Verdict: concur with notes. Nothing blocking.**

The reviewer traced all nine scope questions in code and found no gap. Nothing can delete a chat unless the page predicate holds, the HMAC marker verifies in Node, the operation-bound kept channel exists and a fresh `getChannels` shows the exact title. Rollback reaches only the channel just created. Create cannot add any member other than the account and the granted bot (checked by username, id and bot flag), and the bot gets no rights beyond manage_topics/pin/delete_messages (+ implied `other`). No access hash reaches Node: the parsers take exact keys only. Caller data reaches page JavaScript only through `canonicalBrowserJson`. `authorize()` runs before every evaluation. Known and unknown outcomes are split at the mutating evaluation. Claim renewal cannot cause a double send or a silent drop.

Notes and what was done:
1. *Low, fixed.* An `enqueue` rejection (broker closed or queue full) passed out of `runTestGroupOperation` unhandled, so the route would hang. It now returns `known-failed`, which is correct because nothing was evaluated. A failing `closeDriver` in the catch path can no longer turn an unknown outcome into a rejection either. Test added: "a closed broker answers known-failed".
2. *Low, fixed.* A `406` from `createChannel`/`deleteChannel` whose `type` starts with `NETWORK_` (a client-side transport failure in some Web K builds) is now uncertain instead of a known refusal, so it cannot lead to a blind retry and a duplicate group. Test added.
3. *Low, accepted (safe direction).* Spec section 3.6 says the busy check and the enqueue happen together. In the code, the audit summary and the key load run between `admit()` and the enqueue. A reply can be queued in that gap, and then the test-group operation waits behind it. That is the direction the rule protects. Two test-group operations still cannot overlap (`running`).
4. *Note for the live proof.* The create evaluation leaves about 5 s for the in-page re-probe before the 15 s createChannel floor. A slow asset census gives a known `budget` failure, which is safe. The live proof records per-step timings.
5. *Note.* A transient renewal error is tolerated until the last good renewal is 40 s old. That is not a regression: `markDispatched` still refuses an expired lease.

An earlier builder session also recorded two review passes, which led to these changes: cleanup holds only for flood waits, transient renewal errors are tolerated, and authorization waits for an in-flight renewal. That history is kept in the commit; the review above is the cold pass of record.

## Evidence pointers

- Unit: `tests/unit/telegram-origin/test-groups.test.ts` (57 tests), `tests/unit/telegram-origin/test-groups-page-scripts.test.ts` (14, real page scripts in a vm against a simulated account), `tests/unit/telegram-test-groups-migration.test.ts`, `tests/unit/feature-delivery-completeness.test.ts` row.
- Integration: `tests/integration/telegram-origin-test-groups.test.ts` (routes through the HTTP pipeline; claim renewal against the real origin store, including a failed renewal that is never dispatched).
- E2E: `tests/e2e/telegram-test-groups-boot.test.ts` (real `bootTelegramOrigin` with a broker-owned profile; the wrapper forwarding is what the broker reaches).
- Mutation checks run during the build: marker verification forced true (3 tests fail), renewal disabled (2 fail), wrapper forwarding removed (1 fails).
