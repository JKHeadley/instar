# Convergence Report — B1, show what the scheduler covered

## Cross-model review: codex-cli:gpt-6.2-astra

The installed Codex reviewer returned results on six exact revisions. Gemini lacked authentication and the clean Anthropic wrapper was unavailable. Independent integration and performance reviews inspected production JobScheduler, Croner and the Jobs route. Lessons and decision review verified the report the owner would see and counted three numbered decisions and zero cheap-to-change tags.

## ELI10 Overview

A job can be enabled without enough evidence to tell what happened on schedule. The proposed view shows whether the observer witnessed a due time, whether a scheduler callback entered, and which parts are still unknown. It shows later recorded outcomes separately. A local health observation can reveal a stalled scheduling callback without starting or changing any job.

## Original vs Reviewed

The design now measures actual callback entry instead of a last-run timestamp. It distinguishes a paused or changed definition, a late callback, and a missing baseline. It uses separate watcher, row and peer freshness. Same-named jobs on two machines retain separate evidence.

## Iteration Summary
- Round 1, body `79661176fc19399bf5fb1ae3644d1e4572d224a60defe41f34426110cab1fb8c`. Standards-Conformance Gate: ran (4 flags).
- Round 2, body `7b239a1b23fd8ca0c33dbe4b3a6e3c16ad9cdd13aec597ded0709c2a1d28c28e`. Standards-Conformance Gate: ran (3 flags).
- Round 3, body `170d0e2de93002dae7d44b153db6d8bbc78d4e511aadb0eb851f02454937b65a`. Standards-Conformance Gate: ran (1 flags).
- Round 4, body `989db7152224963d237648c367bc79a3395dbfd9c459370a910b5e02439ecc72`. Standards-Conformance Gate: ran (2 flags).
- Round 5, body `5de39fca4eb73150c802ea5d1505aed1c712b00130f478582bad54ebb16c6457`. Standards-Conformance Gate: ran (4 flags).
- Round 6, body `e8d23e2614e041d065d2508db0a6d9a6922566aa14f44e5543aa4fe20073ce64`. Standards-Conformance Gate: ran (2 flags).

## Proportion

Tier 2, six of six rounds. Review followed the distinctions between timing, completed execution, and lack of evidence through the production and pool routes.

## Experience fit

The Jobs page should answer whether the observed scheduling opportunity was covered, with a date and a plain reason. Assigned follow-up does not make a machine condition healthy. It remains possible to have regular callback entry while the exact occurrence result is unknown. The display presents both facts independently.

## Left behind

- External DESIGN. Recheck witnessed continuous time through serialization and report unknown on a read immediately after resume or a clock correction until a current continuity observation exists. The same-boot continuity rule already disallows suspended intervals. Require distinct heartbeat and wall/monotonic control tests before claiming absence.
- External DESIGN. The first build is local-only for known coverage. Peer data without the required nonce and proof stays unknown. Any peer proof must authenticate each slug with its coverage bytes. Add two same-machine jobs with transposed opposite verdicts before enrolling peer evidence.
- External DESIGN. Before a user-facing rollout, name supported schedule cohorts and their expected observable outcomes. Set and verify a minimum fraction from the measured operator canary. The initial production fixture can show a real callback and a stalled callback without declaring that all real jobs can be assessed.
- Conformance. Keep only observation bounded by existing capacity and report gaps. Terms should link to the authority/discovery foundation. Runtime read evidence does not broaden job state or grant permission.

## Full Findings Catalog

### Round 1

**Verdict: SERIOUS ISSUES**

- **DESIGN — Observation / Maturation plan.** The acceptance test says to “hold its registered cron callback.” A hold at callback entry proves the callback *was invoked*. The spec leaves the hold point unspecified, and the supplied material does not establish when Croner updates its progress timestamps. Test two cases separately. Suppress delivery before callback entry while preserving registration and observer ticks, then allow entry and hold subsequent work. Require the first case to produce “No scheduled callback observed” for at least one named supported schedule. Require the second never to produce that verdict. Record callback entry independently as the test oracle.

- **DESIGN — Observation / Jobs read and display.** B1 verifies generation before publication, but Jobs serves a cached observation. A reload between publication and the next read can therefore pair a replacement definition with its predecessor’s coverage, even while the observation timestamp is fresh. Bind each cached result to its definition generation and scope, and check both against the row being serialized. Test a same-slug schedule replacement followed by an immediate `GET /jobs` before the next observer tick.

