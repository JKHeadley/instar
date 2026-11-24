# Convergence Report — B2, one canonical project record with recoverable custody

## Cross-model review: codex-cli:gpt-6.2-astra

The installed Codex reviewer returned a result on six exact bodies. Gemini lacked authentication and the clean Anthropic wrapper was unavailable. Independent deployment and lessons reviews contested proof of custody, owner and guest views, and actual project return paths. The draft was written separately from the independent external reviewer.

## ELI10 Overview

The project list and Chief of Staff can show the same project from one authoritative record. Each can keep its separate observation or check-in history. Before Instar moves the authority, it has to show that an accepted project change survives immediate loss of the computer that wrote it. The replacement computer also has to check whether the person can still see the information.

## Original vs Reviewed

Rounds added exact checklist mapping, verified goal and lifecycle reconciliation, a single vote per attempt, distinct delivery proof, no closure from an expired lease, and source/target fences for both legacy and new storage. The draft now avoids planning to turn on a write path if the actual carrier has insufficient proof.

## Iteration Summary
- Round 1, body `cd89f8cc0e62b5ddb1d6fd8c06a4d6be24c57cf476062b3a800be93ea4e42548`. Standards-Conformance Gate: ran (2 flags).
- Round 2, body `eb939c80f7ceabf21679ea62b615c818263f7273c1738d9f29a5f51a89c22eb9`. Standards-Conformance Gate: ran (2 flags).
- Round 3, body `65cde28ddd6041146cd0d18f8d9f3da877f754fddbec254aa69fe5b124af3b3c`. Standards-Conformance Gate: ran (3 flags).
- Round 4, body `7f6bc6bd6b4f372820b701e6048332b7b371ca15d1338f145d4943e11331de9e`. Standards-Conformance Gate: ran (4 flags).
- Round 5, body `ad997efb80cf93ba853ff89d167c324939a5d857f700ea666162f414eaee4c7f`. Standards-Conformance Gate: ran (1 flags).
- Round 6, body `a1af69f47d5b1ca7e746796f7c47d8ec579786fe04db723d49ffc24af41e4d3b`. Standards-Conformance Gate: ran (2 flags).

## Proportion

Tier 2, six of six rounds. The unresolved work affects replicated read authorization and the irreversible acceptance of project edits.

## Experience fit

A still-authorized owner needs the exact last accepted project revision after holder loss. An owner or member whose access was withdrawn must not inherit old source records. Project checklist authority and supervision cadence are separate parts of normal work.

## Left behind

- External DESIGN and privacy risk. Define which currently reachable authority can prove continued access without the old holder. A certificate for stored bytes is not a current audience grant. The identical local survivor state must produce different read outcomes only on verified current authorization, or remain generically unavailable.
- External DESIGN and data-integrity risk. The reviewed body gives ordinary edits no explicit irrevocable decision event against abort. Define ordinary-edit seal, authority recheck and recovery for a delayed certificate that races a durable abort vote. Both machines must converge on one accepted result.
- External DESIGN. Reproduce what prior authorized act and closure policy permit automatically closing an old Chief of Staff binding. An item certification alone cannot authorize lifecycle closure. If the migration cannot prove the old policy, show the behavioral change and require current owner authority.

## Full Findings Catalog

### Round 1

**Verdict: SERIOUS ISSUES**

- **DESIGN — Canonical record and entry points.** Chief of Staff §2.6 closes a project automatically when every deterministic check passes. B2 retires the status mirror and explicitly routes project-affecting *taps* to the canonical service. It leaves the automatic close path unspecified. A project could therefore appear finished in the Chief of Staff note while Projects still shows it active. Route `done-verified` through the same service with the evaluated checklist revision, evidence, existing lease and authority checks, and a stable occurrence ID. Test an all-deterministic closure with no tap, including a checklist edit between evaluation and submission. Report completion only after canonical acceptance.

- **DESIGN — Accepted revision and custody, steps 3–4.** Every signature proves its member stored the candidate and signed its choice. Those signatures precede distribution of the assembled certificate, so they cannot prove every member stored that certificate. B2 requires that second fact before returning success but leaves the read-visible commit point unspecified. Define when a certified revision becomes current, what durable receipt proves certificate installation on each member, and which result a retry returns during distribution. Test a crash after one member stores the assembled certificate but before another receives it. Check both members’ reads and the caller’s retry.

- **DESIGN — Cutover and recovery.** A1 §Migration requires each cutover plan to name the actual serializer covering source, target and pointer. B2 repeats that requirement without identifying the serializer or the durable location of the pointer. Its holder-loss test also gives the survivor a revision and certificate without testing how it establishes that canonical authority was ever published. Specify the fence at each physical write boundary and how the survivor verifies the authenticated publication receipt. Isolate the holder immediately before and immediately after pointer publication with identical shadow data. Verify that the survivor distinguishes the two outcomes or explicitly reports authority unavailable.


