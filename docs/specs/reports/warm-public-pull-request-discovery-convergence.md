# Convergence Report — Keep the Public Pull Request Inventory Warm

## Cross-model review: codex-cli:gpt-6.2-astra

The installed Codex reviewer examined six exact bodies. Framework detection found no authenticated Gemini. Independent reviewers Discovery and Quick Review verified public visibility, route and browser budgets, publication fencing, operator experience and shared provider spend. Stores tested a separately isolated implementation prototype against production AgentServer routes.

## ELI10 Overview

Instar can load the public pull request list when it starts, then keep a copy ready. If the first search reaches Work during startup, it gets the full time allowed for one scan. The same list also serves an existing Chief of Staff lookup. If permission or data cannot be verified, Work reports the gap.

## Original vs Converged

The original proposal used an unspecified quick refresh. Review established one explicitly enrolled home, a bounded provider flight, independent request cancellation, durable usage and throttle accounting, and aging that reflects when the GitHub snapshot was checked. No user question leaves the machine.

## Iteration Summary

- Round 1, body `0d627a0437dfb3d2b6aa4ba37e20b7102caa7fac5bad99c8dd349b232299a75a`. Standards-Conformance Gate: ran (2 flags). External 3 DESIGN and 1 PRECISION. Set internal deadlines, shared cancellation, current authorization and an honest upstream traffic contract.

- Round 2, body `ebfc185ae6ef686559e7ddd8bdbd39410137c7a0e8065afa5d193e8da78b7d47`. Standards-Conformance Gate: ran (6 flags). External 3 DESIGN and 1 PRECISION. Defined per-home cohort admission and ownership, startup/stop fencing, throttling and exact cadence.

- Round 3, body `6ee51c90e5b20ab02b1f5356a87c83784d892a42bffab21910dfc3c9a5887427`. Standards-Conformance Gate: ran (4 flags). External 3 DESIGN and 1 PRECISION. Persisted rolling reservations, separated per-scope recovery from response readiness and specified unknown during turnover.

- Round 4, body `ed1031ff9da0d95d19edfb6c54c4c48cee139860393e0141c16f0dd78c676089`. Standards-Conformance Gate: ran (6 flags). External 2 DESIGN and 1 PRECISION. Made budget provisioning explicit and set pause cancellation, replacement and retained-data rules.

- Round 5, body `43693b6489758bc96b15eed89b4140ce8494324c83b92c8ebd04da28e5400def`. Standards-Conformance Gate: ran (6 flags). External 2 DESIGN and 1 PRECISION. Separated ordinary complete-retained reads from early repair and carried retry floors through pause and restart.

- Round 6, body `895496a208441ed23e8c1c523a912813eb0d020aafcca108dd4dc9a8db4b481d`. Standards-Conformance Gate: ran (5 flags). External 2 DESIGN and 1 PRECISION. Independent enrollment marker and no-demand repair. Cap closure sets two additional binding quota tests.


## Proportion

Tier 2, six rounds. Review focused on concrete visibility, timeout, resource custody and live-path obligations.

## Experience fit

A request that waits for the shared first scan retains the ordinary pending state and can be dismissed without cancelling other readers. The warm result returns promptly. Coverage uses the snapshot's actual age and an unavailable provider never looks like a completed search.

## Left behind

- Outstanding page custody. Before any enabling, durably mark each page reservation as outstanding. Settle the marker and any observed retry floor atomically. A restart with an unsettled marker cannot establish the prior upstream floor and holds paginated access until the authorized recovery procedure proves clearance. A clean process-observed cancellation remains charged and uses the conservative retry floor. Inject loss after a received header and before settlement.
- Pause does not move a spending limit. Every paginated call on the once-enrolled home, including baseline mode during pause, charges the same durable budget and checks the current floor. Test the eighth attempt through pause, restart and re-enable. A never-enrolled home remains on its preexisting path.
- The fixed upstream request is state-specific and uses a validated cursor only after the first page. The actual first-use proof must use the normal Work deadline and report observed retry, page count, bytes and elapsed time.
- Review and operator-controlled enrollment precede real use. The exact first-use result, multiple scan measurements and normal Chief of Staff answer and assignment are release evidence. No fleet default change is implied.

