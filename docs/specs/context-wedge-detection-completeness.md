---
title: "Context-wedge detection completeness — make the LIVE recovery engine fire for the scrolled-out-banner wedge"
slug: "context-wedge-detection-completeness"
author: "echo"
status: draft
approved: false
supersedes: "context-limit-wedge-recovery.md (WITHDRAWN — it proposed a NEW ContextWedgeSentinel family that DUPLICATED the live SessionRecovery engine; caught in spec-converge round 1, reviewer adbfa439 + author re-grounding)"
parent-principle: "The Agent Is Always Reachable — a session that fast-fails every turn at the context wall until a human manually /compacts is not reachable; the recovery engine EXISTS and runs live, but its DETECTION misses the persistent post-wedge state"
lessons-engaged:
  - "Verify the State, Not Its Symbol (the fix is to persist the WEDGED STATE once observed, so a transient banner that scrolls out of the capture window does not drop the detection — the state is the wedge, the banner is only its momentary symbol)"
  - "Foundation grep evidence (this spec's §1 lists the capability-level grep that the WITHDRAWN spec skipped — grounding against ALL implementations of context-exhaustion recovery, not the one component the author anchored on)"
  - "Reuse Before Rebuild (the /compact→respawn ladder, attempt cap, cooldown, in-flight-reply capture, and the 2026-06-06 false-positive framing guard ALL already exist in the live engine; this spec adds ONLY detection persistence — no second engine, no double-compact race)"
  - "No Unbounded Loops (P19: the fix rides the EXISTING SessionRecovery attempt cap + cooldown; the persisted wedged-state has a bounded TTL and is cleared on genuine progress)"
  - "Distrust Temporary Success (the persisted wedged-state clears ONLY on a genuine output delta BELOW the banner, never on a transient repaint)"
single-run-completable: true
---

# Context-wedge detection completeness

## 0. Why this spec exists (and what it replaces)

The context-wall wedge hit the interactive session TWICE in apprenticeship Drive 7: the session fast-failed every turn at "Context limit reached · /compact or /clear to continue" until the operator MANUALLY sent /compact (~55 min unanswered the first time). A first spec (`context-limit-wedge-recovery.md`) proposed adding a THIRD `context-limit` family to `ContextWedgeSentinel` with its own /compact→respawn recovery ladder. **That spec was WITHDRAWN in spec-converge round 1** — the reviewer AND the author's own re-grounding found it duplicated a **live-by-default recovery engine that already implements the exact ladder**. This spec is the correctly-grounded redirect: the recovery already works; the DETECTION misses the persistent post-wedge state. Fix the detection, reuse the engine.

## 1. Verified foundation (capability-grep evidence — the step the withdrawn spec skipped)

**Grep run (the foundation audit at capability level, not one component):**
```
grep -rl "detectContextExhaustion\|context.*limit\|conversation too long" src/
→ QuotaExhaustionDetector.ts, SessionMonitor.ts, SessionRecovery.ts, server.ts, StuckSignatureClassifier.ts, guardManifest.ts …
grep -rn "detectContextExhaustion" src/
→ defined QuotaExhaustionDetector.ts:161; called SessionMonitor.ts:287, SessionRecovery.ts:270, server.ts:11085
```

What that grep establishes (all verified against origin/main v1.3.889):

