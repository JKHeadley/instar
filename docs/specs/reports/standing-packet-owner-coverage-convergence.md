# Convergence Report — Restore owner framing and current work to standing packets

## Cross-model review: codex-cli:gpt-6.2-astra

The GPT reviewer ran and produced substantive findings. Independent reviewers covered security, adversarial framing, scalability, integration, decision completeness, and standards.

## ELI10 Overview

The Chief of Staff recovery packet had no owner quotes because sender rows carried the raw Telegram ID while the binding recognized the profile ID. Its limited space then went to bare ledger identifiers. The repaired packet recognizes exact direct owner messages and keeps space for framing, recent words and current work.

## Original and revised design

Review required live checks for staged output, source corrections, current session authentication for full continuation, and a pointer version older hooks reject. A retired file path cannot reopen a protected continuation. The app rebuilds it when the current session is authorized.

## Iteration Summary

| Round | Review | Findings and disposition |
| --- | --- | --- |
| 1 | In-process independent security, GPT | New source join requires direct provenance, real-owner rotation must invalidate all staged output, and derived summaries are historical. Fixed and tested. |
| 2 | In-process integration and decision reviewers, GPT | Version pointers, recheck row bytes and provenance, use the indexed topic/message lookup, and choose the whole-framing boundary. Fixed and tested. |
| 3 | In-process targeted recheck, GPT | Protect the on-demand continuation, bind to the live session, retire legacy paths, and document local owner revocation and protected key namespace. Live route and HTTP controls implemented. |
| 4–5 | GPT and independent review of the merged checkout | The same hook buffer is emitted after the check. The continuation rebuild already checks the signed topic and session name together. The existing watermark writes rows before cursor advancement and resets positions above its database maximum. These code-path facts are now explicit in the spec. |

Standards-Conformance Gate ran using the submitted markdown after the worktree path returned 404. It checked 102 standards and returned six advisory flags. Cross-machine revocation follows the current machine binding. The change adds no manual refresh requirement on a connected machine. The prioritization and ceiling flags concern inherited limits and deterministic recovery constraints. The complete rendered candidate counts all omission and continuation text, rejects whole candidates that cannot fit, and offers the existing ordinary recovery fallback.

## Proportion

Tier 2. This touches attribution, protected recovery, generated hooks, and real-server wiring.

## Left behind

A machine that has not received an ownership update continues under its local binding. Historical derived descriptions and already delivered session copies are outside quote-authority revocation. An unrelated replacement SQLite database with overlapping row positions keeps the existing TopicMemory recovery contract.

## Full Findings Catalog

- Owner transfer and inferred alias unlinking can preserve old classification. Current owner source checks and a changed binding fingerprint revoke fresh and staged attribution. Independent reviewer confirmed both corrections.
- Source provenance or bytes can change with the owner binding unchanged. Version-two pointers record exact source row references and revalidate both before either Claude hook emits the bytes. The exact lookup uses the unique topic/message index.
- Older hooks ignored added pointer fields. They reject version two. Scope applies to future deliveries and restored files should not include legacy raw copies.
- An old raw continuation path could bypass a later ownership check. Production packets now point to the server's authenticated rebuild, which tests the signed topic set, exact running session/topic assignment, and current session environment in one flow. The HTTP regression verifies wrong-topic and retired-session refusals plus a changed-owner read with the original token.
- Ledger-only references previously exhausted the reduced packet. Both full and keep budgets operate on complete rendered candidates. The full packet uses the existing 500-entry live ledger view and discloses older entries outside it. A framing quote without room for H1 remains whole with explicit omission. Emoji sizing and an active ledger flood are covered.
- Profile and source row coordinates use the existing agent/chat namespace, topic and channel message ID. SQLite cursor IDs are only local. The test uses different local insertion order and identical quote text. The relabel test advances the old cursor, starts under a different binding from row zero, and resumes after interruption.
- Staged bytes are captured once, checked by hash, and emitted from the same buffer. The Python fixture checks authenticated hash confirmation and both real generated Claude hooks exercise owner rotation. The current local binding becomes authoritative when the ownership update reaches that machine.

## Convergence verdict

The merged-checkout independent review found no remaining material issue in the incremental change. The external reviewer raised representation and existing recovery boundaries that the spec now explicitly describes. The local implementation remains subject to exact-head checks and shared verification.
