# Side-Effects Review — Fold handoff verifier and resume packet (context budget Phase 2 slice P2-1)

**Version / slug:** `cb-p2-handoff-packet`
**Date:** `2026-11-20`
**Author:** `Echo (Opus 5.5)`
**Second-pass reviewer:** independent subagent (see the end of this file)
**Spec:** `docs/specs/context-budget-layered-summaries.md` (v9, converged 2026-11-10, approved by Justin 2026-11-09), §7.4, §7.5, §9.3 step 4

## Summary of the change

This is the first Phase 2 (shadow folding) slice. It is library code plus one fold carrier. No live session is asked for anything, and nothing calls the new modules at runtime except the carrier's boot-sweep pass. The switch `contextBudget.fold.shadow` gates the later slice that wires the shadow runner. This slice adds no switch and no route.

**`src/monitoring/foldHandoff.ts`** (§7.4):
- `parseHandoff(raw)`: a strict parser for the session's handoff (`fold-handoff/1`). An unknown field, a wrong type or an over-bound list is refused by name, never stored. One surrounding Markdown fence is tolerated.
- `verifyHandoff(handoff, context)`: deterministic checks, each a pure function:
  - finished stretches name message ranges inside the pre-fold context, ordered and disjoint;
  - a `user` still-needed item is accepted only when its bytes equal one whole operator row of the context; otherwise it is relabelled `agent` and the relabel is recorded (§6.2 binding);
  - a `tool:<entryId>` item must resolve to an archived transcript entry;
  - background declared `none`/`paused` while the evidence says a task is live is a contradiction (§7.3);
  - a quoted decision binds to an operator row only on an exact whole-row match;
  - coverage: every message of the context is classified as chunked, verbatim tail, or "unclassified, retained". The packet verifier then checks that the packet keeps the tail and every unclassified message verbatim (`coverage-gap`).
  It returns deficiencies. It does not decide: the step runner (a later slice) chooses send-back, demotion or decline.