- **`QuotaExhaustionDetector.detectContextExhaustion(tmuxOutput)`** (`QuotaExhaustionDetector.ts:161`) — detects the wall via `CONTEXT_PATTERNS` (banner strings: `context.*limit`, `conversation too long`, `press esc twice…`) with a **hard-won 2026-06-06 false-positive framing guard** (the bare phrase "conversation too long" without CLI recovery framing does NOT fire — born from the topic-13435 flood where a session working ON the feature self-amplified one false positive). Returns `{matched, pattern, confidence}`.
- **`SessionRecovery.recoverFromContextExhaustion`** (`SessionRecovery.ts:533`) — the LIVE recovery ladder: **Rung 1 `/compact`** (`attemptCompaction`, `server.ts:11070` — presses /compact, polls ≤30s, verifies `!detectContextExhaustion(out).matched`, detects "error during compaction") gated on `!hasActiveProcesses`; **Rung 2** kill + fresh respawn with in-flight-reply capture; plus an **attempt cap** (`shouldAttempt`/`maxAttempts:3`/`cooldownMs:15min`).
- **Trigger:** `SessionMonitor.checkSession` (`SessionMonitor.ts:287`) calls `detectContextExhaustion(currentOutput)` on every poll, where `currentOutput = captureSessionOutput(sessionName, 30)` (**30-line window**, `:257`). `SessionRecovery.enabled` defaults **true** → this engine is LIVE now, not dark.
- **`ContextWedgeSentinel`** (`ContextWedgeSentinel.ts`) — a SEPARATE engine for two OTHER fast-fail families (`thinking-block-400`, `aup-rejection`), both recovering via DESTRUCTIVE respawn. It owns the "Cooked for 0s" / "API Error … latest assistant message" fast-fail signatures — which `QuotaExhaustionDetector` does NOT have.

## 2. Root cause (code-grounded, symptom-consistent)

The live engine keys on the wall **BANNER** inside a **30-line capture window**. After the wedge, each fast-failed turn ("Cooked for 0s") emits NEW lines, scrolling the original banner **up and out of the 30-line window**. `CONTEXT_PATTERNS` has **no fast-fail signature**, so `detectContextExhaustion(last-30-lines)` returns `matched:false` on the persistent post-wedge tail → the live /compact engine **never fires** → the wedge persists until a manual /compact.

**Why this is the cause, not a guess:** Rung 1 fires on `!hasActiveProcesses`, and a fast-fail wedge runs no child process. Had the engine DETECTED the wedge it would have auto-/compacted (no manual /compact needed). The operator needed to /compact manually → detection missed it → the banner was not in the scanned window. The withdrawn spec's "idle-gate skips the mid-turn wedge" premise was FALSE (the gate is `!hasActiveProcesses`, which a fast-fail wedge PASSES). **Empirical validation step (Verify the State, Not Its Symbol):** confirm against the actual Drive-7 pane capture if still on disk (≈2 days old; may be rotated) before the live flip; the code-level argument is strong but the capture is the ground truth.

## 3. Proposed design — persist the wedged STATE (add detection persistence, reuse the engine)

### 3.1 The change (small, one detection layer)
Add a per-topic **wedged-state latch** in the `SessionMonitor` context-exhaustion path (feeding the SAME `detectContextExhaustion` → `SessionRecovery` trigger, unchanged):
- **Set:** when `detectContextExhaustion(currentOutput).matched` is true for a topic, record `contextWedgedSince[topicId] = now` (alongside the existing `contextExhaustionCooldowns`).
- **Hold:** on a subsequent poll where the 30-line window NO LONGER contains the banner (it scrolled out) BUT the session is still fast-failing, the latch keeps the topic classified as wedged, so `SessionRecovery.checkAndRecover` is still invoked — the recovery the banner-detection would have triggered is not dropped just because the banner scrolled out.
- **Clear:** the latch clears ONLY on a **genuine output delta below the banner** — the pane tail advanced with NEW non-fast-fail content (real work resumed / the /compact landed / a fresh prompt is accepting input). A transient repaint never clears it (Distrust Temporary Success).

### 3.2 The load-bearing safety precondition (reviewer M-D)
The latch MUST be gated by an **active-work-indicator negative check** — `looksActivelyWorking`/`looksGeneratingNow` (`sentinelWiring.ts:171`: spinner / "esc to interrupt" / a live subagent). A session genuinely mid-long-tool-call at high context (a build, a big grep, a subagent) can show the banner as a status hint while STILL working; it must NEVER be /compacted out from under live work. The latch sets/holds ONLY when the active-work indicators are absent (a true fast-fail wedge shows no spinner). This is the protection the withdrawn spec wrongly discarded as "coarse."

