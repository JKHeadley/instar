# Side-Effects Review — S-1 NovelFailureReviewer

**Version / slug:** `s1-novel-failure-reviewer`
**Date:** 2026-05-16
**Author:** echo
**Second-pass reviewer:** not required (Tier-3 LLM-driven module; proposes only, cannot promote)

## Summary of the change

Adds `src/remediation/NovelFailureReviewer.ts` — the bottom-up signature-discovery module per spec §A18, §A10, §A26, §A57 Tier-3. Watches the audit projection for `no-matching-runbook` entries, clusters by signature, summarizes recurring patterns via a Haiku-class LLM, and emits proposals for human approval. Cannot author runbooks itself — proposals require an `/instar-dev` commit + spec-converge approval to become runbooks. 17 unit tests cover all behaviors. Small extensions to `Remediator.ts`, `TrustElevationSource.ts`, `audit/AuditProjection.ts`, and `audit/AuditWriter.ts` expose the read-only APIs the reviewer needs.

## Decision-point inventory

- `src/remediation/NovelFailureReviewer.ts` (new) — **add** — clustering + LLM summarization + proposal generation. Propose-only authority.
- `src/remediation/TrustElevationSource.ts` (modified) — **modify** — adds a `dismissProposal` predicate path requiring `collaborative` trust per §A26.
- `src/remediation/audit/AuditProjection.ts` (modified) — **modify** — exposes `readUnmatchedSince(cursor)` for the reviewer's tick loop.
- `src/remediation/audit/AuditWriter.ts` (modified) — **modify** — emits `remediation.novel-failure-reviewer.*` events through the same writer.
- `src/remediation/Remediator.ts` (modified) — **modify** — one-line API surface for cluster-counter introspection.

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

- LLM output that's schema-valid but conservative (e.g., suggests `UNKNOWN_NETWORK_FAILURE`) is accepted regardless of whether it's the *best* code — the gate is structural, not quality. This is intentional.
- Collisions with existing runbook prefilters are auto-rejected (no slot consumed per §A26 R3). False-positive collisions on common substrings would mean a legitimate proposal is suppressed; mitigated by the strict prefilter-equality check (not substring match).

## 2. Under-block

**What failure modes does this still miss?**

- An LLM that returns schema-valid output containing injected misleading text past the URL/code-fence/imperative-verb filter. The 200/400 char limits + tier-3 human-review boundary contain damage; rendering is in a clearly-marked "Untrusted LLM-summarized content" frame.
- Coordinated audit-log pollution: if an attacker can inject enough no-matching-runbook entries to cross the 3-occurrence × 2-lifetime × 14-day threshold for a chosen signature, they can shape a proposal. Mitigated by §A12 audit-token enforcement (forged entries route to `audit-rejected.jsonl`, not `audit-projection`); the reviewer reads only verified entries.

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The reviewer reads audit projection (read-only signal) and emits proposals (writes to a per-machine proposals directory). It cannot mutate the runbook registry, cannot dispatch attempts, cannot suppress alerts. The line between "execute" and "propose" is structural — the reviewer's only write surface is `proposals-<machineId>/` and the cluster-counters file. Promotion requires crossing a different authority boundary (`/instar-dev` commit + spec-converge).

## 4. Signal vs authority compliance

**Does this hold blocking authority with brittle logic, or does it produce a signal?**

Pure signal-producer. LLM-summarized proposals are explicitly marked as untrusted human-review artifacts. The runbook registry validator (in F-8) is the authority; the reviewer feeds candidate signatures into a human-gated approval path. Compliant with `docs/signal-vs-authority.md`.

## 5. Interactions

**Does it shadow another check, get shadowed, double-fire, race?**

- **Cluster threshold + per-signature persistence (§A47):** counters live at `.instar/remediation/cluster-counters-<machineId>.json`. LRU-capped at 500 distinct signatures. 1k-entry tail kept for forensic display. No race with the audit writer (read-only consumer; writes its own state file).
- **Outstanding-proposal cap (≤3, §A10):** queue overflow is silent. New proposals beyond the cap are tracked in counters but not LLM-summarized until a slot frees.
- **LLM monthly budget (§A65):** pauses LLM calls when cumulative spend ≥ budget. Backoff on LLM failure: 1h → 6h → 24h.

## 6. External surfaces

**Does it change anything visible to other agents, other users, other systems?**

- New state files under `.instar/remediation/`: `cluster-counters-<machineId>.json`, `proposals-<machineId>/<proposalId>.json`, `llm-raw-<machineId>.jsonl` (30-day TTL per §A26 R4).
- Per §A14 backup/sync taxonomy: cluster-counters and llm-raw are per-machine, NOT git-synced. proposals are git-synced read-only history (Dashboard S-2 surfaces them).
- LLM call: outbound to the configured `llmModel` (default haiku-class). Subject to §A65 monthly budget cap.

## 7. Rollback cost

**If this turns out wrong, what's the back-out?**

- Delete `src/remediation/NovelFailureReviewer.ts` + tests.
- Revert the small API additions in `TrustElevationSource.ts`, `AuditProjection.ts`, `AuditWriter.ts`, `Remediator.ts` (each <15 lines).
- The Tier-3 dashboard sub-section (S-2, future PR) is the only consumer. No runtime path depends on this module yet.
- State files at `.instar/remediation/cluster-counters-*` and `proposals-*/` are forensic-only; safe to delete.

## Trust elevation

`dismissProposal` requires `collaborative` trust + audit-logged principal identity. Per-agent dismiss rate-limit: 10/hour (enforced in the reviewer module).

## Side-effects on adjacent systems

- No HTTP routes, no Telegram surfaces, no dashboard wiring yet (S-2 is the consumer).
- Audit projection: read-only consumer; reviewer's own writes go to `audit-projection` via the standard AuditWriter path (verified-append per §A12).
- Backup/sync: A14 paths honored. F-7's `addGitignoreEntry` step already includes `cluster-counters-*` and `llm-raw-*`.