- **DESIGN — Jobs read and display / Multi-machine posture.** B1 promises explicit unknown coverage for unreachable peers through the existing pool merge. The lease-coverage spec’s *Problem statement* describes that merge as online-only and says it ignores machines declaring zero jobs. Its *Proposed design* introduces registered-peer availability and retained **catalog** observations. Neither establishes a current schedule-observation row for a never-seen offline peer. Specify which machine inventory supplies the offline entry and render unknown at machine level when no job row exists. Test a registered, unreachable peer with no cached rows alongside a reachable peer reporting a verified empty catalog. The inline material does not establish which pool behavior is deployed.


### Round 2

**Verdict: SERIOUS ISSUES**

- **DESIGN — Observation / Jobs read and display.** An unchanged counter proves that no callback entered **by the post-grace sample**. B1 checks generation again during serialization, but a late callback can increment the counter without changing generation. The row could therefore keep saying “no callback observed” after entry. Define the claim as “No callback observed by [time] for the [due time] opportunity,” or recheck the counter and downgrade to unknown when it advances. Add a test that releases a delayed callback after publication and reads the row again.

- **DESIGN — Observation / Jobs read and display.** B1 retains both the upcoming and most recent witnessed opportunity, but specifies one row state and one due instant. On a recurring schedule, the next opportunity can be upcoming while the previous one has a proven callback gap. Both states fit the spec, and choosing “upcoming” hides the condition B1 exists to show. Define which opportunity controls the row, when a newer observation supersedes it, and which due instant accompanies each verdict. Test the ordinary Jobs screen across two consecutive occurrences.

- **DESIGN — Jobs read and display / Multi-machine posture.** B1 requires the pool to distinguish a verified empty catalog from unknown and points to inventory and health for peers with no Jobs row. The supplied *Lease job coverage* spec says the existing pool merge ignores zero-job machines and explicitly requires successful catalog loading to prove emptiness. Reachability and zero returned rows do not supply that proof. Use an authorized, complete catalog observation for the same machine and visible scope when available. Otherwise show “catalog unknown.” Test a reachable scheduler-less standby alongside a verified empty peer.

- **PRECISION — Maturation plan.** “Repeat for genuine progress” leaves the expected result unclear. *Observation* says a counter advance alone cannot identify the occurrence, and B1 enrolls no new exact-history provider. Specify that an ordinary callback with only counter evidence yields “due with unknown handling,” with any recorded outcome displayed separately. Reserve “exactly observed handling” for a fixture that supplies the required occurrence identity.


### Round 3

**Verdict: SERIOUS ISSUES**

1. **DESIGN — Observation; Maturation plan.** A registration counter can advance for occurrence A while occurrence B receives no callback. If B’s witness was armed before A entered, B correctly reports unknown under the specified rule. Neither required fixture exercises this ambiguity because each tests one occurrence in isolation. Add a recurring fixture that delays A’s entry into B’s observation window, suppresses B, and checks the ordinary Jobs row. Document which schedule and grace combinations can yield an occurrence-specific verdict.

2. **DESIGN — Observation; Jobs read and display.** The spec requires an otherwise reachable server to detect a stopped watcher. It also spreads job evaluation across ticks. A fresh watcher heartbeat therefore says nothing about when a particular row was last examined. The specified serialization checks cover counter, generation and scope, but give no expiry rule for a row the cursor has yet to revisit. Define separate freshness deadlines for the watcher and the row, enforce both on read, and retain the original sample time. Test a healthy watcher advancing through a backlog while one row ages past its deadline.

3. **DESIGN — Jobs read and display; Multi-machine posture.** B1 requires coverage to stay machine-local. The lease-coverage context says the pool merges peer catalogs and can encounter the same slug on multiple machines. B1 leaves the row mapping unspecified when both machines contribute that slug. If one machine witnessed silence and the other counted an entry, a single scalar verdict on a merged row would lose evidence or misattribute it. Specify per-machine coverage within a merged row, or preserve distinct machine rows. Test both readings together and then age one peer’s cache independently.

These findings concern the supplied contracts. The inline material contains no runtime measurements or pool merge implementation, so it does not establish that a deployed system exhibits any of these failures.


### Round 4

**Verdict: SERIOUS ISSUES**

1. **DESIGN — Jobs read and display, pool identity.** B1 attributes each verdict to the machine serving an “authenticated” Jobs response. The lease spec’s *Catalog observations and peer transport* explicitly distinguishes shared-bearer admission from machine identity. Its signed snapshot covers catalog metadata, with no binding to B1’s volatile callback evidence. The supplied material establishes no equivalent identity guarantee for ordinary pool Jobs responses. Require a verified machine-bound transport or response that covers the `scheduleCoverage` payload itself. Where that proof is unavailable, preserve the existing Jobs row and show unknown peer coverage. Test a validly admitted response from the wrong registered machine.

