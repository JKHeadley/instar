---
title: "Restore owner framing and current work to standing packets"
slug: "standing-packet-owner-coverage"
author: "Echo Context Budget"
parent-principle: "Attributed Statements Trace to Their Source"
review-convergence: "2026-11-27T11:33:00.784Z"
review-iterations: 5
review-completed-at: "2026-11-27T11:33:00.784Z"
review-report: "docs/specs/reports/standing-packet-owner-coverage-convergence.md"
cross-model-review: "codex-cli:gpt-6.2-astra"
single-run-completable: true
frontloaded-decisions: 6
cheap-to-change-tags: 0
contested-then-cleared: 2
approved: true
approved-by: Echo Context Budget after independent review of owner rotation and source provenance
---

# Restore owner framing and current work to standing packets

## Problem statement

Studio stored direct owner messages under their Telegram sender ID without an internal profile ID. On a multi-person installation the standing corpus could reject that representation even when the configured owner and owner profile both carry the same Telegram account. Topic 141385 consequently had no operator rows. Independently, pending ledger entries with no bound words could fill the delivered packet before the current-work summary was considered.

## Proposed design

Keep the identity repair inside the protected corpus. A raw Telegram sender key without a resolved person ID can join to the owner only when it exactly matches both the configured Telegram owner and the owner profile's Telegram ID. Preserve the corpus's sender-origin and forward exclusions. The corpus fingerprint changes version and incorporates the exact join, so ordinary bounded refresh reclassifies existing rows. General memory authority keeps its own resolver.

The delivered budget gives first priority to the framing quote, then current work, recent and bound protected rows, other summaries, and finally identifier-only ledger lines. Protected quotes still fit whole. Disclose omitted content and offer a conversation-bound full rebuild on demand. Apply the same current-work priority to the bounded pre-compaction instructions.

## Decision points touched

- Raw sender identity join — invariant; basis: enumerable-domain; evidence: a configured Telegram account and the owner profile must hold the same numeric ID, and the source row must explicitly be direct. Display names and ambiguous provenance cannot establish the owner.
- Staged quote validation — invariant; basis: irreversible-consequence; evidence: emitting text under the wrong owner attribution cannot be withdrawn from session history. Source authority, exact bytes and current staged hash must all agree. A version-two pointer is rejected by the older hook parser.
- Packet order — judgment-candidate; floor: only whole verified quotes and all omission counts, with ordinary recovery when no packet verifies; arbiter: the repository's existing deterministic reducer under the Chief of Staff's product decision. Exemption from runtime model arbitration: recovery executes while context is unavailable and cannot make an additional model call. Framing, current work and recent words take precedence over identifier-only entries. The fixed four examples per section are informative metadata, with all omissions counted and the full packet available.
- Hook timing and delivered budget — invariant; basis: external-constraint; evidence: the existing loopback confirmation uses a two-second network timeout, and the existing recovery fitter must leave room for identity and recovery inside Claude's 10,000-character limit. Retain the existing 6,000 UTF-16-code-unit delivery budget including headings, notices and read lines.
- Full continuation — invariant; basis: irreversible-consequence; evidence: a saved plain-text path would let a session reopen text after authority changed. The request must carry a signed token for the topic and match the current destination session credential. Build and verify after that check, send with no-store, and retire the previous raw paths on boot.
- Quote reference work ceiling — invariant; basis: enumerable-domain; evidence: ordinary assembly considers at most 500 ledger entries, 20 recent turns and three framing messages. The 550-reference limit bounds malformed pointer work and admits the maximum packet produced by these sources.

## Multi-machine posture

Anchor, ledger and summary records keep the layer store's existing replication path. The corpus listing and its watermark are rebuilt from the current machine's TopicMemory because their row IDs belong to that SQLite database. Revocation takes effect on a machine when its live configured owner and corresponding profile reflect the transition. Delivery checks that local authority snapshot. A machine that has not received an owner change still operates under its previous snapshot. An operator who needs a transfer to take effect across disconnected machines must use the existing access and session isolation controls before allowing recovery on those machines. The current layer transport is agent-scoped and uses the agent's configured Telegram chat as its namespace. Inside that namespace, protected references use the Telegram topic and channel message ID plus the UTF-16 length and SHA-256 of the source text. They do not use a SQLite row ID. Upon a fingerprint change, the first ordinary refresh restarts at local row zero, and each successful bounded batch persists the new fingerprint and local row position. A restart with the same fingerprint resumes from that persisted position. The private replay of a single topic is acceptance evidence and is never replicated or deployed.

## Verification

Use fixtures for agreeing owner identity, a conflicting person ID, a mismatched profile, a changed fingerprint, and a ledger flood. Replay a one-topic private snapshot of Studio 141385 through the production corpus, anchor selector, assembler, and verifier. Require a verbatim anchor, recent owner messages, and H1. Publish no private test input.

## Open questions

None.

## Owner changes during recovery

