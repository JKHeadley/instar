# App-First Owner Approval Delivery

Tier 2 security-related publication/discovery repair. Existing authority, no new approval consumer. Spec review: six external reads at cap, three internal reviewers across six lenses, final source-backed internal closure; no quiet external pass claimed. Code review caught delivery-reservation and duplicate acceptance-flush races, repaired with explicit reservation ownership.

## Over-block

Fresh requests retain inherited creation bounds. Carrier repair reuses an existing request without fresh admission or extended expiry. A paired device receives setup, not approval. Unknown registry state refuses routing without guessing chat. No-Touch-ID Mac guidance is conditional and names iPhone/local pairing recovery. App setup takes precedence over accepted chat by explicit product choice.

## Under-block

Existing onPresenceApproval checks owner principal, active matching device and presence keys, current acceptance, exact proposal hash, expiry and consumption CAS. Browser and confined first-phone admission remain ineligible. No caller-supplied identity or bearer approval is added.

## Abstraction

AccountPathService selects a carrier from the real device directory. Separate carrier metadata cannot create a request or grant. Existing writeGate/proven and durable consumption stay the authority; Needs-you/console are read-only signals.

## Signal Versus Authority

Conforms to docs/signal-vs-authority.md: availability and listing are signals; exact signed approval remains authority. The local queue reserves fresh-request admission through durability; external chat sends run outside it. Creator-owned reservations cannot be reused by acceptance flushes.

## Interactions

Markers validate original id/hash/principal/expiry and survive either replay order without publishing orphan rows. Confirmed chat receipts retain binding. Chat/device consumption stays single-use. Pre-send lease recheck suppresses former-holder sends. Every chat send has a durable pending request first; interrupted receipt recording is visibly unconfirmed. Existing authenticated acceptance replay provides deliberate recovery, not automatic uncertain resends. Duplicate proposes do not duplicate notifications.

## External Surfaces

Additive approvalDelivery metadata on existing bearer/native listings; a Needs source, read-only console section and awareness note. Push remains contentless; listed never means push arrived. No new secrets, keys, drop tokens or approval codes are exposed. New awareness file uses normal automatic migration delivery.

## Multi-Machine Posture

Requests/carrier markers replicate in trustJourney. Only holder publishes/consumes. Non-holder current availability is unknown while replicated requests remain visible. Keys stay on their hardware. Old readers ignore the delivery-only metadata record and retain the base request; no action-kind change in this slice.

## Rollback

Revert restores old preference/UI without erasing requests or approvals. Existing device consumers still handle device requests. No destructive state migration, permission repair or automatic board-policy approval.

## Verification

Store24, service59, HTTP8, discovery/Needs/console219, production lifecycle2 focused tests pass (final result captured in build evidence); Two independent final implementation reviews concurred after reservation and post-sweep holder rechecks. Full exact-head verification remains required. Full suites go only through echo-increasing-throughput. No full-green, live-deployment or shipped claim in this artifact.

Final independent reviews concurred after reserving fresh slots before the durability wait, explicit creator ownership, and post-await holder recheck. Added native delivery evidence enum. No remaining material defect reported; full exact-head verification pending.

## 4b. Judgment-point check

No new static heuristic at a competing-signals judgment point. Carrier state is the enumerated accepted/setup/none/unknown domain; the explicit product choice is app-first delivery, while human intent and the existing exact approval authority remain separate. Inherited creation limits are not claimed as new constitutional floors.

## 6b. Operator-surface quality

1. Leads with the primary action: Changes to approve is the first settings section. A human headline and the How to approve button precede every full exact disclosure; the button opens instructions, not a bearer mutation.
2. Zero raw internals as primary content: the headline names the requested behavior by changeKind in everyday words. Exact tool/settings disclosures are preserved in secondary text, never removed or promoted into the headline.
3. Destructive actions de-emphasized: this section has no revoke, delete or stop action and grants no approval from the console. It points to the existing native presence ceremony or exact private chat card.
4. Plain language at phone width: inspected the actual module and console CSS in normal Chrome in a390px viewport. The document scroll width was375px (no horizontal overflow), and How to approve was44px high with its bottom at459.8px inside the844px frame. The full rendered page text was read; human headline, app continuation and action appeared before full exact summaries. Evidence: Echo recovery identity-144636/approval-phone-browser-read.json. This is a local read-only fixture, not a live owner approval.

## Second-pass review

Two independent source reviewers concurred after concurrency and holder fixes. UI action ordering/humanization then passed40 focused discovery/Needs checks and normal-browser phone inspection. Full exact-head verification remains pending.