## Full Findings Catalog


### Round 1

**Verdict: SERIOUS ISSUES**

- **DESIGN — Frontloaded Decisions 2 and 5; Multi-machine posture.** The parent PR spec reports 27 pages and 4.37 MB for one scan, with a two-minute freshness window. Repeating that scan once every two minutes would mean 810 page requests and about 131 MB per hour per eligible process, even with no searches. That is an extrapolation from one probe. The proposed limits bound each scan but leave the sustainable hourly cost unspecified. Measure bytes and GitHub quota consumption over repeated refreshes at the expected process count. Set an operating budget and specify degraded coverage when staying fresh would exceed it.

- **DESIGN — Proposed design, request deadlines.** The parent Work spec places both an aggregate deadline and per-provider budgets beneath the caller’s deadline. This draft extends the route budget, but a shorter inner deadline could still discard a healthy PR result. Specify the deadline ordering from browser through HTTP, Work aggregation, and the PR provider, including time for admission and response serialization. Apply the longer wait only when the request needs a cold PR inventory. Test a healthy scan near the inherited 20-second provider limit through the normal browser path. A scan just over five seconds proves only that the old cutoff moved.

- **DESIGN — Proposed design, cancellation.** Startup, the timer, and concurrent requests share one refresh. The draft also requires response cancellation without identifying who owns cancellation of the shared network operation. Give the provider ownership of the refresh and let a disconnected caller cancel its own wait. Test two cold callers joining the startup scan, then disconnect one. The other should receive the result from that same scan, and the next warm read should reuse it.

- **PRECISION — Frontloaded Decision 5.** The claim that no eligibility signal leaves the machine is broader than the design supports. Startup traffic occurs only on eligible installations, so request timing can reveal that warming is active. State the testable guarantee directly. Outbound requests use the fixed repository and carry no caller text, private search terms, or explicit cohort field.

- Conformance — Judgment Within Floors. One successful cold scan and warm-cache reuse do not establish the exact refresh cadence, response allowance, or request, byte, history and page cutoffs for a larger inventory that could safely yield a match on the next page; the design gives no reason to exclude adaptive scheduling and continuation within verified rate, resource and cancellation floors.
- Conformance — Maturation Path — Test Agent → Development Agent → Fleet. The rollout stops at development pending operator review, with no machine-checkable graduation threshold or recurring decision path to a reviewed fleet default.

Disposition. Set internal deadlines, shared cancellation, current authorization and an honest upstream traffic contract.

### Round 2

**Verdict: SERIOUS ISSUES**

- **DESIGN — Proposed design, warm reads.** The spec says a usable snapshot returns promptly and Work waits only when the provider is empty. The approved *Inventory and coverage* contract allows one scope to succeed while the other remains unavailable. On an unenrolled installation, a successful open scan could therefore satisfy the warm-path condition while merged coverage gets no retry until open evidence expires. Define refresh eligibility per scope and response readiness separately. Test a merged-only lookup and a Work lookup after open succeeds, merged fails, and the retry cooldown elapses.

- **DESIGN — Proposed design, startup and rolling-hour budget.** The cap is explicitly per process, while enrollment is per installation. The restart rule preserves an upstream throttle floor “where available” but specifies no recovery for locally charged attempts or pages. Eight healthy startup scans under eight successive processes would consume 216 pages at the reported canary size, and a ninth process could start immediately. This is a consequence of the specified accounting, not an observed restart incident. Define the bound intended for the enrolled installation across restarts. A small local usage ledger would preserve it without persisting inventory. Test restart immediately after exhausting the allowance.

