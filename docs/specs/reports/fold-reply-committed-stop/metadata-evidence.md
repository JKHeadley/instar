# Practice-fold reply completion: metadata evidence

Inspected on 2026-11-22 PST. This is local empirical evidence, not a published Claude Code format guarantee. No Claude requests were made. No transcript message text, hook commands, or private paths are copied here.

## Observation

A metadata-only scan of all 268 files matching `~/.claude/projects/*/*.jsonl` found 483 assistant records with `message.stop_reason` equal to `end_turn` or `stop_sequence`. It found 63 `system` / `stop_hook_summary` records: 22 on Claude Code 2.1.329 and 41 on 2.1.330. Every summary's backward `parentUuid` chain reached an assistant record with `stop_reason: end_turn`. No record belonging to that same assistant `message.id` was observed later than its summary.

The 63 immediate backward-chain shapes were:

| Count | Backward chain from summary to assistant |
| --- | --- |
| 15 | `hook_success` attachment, assistant |
| 39 | `hook_non_blocking_error` attachment, assistant |
| 7 | assistant directly |
| 1 | `hook_blocking_error` attachment, synthetic user, `hook_success` attachment, assistant |
| 1 | `hook_blocking_error` attachment, synthetic user, assistant |

All 63 summaries had `preventedContinuation: false`. Both summaries with a linked `hook_blocking_error` had `failedHookErrorIndexes: []` and were followed by an assistant conversational record. Therefore neither `preventedContinuation === false` nor an empty `failedHookErrorIndexes` proves that the response was accepted. Conversely, all 39 nonblocking-error summaries had nonempty failed indexes. An empty-index requirement would reject ordinary completion and would still accept both observed blocked attempts.

The two synthetic user entries in blocking chains had `isMeta: true`, string message content and their own UUID/parent UUID. A blanket rule that any non-tool-result user closes the request would prematurely close these blocked attempts; a blanket rule that all meta users are safe to ignore would be too permissive.

Seven summaries had `hasOutput: false` and linked directly to the assistant, so neither hook output nor an individual `hook_success` is necessary when the aggregate summary exists. The other 56 summaries had `hasOutput: true`.

## Synthetic shapes

These are constructed examples using invented IDs and placeholder text, not transcript excerpts.

Successful completed message, with aggregate summary:

```jsonl
{"type":"user","uuid":"request-1","parentUuid":"prior","message":{"role":"user","content":"[internal: context-budget handoff request, request nonce-1; ...]"}}
{"type":"assistant","uuid":"answer-1","parentUuid":"request-1","message":{"id":"message-1","role":"assistant","content":[{"type":"text","text":"<handoff JSON>"}],"stop_reason":"end_turn"}}
{"type":"attachment","uuid":"hook-1","parentUuid":"answer-1","attachment":{"type":"hook_success","hookEvent":"Stop"}}
{"type":"system","subtype":"stop_hook_summary","uuid":"summary-1","parentUuid":"hook-1","hookCount":6,"failedHookErrorIndexes":[],"preventedContinuation":false}
```

Blocked attempt despite apparently reassuring summary flags:

```jsonl
{"type":"assistant","uuid":"attempt-1","parentUuid":"request-1","message":{"id":"message-1","role":"assistant","content":[{"type":"text","text":"<first attempt>"}],"stop_reason":"end_turn"}}
{"type":"user","uuid":"hook-feedback-1","parentUuid":"attempt-1","isMeta":true,"message":{"role":"user","content":"<hook-generated feedback>"}}
{"type":"attachment","uuid":"block-1","parentUuid":"hook-feedback-1","attachment":{"type":"hook_blocking_error","hookEvent":"Stop"}}
{"type":"system","subtype":"stop_hook_summary","uuid":"summary-1","parentUuid":"block-1","hookCount":8,"failedHookErrorIndexes":[],"preventedContinuation":false}
{"type":"assistant","uuid":"attempt-2","parentUuid":"summary-1","message":{"id":"message-2","role":"assistant","content":[{"type":"text","text":"<revised handoff>"}],"stop_reason":"end_turn"}}
```

A tool-result user is distinguished by structured message content consisting entirely of `tool_result` blocks. It continues the same user-request turn. A real user input can contain text, images or mixed blocks; it closes the old request scope. The meta user in the blocked example is neither a normal user input nor a tool result. It should be recognized only as part of the exact linked blocking-attempt chain, never by the text of its feedback.

## Recommended fail-safe contract

