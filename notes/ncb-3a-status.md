# NCB slice 3a — status

**Slice:** native-conversation-base §3a, "A reply is ended only for a cause (F1)".
**Branch:** `echo/ncb-3a-held-replies`. Fresh off `origin/main` 3ae8208a6, with `echo/ncb-3b-owner-read` (PR #3092, not yet merged) merged in for its `receipt` fields `outcome`, `failure` and `role`. The spec, its ELI16 and its convergence report come from that merge and are identical to `echo/native-conversation-base-spec` (PR #3086).
**PR:** https://github.com/JKHeadley/instar/pull/3102 (opened through a one-shot session on the Studio; this machine's token cannot create PRs). JKHeadley was not requested as reviewer from here.
**Local Verify:** requested on the Studio (`POST /local-verify {"pr":3102}`, port 4042, Tailscale 100.124.55.70) right after this note was pushed, so the head it runs on is final. See the PR for its result.
**Merged:** no (by instruction).
**Built on:** the Mac M5 Pro (`MacBook-Pro.local`, agent home `/Users/adriana/echo-compute/echo`), 2026-11-11, 20:19 to about 21:35 PST.

## Step 0 (CMT-057): not done here

This is not the Dabombs Mac Studio, so I did not read why the first agent reply in topic 141868 was suppressed (2026-11-11, 18:09 to 18:40 UTC). The Studio's `server-stderr.log` and origin store were not read, and the spec's §1.4 is unchanged. **F1 is not claimed fixed by log evidence.** Until the Studio session records the line, F1 rests on this slice's tests and on the 3a live proof replaying the 141868 topology. If the line shows the content duplicate check rather than `retired overtaken queued reply`, this slice does not fix F1, and the duplicate record is the next thing to read.

## What is built (all of §3a items 1 to 9)

- The timestamp review is removed: `QueuedReplySupersession.ts` and its test, the `reviewQueuedReply` option, the boot pass-through and the server's pool read. No timestamp comparison is computed.
  - **Brief vs spec:** the build brief said to keep the temporal rule "only as a shadow counter". The approved spec says the opposite (FD-3: "none is computed (the r3 shadow counter is removed in r4)"; Decision points: "No timestamp comparison is computed"). I followed the spec. Every recovered reply's delay is still counted (`lateDeliveries`, `recoveredUnderThreshold`).
- Closed suppression-reason set enforced in `recordOperationState`. The three reasonless writers now name their reason.
- Late first line:
  - Carrier: the two columns, added with a duplicate-column-tolerant add.
  - The `firstPreparedAt` envelope field, read by the content check.
  - `runAsRecordedProducer`, so a replacement stays a session reply.
  - `replacementState: 'admitted'`, the direct-path `markLateDirect`, and the forward-path replacement in `recoverForwardedHold`.
  - Marked once, and the mark is kept on every successor. An unmarkable reply is counted and never retried.
- Session lines: late (batched per pass), definite with one of three causes, uncertain, and older-owner. Each goes out once per operation, keyed, and names the id the session was given.
- `ownerVerdict` (the merge nulls `ladder.nextAt`) and `ownerUnstated`:
  - The raw receipt classifier `classifyHolderReceipt` replaces the mapper that folded a reasonless `suppressed` into "not accepted". The test stub's old holder (`state: 'suppressed'`, no outcome) leads to nothing being sent.
  - One fresh-time replacement against an older owner, then the row is settled.
  - The uncertainty is kept across a lease change.
  - `recoverForwardedHold` returns at once for verdict rows.
  - A holder receiving a submit for an id it holds as terminal answers with that ending.
- Forward-expiry carrier with `forwardExpiryArm`: the hub item is raised once, the row is reported only after the line is injected, and it stops at the purge horizon (`neverHandedBack`).
  - Scan carrier for this machine's own sends.
  - Per-topic attention item `telegram-origin-unresolved:<topicId>`.
  - The due ladder no longer reads through the 500-row listing.
- Reply-text route `GET /telegram/origins/operations/:id/text`: API token only (device principal refused in the handler), the conversation check, the authoring machine only.
- `heldReplies` counters on `/telegram/origins/status`; CLAUDE.md awareness (template plus migration plus framework shadow); maturation row `telegramOrigin.causalRetire` in `src/data/feature-ladders.json` (finished, live everywhere, rollback by version).
- The two existing tests that encoded the old review were updated. `telegram-origin-worker-recovery` now asserts a queued reply with a newer message is delivered; `transport-deadlines` drops the `'retire'` stub. The review's own unit test file was deleted with its module.
- `docs/specs/queued-reply-coherence.eli16.md` carries a "Superseded" note (spec Left behind 12).

## Tests (M5 Pro; TMPDIR=/Users/adriana/echo-compute/tmp/ncb3a, umask 022)

**Neighbour lanes.** Selected by `git diff` (every test importing a touched module) plus the migrate*/PostUpdateMigrator tests:

| Lane | Files | Passed | Skipped | Failed |
|---|---|---|---|---|
| Unit | 459 | 14,768 | 1 | 1 |
| Integration | 38 | 266 | 5 | 0 |
| E2E | 64 | 455 | 0 | 1 |

- **Unit failure:** `no-silent-fallbacks` (495 > 494). It was my new catch in the text route; it was annotated, and the ratchet passes.
- **E2E failure:** `telegram-origin-native-hook` (a guard state read `unknown` vs `ready` under the full serial lane). It is not touched by this slice and passed 2 of 2 alone.

**Final re-run on the committed code:**
- Unit: `tests/unit/telegram-origin/` plus the forward-on-standby, migration, ladder and silent-fallback tests. 67 files, 805 passed, 1 skipped.
- Integration: held-replies, worker-recovery, forward-on-standby, outcome-owner, mesh and routes. 6 files, 64 passed, 5 skipped.
- E2E: causal-retire-alive, forward-lifecycle, owner-read-alive and held-outcome-lifecycle. 4 files, 6 passed.

**New tests:**
- `tests/unit/telegram-origin/held-reply-causal-retire.test.ts`
- `tests/unit/telegram-origin/held-reply-store.test.ts`
- `tests/unit/telegram-origin-held-late-migration.test.ts`
- `tests/integration/telegram-origin-held-replies.test.ts`
- `tests/e2e/telegram-origin-causal-retire-alive.test.ts`

**Environment fix on this machine:** the shared `node_modules` lacked `nodemailer` (declared in `package.json`). I installed it in an isolated prefix (`/Users/adriana/echo-compute/tmp/ncb3a-nodemailer`) and symlinked only `nodemailer` and `@types/nodemailer` into the shared `node_modules`. Nothing else in that tree changed.

## Second-pass review

An independent subagent first raised one real defect: a late-marked reply lost its first line on its next replacement (holder change, or the reasonless-ending replacement) while still recorded as marked. It also raised two cosmetic points: ids in session lines, and the hub-item wording for a verdict. All three are fixed with tests. On re-check: "Concur with the review". Details are in `upgrades/side-effects/ncb-3a-held-replies.md`.

## Open problems

1. **Step 0 / §1.4** (above): it needs the Studio's log read; the owner is the Studio session.
2. **Spec text vs build (for the spec owner):**
   - The `ownerUnstated` bullet says an owner `not-delivered` with a failure "clears the uncertainty so the ordinary route runs". The build records `ownerVerdict` and stops instead, as the first bullet of item 7 does. That is safer, and the spec should say so.
   - Item 2's "planned again, so its part count can differ": the direct path marks single-part replies only; the forward path allows up to the original's part count. Anything larger goes out unmarked and is counted `lateUnmarked`.
3. **A direct-path late copy has no hold detail linking it to its original.** If that copy later fails, its hand-back line names the copy's id. The text route answers for that id. This is cosmetic.
4. **The 500-row held summary listing.** Expired forwards waiting up to 7 days for a session sit oldest-first in the listing `refreshHeldForward` uses for its health counts and per-topic items. The due ladder was fixed to read by id; the summary was not.
5. **3b's local classifier** (`OriginOperationOutcome.ts`, not edited here) still reads a held `ownerVerdict` row as `pending` when no owner answer is available. The route resolves it through the author statement and the owner ask. Noted for the 3b owner.
6. **Commit used the logged orphan-deferral override.** The lint flags 15 lines in the approved spec text, copied unchanged from #3086. The override log is committed with this note.
7. **Live proofs not run.** The two-machine throwaway proof, the one-machine proof with Telegram unreachable, the proof with the holder on the previous release, and Slack parity belong to the test-agent-live rung before the release that carries this slice.
8. **Review 2026-11-25 (CMT-056).** It reads `heldReplies` per machine and the `late-reply-stale` feedback tag. The registered CMT-056 text predates `definiteNoSession` (spec Left behind 14).
