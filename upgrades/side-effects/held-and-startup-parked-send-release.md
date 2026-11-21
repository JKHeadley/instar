# Side-Effects Review — held and startup-parked Telegram sends: send when safe, hand back when stale, retire by id

**Version / slug:** `held-and-startup-parked-send-release`
**Date:** `2026-11-21`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (Phase 5) — see the appended response`

## Summary of the change

Tier 2 (message delivery; durable external side effects). About 15 files, ~900 lines including tests. Spec review: 5 rounds (Tier-2 cap 6), cross-model `codex-cli:gpt-6.2-astra` every round.

Closes two silent-loss paths from the 2026-11-20/21 Studio outage. (1) The outbox's proof that a startup-queued reply never left (`OriginLegacy.isBootBeaconBody`) recognised only the boot beacon's pre-2026-11-16 body, so every reply the reply script parked during a restart was imported as "may have arrived" and never sent. The proof now matches the current body exactly, and `BootHealthBeacon` exports its builder (`bootBeaconResponseBody`) so a contract test pins them together. (2) Replies held `lease-not-held` were released (re-forwarded, replaced, or sent locally) however old they were. A 30-minute bound from first authored time is now checked at every automatic release point (startup-queue import, direct send site in `recoverHeld` — before the `holdsLease` check and again before the claim — and `recoverForwardedHold`, shared by both forward schedulers). Past the bound the reply is retired (`suppressed`, reason `stale-hold-handed-back`, text kept) and handed back to its writing session (one line) or, with no live session, one hub attention item per conversation. New: `POST /telegram/origins/operations/:id/retire` (operator retire by id, this machine), a `telegram_origin_retirements` audit table, two closed suppression reasons, honest outcome readings (`outcome-unknown` imported rows read `unknown`, not "pending"), `legacy:` ids accepted on per-operation routes, the owner-read treats the importing machine as an imported reply's author, and `recordOperationState` refuses to re-hold a `suppressed`/`superseded` row. Files: `src/messaging/telegram-origin/{OriginLegacy,OriginStoreBackend,OriginStore,OriginStore.worker,OriginForwardToHolder,TelegramOriginRuntime,TelegramOriginService,OriginOperationOutcome,OriginOwnerRead,SessionDeliveryNotice}.ts`, `src/server/{BootHealthBeacon,telegramOriginRoutes}.ts`, `src/commands/server.ts`, `src/data/awareness/held-send-retire.md`, tests (unit/integration/e2e), spec + ELI16 + convergence report, release-note fragment.

## Decision-point inventory

- `OriginLegacy.isBootBeaconBody` (replay-safe proof) — modify — accepts the current beacon body, exact keys only.
- Staleness bound at import / direct send site / forward recovery — add — retire-and-hand-back instead of send past 30 minutes.
- `retireHeldOperation` eligibility — add — refuses not-held, in-flight, uncertain (may have arrived), already-retired.
- `recordOperationState('held')` — modify — refuses `suppressed`/`superseded` (no resurrection).
- Retire route — add — explicit per-id stop, agent token only.
- `classifyOperationOutcome` / `OriginOwnerRead.readOne` — modify — reading only; new reasons and `outcome-unknown`; imported author.

---

## 1. Over-block

- A held reply that is still correct after 31 minutes is not sent automatically; its author gets it back and must resend (one extra turn), or the operator says "send it" on the hub item. Accepted by the owner-approved brief (bounded threshold, author decides).
- A stale reply whose retirement is refused (e.g. it carries a policy verdict) stays unsent until its 6-hour expiry hand-back. Never sent blindly is the intended direction.
- A replay of a parked reply whose identical text (≥ 40 chars) was accepted in the topic since is suppressed by the existing content authority even if it was a distinct answer (recorded in the spec's Left behind; codex dissent).

## 2. Under-block

- A forward whose last attempt is `outcome-unknown` at an unreachable holder is never retired (correctly: it may have arrived) and rides to its 6-hour deadline; its author hears at expiry, not at 30 minutes.
- A `local-sent` forward rides to its deadline with the existing "may or may not" wording.
- Other hold reasons (store/credential blips) keep their existing release rule (late line past 5 min, 6 h deadline).
- A short (< 40 chars) reply resent by hand after a 503 and then replayed can reach the user twice.
- The hand-back line is at-least-once (existing `sessionLine` semantics).

## 3. Level-of-abstraction fit

The gate lives in the origin outbox's release paths (the one place that decides "send now"), not in the reply script or the adapter, so every scheduler (recovery pass, forward ladder, import) passes through it. It uses the existing outbox primitives (operation states, closed suppression reasons, `sessionLine`, attention upsert, `DegradationReporter`) rather than a parallel queue. The beacon proof now reads from the beacon's own builder instead of a hand-copied shape.

## 4. Signal vs authority compliance

- [x] No — the change holds no new brittle blocking authority over a message's content.

The 30-minute bound is a deterministic floor that only decides "send automatically now" vs "return to the author"; the author (an LLM session with full context) or the operator is the arbiter of whether the reply goes out. It never deletes: the text stays retrievable. The beacon proof is an exact-match invariant against a single emitter, failing closed to the existing "uncertain" path. Duplicate suppression on replay is the existing content authority, unchanged.

## 4b. Judgment-point check

The staleness bound is declared in the spec as a judgment-candidate with floor (release vs hand-back, conservative default keeps the text) and arbiter (author session / operator). No other new static heuristic at a competing-signals point.

## 5. Interactions

- **Receipt resolution first.** In `recoverForwardedHold` the stale gate sits after the owner-unstated and `outcome-unknown` receipt blocks (which never send), and the older-owner reasonless branch settles instead of preparing a successor when stale; so a reply the holder may have delivered is resolved, never relabelled "not sent".
- **Race with a running pass.** A pass that read a row before an operator retirement cannot resurrect it: its marker write (`held`) is refused from `suppressed`, so the existing "marker store refused → retained" branch runs. The operator path also waits on the pass single-flight (per process; the store refusal is the cross-process guard). Automatic paths call the store directly (no self-deadlock).
- **Expiry hand-back.** Retired rows are `suppressed`, so they leave the held listing and never get the expiry hand-back (no double notice).
- **Late mark.** `markLateDirect` runs after the send-site gate; a stale row is retired before it would be late-marked.
- **Held-topic item / token-less debt.** `onRetired` clears them on every path, immediately and again from the report pass (idempotent).
- **Content dedup.** Imported replays pass the existing reservation; verified by an integration test.

## 6. External surfaces

- New route `POST /telegram/origins/operations/:id/retire`; outcome/text routes accept `legacy:` ids; new outcome reasons on the outcome route and the `receipt` mesh answer.
- New hub attention item `telegram-origin-retired:<topicId>`; new session line text.
- Telegram: fewer late sends (stale ones are handed back), and replies parked during restarts now actually go out — a visible behavior change for users (more replies arrive after restarts).
- Timing: depends on the recovery tick (30 s) and wall clock; age ignores future/garbage timestamps.

## 7. Multi-machine posture (Cross-Machine Coherence)

- Outbox rows, stale gate: machine-local by design (`physical-credential-locality`: custody sealed to the execution owner's credential on that disk).
- Retirement audit rows: proxied-on-read via the `receipt` verb / outcome owner read (reason, outcome, safeToResend travel); full row on the custody machine.
- Retire route: this machine only; a machine without the row answers 404.
- One voice: author line only on the authoring machine; hub item per conversation, hub-only; the holder raises nothing for a reply another machine wrote (`author-elsewhere`).
- Mixed versions: an older author reads a new reason as reasonless with `olderOwner=false` → settles, never resends; a newer author with an older holder never sees a retirement.

## 8. Rollback cost

Revert the PR (no config, no data migration). The new table is left in place, harmless. Retired rows stay `suppressed`; old code reads the new reasons as "no stated reason" (`unknown`, never resent). Unreported retirements at revert time are not handed back by the old code (replies remain unsent, readable by id). Rows the new code sent stay sent.

---

## Second-pass review

(Appended below by the independent reviewer.)

**Reviewer:** independent subagent (claude-opus-5-5), 2026-11-21

Concur with the review. Traced against the code, not the artifact:
- Stale gate covers every automatic release: `importLegacy` retires only non-terminal (replay-safe) rows past the bound, and a refused retire takes the existing `outcome-unknown` ending, never a send (OriginStoreBackend.ts ~533-560). `recoverHeld` runs `staleAtSendSite` before the `holdsLease`/`readmitLeaseHold` step and again before `markLateDirect`/reserve/claim; an unreadable row or a refused retire is skipped, never sent (TelegramOriginRuntime.ts ~950-960, 1119-1134). `recoverForwardedHold` gates before every local-send/forward/replacement branch, and `local-sent` rows still only retain (OriginForwardToHolder.ts ~957, 989).
- Never "not sent" for a possibly-delivered reply: `retireHeldOperation` refuses claimed entries, dispatched attempts with unknown/accepted outcomes, non-queued children, and `outcome-unknown`/`local-sent`/`ownerUnstated` details, all in one immediate transaction.
- Race: the retire dead-letters the queue entries and suppresses the children atomically, so a later `claim` cannot win. `recordOperationState('held'|'admitted')` cannot resurrect a `suppressed` row, and the operator route waits on the pass single-flight.
- Minor, non-blocking: the browser-transport recovery branch has no stale gate. `lease-not-held` holds come from the bot `authorize` path, so I found no route by which a lease-held or imported reply reaches that branch.
- The 20 unit tests pass locally. I did not run the integration or e2e files.