### 3.3 What is REUSED unchanged (no second engine)
The `/compact`→respawn ladder, the `!hasActiveProcesses` Rung-1 gate, the attempt cap (`maxAttempts:3`/`cooldownMs:15min`), the in-flight-reply capture, and the 2026-06-06 false-positive framing guard — ALL unchanged. This spec adds ONLY detection persistence. **Explicitly REJECTED:** a new `ContextWedgeSentinel` `context-limit` family with its own ladder (the withdrawn design) — it would create two engines watching the same pane, two attempt caps, and a double-compact/double-respawn race.

## Multi-machine posture

The context-exhaustion detection + recovery act on **THIS machine's own tmux sessions** — a pane wedge is a local phenomenon; only the machine holding the pane can capture its output or send-keys /compact. Same posture as the existing detector/recovery. No cross-machine surface is introduced (the latch is per-topic in-memory monitor state on the owning machine, rebuilt from the live pane on restart — it is a cache of an observable, not durable authority).

machine-local-justification: hardware-bound-resource

## 4. Testing (Testing Integrity — all three tiers)

- **Unit:** (a) banner in window → latch SET; (b) banner scrolls out of the 30-line window while fast-fail tail persists + no active-work indicator → latch HELD → recovery still invoked (the core fix); (c) genuine output delta below the banner → latch CLEARED; (d) active-work indicator present (spinner/subagent) → latch NOT set even with banner visible (no compact out from under work); (e) the existing attempt cap still bounds repeated recovery (re-wedge after /compact → cap → escalate, not loop).
- **Integration:** a simulated wedged session whose banner scrolls out drives ONE /compact via the EXISTING `SessionRecovery` path (metadata-only audit row); the recovery engine is invoked exactly once per the cap.
- **E2E:** the detection-persistence is alive on a dev agent in the existing monitor path (logs the held-wedge classification) — "feature is alive."

## 5. Deployment, migration, rollback (Maturation + Migration Parity)

- The DETECTION persistence is default-on housekeeping (it only changes WHEN the existing engine is invoked, gated by the active-work precondition — it never adds a new destructive action). The RECOVERY it triggers is the existing staged `SessionRecovery` path (already live-by-default with its own cap), so no new rollout stage is introduced; the active-work precondition is the safety.
- Migration Parity: the change is in built-in monitor code (always-overwritten on update); no per-agent config migration. Agent Awareness: update the CLAUDE.md "Stuck-Context Recovery" section — RECONCILE, do not append: the existing note says the context-wall recovery presses /compact first; add that detection now PERSISTS across a scrolled-out banner so the mid-turn wedge is covered.
- Rollback: a config flag (`monitoring.contextWedgeLatch.enabled`, default on) disables the latch → detection reverts to banner-in-window-only (today's behavior); no regression, a wedge then needs a manual /compact exactly as before.

## Frontloaded Decisions

- **FD-A (persist detection, do NOT build a new recovery engine):** the /compact ladder exists and runs live; the gap is detection dropping when the banner scrolls out. Reversible (config flag).
- **FD-B (clear the latch ONLY on genuine progress, not a repaint):** Distrust Temporary Success — a transient frame change is not recovery.
- **FD-C (active-work-indicator precondition is mandatory):** the latch never fires while spinner/subagent indicators are present — the protection against compacting live work (reviewer M-D).
- **FD-D (empirical validation before live flip):** confirm the scroll-out mechanism against the real Drive-7 pane capture if available; the code argument is strong but the capture is ground truth.

## Decision points touched

- **The wedged-state latch (§3.1) — `invariant` (deterministic state machine).** Set on banner-match, hold while fast-failing + no active-work indicator, clear on a genuine output delta. No LLM authorizes it; it is a regex + a bounded-TTL latch feeding the EXISTING recovery trigger. Justification: this is exactly the "static rule at a deterministic detection point" the Judgment-Within-Floors standard permits — the input (banner present / fast-fail tail / active-work indicator / output delta) is structurally observable, not a competing-signals judgment.
- **The recovery action itself — unchanged, owned by `SessionRecovery`.** Its existing classification (compact-vs-respawn on `!hasActiveProcesses`, capped) is not modified by this spec.

## Open questions

*(none)*
