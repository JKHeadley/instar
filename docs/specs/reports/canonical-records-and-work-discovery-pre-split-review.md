# Convergence Report — Find existing work and give each record one authority

## Cross-model review: codex-cli:gpt-6.2-astra

The Codex model completed reviews of the six exact revisions. Its first attempt on round 2 timed out and the identical-revision retry succeeded. The installed Gemini CLI lacked authentication. The clean Anthropic wrapper returned unavailable. The internal review covered security, adversarial behavior, deployment, performance, decision completeness, and lessons with separate lens assignments across three reviewers. The final internal lenses cleared their earlier findings or recorded a remaining origin admission implementation condition.

## ELI10 Overview

Instar should be able to find work it already designed, even if the conversation that started it is incomplete. The proposal connects relevant conversations, decisions and artifacts, and tells the agent which sources it searched before the agent starts new work. It also names one service that can edit each enrolled record.

Review found ways those protections could still fail when requests arrive together or a retired process resumes after a timeout. The reviewed draft is available for reading. It has not cleared the safety review.

## Original vs Reviewed

The draft now checks where an answer will appear as well as who asked, protects private evidence during recovery, uses the same identity across routes, and requires a verified authority cutover. It distinguishes complete, partial and unavailable sources. The last round found that a large hidden backlog could still affect visible admission, and that an old worker could resume when an external action cannot be safely retried.

## Iteration Summary

| Round | Body hash | Change or disposition |
| --- | --- | --- |
| 1 | `1bbff9a761c9f2449c1fe4c038e50331d861e34b8ac8067f9c149d6058344e87` | Separate source and destination authorization, define durable origin identity and close the late-write migration window. |
| 2 | `30ab02b915591d762f712e6d03866654777265e7bcc43675ef6ed2501940dbf4` | Bind source occurrences before fan-out, retain uncertain dispatch outcomes, separate artifact attestation from effort links, and choose receipt expiry. |
| 3 | `d7b0dd04f71bd3d4751cc7985a0657566f6514a9d2f4431d8c6e5bfccbd07e99` | Define versioned origin-to-effort mappings, direct owner-journal reads, and authorization-aware limits. |
| 4 | `36ee9265e649a44625ceb09fcf772b6322a510705b16536dbb810eda70035ce9` | Bind receipts to the applied revision and the owner-derived profile. Use the originating service’s custody evidence. |
| 5 | `64e40bffc2719dc0ff5743066dc7491b6d199eaa02b013ae6a317f860bb5727a` | Consult the full current authorized roster on incomplete provider coverage, use one offline path, and make grouping CAS explicit. |
| 6 | `b417fd24dd09d6f580f231c31dabe85ef11d19c41485c1f7b418be78c3da9014` | Reached the cap with authority and dispatch safety findings. Convergence failed. |

- Round 1 Standards-Conformance Gate: ran (5 flags).
- Round 2 Standards-Conformance Gate: unavailable: error.
- Round 3 Standards-Conformance Gate: ran (3 flags).
- Round 4 Standards-Conformance Gate: ran (4 flags).
- Round 5 Standards-Conformance Gate: ran (3 flags).
- Round 6 Standards-Conformance Gate: ran (2 flags).

## Proportion

Tier 2, six of six rounds. This design covers multiple resource owners, authentication and privacy, dataset recovery, and external actions. Reaching the cap reflects continued material findings rather than a quiet final review.

## Experience fit

The acceptance corpus includes the actual permanent-links question through normal owner delivery, the earlier duplicate mesh recommendation, the lost security-finding definitions, a genuine similar effort, and partial-coverage wording. The lookup is designed to surface already-approved and implemented work while preserving the distinction from deployment. Six review rounds do not verify those runtime journeys.

## Left behind

