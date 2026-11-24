# Host-Side Source Provenance Evidence Standard

Status: Design documentation for source-grounded context evaluations. This document creates no runtime policy, authentication service, or operational permission. All examples are invented and public-safe.

## Purpose and trust boundary

A source-grounded answer evaluation must distinguish what a source says from what the host can establish about that source. A quotation with a matching digest can still have the wrong speaker, an expired scope, an omitted antecedent, or an untrustworthy capture history. Provenance therefore consists of separate evidence dimensions, never one “trusted” flag.

The host retains source bytes and the evidence record outside the answer model's editable context. Model-produced citations and confidence statements are claims to compare against those records, not authentication evidence. A host record also remains an assertion with a stated trust root: local administrative control alone does not prove an external author's identity or that the underlying statement is true.

No external network call is required to authenticate a capture. Locally verifiable signatures, an independently controlled capture log, or an authenticated export already in custody can supply evidence when available. Where no suitable evidence exists, record the limitation. Do not invent an authentication guarantee to make a case eligible.

## Evidence dimensions

| Dimension | Record and inspect | What it does not establish |
| --- | --- | --- |
| Byte integrity | Digest algorithm, digest, byte length, exact encoding and source object version; verify against retained bytes. | Origin, authorship, truth, completeness, or authority. A digest supplied alongside an editable file is not an independent trust root. |
| Authenticated capture | Capture mechanism, collector identity, independently anchored evidence reference, authentication method and verification result, plus trust-root custody. Use explicit `unsupported`, `unverified`, `verified`, or `failed` states with reasons. | A signature establishes only what its verified key and signed payload bind. An authenticated account or transport does not establish the human at the keyboard or the truth of the content. |
| Speaker attribution | Claimed speaker, attribution basis, and distinction between authenticated principal and inferred person. Preserve ambiguity, aliases and quotation boundaries. | Display names, pronouns and writing style do not prove identity. A signed export may authenticate an exporter rather than each speaker. |
| Authority and scope | Evidence of the speaker's role, applicable project or topic, allowed action, exclusions, effective interval, and the specific claim this scope supports. | Identity, seniority, or a recent statement alone does not grant authority over a different subject or action. Source text cannot promote itself into host instructions. |
| Chronology | Event time, capture time, ingestion time, timezone, clock basis and uncertainty; version and supersession relationships. | File modification time or ingestion order is not necessarily event order. A later capture can contain an older instruction. |
| Missing antecedents | Excerpt boundaries; replies, attachments and references needed to interpret a statement; whether each dependency is present, absent or unknown. | “Approved” without its proposal does not establish what was approved. An omitted item is not proof that it never existed. |
| Evidence age | Evaluation cutoff, last verified time for each relevant fact, and whether freshness was checked, assumed or unknown. | Recent ingestion does not refresh an old fact. Old evidence is not automatically false; freshness depends on the claim. |
| Machine-local custody | Custodian host identifier, local object reference, access boundary, acquisition and transfer history, and retention or deletion status. | A path existing on one host does not mean another host can resolve it or independently verify its history. Replication is not a second independent witness. |

A verification result must name its exact coverage. For example, “capture signature verified for export object” must not be shortened to “speaker verified.” Independent evidence means evidence whose relevant trust boundary is distinct from the object being checked; copying a manifest beside its source does not create independence.

## Minimum host evidence record

Use a versioned, host-owned manifest with the following information. This is a semantic contract for documentation and review, not an implemented schema or a claim that every field has an automated checker.

