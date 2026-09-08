# Telegram message origin — design review record

Status: implementation explicitly approved by Justin; design review remains active. This report does not certify convergence, implementation or deployment. Earlier round status notes are historical.

Readable companion: [private overview](https://echo-studio.dawn-tunnel.dev/view/f5d1fbbf-42c5-4e2c-915b-9a685d4800f4); the per-view access signature is shared privately rather than committed.

## What the user asked for

Every message sent by an Instar agent into Telegram records at least its originating machine, harness and model. Display starts on, with optional hiding that never disables recording. This extends earlier operator-account authorship protection. The request is captured directly from Justin's topic 69507 message on September 5, 2026.

## Review mechanism and limits

The author and internal review workers run GPT-6 Astra. Six named perspectives are reviewed: security, performance, adversarial, integration/deployment, decision-completeness and lessons-aware. Workers are reused between distinct perspectives because the session has three worker slots; perspective-specific findings are kept distinct.

External CLI reads ran GPT-5.5 through Codex and Claude Fable 5 through Claude Code. The runner's crossFamily booleans assume a Claude author and are therefore not used as evidence of family diversity here: Claude is the actual different-family reviewer relative to this GPT author. Gemini was detected but unauthenticated; no Gemini review is claimed. No new login or paid API account was established.

The live Standards-Conformance Gate reads the shipped registry, rather than the stale agent-home registry snapshot. Initial source integration evidence is explicitly from package 1.3.1203, while the running server was 1.3.1224; fresh-main source grounding is required before implementation. No code was modified by this drafting work.

## Round 1

Standards-Conformance Gate: ran against 90 articles; one possible-violation flag concerning user reachability when audit storage fails. Not degraded.

| Perspective | Findings and resolution incorporated into the draft |
| --- | --- |
| Security | Scope/revoke session credentials by incarnation; authenticate origin envelope separately from ASP; select a concrete managed browser broker; distinguish hidden tuple integrity from body authorship; scope audit access independently of preparation/relay credentials |
| Performance | Preserve six-plus-child plans across stampede handling; require atomic claims; avoid event-loop database contention; use explicit per-shard pagination; bound active work and separate retained origin from queue payloads |
| Adversarial | Bind actual wire bytes to prepared plans; reject always-unknown wiring as healthy; fence concurrent executors; prepare signed format variants before origin-host loss |
| Integration | Stage rolling upgrades and legacy queue import; preserve exact pre-redacted text/format; keep distinct origins through content suppression; keep origin rows through queue cleanup |
| Decision-completeness | Add durable fallback before holding sends; cosmetic companions only when visible; specify retention/capacity defaults; avoid silently extending ASP to ordinary bot messages |
| Lessons-aware | Typed receipts rather than HTTP-200 success; distinguish post-dispatch timeout from connection failure; separate origin retention from active queue cleanup; define bounded Tier 1 supervision without fabricated delivery evidence |
| Codex GPT-5.5 | SERIOUS ISSUES: browser isolation, availability coupling, concrete model observations, outbox semantics and terminology |
| Claude Fable 5 | MINOR ISSUES label, with substantive availability/browser issues; requested alternatives considered. Footer-on-change and browser best-effort-only rejected because they weaken the direct user requirement |

Raw external and conformance outputs: `.instar/telegram-origin-review/{cross-model,claude,conformance}-round-1.json`. First internal findings are retained in this session's review messages and consolidated above; no separate per-reviewer first-round file is claimed.

## Round 2

Standards-Conformance Gate: ran, but degraded with reason `error`; its empty findings are NOT a clean constitutional pass.

Internal reports: `.instar/telegram-origin-review/internal-round-2-*.md`.

| Perspective | Residual finding | Draft change |
| --- | --- | --- |
| Security/integration | Hidden captionless operator-account sends had no ASP carrier; pre-signed tags expire after 15 minutes; fallback execution eligibility ambiguous | Separate security companions from cosmetic metadata; receipt-bind attachments; retain existing 900-second freshness with renewal/hold; make evidence copies inert |
| Performance/decisions | Fallback copies could imply competing executors; recovery accounting/episodes unspecified; broker ownership not frontloaded | Use one credential-owner transactional outbox; persist per-child deadlines/attempts; disclose profile migration and security companions |
| Adversarial/lessons | Same captionless-carrier and signature-expiry defects independently found | Same changes; these findings reset the design-quiet counter |
| Codex GPT-5.5 | SERIOUS ISSUES: ad hoc distributed commit, LLM recovery authority, browser alternative, display audience and terminology | Remove execution authority from fallback sinks; keep deterministic receipts with diagnostic-only supervision; document operator-account capability and deliberate per-message default |
| Claude Fable 5 | MINOR ISSUES label, but key lifecycle and hidden linkage concerns | Specify key epochs/revocation and acceptance-time evidence; retain private message-identity linkage intentionally; no covert token when display hidden |

The LLM diagnostic consult remains because the repository requires Tier 1 supervision of critical recovery pipelines. It does not classify receipts or grant retries, and it never delays ordinary sends. The alternative recommendation to let an LLM resolve delivery ambiguity is not adopted.

## Round 3

Standards-Conformance Gate: ran against 90 articles, not degraded. It again flagged reachability at the all-durable-sinks-failed boundary. That is now an explicit operator choice sent to Justin, not silently asserted as a settled reading of the requirement.

Internal reports: `.instar/telegram-origin-review/internal-round-3-*.md`. Security/integration found that content sent before its security companion could be treated as human-authored before verification; adversarial/lessons found that renewed tags/receipt-dependent companions conflicted with an already immutable plan. Performance/decisions found only precision issues concerning capacity reservation and the separate execution-outbox admission requirement. The design-quiet counter therefore resets.

Resolution: reject operator-account forms unable to carry the same-message authorship proof before any network effect, rather than introducing a multipart ASP authority race. Bot captionless cosmetic companions remain distinct. Define narrow authorized child derivation and immutable sealing before execution claims; reserve all derived capacity in advance. Clarify that durable evidence fallback does not bypass the sole execution outbox.

GPT-5.5 additionally requested Web-vs-TDLib comparison and concrete receipt correlation; both are documented using Telegram's primary sources. Claude Fable 5 requested explicit all-sink failure confirmation, an audit replication alternative, a diagnostic consumer and audience clarity. The failure-policy question is with Justin; the replication tradeoff and diagnostic consumer are documented. The user's wording explicitly covers any agent message appearing in Telegram, so the default is not silently restricted to this private topic. The display policy still passes through existing destination/disclosure authority.

## Pending work after round3 (historical; superseded by explicit approval below)

Waiting on the failure-policy answer requested in topic 69507. It is explicitly listed in the draft's Open questions. Updated design has not received another complete review round, and is not converged. After incorporating the answer, two consecutive rounds without DESIGN-class findings are required by spec-converge. Every design correction must retain the user's scope; bot-only or recommended-helper-only recording would not satisfy it.

Runtime implementation, all required test tiers and rollout have not occurred. Approval, if requested, must refer to the final concrete reviewed design and its readable overview rather than this intermediate report.

## Approval and round 4

Justin (verified Telegram operator 7812716706) explicitly approved implementation: “Lets go with hold for now, but the user should be notified. Approved, please build this feature.” Approval is recorded from that message; it does not assert completed tests or deployment.

Fresh source is now verified current main 77df8be42a24a09d991b044027161c95eb9322a5, package 1.3.1225. All six internal perspectives ran on GPT-6 Astra. Security/integration and adversarial/lessons found zero design defects; adversarial found one precision issue in the availability summary. Performance found one design ambiguity: separate processes cannot share an in-memory notice permit. Decision-completeness found zero unresolved operator decisions. Resolve by naming one process as the preclaimed notice owner; other processes use bounded IPC and may never take ownership on timeout. Bound emergency reservations independently of ordinary delivery slots.

Conformance round4 ran against 90 articles and again flagged hold/reachability; explicit Justin hold-and-notify authorization resolves that policy conflict. The flag remains retained honestly. GPT-5.5 and Claude Fable5 external reads both ran. Their design findings require explicit browser-receipt feasibility and activation canaries, an explicit preclaimed-notice contract, lessons-engaged frontmatter and recorded bound derivations; those are being incorporated. The stale footer-typo quotation in the Claude result is not present in the reviewed spec body and requires no new behavior change. Open questions remains only operator decisions, not a claim that implementation feasibility was already proved.

This round is not design-quiet in aggregate. Final implementation review must cover the new notice path and actual browser receipt seam.

## Rounds 5–7

Round5 internal six perspectives: zero DESIGN. Both external reviews ran; their declared counts remain **5 DESIGN / 3 PRECISION**. The independent comparison found several already-covered requirements but did not reclassify the originating reviewers' findings. The complete outputs and evidence-based dispositions were returned to those reviewers in corrective round6.

Round6 internal six perspectives: zero DESIGN. Conformance5/6: each checked90, zero flags, not degraded. External6 withdrew the earlier availability/diagnostic-consumer/TDLib-first demands where already satisfied, then declared **4 DESIGN / 4 PRECISION** covering canonical encoding, current notification policy, correlated local storage and freshness-clock assumptions. Those were incorporated with explicit canonical bytes, current policy checks, named host correlation, and a 60-second clock-skew plus60-second transport budget.

The Web feasibility spike now proves a concrete Web K manager RPC and server-result seam, using exact production asset/source-map evidence and an anonymous non-sending canary. This establishes feasibility, not completed authenticated managed-profile delivery. No operator login was modified and no Telegram message sent by the spike.

Round7 conformance: checked90, zero flags, not degraded. External7 declared **5 DESIGN / 3 PRECISION**, including a too-strong fixed notice resumption promise, cosmetic preference changes invalidating the notice, exact canonical string encoding, and relocating the already-stated TDLib fallback into activation criteria. The notice promise is corrected; presealed finite display variants will preserve notification across cosmetic preference changes without bypassing recording. JCS is named as the canonical base, with the existing safe-integer/string-ID constraints. The Bot API byte boundary and Web RPC argument boundary are distinguished explicitly. These are addressed before another round; no convergence is claimed from the quiet internal results alone.

## Rounds 8–9

Conformance8: checked90, zero flags, not degraded. External8 declared **4 DESIGN / 3 PRECISION**: unspecified unavailable policy reads; drift maintenance contract; bot-unreachable operator-account chats; cross-conversation notice burst. Resolve through the operator's existing alert hub (the standing one-hub notification policy), coalescing many held conversations into one reserved notice; explicit unknown-state suppression, a bounded paced queue for distinct operator hubs, and activation/pre-write build checks with an assigned maintenance owner and public-MTProto migration path. No third-party recipient receives an infrastructure alert and no per-event topic is created.

Conformance9: checked90, not degraded, repeated the general reachability/hold flag; Justin's explicit hold decision remains its documented resolution. Round8 completed internal perspectives found zero DESIGN. Round9 was attempted but its adversarial/lessons pass was superseded before completion; it is not a full convergence round. External9 declared **4 DESIGN / 2 PRECISION**. The concrete named-notifier-API/sabotage-test request is incorporated. Repeated TDLib-first and always-visible-alert recommendations are returned for corrective adjudication: the former does not enforce the requested browser path, and the latter conflicts with universal optional display. The author does not relabel these originating findings; round10 explicitly asks the original reviewer families to resolve them against the full approved requirement.

## Rounds 10–11

Conformance10 checked90 with the known operator-resolved hold flag; conformance11 checked90 with zero flags; both were not degraded. External10 declared2DESIGN/3PRECISION; prior TDLib-first and forced-alert-footer findings were explicitly withdrawn by the originating Claude reviewer on their merits. New changes require exclusive notifier consumption with source-boundary lint and behavioral sabotage, and independently refreshed policy-authority projections so a failed origin worker does not automatically suppress the alert. Internal lessons10 additionally required one bounded read-only browser canary recovery before escalation under P22; this is implemented in the contract with a persisted brake/latch and no message replay.

Internal11 six perspectives returned zero DESIGN. GPT external11 declared2DESIGN/2PRECISION, one of which asks for the exact notifier boundary lint already in the file; the full exact quotation is returned for corrective review. Its concrete storage-selection question is answered by naming the actual existing SQLite/WAL PendingRelayStore and comparing external broker alternatives. Claude external11 used an ambiguous MINOR category for two requests; both are conservatively addressed: concrete authority anchors and an activation-blocking contract-to-test conformance artifact. Its ELI16 context limitation is resolved by inlining the actual companion in round12. No aggregate quiet round is claimed from ambiguous or unwithdrawn classes.

## Rounds 12–14

Conformance12/13 each checked90 with zero flags, not degraded. External12: GPT1DESIGN/2PRECISION (explicit restart-during-outage acceptance missing), Claude0DESIGN/2PRECISION. Resolve acceptance18 with failed-origin-worker production restart, truthful lost-permit status and forbidden emergency bypass; fix sequential numbering and add P17/P22/P23 lesson declarations. Both external families explicitly withdrew the redundant notifier-lint criticism.

Round13: all internal perspectives zero DESIGN; GPT external1DESIGN/2PRECISION re-raised the Web drift-budget question, while Claude0DESIGN/2PRECISION accepted the concrete bounded Web path. A corrective round14 supplied the exact existing two-failed-builds threshold, required authenticated proof and named maintainer/fallback, without changing the body. GPT14 explicitly withdrew that remaining design objection and returned0DESIGN/3PRECISION. Claude14 was delta-skipped because the exact body hash0cf9f5ebddf6917de2e748ea4a78081958572c3f96c518275fb0f2b9a1643c4a was unchanged from its clean round13 read.

Conformance14 checked90 and flagged Observability. Security/integration and adversarial/lessons found the existing telemetry sufficient; performance independently identified1DESIGN: typed audit rows and capture counts do not explicitly require aggregate counters for the whole delivery funnel. The finding is preserved, so round14 is NOT aggregate-quiet despite clean external reads. Resolve with bounded operator-scoped preparation/admission/attempt/outcome counters, explicit counting units, transactional dedup, stale/unavailable coverage and archive invariance. A compact lifecycle and browser activation table clarify existing behavior; approval is explicitly separated from runtime compliance.

Review-process disclosure: the adversarial/lessons pass in attempted round9 was superseded before completion. It is not counted as a completed full round or convergence evidence. All final convergence rounds must include all six perspectives and their actual model disclosure; no interrupted intermediate pass is silently treated as clean.

## Round 15

Conformance15:90 articles, zero flags, not degraded. All six internal perspectives returned zero DESIGN; adversarial noted one precision correction moving partial-delivery counts to logical operations. Claude external15 returned0DESIGN/3PRECISION. GPT external15 re-raised the Web maintenance preference as1DESIGN/3PRECISION after withdrawing it in14. Its specific distinction is returned for corrective review: the first unsupported build already blocks writes; the two-build threshold governs migration, not permission to continue writing unsafely. This originating class is retained until the reviewer resolves it.

The aggregate metrics requirement is now explicit. Precision updates number outage obligations N1–N10, remove duplicate term definitions, declare P20 and clarify partial-count units. Those do not alter the approved send/receipt policy. Round16 reviews the changed body, with the original reviewer asked to adjudicate its repeated Web item rather than the author relabeling it.

## Round 16

All six internal perspectives (GPT-6 Astra) returned0DESIGN/0PRECISION. Conformance16 checked90, zero flags, not degraded. GPT-5.5 external16 explicitly returned0DESIGN/3PRECISION and withdrew the repeated Web-first objection on its merits; Claude Fable5 returned0DESIGN/2PRECISION. Both ran against exact reviewable body hash9294f4b98380ebfb6727a408530ea66092e9710d0971e46a82a67ad7347ca5b5. This is the first aggregate design-quiet round after the Observability correction.

Remaining precision notes do not change behavior: the mandatory Open questions heading retains explicit operator-decision scope; a lifecycle/activation table already exists, while the final implementation conformance matrix will cite exact transitions/tests; automation renders its registered producer truthfully without borrowing a session model. The wording “Disabled enabled” is a retained grammatical precision note; the effective enabled:false behavior is explicit elsewhere in the same spec. These notes are retained rather than used to invent another product requirement.


## Round 17 — convergence

All six internal perspectives returned 0 DESIGN/0 new PRECISION after independent reread of unchanged body 9294f4b98380ebfb6727a408530ea66092e9710d0971e46a82a67ad7347ca5b5. Conformance17 checked90, zero findings, not degraded. Both external families are delta-skipped under the skill’s unchanged-body rule using their actual successful round16 reviews; retained precision counts are GPT3 and Claude2. Rounds16 and17 are the two consecutive aggregate design-quiet rounds. This concludes design review, not runtime validation.
