# Selected Local Conversation Import — Review Report

Review status: six rounds completed, followed by targeted resolution review at the cap. All final external findings were addressed; all six internal targeted perspective passes report zero unresolved DESIGN or PRECISION. This is design convergence with explicit external/conformance limitations, not a clean external verdict or implementation verification. All internal reviewers use inherited GPT/Codex contexts; no Claude calls or model overrides were used. Separate Codex CLI reviews report gpt-6.2-astra. This is separate-context review, not a different-family validation. Gemini was unauthenticated. Raw driver crossFamily=true reflects its non-Anthropic registry assumption and does not establish a different family from the author.

## ELI10 Overview

You choose local Claude Code or Codex conversation files, the app uploads that selected snapshot to the computer you chose, and you review and confirm a private preview before copying. The server does not receive permission to browse paths on your device. The history stays inert: it does not become instructions, scheduled jobs or connected accounts.

The review focused on protecting ownership and keeping large files from disrupting normal requests. Approval must be fresh and bound to the selected target, old requests cannot recreate approval after restart, and retries must remember a conversation’s import identity rather than copying it twice. Large work runs in a bounded child while the server retains permission checks. If copying stops midway, the result is interrupted or uncertain rather than false success.

## Original vs Converged

Originally the draft asked the server to open native-picker paths without proof that the picker and server shared a disk. Review replaced that with selected-byte upload using existing signed binary transport and the app’s proven-origin pinning pattern. Further review required independently pinned target signing keys and a purpose-separated sealed transport; a pinned hostname alone cannot protect plaintext when routing moves to another computer.

Originally receipts and source identity were temporary. Review separated expiring approvals from durable owner-scoped representation claims enforced by the store. It added historical-owner read filters, boot challenges, real crash-prefix/torn-tail retry tests, buffered-ingress admission and off-main-thread apply as well as preview preparation. An arbitrary aggregate project-size cap was removed; supported files are prepared sequentially with measured disk accounting and explicit existing per-file support limits.

## Iteration Summary

| Round | Internal DESIGN findings (perspective counts, overlaps intentional) | External | Spec changes |
|---|---|---|---|
|1|security4,adversarial2,integration5,scalability6,decision-completeness3,lessons4|Separate Codex gpt-6.2-astra returned4 DESIGN groups|Upload-only origin-pinned design; durable representation; actual read/label/startup wiring; resource/disposal policy; explicit retry/crash behavior|
|2|security2,adversarial1,integration2,scalability2,decision-completeness1,lessons1|Timed out; degraded, no findings inferred|Historical-owner opaque refs/filtering; parent FD authorization bridge; isolated apply; before-write reservations; shared worker and ingress admission|
|3|all six perspectives0 additional DESIGN|Timed out at180seconds; degraded, no clean opinion inferred|Only accepted PRECISION clarifications: opaque child argv/private frame, already-issued permit boundary, durable destination growth accounting. Source-backed transport feasibility closed into owned implementation handoff|

Standards-Conformance Gate, each round: **unavailable under the zero-Claude restriction**. Source inspection shows the live route calls an injected intelligence provider; no safe no-Claude runtime routing was established. It was not invoked at risk of violating the operator constraint. This is an explicit review limitation, not a clean constitutional result or an unexplained skipped gate. Lessons-aware review did independently engage the design principles and fixed limits.

## Proportion

Tier2 security-sensitive owner-directed import contract;Round4 initiated after the structural maturation gate caught a missing design requirement;6round cap remains. Stop iterating once no reviewer changes what gets built. Do not run another round merely for the precision edits.

## Full Findings Catalog

### Round1