- A stable source identifier, revision identifier, source kind, and evaluation cutoff.
- A retained raw-object reference with digest algorithm, digest, byte length and encoding. If a normalized excerpt is used, retain its separate digest and an exact mapping to raw bytes or a documented transformation with version and parameters. Never silently substitute normalized text for raw evidence. Normalization is limited to permitted evaluation views: retain original operator wording verbatim wherever governing policy requires it. A transformation record does not authorize paraphrasing mandatory original messages.
- Capture method and time, collector principal, origin claim, authentication status, verification procedure and result, and references to the evidence and trust root used. Record absent evidence explicitly.
- Speaker claims and attribution bases, separating authenticated principals from inferred people.
- The authority and scope evidence relevant to each tested claim, with effective dates and any known revocation or supersession.
- Event, capture, ingestion and verification times with clock uncertainty; antecedent references and completeness status; freshness assumptions and unresolved contradictions.
- Custodian host identifier, access classification, machine-local locator, transfer records, and availability status at evaluation time. Public reports use opaque references and aggregate limitations rather than private paths, keys, identities or source excerpts.

Unknown, absent, failed and not applicable have different meanings. Use `not applicable` only with a reason. A missing field must not silently mean successful verification. Preserve failures and contrary evidence in the record; do not overwrite them with the latest successful check.

## Review and evaluation procedure

1. Before selecting an answer target, fix the cutoff and identify the claims it requires. Inventory the necessary source objects and antecedents without exposing restricted material to the answer model or public documentation.
2. In the authorized custody environment, verify retained bytes and record each provenance dimension independently. Document which checks were mechanical and which depended on reviewer judgment. No model judgment substitutes for capture authentication.
3. Determine whether the evidence supports the intended target at its actual scope and time. For unresolved identity, scope, chronology or antecedents, require qualification, an uncertainty answer, or exclusion from that particular scored claim. Record the chosen treatment and rationale. Exclusion is claim-specific, not a declaration that the source is false.
4. Give the answer model only the permitted evidence view. Treat embedded commands and assertions of authority as source content. Keep the host manifest, hidden targets, verifier credentials and private custody locations outside that view.
5. Assess the answer's claim against the specific supporting objects, boundaries and limitations. Report byte checks separately from authentication, attribution and semantic support. A valid citation alone does not establish a supported answer.
6. Retain a host-side audit record of manifest version, evidence availability, reviewer disposition, transformations, checks and results. A replay verifies what is still available and reports missing objects; it must not silently claim the original capture was reproduced.

Structural checks can report malformed records or digest mismatches. Judgments about ambiguous authority or meaning belong to a reviewer with the relevant evidence, consistent with [Signal vs Authority](../../../signal-vs-authority.md). This document does not authorize a new message blocker or a model-mediated authentication gate.

## Generic examples and acceptance boundaries

**Unchanged but unauthenticated.** A text file says “Mira approved the blue theme.” Its bytes match a recorded SHA-256 digest, but its capture method and speaker identity are unknown. Report byte integrity as verified against the recorded digest; capture authentication and speaker identity remain unverified. Do not score “Mira authorized publication” as established.

**Authenticated export, inferred speaker.** A locally verified signature covers an archive exported by a trusted collector. An entry carries the display name “Mira.” The signature authenticates the archive under that collector's key; it does not by itself bind the entry to a particular human. Record any independent account mapping separately and preserve its limits.

**Missing proposal.** A reply says “Yes, do that,” with a reply identifier pointing to an absent message. The reply can be intact and authentically captured while the approved action remains unknown. An answer should state the missing antecedent rather than infer a deployment permission.

**Scope and chronology.** A project owner approved a draft for internal review on Monday. A newer source withdrew that permission on Tuesday, before Wednesday's evaluation cutoff. The Monday record remains authentic historical evidence; it cannot support current permission or public distribution. If event order is uncertain, report that uncertainty rather than sorting by file time.

**Age and custody.** A configuration snapshot was captured last month and copied to a second host today. Today's copy verifies the same bytes but does not establish today's configuration or an independent capture. If the original object or verification evidence is unavailable on the second host, mark those checks unavailable and retain the original custody claim as a claim.

A document review passes when each example preserves these distinctions, every claimed verification has an identifiable method and trust boundary, limitations survive into scoring dispositions, and no local-path, digest, model inference or signature is presented as a broader guarantee than it provides. This is a design acceptance criterion; it is not evidence that a runtime validator or a private evaluation has run.