1. Before injection, open the exact transcript and capture its identity and byte length. Arm one request-specific reader before sending the request, with a fresh opaque request nonce. If identity/offset cannot be established, decline without injecting. Never use a bounded sliding tail that can lose the request boundary and then accept another matching header.
2. Read only complete appended records from that offset, within the existing 4 MiB total append bound and original wall-clock bound. Identity change, truncation, coverage loss, malformed records, duplicate UUID ambiguity or missing ancestry yields unknown/decline, never a reply. The arm offset must be a record boundary, otherwise a partial pre-arm record can be misread as post-arm evidence.
3. Match the exact injected request, preferably its exact expected text as well as the nonce, once. Freeze that request record UUID. Do not reopen after a later user input or a later repeated copy of its header. Reject an intervening unrelated user input before the match rather than scanning past it for a convenient request.
4. A candidate answer must belong to the matched request's parent-linked turn, be the newest completed assistant message of that turn, and have terminal `end_turn` or `stop_sequence`. Join text records only for the exact same assistant message ID, in record order, with all required ancestry present; never collect arbitrary recent assistant text.
5. Require a linked `system/subtype=stop_hook_summary` for that candidate. Traverse the summary's parent chain to that candidate, allowing only the expected structural record kinds. A linked `hook_blocking_error` invalidates that attempt. Known meta feedback can bridge only the linked blocked attempt; wait for the next terminal assistant message and its own unblocked summary. An ordinary later user input closes the old scope.
6. Individual hook success, event-arrival order, apparent stable text over 250 ms, wall-clock quiet and reassuring summary flag values are not substitutes. Polling may wake the reader, but only transcript structure can produce acceptance. With a summary after all records of a message, timing-based stability confirmation is unnecessary.
7. Accept only the candidate justified by the newest available request-scoped branch. A newer assistant message, another user input or unknown intervening control structure already visible in the same read must not be ignored in favor of an older valid-looking summary. No hook payload text fallback. The existing handoff parser, verification and audit still run afterward.
8. Every completion/cancel/timeout is owned by one wait object. Its completion removes only itself and closes its open file handle/timers. A late read from an expired wait must never settle a replacement wait. Bound each wait once; repeated signals do not extend its deadline.

## Availability limit and uncertainty

420 of 483 terminal assistant records had no linked summary in this sample (360 on 2.1.330 and 60 on 2.1.329). Some can be incomplete/open transcripts or sessions that never emit such summaries; this inspection does not establish why. Thus summary-only acceptance is conservative but has a substantial potential availability cost. Absence cannot be treated as success. Older/different transcript formats remain unqualified. The initial runtime qualification must demonstrate that the actual practice-fold target emits an unblocked summary and yields a parsed complete handoff; otherwise the feature should stay off, report the missing completion evidence, and stop waiting at its bound.

This scan covers main transcript files only, not nested subagent transcripts, and is not evidence of every producer/version. Parent-chain evidence is structural provenance inside one transcript, not a defense against an actor able to rewrite that transcript. Files were read from live disks and may grow during inspection; figures are a snapshot.

## Adversarial review of the recommendation

- A hook success can arrive before another hook blocks: requiring the aggregate summary plus scanning its linked chain avoids the early-success race.
- Summary flags can look clean while a block resumes the model: the two real blocked examples prove that explicit linked blocking attachments must decide this boundary.
- A pasted or quoted request ID can select the wrong answer: arm-time offset, exact expected injection, frozen UUID and no reopening after real user input prevent convenient rematching.
- Partial request text at the captured offset can corrupt parsing: require a newline boundary or decline before injection; never silently skip an uncertain leading record.
- A summary for an earlier assistant message can coexist with a newer in-progress message: newest-branch checking must keep the reader pending, not accept the older message.
- A synthetic meta user can either falsely close a blocked turn or accidentally permit a real interruption: only the narrow linked blocking structure gets special treatment. Unknown user/meta structures fail safely.
- A disconnected/sidechain summary can resemble completion: require `isSidechain !== true`, exact session identity where present and a complete backward chain to the chosen candidate and request.
- A rotated file or sliding tail can lose the true request and expose a copied one: retain file identity/offset and never rematch; abort on lost coverage.
- A final summary can be absent indefinitely: timeout/decline is honest. Do not regain availability by returning to hook text or a quiet-period heuristic.

## Follow-up: exact synthetic-feedback and last-record invariants

For the 63 summaries, the nearest assistant ancestor was always the last chronological record of that message ID. Twenty-two candidates had two assistant records sharing their message ID; 41 had one. No summary pointed to an earlier record while a later same-message record was already present. This supports the strict invariant: the nearest assistant ancestor of a summary must be the current candidate's last linked assistant record UUID, not merely an arbitrary record with the same message ID. Unknown variations remain unavailable.