## Native disclosure compatibility correction

The shipped Apple decoder bounds each summary to 40 entries of 400 Characters. The previous server card-size limit could publish a line the app silently shortened. The correction changes only native presentation and refusal: grapheme-safe packing under conservative codepoint bounds, applied equally to old persisted requests, with no canonical change or hash rewrite. Fresh or duplicate native publication refuses an undisplayable summary before writing; accepted-device consumption refuses it before proof issuance and effect. It remains visible with an explanation. Chat-only publication retains its existing whole-message bound.

No filesystem, timer, network, installed-file, configuration, ownership or replication-writer change is introduced. Work is linear in the already bounded normal disclosure; an exceptionally oversized legacy disclosure is refused. Rollback restores the prior disclosure risk, so keep the candidate held until the corrected exact head is verified. Existing records do not require a migration because formatting is derived at read and consumption time. The actual phone renderer uses separate dynamic Text entries with no lineLimit or Markdown interpolation on full summaries. No app binary change is needed for the conservative server format.

Independent second pass identified a grapheme split at the first implementation's boundary; fixed with Intl.Segmenter before commit. The reviewer then concurred with no remaining material source defect. Universal Unicode-version visual equivalence is not claimed. This is source and focused-test evidence; no live owner approval or shared full pass is claimed.

Correction validation: 13 boundary units plus existing 59 device/service regressions passed (72 total); distinct signed HTTP boundary test passed; production-runtime long-disclosure E2E passed; TypeScript checked clean; all 55 lint steps passed. Independent source reviewer and test reviewer concurred. Full verification remains exclusively with the shared coordinator.

## Exact-head verification repair

The shared full gate for 20ce83b6 failed. Retained evidence is truncated and is not a complete failure list. Focused reproduction exposed the common migrator error: the feature awareness entry omitted its YAML frontmatter delimiters, so the real registry rejected it and migrations reported an error. Add only the required opening and closing delimiters; preserve the entry text and all approval behavior. Existing registry and migration tests verify the actual parser. Independent review and corrected exact-head shared verification remain required. No pass is inferred for unexecuted lanes.

Repair evidence: all 140 tests in the 32 retained unit files pass; the 45 real registry tests pass; all 14 tests across the three retained E2E files pass. Independent reviewer local_link_review concurred that only required delimiters changed, with no Telegram requirement or approval behavior change. All 55 normal lint steps and TypeScript passed. The commit gate correctly refused the first attempt because its earlier trace was stale; this fresh trace records the completed review. This repairs the reproduced retained failures and does not establish clearance of the unavailable remainder of the truncated full-run report.

## Withdrawal route regression test correction

The next shared gate failed one unit in mobile-trust-approval-routes.test.ts on head 1ea8dbac4. Its exact assertion artifact aged out; the retained worker summary confirms only the file and count, with HTTP/lifecycle stopped early. Focused reproduction on that head found the withdrawal test’s stale no-approver expectation. The paired app now retains requests as awaiting-acceptance after withdrawal. Correct only the test, and additionally require real signed approval to fail with 403 acceptance-withdrawn, zero apply, and the request still open. Runtime and authority are unchanged. Independent reviewer app_first_lessons_review concurred. All 60 focused route, discovery and device-approval tests pass. This reproduction is not asserted to be the lost full-run stack. Full corrected-head verification remains required.

## Real-server withdrawal integration expectation

The exact c641d6d6 full run passed 74,317 units and 4,388 lifecycle tests, with one HTTP failure among 7,938: trust-app-approval-routes.test.ts:67 expected no-approver after withdrawal, actual awaiting-acceptance. The complete retained artifact is .instar/recovery/retention1961/pr3660-c641-retained-failures.json in the agent home. Focused reproduction matches it. Correct only the final integration expectation and strengthen its real pipeline: paired-device setup remains visible without exposing a code, the signed request list shows the open row, real presence-signed approval refuses with 403 acceptance-withdrawn, calendar trust does not rise and the request stays open. All earlier no-device, acceptance, apply, replay and bearer-refusal checks remain. The focused real-server HTTP test passes. Runtime is unchanged; exact full verification remains required.

Independent reviewer app_first_lessons_review concurred on the real-server integration correction: no material defect, real signed refusal and unchanged original success/replay/bearer pipeline.

## Dashboard unread lifecycle test signing repair