- **Security.** The admission read must be indexed and revised by authorized audience. An unfiltered hidden backlog must not change a visible result, reservation decision, or timing class.
- **External action safety.** A non-idempotent downstream needs a fenced dispatch-started marker before the call. A successor reconciles that marker and requires positive no-dispatch proof before retry. Test a paused predecessor resuming after takeover.
- **Deployment proof.** Compare bounded discovery on the complete labeled cohort with the classifier-routed path, including skipped turns, and measure lost known evidence, unnecessary lookups, and latency.
- **Integration.** Persist source-issued occurrence assignments with a source-owner CAS on native revision and current occurrence-set revision. A losing request rereads the winner before fan-out.
- **Judgment.** Recontest the minimum repository evidence rule for a verified distinct authorized request during a provider outage. Document related multiple efforts while keeping single-count grouping.

## Full Findings Catalog

### Round 1 external findings

**Verdict: SERIOUS ISSUES**

- **DESIGN — § One discovery query; § Check before creating or declaring absence.** Discovery authorizes the caller and returns excerpts to the agent. The hierarchy spec (§6.2) separately authorizes the reply destination *before* private evidence enters a chat session. An owner asking in a shared topic satisfies the caller check. Require the adapter’s destination-bound capability on discovery reads and pagination. Test that a private canary title never enters the shared session’s model input, even when the owner asks.
- **DESIGN — § Capture and link work.** The draft introduces a stable work ID and directs source providers to emit events. The hierarchy already defines `EffortRef`; its §3.2 reserves effort creation and cross-link edits to the owner and gives authenticated dispatch a narrow delegation operation. The draft leaves implementers to decide whether a card creation also creates an effort and who can certify that link. Specify the mapping to `EffortRef`, the actor authorized for each new link operation, and when a captured artifact remains an unlinked hit.
- **DESIGN — § Check before creating or declaring absence; § Acceptance evidence.** The acceptance case promises one mutation for two starts from the same origin. The transaction coalesces only equal originating-request IDs, and the draft never identifies who assigns that ID before Codex, Claude, or remote dispatch can receive the request independently. Assign the key at common intake, include an occurrence identifier for separate actions in one message, and propagate it across handoffs. Test independent deliveries of one source occurrence and two distinct actions from the same message.
- **DESIGN — § Migration and reconciliation.** The draft requires equivalence validation before moving reads and fences writers at cutover. It leaves the ordering of final validation and fencing unspecified. A legacy write between those steps could be acknowledged and omitted from the target. Require a final source watermark under the fence, drain and verify through that watermark, then switch routing. Inject a legacy write immediately after preliminary validation and verify that every acknowledged revision survives. Spec B was not supplied, so this finding concerns the common cutover contract.

### Round 2 external findings

**Verdict: SERIOUS ISSUES**

- **DESIGN — § Check before creating or declaring absence.** The spec gives distinct actions in one message separate “accepted occurrence slots.” It does not say who allocates those slots or how two adapters recover the same slot when they encounter the actions in different orders. The hierarchy’s *Core concepts and data* section gives typed decisions source-issued occurrence IDs and maps edits explicitly. Apply that rule to work starts. Persist the occurrence before fan-out. Test one message requesting two cards in the same project, replayed through another adapter in reverse order. The expected result is exactly two cards, each linked to its original request.

- **DESIGN — § Check before creating or declaring absence, remote dispatch.** The sender records a durable intent, and the receiver checks for duplicates before execution. That leaves the receiver’s recovery behavior unspecified if it crashes between admission, execution, and recording the outcome. The hierarchy’s *Answer gateway custody and failure domain* section explicitly holds ambiguous sends for reconciliation. Require each enrolled receiver to commit the effect and its result atomically, pass the same idempotency key to a downstream service that honors it, or retain an unresolved outcome pending reconciliation. Test crashes immediately before and after the effect.

- **DESIGN — § Capture and link work.** The spec places verified artifact links under graph custody and allows a source adapter to attest its own artifact. Hierarchy §§3.2–3.3 define a finite operation set, restrict graph nodes to efforts and conversations, and reserve cross-link writes for the owner. No listed operation records an adapter’s artifact attestation. Declare a separate versioned attestation record carried by the journal, with the source adapter owning the artifact-to-origin assertion and the graph owner authorizing the origin-to-effort link. Test independent revocation and rebuild of both relationships.