A narrow mechanical rule for recognized blocking feedback is: a main-thread user record has `isMeta === true`; a subsequent main-thread attachment has `attachment.type === 'hook_blocking_error'`, `attachment.hookEvent === 'Stop'` and `parentUuid === feedback.uuid`; both occur in the complete backward ancestry from the same aggregate Stop summary to the candidate's last assistant record. Only that known blocked-attempt chain may bridge such a user. The blocked candidate is not accepted. If the parser sees the meta user before its linking attachment/summary is appended, it must stay pending without accepting earlier text or irreversibly closing the scope; when later bytes show an ordinary user or incompatible structure, the attempt closes. Do not recognize feedback from its text, from `isMeta` alone, from summary flags or from a loose UUID lookup outside the selected branch.

A deterministic streaming contract is simpler than selecting an old answer from a whole snapshot: process appended complete records in order; before the first qualifying summary, the candidate is the latest assistant message; when its own aggregate summary has a complete clean ancestry, capture it once. A real user input before this completion closes the request. Records after this accepted summary cannot retroactively invalidate the captured reply, even if the same filesystem read happened to include them. This rule reconciles newest-message selection with the draft's explicit non-retroactivity clause. If instead the design chooses whole-snapshot newest-message selection, it must remove that streaming acceptance claim and test the resulting delay behavior; do not leave the selection policy ambiguous.

The request matcher should not scan past unrelated new user input before finding a later matching header: an unrelated user before the injected request means the captured boundary no longer identifies the expected next request and should abort. Matching the full generated injection text as well as nonce/header is stronger than matching only the first line and is still a protocol equality check rather than semantic judgment.

## Assembly qualification — external round 3 follow-through

A fresh metadata-only scan of the same 268 files checked record content-block types and compared text strings only internally (no text was emitted or retained). All 63 summary-linked assistant message IDs have exactly **one text-bearing record**. The 22 two-record messages are `thinking` followed by `text`; the remaining 41 are one `text` record. There are no pairs of text-bearing records to classify as equal snapshots, prefix-cumulative snapshots, or disjoint fragments. Those relationships are unobserved, not proven absent from the producer protocol.

The broader scan grouped all assistant records by transcript-local `message.id`:

| Measure | Count |
| --- | --- |
| All assistant message IDs | 689 |
| All assistant records | 1,339 |
| Assistant records with zero text blocks | 921 |
| Assistant records with exactly one text block | 418 |
| Assistant records with multiple text blocks | 0 |
| Message IDs with multiple text-bearing records | 0 |
| Terminal assistant message IDs | 293 |
| Terminal message IDs with `thinking` then `text` | 192 |
| Terminal message IDs with one `text` record | 101 |
| Terminal message IDs with exactly one text-bearing record | 293 |

The earlier total of 483 terminal *records* is consistent with 293 terminal message IDs: multiple same-ID records can both carry a terminal stop reason. Do not mistake them for separate final answers or text fragments.

### Supported assembly contract

Return the sole text block from the sole text-bearing record of the selected assistant message. Preceding same-ID thinking-only records are permitted when their UUID ancestry is valid. The last linked record of this message must be the supported text-bearing record and must carry the terminal stop reason. A summary must point back to that last record as already specified.

Do not concatenate multiple text-bearing records, deduplicate equal strings, infer cumulative snapshots from prefixes, or insert a separator between supposed fragments. More than one text-bearing record or multiple text blocks in one record is an unsupported assembly shape and must decline rather than return partial/altered text. This is a deliberate qualification limit, not proof that the producer can never emit these shapes. Any future extension needs controlled producer evidence first.

### Synthetic fixture shapes

All values below are invented. The two supported shapes are:

```jsonl
{"type":"assistant","uuid":"thinking-1","parentUuid":"request-1","message":{"id":"answer-1","role":"assistant","content":[{"type":"thinking","thinking":"<synthetic reasoning>"}],"stop_reason":"end_turn"}}
{"type":"assistant","uuid":"text-1","parentUuid":"thinking-1","message":{"id":"answer-1","role":"assistant","content":[{"type":"text","text":"{\"synthetic\":true}"}],"stop_reason":"end_turn"}}
```

or one text-only assistant record with its parent equal to `request-1`. Both require a later qualifying aggregate summary. The returned string is exactly `{"synthetic":true}` from that one text block; no reasoning is copied, no separators are manufactured.

Negative fixtures should include two same-ID text records with equal text, later-prefix-cumulative text, reversed prefixes and disjoint text; all are unsupported regardless of string relationship. Include one record containing two text blocks as another unsupported shape. This explicitly prevents a future implementation from treating the unobserved assembly mode as guessed concatenation.