- **DESIGN — Proposed design, scheduling.** “No faster than eight minutes” sets a minimum interval. “Jittered zero to 30 seconds from expiry-ready scheduling” leaves the timer’s anchor undefined. If expiry itself triggers the timer, even a healthy replacement finishes after the ten-minute retention window. Specify a due time relative to the observation supplying coverage, reserving the 30-second jitter and 20-second scan envelope. Use a deterministic clock to verify uninterrupted usable coverage at maximum jitter when budget and upstream guidance permit.

- **PRECISION — Proposed design, enrollment terminology.** “No startup activity outside the cohort” uses *cohort* where Frontloaded Decision 2 distinguishes eligible development installations from the single installation enrolled for recurring work. Name the two predicates and state which admits startup, timer, and on-demand scans.

- Conformance — Judgment Within Floors. The 27-page, 4.37 MB scan estimates typical cost but establishes no shared quota or resource boundary requiring eight minutes between autonomous attempts, up to 30 seconds of jitter, or rolling per-process ceilings of eight attempts and 300 pages per hour; a ninth cheap, authorized cold scan could fit the credential’s remaining quota, so refresh admission should use judgment within proven upstream and host limits.
- Conformance — Judgment Within Floors. The 21-second lookup and 22-second outer timeout leave room for the provider’s 20-second deadline, but the 18–19-second fixture does not establish why a healthy 21-second scan must be cancelled or why the inherited request, response, byte, history and page cuts are necessary at their exact values; a larger authorized scan could finish within actual transport and resource limits.
- Conformance — Judgment Within Floors. Two minutes can serve as an advisory freshness label, but the ten-minute cutoff suppresses even a timestamped positive observation during an eleven-minute outage, and the spec gives no reason that judgment about its usefulness cannot operate within the existing authorization and visibility fences.
- Conformance — Maturation Path — Test Agent → Development Agent → Fleet. A single explicitly selected development installation per credential makes enrollment depend on installation identity, while deferring wider criteria leaves no role-based, evidence-gated path to fleet activation even when a second development agent could warm safely within a verified shared budget.
- Conformance — No Unbounded Loops — Every Repeating Behavior Carries Its Own Brakes. The hourly allowances and upstream backoff slow retries, but exhausting an allowance merely waits for it to refill, so a persistent transport failure can trigger scans indefinitely without a breaker that halts attempts and surfaces the degradation once.
- Conformance — No Deferrals. The instruction to record wider rollout criteria separately postpones a shipping obligation without a same-PR tracked commitment that will bring it back for review.

Disposition. Defined per-home cohort admission and ownership, startup/stop fencing, throttling and exact cadence.

### Round 3

**Verdict: SERIOUS ISSUES**

- **DESIGN — Proposed design, single-flight and request deadlines.** The 21-second lookup deadline starts at route entry. The spec also requires a superseded flight to settle before its replacement starts. If a request enters just after credential rotation, two seconds of cancellation cleanup followed by a healthy 20-second replacement already exceeds the deadline. The 18–19-second fixture tests an ordinary cold start. Specify what the caller receives during generation turnover and add a delayed-cancellation fixture that verifies the response deadline, single-flight limit, and subsequent recovery.

- **DESIGN — Proposed design, rolling budget.** The spec requires an atomic budget record, restoration before new work, and a distinction between first enrollment and loss of that record. A missing record alone cannot establish which event occurred. Define what independently witnesses completed enrollment and the order of writes. Test process death between initialization steps and deletion of the record after quota has been consumed. Neither case should silently issue a second allowance.

- **DESIGN — Proposed design, hot-off during shared reads.** Hot-off preserves a flight owned by a baseline consumer, while the disabled cohort also fences pending publication. The supporting spec says concurrent reads share a refresh and completed streams populate the inventory. A legacy caller that joins a startup flight therefore has no specified result when enrollment switches off mid-scan. Define when that caller acquires ownership, whether validated rows may publish for its read, and how remaining pages are charged. Test that transition with the caller still connected.

- **PRECISION — Proposed design, traffic estimate.** The supporting probe measured 27 pages and 4.37 MB for one scan. Eight such scans yield 216 requests and 34.96 MB by extrapolation. The draft’s “216 measured page requests” blurs that distinction. Label the hourly figures as projections and report actual totals separately in the release artifact.

