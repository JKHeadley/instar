# Conversation and Effort Hierarchy — Frontier Review Round 10

**Status:** fifth independent GPT/Claude check complete. Both returned `CHANGES_REQUIRED`; the exact reviewed packet is frozen, and the findings are being incorporated. This is review evidence, not a convergence claim.

## Provenance

- **GPT-6 Astra:** Codex CLI 0.164.0, `model: gpt-6-astra`, high reasoning, read-only; session `01a1a8f4-ada3-7712-877c-e9a3165739e4`. [Exact input](review-evidence/conversation-round10-input.txt), [raw result](review-evidence/conversation-round10-gpt-astra.json). Seven findings: answer recovery, three pending/sample state defects, front-door eligibility, exact question sources, and status labels.
- **Claude Opus:** Claude Code 2.1.318, `--model opus --effort medium`, no tools, streaming output; resolved model `claude-opus-5-5`, session `befc0117-4212-4d30-a861-d50b5c74297d`. [Exact input](review-evidence/conversation-round10-input.txt), [parsed result](review-evidence/conversation-round10-claude-opus.json), [raw stream](review-evidence/conversation-round10-claude-opus-stream.jsonl). Twelve findings plus one context-incomplete note. Both reviewers saw the same frozen packet, before the revisions below.

## Design changes from this pass

1. A witness-wide compare-and-swap now owns one unresolved answer attempt per logical decision occurrence. Two devices or epochs cannot send two automatic answers. A new attempt needs a witnessed terminal `not-sent` outcome, or an explicit owner override after a possible-duplicate warning.
2. A successor checks the send/outcome ledger and any authoritative platform lookup. A permanently ambiguous result becomes `Answer needs review` for an owner decision; it does not stay forever in `Checking answer` or resend automatically. A confirmed send whose decision transition cannot certify becomes `Answer needs linking` with its exact sent ref; it is never silently canceled or reopened.
3. Cancel is restricted to unsent proposals throughout the API, operation table, UI contract, and recovery path. The API returns `not-cancelable:answer-sent` for a confirmed answer. A pending front-door reassignment does not make a subsequent Move eligible until that reassignment certifies. `set-front-door` can name an eligible direct conversation or null to clear. `re-source-decision` is included in the operation table.
4. The visible label table now distinguishes unprovisioned witness (`Sync setup needed`) from temporary outage (`Sync unavailable`), and names the answer, cancellation, erasure, and aggregate Decision/Question states. Personal Archive does not suppress open attention, and All provides Unarchive.
5. The sample now uses agent-authored messages containing the actual two questions and real update-source targets; erasing one source removes that text and marks the affected question `Source needed`. Pending decision operations have occurrence keys; Cancel restores a Dismiss without touching a different answer. Queued placement overlays recompute from the certified parent. Front-door choices are eligible direct siblings under the named effort. Conflict remains visible while Resolve waits; Why here? distinguishes placement from other pending operations. A browser script exercises the reviewed failure paths.

## Limits and next check

The sample is a behavior probe, not a source-storage or platform-send implementation. The review's no-witness and ambiguous-send sample controls, exact cue copy consistency, and proof that every new design rule survives a follow-up model check are still being completed. The installed 94-standard gate retains one disclosed sleeping-machine survivability tradeoff; no zero-flag conformance verdict is claimed. The owner has been told the default responsive interpretation and can choose stricter all-machine waiting.