### Round 2

**Verdict: SERIOUS ISSUES**

1. **DESIGN — Canonical record and entry points; Accepted revision and custody, steps 1–4.** Chief of Staff §4 prohibits new closes after the operator lease expires. B2 requires the owner to revalidate authority at commit, but custody recovery also directs a successor to finish a safely completable candidate. Consider a close staged with a live lease that expires while a member is offline. The spec leaves the implementer to decide whether recovery may publish that close and, if it refuses, how the project can accept another write after a member has durably chosen it. Define when authorization becomes binding and how to retire an expired, partially chosen command. Test lease expiry after the first choice and before certification, then attempt an ordinary project edit.

2. **DESIGN — Accepted revision and custody, step 3; Cutover and recovery.** The signed installation receipts attest to installation of the *choice certificate*. Shared success requires a later event at every member: durable installation of the *assembled accepted proof and mutation result*. If the holder disappears during that final distribution, a survivor with the assembled proof can verify its own accepted head, but those receipts alone cannot tell it whether every peer completed the final write. Specify what durable evidence establishes shared success on retry. Test holder loss after only one member installs the final proof, and distinguish the survivor’s read result from its mutation-retry result.

3. **DESIGN — Cutover and recovery; Multi-machine posture.** Cutover admission is project-kind-wide, while custody membership is project-specific. The publication record binds one target head and one membership. For two projects in the same legacy file with different authorized holder sets, the spec does not identify who certifies the common pointer or how each holder verifies its project’s migration without learning the other project’s protected metadata. Define the authority and payload for the kind-wide pointer and how it commits to separately authorized project heads, or explicitly restrict enrollment to compatible scopes. Test two differently scoped projects sharing `initiatives.json` through publication and holder loss.


### Round 3

**Verdict: SERIOUS ISSUES**

1. **DESIGN — Accepted revision and custody, step 4.** B2 requires every member to persist the complete witness set before the owner acknowledges shared success. Its retry rule returns the accepted result once the full set exists. Those rules give different answers if the holder collects both witnesses, crashes before forwarding the set, then restarts and receives a retry while its peer is offline. If the holder reports success and is subsequently lost, the peer can prove local acceptance but cannot reproduce the promised shared result. Apply the same acknowledgment rule to first responses and retries. Test this crash sequence and require a pending response until distribution is verified.

2. **DESIGN — Canonical record and entry points; custody steps 1–3.** Chief of Staff §§2.2 and 2.6 require deterministic checks to pass at closure and define freshness limits. B2 binds the observed evidence and rechecks the lease and checklist at the seal, but gives no rule for evidence that expires while a member is slow to vote. A status check can age past its freshness ceiling while the lease and checklist remain valid. Bind evidence validity to the candidate and enforce the source’s verification rules at sealing. Test delayed votes with an unchanged checklist, a live lease, and a previously passing check that now fails.

3. **DESIGN — Canonical record and entry points; Maturation plan.** B2 assigns goal and checklist ownership to the project service while allowing a Chief of Staff binding to change supervision. Chief of Staff §§1.3 and 2.2 gather the goal and checklist from the binding to direct ongoing work. B2 specifies the canonical close path but leaves the input to ordinary restart and redirect decisions ambiguous. A Project edit could therefore leave a paired conversation receiving redirects toward its former goal. Specify that paired checks and redirects resolve the canonical goal and checklist revision, while cadence comes from supervision. Test a goal edit through Projects followed by an ordinary Chief of Staff tick, and verify the actual redirect content.


### Round 4

**Verdict: SERIOUS ISSUES**

- **DESIGN — Canonical record and entry points.** B2 routes any judgment item to owner confirmation. Chief of Staff §§1.3 and 2.6 already let the owner mark an individual item `agent-may-certify` and specify the evidence required to certify it. Migration could therefore preserve the delegation in storage while removing its effect on the next ordinary check. Honor the item-level delegation at the exact checklist revision, evaluate authority to close separately, and test a checklist containing both delegated and owner-confirmed items.

- **DESIGN — Accepted revision and custody, steps 1–3.** Step 3 advances the attempt generation after abort while leaving the accepted predecessor unchanged. Step 1 lists the fields covered by a signed choice, but never explicitly binds it to that attempt generation. If an owner retries the same occurrence and candidate after abort, the stated fields can match the retired attempt. Bind the attempt generation to the candidate digest and every dependent certificate. Test replaying old choices into the new attempt with the same mutation ID and payload.

