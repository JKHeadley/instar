# Personal Mute And Reversible Archive Review

## ELI10 Overview

Mute is a personal notification choice; archive is a personal list choice. Neither removes messages, stops a session or changes someone else's access. Archived chats can be opened or restored. A saved local choice is distinguished from other computers still syncing, and an older computer cannot be described as already quiet.

The main hidden risk was delayed notifications. The old sender loses who and which chat produced a summary. Actual probes showed that merely preserving extra fields did not stop an older sender from delivering after device reassignment. New bound queues are therefore kept in a separate sidecar, with durable quarantine before the legacy slots are cleared and new writers enabled. Supported rollback keeps that older sender disabled until a guarded sender returns; it does not pretend notifications continue safely during that rollback.

## Original vs Converged

The initial design reused immutable per-reader state and planned typed queued replies. Review added exact fresh-action identity, intended-reader queue partition, represented reply witnesses, current per-attempt payload rebuilding, version-specific acknowledgment and migration episodes. Archive pagination now consumes a globally ordered prefix without skipping lookahead, returns scoped partial totals, and preserves the fixed Chief navigation locator separately. Telegram preferences include chat namespace; stable Slack identity cannot be inferred from a foreign machine's negative alias.

## Iteration Summary

Six rounds reached the Tier2 cap. The six internal perspectives ran each round in two batches of three: security, performance, adversarial, integration, decision completeness and lessons/experience fit. External review used the real installed authenticated Codex CLI, gpt-6.2-astra, every round. All six external calls returned statusok and SERIOUS ISSUES. There was NO quiet external round and none is claimed. Raw findings and actual conformance reports are committed; the review ledger records exact flags and102-standard nondegraded runs.

| Round | External findings | Main corrections |
|---|---|---|
| 1 | 4 DESIGN | Answering server filters unfiltered peer candidates; writes sort after observed fields; remote legacy queue unknown; explicit outbox status. Internal review added fixed Chief locator, uncertain selection, older-holder readiness and truthful local save. |
| 2 | 4 DESIGN | Witness must represent pending activity; intended-reader binding; budget continuation; explicit rollback provenance loss. |
| 3 | 3 DESIGN and1 PRECISION | Per-field clear exception with atomic rejection; unbound anonymous state always held; returned-row partial unread totals; unsupported is a client inference. |
| 4 | 4 DESIGN | Rebuild/ack each retry's eligible versions; actual unsafe old-drain probe and isolated sidecar; Telegram chat namespace; shared admission reason record. |
| 5 | 4 DESIGN | Fresh action request identity versus retry; urgency only from admitted witness; durable migration episode; readiness/identity cache invalidation. |
| 6 | 4 DESIGN | Immutable save receipt versus live per-field emission; reader-qualified coalescing; consumed merged-prefix cursor; supported rollback quiesces the old sender. |

Standards-Conformance Gate ran each round with102 standards, nondegraded; per-round flags are in the ledger. Some early reviewers finished before that round's asynchronous report became available; later lessons/integration dispositions explicitly engaged the reports. No unavailable report is relabeled passed.

## Full Findings And Closure

The six raw external JSON files contain verbatim findings. The table above catalogs their disposition; every listed design correction is in the final contract. Internal security repeatedly checked current-reader/permission boundaries; performance checked finite pagination and coalescing; adversarial checked transport awaits/retries, notices and private-activity witnesses; integration checked actual old-code behavior and rollout; decisions counted all settled contracts; lessons checked actual native outcomes and the existing foundation.

At the cap, the four final external findings were fixed in the document. Independent security, integration and decision reviewers then reread those exact corrections and found no remaining material safety/data-loss issue or unresolved build choice. That is internal closure after a capped external review, not an invented external approval or a seventh round. Implementation and independent runtime review still have to prove the design.

The actual previous-module probes establish: old load/save preserves unknown nested fields/count; an old fold overwrites their provenance; actual old aggregate drain sends after reassignment; isolated sidecar plus empty legacy slot is not discoverable by the old drain; the full old enqueue/reassign/drain sequence sends once while enabled and zero after its existing enabled gate is quiesced. Test-only generated keys and stub transports were used, with no live push.

## Conformance Dispositions

Latest represented reply can delay an earlier readable contribution when the latest is private. This is explicitly accepted conservative coalescing: retain pending state, never invent an old-history witness or silently discard it. It is classified as a judgment rather than a permission invariant; no new numerical quota or LLM is introduced.

Preferences use existing eventual replication. A local save or journal emission is not a claim of current global enforcement or independently recoverable copies. Disconnected/older holders and unknown queues are explicit pending/partial states in the native contract. Integration and lessons reviewers rejected expanding this personal preference card into a new global receipt/quorum subsystem. Those disclosed limitations remain real and must appear in user wording; no instantaneous mute claim is authorized.

Operator-Surface Quality is the parent for predictable reversible control and truthful saved/syncing/unsupported feedback. The inspector repeatedly rated fit weak because Apple owns layout; the independent lessons reviewer judged the server contract's truthfulness and reversal behavior a reasonable direct fit. This is a recorded author judgment, not a mechanical override of an authorization gate. The app owns layout and exact native proof.

Anonymous unbound queues have an explicit retained/quarantined disposition visible in existing status; retries cannot reconstruct erased identity. Older-summary caveats apply to unknown queues and partial/unknown delivery support even after an empty inspection. Existing quoted Chief instructions assign full suites to the normal throughput lane.

## Experience Fit

Justin's delegated request is personal mute plus reversible archive. Required contrasting cases: muted reply quiet while an authorized notice survives; archive hides only the ordinary row while direct read/session/history remain; restore returns the same chat; fixed Chief identity remains reachable; local save versus remote pending/older support remains explicit. Exact Apple build/user-channel proof is required before card completion. A source PR, API response or design report alone does not establish that journey.

## Fixed Limits And Decisions

Seventeen frontloaded decisions; zero cheap-to-change-after and zero contested-and-cleared tags. No unresolved operator decision remains. The bounded witness tradeoff was explicitly contested and retained with pending behavior, not smuggled in as an authorization necessity. Existing delivery/pagination/request retention limits are inherited. Closed statuses, priority and field domains are schema identities.

## Model Disclosure

External reviewer: actual Codex CLI gpt-6.2-astra; the author is also Codex. This is an independent CLI read, not cross-provider diversity. Gemini authentication was unavailable and Grok disabled in the installed-framework detection; no failed family was silently counted as a successful opinion. Internal reviewers inherited the session model and have no exposed exact runtime model ID; no Claude or other identifier is fabricated.

## Proportion

Six rounds on a substantial preference/notification change reached the cap. The code scope expanded only where actual old-code probes disproved safe delivery/rollback; no unrelated subsystem is added. The review cost is high relative to an ordinary mute switch, and the cap now ends document refinement so implementation can proceed.

## Left Behind

Conservative pending witnesses and existing eventual-sync semantics are accepted limits with explicit user wording, not unresolved security fixes. Full external quiet was not achieved before the cap. Runtime tests/review and exact-head verification are required. No new acknowledgment system, continuity reconstruction service or notification timer is introduced.

## Convergence Verdict

Converged at the six-round cap after concrete final corrections and independent internal security/integration/decision closure. No remaining material safety/data-loss finding or operator choice was identified. The external verdict remains honestly SERIOUS ISSUES on its reviewed pre-correction body. Echo may approve the final implementation contract under the standing feature authorization; no shipped/live/native completion claim is made.