- Conformance — Judgment Within Floors. A scan using 27 pages and 4.37 MB establishes a workload baseline, but it does not justify refusing a ninth attempt, a 301st page, or a healthy scan needing 21 seconds when upstream quota and caller time remain; a bounded scheduler could vary refresh timing and work allowances within verified quota, concurrency, and response deadlines.
- Conformance — Judgment Within Floors. The draft gives no evidence for discarding a verified observation at ten minutes even when a caller could use an explicitly dated eleven-minute-old positive result; contextual relevance could be judged while still enforcing access checks, invalidation on denial, and limits on freshness claims.
- Conformance — Maturation Path — Test Agent → Development Agent → Fleet. The rollout selects one named development home per credential and leaves wider criteria for later, so a second equally qualified home cannot participate even after the first stops; a single active warmer per credential could preserve the traffic bound while role-based rungs and measured graduation criteria govern eligibility.
- Conformance — No Deferrals. “Record the reviewed wider rollout criteria separately” defers the graduation criteria without identifying a same-PR tracked commitment that will bring them back for review.

Disposition. Persisted rolling reservations, separated per-scope recovery from response readiness and specified unknown during turnover.

### Round 4

**Verdict: SERIOUS ISSUES**

- **DESIGN — Proposed design, warm reads and retry admission.** The source calls for a two-minute read-through cache. The draft schedules autonomous scans eight to eight-and-a-half minutes apart and permits stale responses during the quiet period. It leaves open whether an HTTP read of a *complete* three-minute-old snapshot also starts a background refresh. That choice determines whether ordinary traffic can spend all eight hourly attempts well before the retained evidence expires. Specify one scheduling rule for demand and timer triggers. Test sustained reads through a full rolling hour and assert both the charged attempts and the longest gap in usable coverage.

- **DESIGN — Proposed design, throttle persistence across hot-off.** The draft permits a baseline refresh after a cancelled enrolled flight settles. It requires honoring throttle signals from superseded flights, but requires restoring the persisted throttle floor only before background or longer cold-path work. Consider a flight that receives `Retry-After`, followed by hot-off, restart, and an ordinary explicit read. The source requires the provider to honor the upstream retry time. Require every refresh entry point on that installation to consult the recorded floor before its first page, including baseline reads while enrollment is off. Exercise that sequence through the real route and assert zero upstream requests before expiry.

- **PRECISION — Problem statement and maturation plan.** The draft reports that the first healthy scan exceeded the five-second Work wait. The supporting source reports about ten seconds for the merged stream, while the maturation plan proposes an eighteen-to-nineteen-second fixture. Those figures serve different purposes. Keep the fixture as a near-deadline test and record elapsed time for the live first Work request separately, so a passing fixture cannot be read as a measurement of production latency.

- Conformance — Judgment Within Floors. One 27-page scan establishes neither eight attempts nor 300 pages as the safe hourly boundary, yet both caps can block a legitimate cold lookup even with ample verified quota; demand-aware admission could prioritize that lookup within upstream limits and an evidenced shared-credential reserve.
- Conformance — Never Silently Cut the Data a Decision Depends On. The draft carries forward byte, history and page limits without deriving their sizes or identifying which evidence they preserve, so a relevant public pull request beyond a cutoff can be omitted without the consumer learning which portion of the inventory was lost.
- Conformance — Judgment Within Floors. The eight-minute cadence, 0–30-second jitter, two- and ten-minute age boundaries, and 20/21/22-second deadline chain are internally coordinated but lack evidence for their exact values; a healthy scan finishing in 23 seconds or an eleven-minute-old positive observation could still answer a request under a measured resource ceiling with explicit age disclosure.
- Conformance — Maturation Path — Test Agent → Development Agent → Fleet. Selecting one nominated development home per credential makes graduation depend on an installation allowlist, while leaving wider rollout criteria for a separate record omits the machine-checkable thresholds and reviewed path to fleet default-on.
- Conformance — No Unbounded Loops — Every Repeating Behavior Carries Its Own Brakes. The rolling budget replenishes and the timer can resume after each backoff, so sustained transport failure can trigger scans indefinitely without a specified breaker that stops attempts and surfaces the degradation once.
- Conformance — Capacity Safety — No Unbounded Self-Action. Four observed scans and a rolling hourly cap measure traffic over a window but cannot prove that the number of autonomous retries settles when the upstream failure persists.

