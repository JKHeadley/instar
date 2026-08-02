# Side-Effects Review — Cartographer Non-Git Structural Snapshot

**Version / slug:** `cartographer-non-git-structural-snapshot`
**Date:** `2026-08-01`
**Author:** `instar-codey`
**Second-pass reviewer:** `not required`

## Summary of the change

Zero-cost boot population now preserves the freshly scaffolded filesystem hierarchy when the configured project root has no Git HEAD. That snapshot is explicitly labeled `structural-only`, carries real node and never-authored counts, and reports summary freshness as unknown. The normal detect and cost-bearing author sweep retain the existing named Git refusal.

## Decision-point inventory

- `snapshotOnly Git failure` — modify — return a usable structural aggregate instead of replacing a completed scaffold with empty refusal counts.
- `ordinary/sweep Git failure` — pass-through — still refuses as `detect-git-error`; no author candidates or paid work can be produced.
- `snapshot route classification` — modify — `structural-only` is a present hierarchy, while genuine timeout/start/index/Git failures remain `detect-failing`.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

No block/allow surface — over-block not applicable. Snapshot-only population accepts one additional honest result shape; the semantic sweep's refusal contract is unchanged.

## 2. Under-block

**What failure modes does this still miss?**

The structural fallback cannot recover a scaffold that itself fails, an unreadable/oversized index, or a worker timeout/start failure; those remain named failures. A root with unreadable Git metadata is intentionally limited to structure: it cannot classify an authored summary as fresh or stale, and it cannot produce author candidates.

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The generic detect worker already owns the conversion from a freshly scaffolded index into a bounded read snapshot. Preserving filesystem counts there keeps all consumers on the existing cached-snapshot path. The HTTP layer only classifies the explicit result status; it does not repeat index or Git analysis.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

This change publishes an observe-only structural signal. It does not gate user intent, messages, dispatch, provider selection, or paid work. The semantic sweep's existing Git refusal remains its own hard data-integrity floor.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The result is a mechanically enumerable state: the index was freshly scaffolded and can be counted, while Git-backed freshness is unavailable and therefore remains `null`.

## 5. Interactions

- **Shadowing:** none; Git-backed snapshots remain authoritative when Git is available.
- **Races/double-fire:** unchanged; the one boot population promise still owns scaffold then snapshot publication.
- **Feedback loops:** none; the snapshot is read-only and schedules no retry or author work.
- **Failure recovery:** timeout, worker-start, unreadable-index, and oversized-index behavior is unchanged. Only the expected no-Git shape gains a bounded structural result.

## 6. External surfaces

Health, stale, and compact-tree reads expose the additive `structural-only` status. Existing agents gain a corrected machine-local snapshot after update and restart. The change writes only the existing Cartographer index/snapshot state, depends on no conversation timing, and has no network, provider, LLM, billing, notification, or operator-action path.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable. The existing read APIs expose more honest state but add no dashboard form, approval surface, or operator action.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design. The snapshot describes one host's filesystem root and may differ across machines. No replication or one-voice messaging is involved.

It emits no user-facing notices, holds no topic-transferable durable state, and generates no URLs. Each machine should report its own filesystem hierarchy rather than replicate another machine's map.

## 8. Rollback cost

- **Hot-fix release:** revert the code change and publish the next patch.
- **Data migration:** none; the snapshot schema already carries a string detect status.
- **Agent state repair:** none; the next boot rewrites the cached snapshot.
- **User visibility:** rollback would restore the prior false zero/detect-failing report at non-Git roots until the correction is reapplied.

## Conclusion

The correction preserves structural truth without weakening the authoring sweep's Git safety floor. Part A remains local and zero-cost; Part B remains disabled and untouched.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. The correction does not add or modify a self-triggered controller; it changes the bounded result produced by the existing one-shot boot population and introduces no retry, restart, notification, or autonomous action.