When a real owner profile exists, the corpus no longer admits a historical operator key as owner authority. The new raw Telegram join also requires explicit non-forwarded provenance. The standing packet checks present-day source authority when building and verifying anchor, decision, and recent quotes. A staged recovery or keep file carries the owner-binding fingerprint and exact protected-row references. A current check confirms the row still has owner authority and its bytes are unchanged. Version-two pointers make older hooks reject the file. Claude's generated recovery and pre-compaction hooks confirm the exact staged hash against the live local server before emitting text. A rejected recovery uses the existing ordinary context path. A rejected keep file emits no steering. Codex builds and verifies its packet inside the request that offers it. The async proposal path retains the destination credential and exact-packet recheck.

The strict local replay accepts 144 current owner rows, one framing quote, fourteen recent quotes and H1 at 5,948 UTF-16 code units, below the 6,000-unit cap. It contains no unbound ledger lines. The independent second pass confirmed that explicit owner rotation and inferred alias unlinking invalidate old staged output.


## Content priority and authority

Only verified protected spans assert whose words are quoted. The H1 current-work section gives the recorded goal, recent trend and themes with their freshness timestamp. H2 and H3 summarize broader work. These generated descriptions are derived historical context and carry no current-owner authority. An owner transfer invalidates already staged text on each machine as its live binding changes. Fresh assembly may reuse derived descriptions with their existing author and freshness stamps while omitting every protected span whose authority no longer matches. It never converts derived text into an owner quote.

The budget tries whole framing quotes first. Admission measures the complete rendered candidate, including omission counts and any required read line. If even that candidate exceeds the budget, the quote is omitted whole and the final packet discloses the omission. A framing quote that fits this check can still leave too little room to add H1. In that case H1 is listed as omitted, and the recovery packet includes the full-packet read line. The bounded pre-compaction instructions also name the omission. The usual case fits both the framing and H1 ahead of bare references.

The binding protects future quote attribution. Existing scope and session isolation policies govern any transfer that also requires historical data separation.


## Full continuation

The reduced production packet points to the current full-packet route. It does not expose a persistent raw-quote file. The authenticated local server checks the exact destination against the active session and rebuilds the packet against current authority and source text. Following an earlier route instruction after rotation receives current verified content or a refusal. A session that already received the earlier text may still retain it in its own history.


## Existing boundaries retained

The hook reads recovered text into one bounded byte buffer, hashes that buffer, asks the server to confirm the hash, and prints the same in-memory bytes. It never reopens the text path after confirmation. The pre-compaction hook uses the same read-once pattern.

Full continuation means the complete verified packet for that rebuild, within the existing 500-entry ledger view. If 501 live entries match, the first 500 may appear, the ledger note counts the one older entry beyond the listing and points to the existing anchor route. Rendering never makes the continuation an unbounded ledger export.

Corpus refresh persists each successful row before advancing its in-memory cursor and then atomically writing the watermark. A failed row stops the pass before it. A crash before the watermark write replays the bounded batch from the earlier cursor. Existing per-row keys and matching classification/hash checks make replay idempotent.

The exact Telegram fallback compares the canonical ASCII sender key formed from a numeric Telegram ID with the same key derived from the configured owner and existing owner profile. Row references hash UTF-8 bytes and separately store UTF-16 length. For example, a literal 🎯 contributes four UTF-8 bytes to SHA-256 and two UTF-16 code units to the packet budget.

The continuation uses one signed payload for both checks. Its topic list must include the requested topic, and its session name must match the running session currently assigned to that same topic. The runtime then matches the supplied credential against that session's exact current incarnation. The existing corpus refresh resets its cursor when it finds a saved row position above the live database maximum. Replacing a database with an unrelated database that has overlapping row positions is a broader TopicMemory recovery case. This change does not introduce a new reliance on that recovery operation or change normal restart and reclassification.

## Maturation plan

- **test-agent-live:** Exercise direct owner identity, source correction, pre-compaction, recovery and authenticated continuation in disposable test homes.
- **dev-agent-live:** Use the existing standing-packet switch and verify the rebuilt packet and upgraded hook pair on the Studio after the reviewed release.
- **fleet:** Follow the existing context layer rollout. Agents without standing recovery enabled do not start delivering it.
- **graduation criterion:** Verify the owner framing, recent words and current work under budget, plus rejection after owner or source changes on both hooks.
- **dark-window:** This repairs current standing recovery behind its existing switch. The separate proposed-purpose pilot remains disabled.
- **ladder:** Reuse the contextBudget.layers ladder and its existing feature evidence.

## Approved project anchors

Persist the verified Telegram owner account at the time an approved project anchor is stored. Use the existing Telegram owner verifier and require an exact current-account match whenever the production standing packet reads the registry. A legacy approval without an account binding, or an approval from a different account, is missing for recovery. The current owner can approve an original direct message under the usual authenticated route and project version check. The anchor digest already checked on staged recovery must fail if its anchor no longer resolves. PreCompact steering excludes project anchors, while Codex recovery evaluates the registry at seed creation.