Disposition. Made budget provisioning explicit and set pause cancellation, replacement and retained-data rules.

### Round 5

**Verdict: SERIOUS ISSUES**

- **DESIGN — Proposed design, budget recovery.** The spec says a missing budget record stops the *enrolled* path, while hot-off restores baseline explicit reads. It also requires those reads to honor a persisted upstream throttle. If the record disappears and the flag is then disabled, the spec gives the baseline path no way to distinguish a never-enrolled home from one that lost an unexpired `Retry-After`. Preserve enrollment history independently of the budget record and define recovery for both entry points. Test record deletion during a throttle, followed by hot-off, restart and an explicit read. The maturation plan tests these events separately.

- **DESIGN — Proposed design, repair scheduling.** The spec requires prompt reads of usable partial evidence. It explicitly permits repair of an incomplete scope after cooldown, but describes timer scheduling only for complete snapshots and foreground repair in terms of a *requested* scope. If startup completes the open stream while merged times out, two implementations could disagree on whether merged gets repaired before anyone asks for it. Specify when the provider rearms after a partial or wholly failed autonomous attempt, subject to cooldown, throttle and rolling limits. Test recovery with **no HTTP requests** between the failed startup attempt and the repaired snapshot.

- **PRECISION — Proposed design, usage evidence.** The 216-page and 35 MB figures follow from multiplying the reported 27-page, 4.37 MB scan by eight. Eight is the rolling-hour attempt ceiling. The stated 8–8.5-minute interval implies a sustained healthy rate of about 7.06–7.5 attempts per hour. Label the figures as an eight-attempt projection at the observed scan size, and report sustained usage separately from the canary measurements.

- Conformance — Judgment Within Floors. One 27-page scan estimates cost but does not establish that an earlier refresh, a ninth attempt or a 301st page would exhaust shared quota, so a useful repair can be refused even when verified headroom permits it; refresh timing and repair priority could be judged within an evidenced resource ceiling and the upstream reset floor.
- Conformance — Judgment Within Floors. The 21-second route deadline allows a 20-second scan plus one second of overhead, but the spec gives no caller constraint that requires refusing a healthy replacement after credential turnover at that exact point, even when the caller is still connected and the replacement is already running within its own resource bound.
- Conformance — Judgment Within Floors. The two-minute freshness label is descriptive, but the ten-minute expiry rejects even an explicitly requested, timestamped observation just past that boundary without evidence that age alone makes it unusable for historical lookup; contextual use could preserve the credential and visibility fences.
- Conformance — Maturation Path — Test Agent → Development Agent → Fleet. The rollout selects a nominated development home and leaves wider criteria for separate review, so it supplies neither the required role-based graduation path nor machine-checkable thresholds and a dark window leading to a reviewed fleet-default decision.
- Conformance — A Safeguard Must Leave a Benefit. The one-home-per-credential restriction protects other consumers while usage is uncertain, but four scans trigger only measurement and the spec never defines what observed headroom or impact would end the exclusion of a second eligible home.
- Conformance — Observability — you can't tune what you can't see. The release artifact measures four scans, cost and latency, but the stated user outcome is an answer on the first request and the plan provides no recurring baseline comparison or visual history of first-request success under healthy, throttled and unavailable conditions.

Disposition. Separated ordinary complete-retained reads from early repair and carried retry floors through pause and restart.

### Round 6

**Verdict: SERIOUS ISSUES**

