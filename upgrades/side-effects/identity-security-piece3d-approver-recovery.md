# Side-Effects Review — A way back if you lose every phone that can approve

**Version / slug:** `identity-security-piece3d-approver-recovery`
**Date:** `2026-11-18`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Piece 3d of the approved identity and security design (topic 144636): recovery through the private chat when every approving device is lost (umbrella §9 and §4.5a, mobile-approver-mark §3.8).

- **Start** (`/approver_reset <code>`): the Telegram adapter handles it itself.
  - The message must come from the owner, in the owner's private chat, not forwarded, read from Telegram's own updates.
  - It answers with a card with Start and Never mind. Start is refused unless:
    - the record is enrolled and this machine holds the lease;
    - no recovery is running and none was locked out in the last 7 days;
    - the target is a chat-paired owner device and its key isn't retired;
    - every machine's fresh signed build statement names the `approver-recovery` guard.
- **The home** (the lease holder at Start) keeps the state in `state/approver-recovery.json` (`src/core/approverRecovery.ts`):
  - the frozen candidate key;
  - the owner keys that may sign a locking Stop;
  - the lost keys;
  - the machines at the start.
- **Notices** go at 0, 36 and 71 hours, each pushed to devices too. Each counts only when Telegram returns a message id. The recovery is ready at 72 hours, with all three accepted, an hour after the final one. It ends 7 days after the wait.
- **Stops:**
  - a signed Stop by a counted key, which locks for 7 days only if this machine first saw the key at least 24 hours before the start;
  - the owner's Stop tap, no lock;
  - any approval by another approver after the start (3a's `lastPresence`).

  Stops are written before answering and shared as the union of every machine's.
- **Finish:**
  1. A fresh chat code.
  2. A read of every machine's signed facts, each at most 15 minutes old.
  3. The proof, signed by the home's key.
  4. The device signs the entry it checked.
  5. A second read, then ingest.
- **2a.** One narrow path after enrolment: `add-owner-key` with `via: 'recovered'`, self-signed by the candidate. It counts only with a machine proof by a key valid at the parent and not revoked before it, stating at least 72 hours.
- **Every machine,** on arrival (2b ingest, every path):
  - **accepts** only if it saw the recovery itself, 72 hours ago on its own clock, and saw the final notice at least an hour ago;
  - **holds** otherwise (re-offered each tick);
  - **retires** the key if its own facts show a stop or an approval during the wait.

  A machine that joined later accepts once every machine at the start has reported accepting that exact entry.
- **Provisional until settled.** The one approver reader and 2b ingest treat the recovered key as approving nothing until every machine at the start has accepted it, with no stop anywhere. The lost keys named at the start are retired one clean sync round after settling (umbrella §4.5a).
- **Decision facts travel in each machine's signed pull request.** 3a's retired-key list now comes only from signed facts, except from a machine without the new guard (a mixed rollout, where retiring only removes rights).

## Decision-point inventory

- Recovery start.
- The arrival decision (accept, hold, retire).
- Provisional and settled.
- Stops and the lock.
- The Finish reads.
- The lost-key retirement.
- 2a's recovered-key rule.
- The retired-key provenance.

## 1. Over-block

- **A machine that never saw a recovery holds its entry** until it can verify it. The key stays provisional, so the owner waits rather than being harmed.
- **A slow or silent machine blocks Start and Finish** ("try again") and keeps the key provisional. The CLI's machine removal is the way past a machine that is gone for good.
- **A legitimate recovery is stopped by any approval.** That is intended: it is the sign of a living approver.

## 2. Under-block

The stated residual (umbrella §9, decision 3): someone who took over the owner's Telegram and went unnoticed by every device for 72 hours completes a recovery, and the lost keys named at the start are revoked. The notices name those devices, so any device that sees one can stop it.

## 3. Level-of-abstraction fit

- **Pure state and decisions:** `src/core/approverRecovery.ts`.
- **The network and the chat:** `src/server/mobileApproverRecovery.ts`.
- **Hooks into the existing record:** 2a's evaluator gains one narrow path, 2b's ingest one gate, and the sync carries the facts.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — deterministic checks over enumerable inputs (signatures, times on this machine's clock, signed peer facts, codes); no judgment over meaning.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic — STOP.

## 4b. Judgment-point check

The limits are approved floors (spec §1b):
- the 72-hour wait;
- notices at 0, 36 and 71 hours;
- the 24-hour key age and the 7-day lock;
- 7 days to finish;
- 30 minutes and three tries for codes;
- the 60-second margin;
- 15-minute freshness for signed facts.

## 5. Interactions

- **Owner-record sync:** pull requests carry `facts` (signed with the request). The tick retries held entries. Build statements carry the new guard.
- **Telegram:** `/approver_reset` is handled before routing. The Start, Never mind and Stop taps reuse the verified `md:a` and `md:d` callback path. Recovery messages carry their own button labels.
- **Push:** the new subject `approver-recovery`, with fixed words.
- **The approvers list** gains `recovery`.

## 6. Rollback

Revert the commit. These stay behind:
- the local state file `state/approver-recovery.json`;
- recovered entries, which older builds refuse (no recovery-proof hook), so an older machine holds them out.

Start refuses while any machine lacks the guard, so no recovery runs during a mixed fleet. A retired key stays retired.

## 7. Evidence

- **Unit:**
  - `tests/unit/identity-piece3d-recovered-key.test.ts`: 2a's path both ways, nothing else loosened.
  - `tests/unit/identity-piece3d-recovery-core.test.ts`:
    - the wait measured from this machine's own first sight, so back-dating gains nothing;
    - retire on an approval or a stop; hold forever when never seen; a machine that joined later; acceptances bound to the exact entry;
    - settling, the notice schedule, ready, the ends, the Finish read.
  - `tests/unit/identity-piece3d-recovery-flow.test.ts`, through the real routes on a lone agent with a faked clock:
    - a whole recovery (start, three notices, ready, finish, the new phone approves, the lost key revoked one round after settling);
    - one stopped by an approval;
    - the chat command's refusals.
- **Regression:** 2a–2c, the 3a record, claim and ratchet tests.
- **E2E lifecycle:** the 3a alive file now checks the recovery routes answer and the wiring is in place (run by Local Verify).
- **Live:** the spec's test-agent-live proof (a two-machine throwaway pair: a start, notices, a cross-machine stop, and a real 72-hour finish on 2026-11-21) is tracked in the build folder.

## Second-pass review

An independent reviewer subagent read the code cold over four rounds and concurred at round 4. Fixed with tests:
- **Round 1:**
  - H1: a second entry under an old recovery id skipped the wait.
  - H2: arrivals were recorded before 2a judged them.
  - M1–M6: a lost chat Stop, signed Stops that didn't lock off the home, machine removal, the joined-later rule, stale-fact lost-key retirement, approvals not ending the wait.
  - L1–L6.
- **Round 2:**
  - The home's start list could shortcut honest machines (high).
  - A conflicting entry recorded a stop.
  - A stop after settling took effect.
  - A relay could hijack a recovery's home.
  - Same-batch children weren't held.
- **Round 3:** a two-machine agent with one compromised machine could skip the wait (high). Fix: a machine that never saw the recovery counts the entry's arrival as its first sight and waits 72 hours itself. A machine that knows of a stop also withdraws its acceptance.
- **Round 4:** concurred, after the chat-tap Stop wording was aligned so the owner is never told a stop worked when it may not have.
- **The app reviewer** found that Finish depended on a request that expires after a day. Start now consumes it, and Finish uses the frozen target.

Record of all rounds: `.instar/state/identity-build-144636/reviews/p3d-second-pass.md` in the agent home.

## Class-Closure Declaration

**In the trace:**
- **defectClass:** `unbounded-self-action`
- **closure:** `n/a`
- **reason:** the recovery tick is bounded by monotone state. It sends at most three notices per recovery, each once (an accepted notice is recorded), plus one owner message per milestone, deduplicated by key in memory and bounded by milestones. One tick runs at a time, every 5 minutes. A recovery ends by itself 7 days after its wait.

## Addendum: rebase onto main (2026-11-21)

Replayed onto the refreshed piece 3a with no conflicts. One test fix: the recovery-flow test pinned its fake clock
to 2026-11-20 while the first-approver code store reads the real clock, so the code read as expired once that date
passed. The test now starts the fake clock at the real time. No source change.

## Addendum: app contract review (2026-11-21)

From the Apple session's comparison of the app with the server contract:

- `POST /mobile/approver/recovery/finish/sign` answers 409 `presence-invalid` for a bad approval signature, not
  401. The app reads 401 as its own device signature being refused and re-pairs. This matches 3a's sign routes.
- `POST /mobile/approver/recovery/seen` now checks the `recoveryId` the device names, as its comment always said.
  A stale or different id answers 409 `recovery-changed` and records nothing.
- `GET /mobile/approvers` gives a recovery started on another computer the same app-facing shape as one started
  here: `recoveryId, startedAt, state, targetName, targetIsYou, endsBy`, plus `elsewhere: true`. Device ids differ
  per machine, so `targetIsYou` compares the recovery's frozen key hash with the keys this device holds or has
  asked with on this machine. The peer's internal fields (counted keys, Stop nonce hashes, machines, the other
  machine's device id) no longer reach phones.

Tests: three new cases in `tests/unit/identity-piece3d-recovery-flow.test.ts`; every 3a/3d unit test and 29
approver, pairing and team integration and e2e files pass.


## Prerequisite maintenance — 2026-11-22

Normally merge corrected approver prerequisite `1c60d736e189ca8a72841f7a859782133c5f16ca` into recovery head `d9ce37106fb37d8b648564b783f1f335e9f3067f`. The merge is automatic; no runtime edits or manual conflict resolutions. LeaseCoordinator, FencedLease, MultiMachineCoordinator, commands/server and core/types remain byte-identical to the corrected prerequisite, preserving current-main stall reconfirm, planned-restart reclaim and lease fence behavior.

This maintenance passes through the existing recovery authority. It does not change Telegram publication, the72-hour wait, Stop rights, keys, app/native dependencies or any authority/admission/release hold. Existing over-block, under-block, interactions, machine posture and rollback analysis above remains applicable; no new decision point or signal authority is introduced.

Focused verification:120unit checks across9files, including signed HTTP recovery-flow cases;5distinct HTTP stall-reconfirm checks;5production E2E checks across approver-alive/stall boot-path; TypeScript clean. Logs are retained under `.instar/state/build/pr3457-maintenance/`. No full suite was run by hand and no full admission requested. Independent parent review concurred before commit: actual merged TelegramAdapter, AgentServer and pairing routes retain recovery wiring, owner-only allowlist and trusted private-chat checks while preserving current credential masking. Lease/stall/boot/server/type guards remain identical to the corrected prerequisite; no material merge regression or unresolved stage was found.


## Second prerequisite refresh — 2026-11-23

Normal merge of corrected3453 `7d559beb1ef491f4c4665cb57133bad4cc35100d` into `d2b57020d155d6b4f271b040c679a8c1d3dce00d`; currentmain `c7a2f64581058fb60b1f25767f3f9a09543f05bf` is already an ancestor of that prerequisite. No content conflicts or manual runtime edits. Recovery core and ceremony files are unchanged from the reviewed3d head; lease/stall/boot/server/type guard files exactly match corrected3453. Main owner-word learning, credential masking and owner-only parent-preview reads remain.

Root independent review concurred before commit after checking actual merged shared integration differences and3d against prerequisite: owner-only recovery routes, trusted private-chat Start, settled-key checks,72-hour wait, independentStop, settlement and retired-key rules all remain intact; no unresolved hunks or deleted guard paths. This is prerequisite maintenance only, not private-chat or root-approval compliance work.

Fresh focused checks pass:120unit across9files including real signed recoveryHTTP cases,5distinctHTTP stall checks,5productionE2E checks and TypeScript. Retained logs: `.instar/state/build/pr3457-maintenance/refresh2/`. No manual fullsuite or fulladmission; normal commit/push gates remain required. Native/private-chat/app/authority/verification/dependency/release holds all remain unchanged. Existing side-effects analysis still applies: no new authority, lifecycle decision, storage format, keys or live runtime mutation; rollback is the prior branchhead.

## Release 1.3.1989 recovery prerequisite readiness

Tier 2 maintenance under the existing approved recovery specification. Coordinator892323d3 confirms published PR3457 head45414feb16ee3bc24d3a2b13ad8256520e70f2c4 is open against main, held and inactive. Chief49f95c2f and the coordinator confirm prerequisite3453 is published at6815a46284bc230815e6fc02076907b2b631e1e0. The existing clean isolated identity-3d-main-repair checkout matches the recovery head; its local branch is echo/identity-3d-main-repair. Canonical origin is JKHeadley/instar, and the matching Node22 database addon loads.

Normally merge the published6815a4628 prerequisite, which already contains minimum-build protection31d46de4f and main ec9401e5b. The merge is conflict-free. Recovery core and ceremony behavior pass through unchanged; there is no manual runtime resolution, new authority, carrier, timing threshold, security-key interpretation or production activation.

The existing over-block, under-block, layer fit, signal versus authority, interactions, external-surface, multi-machine and rollback assessments remain applicable. Preserve trusted private-chat Start and Finish, the72-hour wait, accepted-notice evidence, independent Stop rights, settlement and retired-key rules, recovered-key approval barriers, and current main’s masking, disclosure, authentication and lease protections. Rollback is an ordinary merge correction retaining both guard sets; installed state is untouched.

The unresolved private-chat Start/Finish dependency remains held. PR3626 landing and the subsequent recovery harness rewiring are still required separately. This refresh does not implement a stopped carrier design, establish fresh simulator/native evidence or clear any prerequisite, security-key, app, owner-ceremony, native, real-phone or recovery hold. Publication is a held replacement only.

Verification uses one sequential runner under normal admission for recovery/approver/minimum-build and lease unit boundaries, real HTTP owner-presence/pairing/stall checks, production route and owner-record lifecycle checks, and TypeScript. Full suites remain exclusively with throughput under the existing holds. One scoped maintenance review and one intended normal commit; no new design rounds. Final focused results and independent concurrence follow after completion.

Final focused verification passed134unit checks,47HTTP checks and10production lifecycle/wiring checks (191total), followed by TypeScript with exit zero. The sequential runner recorded each step under normal admission. Independent reviewer /root/review_3457_readiness concurred with the staged merge and appendix: recovery core and ceremony files remain unchanged from the published recovery head; the72-hour wait, accepted-notice evidence, independent Stop rights, settlement, retired-key rules and recovered-key barriers remain intact. Main’s authentication, masking, disclosure and lease guards are retained.

These are maintenance-readiness results. Full verification and every prerequisite, private-chat, security-key, app, native, real-phone and recovery hold remain required. The later PR3626 landing and recovery harness rewiring are still separate prerequisites. Publication is requested only as a held replacement.