- **DESIGN — Cutover and recovery.** B2 uses the project acceptance protocol for the authority pointer. Step 4 allows one machine to install the accepted proof while another still lacks it. Cutover holds admission through pointer CAS and permits a reversible prepublication abort, but leaves the abort decision unspecified in this interval. A1 §Migration requires both store heads to remain fenced through publication. Define the first durable event that rules out rollback, require positive proof of abort before releasing legacy writers, and crash the holder after exactly one machine installs pointer acceptance. Verify the surviving machine’s **write routing**, including after restart.

- **DESIGN — Deterministic source mapping, step 2.** The item mapping requires a source check reference. Chief of Staff §§1.3 and 2.1 describe a valid interval between owner confirmation and the first due check. B2 identifies a digest for owner-item checks but gives no mapping rule for a deterministic item with no check occurrence yet. Derive item identity from the binding revision and original item ID, and attach check references as evidence when present. Migrate a newly confirmed checklist before its first tick and verify its items survive as unverified.


### Round 5

**Verdict: SERIOUS ISSUES**

- **DESIGN — Cutover and recovery, post-publication writes.** B2 checks that all projects share a compatible custody domain when the kind-wide pointer is published. It also routes later project creation and audience changes through that pointer. It leaves open what happens when the next project requires a different holder set. The owner could then face a choice between replicating to an ineligible holder and breaking the published custody contract. Enforce domain compatibility on creation, import, and scope changes. Test creating an incompatible project immediately after cutover. For revocation, require immediate withdrawal of access even if further writes must pause for a custody transition.

- **DESIGN — Accepted revision and custody, step 2.** B2 requires each supporting check to remain valid at the instant of sealing. Chief of Staff §2.2–2.6 includes mutable evidence such as a page body or a record’s current status. Re-reading those sources sequentially leaves an interval between the first observation and the durable seal. The close serializer controls local closure and lease state, but the supplied contract gives it no control over a remote page update. Define which evaluators attest to an observation valid for a stated interval and which can guarantee a condition through sealing. Test a source changing after its final read and before the seal. Hold automatic closure where the delegated rule requires a guarantee the evaluator cannot supply.

- **DESIGN — Canonical record and entry points, paired redirects.** B2 permits reloading a changed project before accepting a redirect. Chief of Staff §2.5–2.6 derives the `drifting` verdict from the goal and evidence together. Reloading the new goal can fix the outgoing wording while leaving the decision to redirect based on the old goal. Invalidate the verdict and any cached evidence-hash match when its canonical goal or checklist revision changes. Test a goal edit after judgment but before ingress where the same work satisfies the new goal. The expected outcome is no redirect.


### Round 6

**Verdict: SERIOUS ISSUES**

- **DESIGN — Current access after holder loss (§ Cutover and recovery).** One test requires the survivor to return the exact accepted result after holder isolation. Another requires immediate suppression after revocation, even with the authority disconnected. The delivery certificate establishes what both machines stored. It cannot tell an isolated survivor whether access was revoked afterward. Name the authority that can prove current access independently of the lost holder, including for mutation-result retries. Run the same recovery test twice with identical survivor storage. When that authority is reachable, enforce its current decision. When unreachable, require `unavailable` and qualify the positive recovery test accordingly.

- **DESIGN — Ordinary edits lack a commit decision (§ Accepted revision and custody, steps 2–4).** B2 specifies an irrevocable seal for automatic closure and cutover. An ordinary edit can proceed from unanimous choices to installation without a seal. If authority changes after the last choice but before the first installation, step 3 describes abort in terms of an attempt that never sealed, while step 4 permits installation with whatever seal the operation requires. Specify the irreversible event for an ordinary edit and serialize it against abort and authority changes. Test a delayed complete choice certificate arriving after one member durably votes to abort. Both paths must converge on one outcome across restart.

- **DESIGN — Legacy close delegation has no reproducible mapping (§ Canonical record and entry points; § Deterministic source mapping).** Chief of Staff §§1.2–1.3 describe owner-confirmed bindings and per-item delegation. §2.6 directs the host to close a verified binding under a live lease. B2 requires separately verified authority to close but never identifies which existing owner act and policy establish it. Two converters could preserve the same checklist and disagree on whether the next passing check closes the project. Define the exact source evidence that qualifies, including whether owner confirmation under a documented automatic-close policy suffices. Test one qualifying legacy binding and one with item certification alone. If the legacy source cannot establish close delegation, state the resulting change to automatic closure explicitly.

## Convergence verdict

Convergence failed at the Tier 2 cap. The spec remains a draft. Do not move project writer authority or alter existing closure behavior. A non-mutating inventory can establish carrier availability and candidate identity separately.