2. **DESIGN — Observation and Jobs read and display, missed opportunities.** B1 says a missed arming sample leaves that opportunity unknown. It also says the preceding verdict stays primary until a newer *witnessed* opportunity reaches post-grace or the old evidence becomes unavailable. Suppose Monday has a verified absence, Tuesday’s arming sample is missed, and a timely post-grace Tuesday sample finds the same counter. The row can be fresh, yet the two rules leave implementers with different answers about which day to display. Specify that once Tuesday’s due instant and elapsed grace are known, its unknown handling takes precedence. Monday’s dated observation can remain visible as history. Test this sequence with the watcher and row both inside their freshness deadlines.

3. **PRECISION — Observation, meaning of a counter advance.** The delayed-A/suppressed-B fixture correctly establishes that an entry somewhere in B’s witness window cannot identify B. That reasoning does not need a queue, durable ledger, or model judgment. A small table pairing the three evidence cases—stable counter through grace, counter advance alone, exact occurrence witness—with their displayed verdicts would make the central rule easier to implement and review.


### Round 5

**Verdict: SERIOUS ISSUES**

1. **DESIGN — Jobs read and display / pool freshness.** B1 permits a machine signature and ages the remaining freshness from receipt. A signature proves who produced a payload. It cannot establish when the peer produced it. A previously valid response from the *correct* peer could therefore regain its original freshness allowance on replay. The lease spec’s *Catalog observations and peer transport* binds each signed response to a fresh request nonce, and that signature covers catalog metadata only. Require equivalent request binding for signed `scheduleCoverage`, or return unknown. Test a genuine same-peer response presented again after its original freshness expires.

2. **DESIGN — Observation / Maturation plan.** B1 explicitly says a counter advance leaves handling unknown for the specific occurrence and reserves exact handling for a native-occurrence fixture. The consequence is that a healthy recurring job can report unknown indefinitely, even when the observer sees callback entries every interval. The release criteria exercise this behavior without requiring anyone to assess what the ordinary healthy row communicates. Keep the occurrence verdict, but show the registration-level fact alongside it, for example “A scheduled callback entered between these samples.” Test that the ordinary Jobs row conveys this in both the healthy case and the delayed-A/suppressed-B case without crediting B.

3. **DESIGN — Jobs read and display / cached pool rows.** Local serialization must recheck the live counter and immediately withdraw a missing-callback label after a late entry. A pool cache hit can check age, but cannot see a counter increment on the remote machine. Both reads can meet their deadlines and still disagree. Define remote coverage explicitly as the source’s verdict **as of source serialization** and preserve that timestamp separately from the original evidence sample. Test a late entry after a pool response is cached but before it expires. The local row should clear immediately, and the cached row should identify when the peer last verified its verdict.

These are specification findings. The supplied material contains no runtime measurements or implementation source.


### Round 6

**Verdict: SERIOUS ISSUES**

1. **DESIGN — Observation / Jobs read and display.** The watcher clears its witness after suspension or a relevant clock correction. The read path checks generation, scope, counter and monotonic age. The spec leaves open what happens on the first Jobs read after resume, before the watcher detects the gap. If the age clock excludes suspended time, every listed check can still pass and the row can present an invalidated absence verdict. Require the read path to verify continuity through serialization or return unknown. Test a read before the first post-resume tick with the registration and counter unchanged.

2. **DESIGN — Jobs read and display, pool proof.** B1 explicitly binds the proof to the machine, scope, request and coverage bytes, but does not explicitly bind those bytes to the outer job slug. The lease spec signs catalog entries that include their slugs. B1’s different-machine test would miss two valid coverage records transposed between jobs on the **same** machine in one response. Authenticate the slug and coverage together, either per row or by authenticating the complete Jobs response, and verify that association through the pool merge. Test two same-machine jobs with opposite verdicts.

3. **DESIGN — Observation / Maturation plan.** B1 explicitly says an ordinary callback increment leaves exact handling unknown. Its canary requires observable silence and counter advance, but sets no criterion for how often an operator can see either fact on real schedules. The release gate could pass with both fixture classes working and most production rows unknown. Before canary, name the intended schedule cohorts and set a minimum observable fraction for each. Measure registration-level activity and qualified silence separately from exact occurrence handling. This tests whether the feature answers its opening question without weakening its evidence rules.

## Convergence verdict

Converged at the six-round cap for the read-only local-first design. The remaining external findings are detection precision, read-only peer rollout and success-ceiling evidence. None authorizes an unproven result or any scheduler effect. Before enabling a scope, prove its stated late-callback, freshness, and authority controls.