- **DESIGN — §§ Frontloaded decisions and Check before creating or declaring absence.** Initiation requires a “recent” receipt. The binding includes source heads and an access epoch, but the spec supplies no expiry rule for a receipt whose heads stay unchanged or whose provider timed out. Define a maximum age per intent profile, enforce it at mutation time, and test a degraded receipt presented after its provider recovers.

### Round 3 external findings

**Verdict: SERIOUS ISSUES**

- **DESIGN — § Capture and link work.** The draft requires an origin-to-`EffortRef` cross-link through the existing graph operation. Hierarchy §§3.3 and 7.5 allow only effort and conversation nodes. An artifact can start work before either exists, and its origin/effect ID is a source reference, which the hierarchy distinguishes from a graph endpoint. The existing operation cannot encode that link. Define a versioned, owner-authorized mapping from a source origin to an existing `EffortRef`. Test an artifact created without a conversation, subsequent owner linking, and independent revocation of each relation.

- **DESIGN — § Check before creating or declaring absence.** The draft requires the mutation owner to recheck a changed start-journal revision and reconsider newly visible candidates. § Capture and link work explicitly allows a committed start to be missing from discovery while its outbox is pending. The revision detects an intervening start, but repeating the search can still miss it. Require the owner to read starts and reservations directly from its journal since the observed revision, apply destination authorization, and validate the disposition against that revision at commit. Test two *different* occurrences with overlapping purposes while capture is paused. The existing same-occurrence test exercises idempotency and would pass despite this gap.

- **DESIGN — § One discovery query.** The draft requires authorization before ranking and directs implementers to reuse conversation search. Hierarchy §7.4 says `TopicMemory.search` returns message text without a viewer argument. If the reused provider limits results before checking access, private hits can crowd an authorized hit off the page even when no private text is returned. Require the conversation adapter to apply principal and destination visibility before candidate limits, or to continue scanning until it fills the authorized page or reports truncation. Test a single authorized literal match ranked below a full page of private matches.

### Round 4 external findings

**Verdict: SERIOUS ISSUES**

1. **DESIGN — A fresh receipt can cover a stale index.** *Capture and link work* permits a committed start to remain absent from discovery while its outbox is pending. *Check before creating or declaring absence* requires a journal scan on a revision mismatch, but leaves the receipt’s starting revision undefined. If discovery has applied starts through revision 40 and the receipt records the owner’s current head of 41, admission can see the same head and miss start 41. Bind the receipt to the highest contiguous **applied** start revision for its contention domain. Under the owner’s serializer, inspect every subsequent start and reservation through acceptance. Test with capture paused **before lookup**, after the first start has committed.

2. **DESIGN — Receipt issuance can change which safeguards apply.** *One discovery query* assigns required provider roles by intent profile. *Check before creating or declaring absence* binds the receipt to the requested source set, but leaves unspecified who selects the profile and how the mutation owner verifies it. A valid receipt for general card creation could omit Git/PR coverage required for a software delegation that starts with a card. Have the owner derive mandatory roles from the verified operation and entry point, bind the profile version into the receipt, and distinguish a required provider that timed out from one the caller omitted. Test the same delegation through the normal and direct API routes.

3. **DESIGN — The durability label contradicts the reused custody contract.** *Capture and link work* prescribes “saved locally, awaiting independent durability.” The hierarchy’s *Visible label contract* reserves `Saving` for this interval and `Saved` for independently durable intake. Loss of the sole local copy would therefore lose an item discovery had described as saved. Render the originating service’s custody state directly. Test the acknowledgment immediately before and after independent persistence.

4. **PRECISION — The reported counts do not establish conflicting facts.** The introduction gives 15 and 22 project rows and four matching conversation keys. *Authority contracts* expressly allows views with different inclusion rules, and *Frontloaded decisions* allows multiple conversations per project. Describe these counts as the reason for reconciliation. To establish an actual authority conflict, show one scoped project identity, the disputed field, and the two writers or incompatible revisions.

### Round 5 external findings

**Verdict: SERIOUS ISSUES**