- Security DESIGN: device signatures do not prove picker locality; ancestor path checks can race; process-memory replay guard admits old requests after restart; resource custody/lifetime unspecified. Resolved by upload-only pinned-origin transport, boot challenge and explicit admission/disposal.
- Adversarial DESIGN: representation loss changes message-key domains after restart; old selection action can recreate a grant. Resolved by durable actual-destination claims and boot/action binding. PRECISION: full apply fingerprint and atomic cancellation boundary.
- Integration DESIGN: private helper absent from some raw reads; local-source search labels/ref grammar wrong; writer/source mode binding missing; startup/allowlist/machine identity incomplete; host proof unavailable. Resolved explicitly. PRECISION: restart outcome honesty and upload posture.
- Scalability DESIGN: reserve before acceptance, bound concurrent parsing/proposals, specify chunk retries, expiry without new traffic, run ownership/residue accounting, and keep expensive prep outside writer. Resolved with importer-only ledger, sequential isolated child, disk artifacts and lifecycle disposal.
- Decision-completeness DESIGN: native action/transport and resource arbiter unnamed; durable interfaces must be frontloaded. Fixed-limit contest established MAX_ELEMENT_CHARS is characters, not an aggregate raw-byte safety proof. Aggregate cap removed; current per-file adapter limit disclosed as support policy.
- Lessons DESIGN: structural store identity, useful explicit limit recovery, awareness/availability/migration, and restart continuation without needless repicking. Supervision precision: finite owner-directed work does not send raw data to a model or delegate authority to an LLM.
- Separate Codex external DESIGN: locality; two competing project fields; append-before-manifest retry not proved; overlapping requests can parse before reservation. Resolved via upload, one project provenance value, actual file-key crash tests plus torn-tail repair, and before-work admission.

### Round2

- Security DESIGN: unique current owner is not historical per-ref owner; normalized temp output must reserve before write. Resolved by owner-scoped refs/claim filters and parent-owned charged output.
- Adversarial DESIGN and integration DESIGN: sync owner callback cannot cross IPC. Resolved by parent-owned descriptors/live checks and bounded pure-child input; no serialized true grant.
- Integration DESIGN: disk previews do not prevent main-thread apply hydration. Resolved by isolated apply with real store writer and scoped parent mutation permits.
- Scalability and lessons DESIGN: apply children also need pre-spawn accounting;120second unit must be per-file plus absolute deadline; post-permit failure cannot say no-copy. Resolved with combined worker admission and explicit outcome policy.
- Decision-completeness DESIGN: per-request raw limits do not bound concurrent buffered bodies. Resolved with a stateDir-shared pre-parser ingress lease, existing full signature authority and bounded abort/disconnect disposal.
- PRECISION: full route prefixes; explicit private child environment/diagnostic handling; child-slot release independent of disk cleanup; challenge and disk reserve values are policies, not physical laws.

### Round3

- Six internal perspectives concurred: no new DESIGN findings.
- Security PRECISION: no private provenance in child argv. Added private bounded input frame.
- Adversarial/lessons PRECISION: already-issued permit is admitted in-flight work. Cancellation denies later permits but does not retract that packet.
- Scalability PRECISION: durable append/claim/manifest temporary growth also reserves before permit; committed storage remains reflected in free space.
- Decision-completeness independently read exact app commit2c0087e and closed feasibility into a named frontloaded serverv1/native-owner handoff. It does not claim native source is complete or that Apple approved every field.

## Fixed-Limit Contest

Twelve groups reviewed: source/schema/single-project scope; exact principal/consume-once; refreshable60s challenge; existing1MiB framing; current per-file support; configurable512MiB heap; configurable120s per-file phase; worker/ingress scheduling; configurable24h lifetime;3cleanup attempts at1/10/60s; inherited max2GiB/5% disk reserve; supported0700/0600 privacy permissions. Numerical resource/scheduling/retention/retry values are explicit initial policies with legitimate counterexamples and refusal/recovery costs. Only schema/privacy/idempotency boundaries are treated as invariants. No cheap-to-change-after tags were used. Final decision review counts: frontloaded-decisions7groups,cheap-tags0,contested-then-cleared0,open-user-decisions0.

## Left behind