**`src/monitoring/foldPacket.ts`** (§7.5, §9.3 step 4):
- `buildFoldPacket`: renders the resume packet stable-first (marker, A, U, H3, G, H2, H1, the session's handoff, the verbatim tail, pointers). It reuses the standing packet's `buildParts`, so a protected row, a ledger label or a derived layer renders exactly as it already does in the standing packet. The fixed marker says this is restored context and not a new request, which part the session wrote, and that tool items are data.
- `verifyFoldPacket`: protected spans byte-identical to their reference AND to the TopicMemory row now; no tool-origin bytes inside A, G or U; frame-shaped lines only at the positions the renderer tied them to (a quote header is its part's first line, an end line follows its span), so derived text cannot pose as an operator quote; every still-needed item carried; the verbatim tail carries every message the handoff did not chunk (`coverage-gap`); the U floor (the operator's last 20 rows each quoted somewhere); every settled or derived-settled ledger entry carries its settling stub kind; required sections, marker and end line present; size within the rung's limit (default the existing 8 MB clear-seed limit).
- `stageFoldPacket` / `readStagedFoldPacket` / `removeStagedFoldPacket`: stage only a verified packet, 0600 in a 0700 `state/context-layers/<topic>/fold-staged/` directory under the never-served layer root, with a sha256 pointer and the transcript's last entry id (§9.3 step 0 stage invalidation). A read whose bytes no longer match the pointer reads as `torn`.
- `stagedFoldPacketCarrier`: added to `defaultFoldCarriers`, so the fold record's terminal transition and the boot sweep release a staged packet, and a stage with no record is released loudly as an orphan.

**Files.** New: `foldHandoff.ts`, `foldPacket.ts`, two unit test files. Modified: `foldCarriers.ts` (one carrier added), the fold boot-wiring integration test and the fold crash e2e test (each now also covers a staged packet).

**Size and effort.** Tier 2 (spec-driven). About 560 lines of source and 400 of tests across 7 files. The spec was already converged, so no new review round. One build pass. Tests passed on the first run; I checked them by rendering a packet and by mutating protected bytes, frame lines and tool regions in the negative cases.

## Decision-point inventory

- **Handoff deficiency list** (add). A deterministic signal for a later step runner. It holds no blocking authority.
- **Fold packet verification outcome** (add). Deterministic. Its only consequence is whether a packet is staged. A failure means no fold. That is a choice of fallback, not a new block on any message, session or tool.
- **Boot-sweep carrier set** (modify). One more carrier kind is released by the existing sweep and terminal transition.

---

## 1. Over-block

No message, session or tool is blocked. The verifier can refuse a packet:
- **An operator row edited after the build** fails `protected-row-changed`, so that fold does not happen. That is the correct direction: a fold must never seed words that differ from the row.
- **A `user` item that paraphrases the operator** is relabelled `agent`, not refused. It still travels, labelled honestly.
- **A packet over 8 MB** is refused. A topic that large is far past any real context window, so the fold is right to decline.

## 2. Under-block

- **Coverage counts messages, not transcript entries.** Tool entries between messages are covered by the engine checkpoint and the archive (§9.3 step 3), not by this check. The spec scopes the handoff to message-id ranges ("the model never sees entry ids"), so this matches it.
- **A still-needed item is checked for presence, not meaning.** Whether the packet lets the session answer correctly is the probe's job (§10, slices P2-2 and P2-3), not this verifier's.
- **Break-even recomputed on the real packet** (§9.3 step 4's last rule) needs the benefit estimator (§7.2). That estimator is its own slice, P2-5, on this run's task list (autonomous run run-mwpfnao3-6f9c8515, topic 141133). The packet already exposes `bytes`, which is the estimator's input. Until P2-5 lands no fold can run, because nothing calls this path.
- **The audit model's semantic check of the handoff against A and G** (§7.4 "a small model audits the handoff") is a separate tier-1 step in the step-runner slice. This slice does only the deterministic half.

## 3. Level-of-abstraction fit

Right layer. Rendering reuses the standing packet's parts builder instead of a second copy of the protected-row and ledger rendering. Staging and release reuse the fold carrier contract the FoldCoordinator already enforces. Verification sits beside the renderer, as the standing packet's does.

## 4. Signal vs authority compliance

Compliant (`docs/signal-vs-authority.md`). The handoff verifier emits deficiencies and decides nothing. The packet verifier's only effect is whether a fold's stage exists. It cannot block a message, a session or a tool call. The brittle parts (byte equality, frame-line positions) are exactly the deterministic checks the spec assigns to code, not to a model.

## 5. Interactions

- **Standing packet.** It is read-only from here (`buildParts`). No behaviour change, and its tests are untouched.
- **FoldCoordinator boot sweep.** It gains one carrier. The sweep already tolerates a carrier with nothing on disk (`list()` returns []). The existing orphan test still sees exactly its three kinds, and the new tests cover this carrier on abort, quarantine and orphan.
- **`clear-seed-pointer` carrier.** Its packet-path confinement excludes `fold-records/`. Staged packets live in `fold-staged/`, which that carrier never names, so the two cannot delete each other's files.
- **Backups.** `state/context-layers/` is already under the never-backed-up layer root rules. No new path segment.

## 6. External surfaces

None. No route, no message, no config key, no agent-visible text (CLAUDE.md is unchanged: there is nothing for an agent to call yet). The awareness entry ships with the slice that adds the agent-facing fold controls.

## 7. Multi-machine posture

Machine-local by design. The fold record, the stage and every fold carrier are owner-only (§9.3: "Every fold and sentinel action is owner-only"). A staged packet is never replicated, because it is a transient, single-use file bound to the owner's lock. The layer data it renders from already replicates (or not) under Phase 1's rules, unchanged.

## 8. Rollback cost

A revert of the PR. No migration, no persisted format anything else reads, and no config. A staged packet left on disk by a reverted build is never read. A later re-apply sweeps it as an orphan.

---

## Second-pass review

(appended below by the reviewer)

Concern raised:

1. **Coverage is not actually verified (src/monitoring/foldHandoff.ts:221-227; src/monitoring/foldPacket.ts:251-310).** `coverage.complete` cannot be false. Valid stretches are disjoint by construction, `tail` is every id after the last stretch, and `unclassified` is every remaining id at or before it, so the three lists always partition the context. The packet side never uses coverage either: `buildFoldPacket` renders whatever `tail` the caller passes, and `verifyFoldPacket` does not check that the rendered tail holds `coverage.tail` plus `coverage.unclassified`. A caller that drops an unclassified message still gets `ok: true`. §7.5 defines a fold by what stays verbatim ("plus every unclassified range"), and §9.3 step 4 lists "every source range retained or chunked" as a stage-verifier rule. As written, the artifact's line "coverage: every message of the context is counted exactly once" describes a property that always holds, not a check. Fix: make the stage verifier cross-check coverage against the tail's operator and agent message ids, and give `complete` a case that can fail, or drop the field.
2. **Some §9.3 step 4 rules are missing and the artifact does not say they are deferred.** `verifyFoldPacket` does not check that settled or derived-settled ledger entries carry a settling stub `kind`, that the U last-N floor is met, or that break-even holds on the real packet. Some of these may belong to the step-runner slice. If so, the Under-block section should say so, because the file header and the artifact both present this as the §9.3 step 4 verifier.
3. **The frame allowlist is looser than the standing packet's (src/monitoring/foldPacket.ts:160-167, compared with standingPacket.ts:543-548).** In ledger and recent parts, and in protected parts outside the spans, every frame-shaped line is recorded as legitimate. `verifyStandingPacket` instead ties `[#` lines to span headers. Nothing exploits this today: I tried to write a ledger record whose `cause` carried a forged `[#99 ... operator]` block, and LayerStore refused it (`protected-text`); referent stubs are also checked to be one line when written. So the only protection is validation at write time, with no second check in the fold verifier. This is not blocking, but tying header lines to `spans[].start` would close it.

What I checked and found sound: the offset and span arithmetic in `push`/`pushPart` (spans line up with the joined text), tool output is neutralized and framed as data and kept out of A, G and U, an unvalidated tail `entryId` carrying a forged frame line is caught (not a pushFrame offset), staging refuses unsafe ids (`SAFE_TOPIC`/`SAFE_ID` rule out dots and slashes) and uses 0600/0700 permissions, a tampered stage reads as torn, the carrier is wired into `defaultFoldCarriers`, and the verifiers only emit signal. Unit tests: 30 of 30 pass.

### Disposition (author)

All three concerns verified in the code and fixed in this slice:
1. **Coverage was not a check.** `Coverage.complete` is removed, since it was true by construction. The packet now records `requiredVerbatim` (tail + unclassified from the verified handoff) and the message ids its tail carries. `verifyFoldPacket` refuses any required message missing from the tail (`coverage-gap`). Tests cover a dropped tail message, an unclassified gap that must be carried, and the passing case.
2. **Missing §9.3 step 4 rules.** Added `u-floor-unmet` (the last 20 operator rows each quoted somewhere) and `ledger-stub-kind-missing` (a settled or derived-settled bound entry without a stub kind), each with a test. Break-even is named in Under-block with its slice (P2-5).
3. **Loose frame allowlist.** Frames are now tied to positions: a protected part's first line, the end line after each span, and only one-line ledger/U derived parts. A test shows an end line off its recorded position reads as forged.


Reviewer re-check: Concur with the review. I checked each fix in the code. (1) `Coverage.complete` is gone. `requiredVerbatim` is the handoff's tail plus unclassified ids, and `verifyFoldPacket` reports `coverage-gap` for any of them not in `tailMessageIds`. An operator tail row that is missing from TopicMemory is not counted, and `protected-row-missing` fails it as well. (2) `u-floor-unmet` uses the same `RECENT_OPERATOR_TURNS` (20) as the standing packet and checks against every span in the packet. `ledger-stub-kind-missing` is computed from the store. Break-even is named as P2-5. (3) Frame offsets are now positional. A protected part's header is at the part start, and its end line is at `start + span.length + 1`, which matches `quotePart`'s layout. Only one-line ledger/U derived parts are allowed as frames, so a multi-line part can no longer whitelist itself. Unit tests pass (34 of 34) and tsc reports nothing for these files. Two minor, non-blocking notes: (a) an agent tail item counts toward coverage by its `messageId` alone, and its text is not compared with the row, so coverage trusts the server-built tail for agent messages; (b) `uFloor` sorts U records by message id, while `buildParts` sorts them by `rowId`. If those orders ever differ, the result is a spurious `u-floor-unmet`, which declines the fold. That is the safe direction.