- **DESIGN — Proposed design, quota persistence.** The spec requires a durable page reservation *before* each fetch, but a throttle deadline becomes known only *after* a response arrives. A process can exit after receiving `Retry-After` and before persisting it. On restart, the record can be readable and internally consistent while containing only the page charge. The maturation plan tests restart with an already-persisted floor, which misses this window. Mark each outstanding page in the reservation record, then atomically settle its marker with any observed floor. Define recovery for an unsettled marker and test process loss between header receipt and settlement.

- **DESIGN — Proposed design, hot-off and rolling budgets.** The spec explicitly carries the throttle floor into baseline reads after hot-off, but leaves the attempt and page accounting for those reads ambiguous. Consider a home that spends its eighth attempt, pauses, and receives a cold explicit request with no upstream throttle. “Baseline refresh” permits a scan under one reading, while “eight attempts … per enrolled installation” forbids it under another. Specify whether the cap follows the durable home identity through pause. Applying it to all paginated reads on that home until decommission would preserve the stated installation ceiling. Test the eighth-attempt case through pause, restart, and re-enable.

- **PRECISION — Frontloaded Decisions §5 and Proposed design.** “Provider cursor” could imply that a returned cursor is the only variable request input. The supporting *Inventory and coverage* section specifies separate open and merged queries, each with a first page before any cursor exists. Describe the request as a fixed state-specific query with an optional validated pagination cursor.

- Conformance — Judgment Within Floors. A single 27-page scan supports a cost estimate but does not establish the eight-minute interval, 30-second jitter range, one early repair per cycle, or rolling limits of eight attempts and 300 pages per installation; a second repair after transport recovers could restore missing results while verified shared-credential quota and host capacity still permit it, so the spec needs evidence for those exact limits or contextual scheduling within evidenced resource floors.
- Conformance — Judgment Within Floors. The existing 20-second refresh envelope explains the ordering of the 21- and 22-second caller deadlines, but the draft establishes neither an external deadline nor a resource cost that requires stopping at 20 seconds, so a healthy scan needing one more second is rejected even when the caller remains connected and quota permits completion.
- Conformance — Judgment Within Floors. The two-minute freshness threshold and ten-minute expiry lack a stated consumer requirement that explains either boundary, yet an owner seeking a previously observed pull request could still use an explicitly dated eleven-minute-old result if current access checks pass and the response makes no claim about current completeness.
- Conformance — No Unbounded Loops — Every Repeating Behavior Carries Its Own Brakes. After an incomplete early repair the timer returns to its normal interval, so a persistent non-throttle failure can trigger fresh attempts every hour as reservations expire, with no specified sustained-failure breaker that stops attempts and reports the degradation once.
- Conformance — Maturation Path — Test Agent → Development Agent → Fleet. The activation predicate admits one named development home per credential rather than agents by role, excluding even a supervised test agent with its own unused credential, and leaves wider rollout criteria to a separate record without defining the thresholds and review that lead to fleet default-on.

Disposition. Independent enrollment marker and no-demand repair. Cap closure sets two additional binding quota tests.


### Internal findings

- Security. Prevent stale publication after public denial, credential rotation, disable and stop. Both scoped pages must settle before public publication. Recheck both authorization surfaces immediately before serialization.
- Adversarial. Keep one active flight through cancellation and use a provider-owned network signal. Request departure is not permission to cancel other readers. Reject redirects.
- Integration. Align browser, Work and HTTP lifetimes and make the first fetch observable through the shipped Work form. Preserve exact pagination revision handling.
- Scalability. The live 27-page scan made default short-cadence polling expensive. Use bounded nominated-home operational accounting, backoff, asynchronous coalescing and honest retained age.
- Lessons. Run the four-scan reused public provider canary and advancement thresholds before rollout. A startup success does not establish steady-state availability or automatic prior-work recall.

## Convergence verdict

Converged at the Tier 2 cap for development implementation. The outstanding and paused quota rules are binding gates. Leave the flag and physical rollout off until their focused evidence and actual owner-facing release evidence pass. The provider grants no write or dispatch authority.