- Actual native UI/transport implementation and full native compatibility remain delivery work owned by the Apple app session, not an unresolved server design choice. Capability must stay unavailable where dependencies/caller support are absent.
- Live conformance and final-body different-family review were unavailable/degraded as disclosed above. These limitations cannot be presented as PASS.
- Larger per-file transcript support and Windows private-storage ACL support are outside this initial supported adapter/storage slice; no silent truncation or unsafe fallback.
- Existing archive-source policies are separate. This design does not fabricate an owner from an unscoped bearer for new local-source reads.

## Rounds4–6 and final status

Round4 internal six perspectives found no additional DESIGN issue. The structural tag gate had refused the missing maturation plan after round3; a development gate, evidence ladder, dark-window checkpoint and old-client compatibility policy were added before round4. External round4 returned SERIOUS ISSUES: movable hostname plaintext disclosure, writer contention after partial progress, native capture disposal, and nonce timing before human review. Those findings required round5 changes.

Round5 external returned SERIOUS ISSUES: private search terms in URLs, lost complete acknowledgement without a known operation id, parent-only exit proof despite a surviving apply child, and unbounded native capture disk growth. These were addressed by sealed finite library requests, operation identity allocated with the upload grant plus upload-id recovery, parent-and-child exit proof before resource reclamation, and device-local live disk reservations. Internal security/adversarial also independently raised the private-search issue and target-key anchor question. Other round5 delta perspectives concurred after these changes.

Process deviation: the author edited the revision6 draft while the remaining round5 delta perspectives were finishing. Those reviews explicitly identified the changed input and are not represented as reviews of one frozen round5 body. Final round6 instead freezes SHA256 `1c79e4808f9555960ad0f3a432cc9c519cf28828d231fb409047731b7e4d1c70` for all six internal perspective passes and the separate Codex external review. No edits during that review.

Standards-Conformance Gate rounds4,5,6: unavailable under the zero-Claude restriction for the same inspected injected-intelligence routing reason as rounds1–3. No live clean conformance claim.

Round6 all six internal perspectives: zero DESIGN and PRECISION on the frozen input, hash verified before and after. External Codex returned SERIOUS ISSUES with four DESIGN findings: asynchronous reads lacked a total deadline; native provenance extraction was unspecified; the added upload-status recovery path was not actually routed; V8 heap isolation overstated total-memory containment. At the six-round cap, these received targeted resolutions rather than beginning a seventh round: total120second read deadline and child-exit release; same-frozen-byte bounded native provenance scanner/shared fixtures; one canonical grant-time operationId and the existing sealed operation status with chunk offsets; explicitly limited heap/process guarantee plus bounded streaming, sampled RSS termination policy and external-allocation test. All six internal perspectives reviewed those targeted resolutions and found zero unresolved DESIGN or PRECISION, current body SHA256 `2fdb78214c8285a5342927932bfbde9ee3f36f94f0c844729a64b6c35d455c98`. No safety/data-loss finding was accepted unresolved. No seventh full round was run; separate external review did not rerun on the correction body, which remains an explicit limitation. The frozen round6 external verdict remains SERIOUS ISSUES and is never rewritten as a clean external pass. The author read this report and approves the resolved design within ordinary backend custody; no constitution or protected-list amendment is proposed. Design concurrence does not establish implementation, native acceptance, full-suite health, deployment or import success.

## Traceability and source implementation review

The commit gate subsequently required explicit parent-principle frontmatter; the spec now names The Person Decides; the Agent Does the Rest, as the existing approved importer does. The intended-outcome and team-posture paragraphs clarify existing ownership constraints rather than widen authority. The side-effects review records simplestRobustRoute and the code reviewers assessed the actual reused reader, cryptographic and process boundaries. The master purpose and rule book were fetched/read on2026-11-23; hashes and copies are in the topic recovery directory. This does not convert unavailable live conformance or the external negative verdict into a PASS.