- **DESIGN — Check before creating or declaring absence.** The receipt binds the discovery projection’s highest contiguous start revision. The owner then checks journal entries *after* that revision. A start can already be indexed at the bound revision yet absent from the receipt because its provider timed out or its page was truncated. The journal delta can therefore be empty even though discovery missed a relevant active start. Track which active starts the receipt actually checked, or query the owner’s active starts and reservations directly whenever search coverage is incomplete. Add a fixture where the first start is fully indexed before the second lookup, its provider times out, and the second request has a distinct occurrence for the same proposed work. The first start should reach the disposition decision.

- **DESIGN — Check before creating or declaring absence.** Provider timeout permits a degraded receipt, while central discovery outage normally defers new work. The spec leaves admission undefined when the coordinator responds but *every required provider* times out. An identical request could create work or wait depending on which component reports the outage. Define the minimum usable observation per intent profile and apply the same offline policy whenever coverage falls below it. Test coordinator failure alongside total required-provider failure with identical owner evidence.

- **DESIGN — Capture and link work / One discovery query.** An `OriginEffortLink` has a revision and tombstone, but the spec leaves open whether one origin may have two active effort links. That matters because discovery groups hits by work ID. The hierarchy’s multiple-membership rule covers conversations and does not decide grouping for an artifact-origin mapping. Specify the cardinality. If one effort determines grouping, require reassignment to name the previous link revision and make the replacement atomic. If several links are legitimate, define how discovery displays and counts the artifact. Test two competing assignments and replay them in reverse order.

### Round 6 external findings

**Verdict: SERIOUS ISSUES**

1. **DESIGN — § Check before creating or declaring absence.** Admission uses a tenant-wide contention domain for a given mutation family and destination, reads every unapplied start since the receipt watermark, and takes the offline path if that read exceeds budget. The same section requires hidden-only changes to preserve the caller’s admission disposition. Those rules conflict when a backlog of hidden starts alone exhausts the read budget. Give the owner an authorization-filtered index over starts **and reservations**, with a scoped revision it can validate atomically at acceptance. Test the same authorized request twice, adding enough hidden reservations on the second run to exceed the unfiltered scan budget. Both runs should admit the request.

2. **DESIGN — § Check before creating or declaring absence; § Acceptance evidence.** The spec requires a receiver to claim an effect before execution and permits a successor to take over after lease expiry. For a downstream service without idempotent acceptance, it specifies how to handle an unknown outcome but leaves open when takeover may safely execute. A paused worker can resume after its lease expires. The supplied hierarchy spec (§3, “Answer gateway custody and failure domain”) gives a concrete precedent. Persist `dispatch-started` under the current fence before the external call. A successor seeing that state must reconcile, and may retry only with positive proof that the earlier attempt cannot dispatch. Test pause and resume across takeover, alongside the existing crash tests.

3. **DESIGN — § Maturation plan.** The graduation cohort compares semantic judgment against a scoped-uncertainty baseline. That measures answer behavior but cannot establish whether the pre-answer classifier improves retrieval. A false negative can skip discovery and still produce an acceptable uncertain answer. Add a read-only shadow comparison that runs the same bounded lookup on every annotated turn, including turns the classifier skips. Measure missed known work, unnecessary lookups, and delivery latency for both paths before choosing which to enforce.

### Internal review synthesis

- Authorization binds caller, destination, current source policy and erasure to reads, results, derived fields and pagination.
- Intake, remote delivery, receipts, canonical start checks and write cutover need independent, durable effect and authority fences.
- Provider capacity isolation, authorized continuation snapshots, replay custody, and closed-origin compaction prevent a slow source from hiding progress.
- Decision-completeness counted five frontloaded decisions, zero proposed or accepted cheap-change tags, and no unresolved author-designated questions. Source corpus, event ownership and maturation were contested.
- The lessons-aware review checked ordinary replies and recommendations as well as creation. It required normal channel and queued/forwarded replays with no second assignment. The current hierarchy source owns custody labels.

## Convergence verdict

Convergence failed at the Tier 2 review cap. The exact round-six body remains a draft. Security and external effect safety findings must clear review before approval or implementation of the affected gates.