Tier 1, reversible test-only maintenance: one E2E test file and this evidence appendix. The retained fd107 shared failure was a TypeError in phoneRow when conversations was absent; that historical response status/body was not retained, so its original status is unknown. A focused original run returned 200 and real unread1 then0 responses. Deterministically reusing the baseline GET timestamp reproduced an actual 401 device-unauthorized response and the same TypeError. MobileDeviceKeys.ReplayGuard hashes the canonical request per device, and mobilePairingRoutes maps that replay rejection to 401; a fresh ECDSA signature does not make the canonical request unique. This confirms a real randomized signing-helper defect and matching failure mechanism, not retrospective proof that the shared response was401.

The test signer now owns a monotonic timestamp per signer, max(Date.now(),last+1), and phoneRow asserts HTTP200 with body diagnostics plus an array before find. The real phone/browser registration, signed HTTP requests, reply, unread1 assertion, browser read marker and unread0 assertion remain unchanged. No production auth/replay/freshness code, threshold, service, disclosure or owner approval behavior changed. Temporary forced-replay and console instrumentation is absent from the final test. Focused corrected lifecycle run passed the existing real-production test.

Independent parent review inspected the actual final diff and concurred: the collision is removed without weakening the production replay guard, failure diagnostics are strengthened, and unread semantics are preserved. Supporting private evidence: .instar/recovery/dashboard-read-markers-fd107-{response,duplicate-get,fixed}.log, structured diagnosis JSON and forced-duplicate fixture in this worktree. An initial environment-controlled injection was stripped by the hermetic test setup and did not exercise the negative condition; the subsequent unconditional diagnostic did. One source review and one planned normal commit; no full suite was run manually. Shared exact-head verification remains required, with disclosure and all native/authority/dependency holds retained.

There is no new decision boundary, external surface, multi-machine state or migration. Existing signal-versus-authority analysis is unchanged. Rollback reverts only this test repair and would restore a random canonical-request collision. No new over-block/under-block is introduced in production; the test now reports an unexpected response at its actual boundary instead of a TypeError.

## Current-main canonical disclosure reconciliation

On 2026-11-23, Chief056fcd25 reprioritized this branch because main had advanced to287bb3422(version1.3.1987) and conflicted with42a003953. The two conflicted source files are AccountPathService.ts and server/routes.ts. Preserve main's SEC-141 verification of the requested change and its proposal hash, and derive every displayed/checked disclosure from that change. Then apply the native lossless-packing/size bound to those derived lines. Duplicate app-carrier migration also checks the derived disclosure before changing the carrier. Do not restore trust in stored summary fields to resolve the conflict.

The chat send retains branch delivery reservations and finally cleanup; canonical verification is inside that try/finally before the external send. Device approval verifies the hash before the display bound and before any approval effect. Device listing verifies and packs the derived lines. The agent listing retains changeKind for the human headline but returns the derived summary. Existing app-first paired-device/setup precedence, synchronous durable preparation, explicit creator ownership, holder recheck, consent withdrawal and single-use consumption remain intact.

Test repairs preserve main's immutable-request security semantics: the first request record fixes contents, while a later same-hash delivery adds only receipt IDs. The replay test now asserts both properties in every replay order. Disclosure unit fixtures explicitly supply canonical rendered lines; new mismatched-summary cases prove a huge cached summary cannot over-block a short verified change, and harmless cached text cannot bypass the actual change's display bound or migrate its carrier. The signed HTTP fixture now uses an actually oversized canonical change with harmless cached text, preserving refusal, zero consumption and pending-request checks. An existing duplicate vitest import was removed from the signed approval/withdrawal test so it compiles.

No new authority, limit, migration, durable format, external channel or operator surface is introduced. Existing awareness entries are retained. Hard authentication invariants fit docs/signal-vs-authority.md's boundary exception. State remains replicated through the existing trust record sink; first-seen immutable contents and signed receipt IDs retain their existing roles. No new notices, URLs or pool-wide verdicts. Rollback must retain SEC-141 canonical verification as well as prior app-first guards, rather than choosing one conflicted side. Parked broader-design specs and recovery evidence remain untouched.

Focused validation at reconciliation:327/327 units across10files, signed HTTP10/10 and production lifecycle4/4 passed. The signed disclosure HTTP case passed again after reviewer-requested assertions were corrected to name the actual service and exclude the harmless cached description. TypeScript check passed. Five independent reviewers (pin_security_review, pin_correctness_review, pin_tests_review, pin_wiring_review, pin_sideeffects_review) concurred; no material source concern. The test reviewer reread both corrections and concurred. Shared exact-head full verification remains required; no live delivery or owner approval is claimed.
