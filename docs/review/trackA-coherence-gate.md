# Track A: Coherence Gate Granularity

## Summary
The coherence gate is a multi-layer system with surprising configurability at the reviewer level, but coarser controls at the feature level. Individual hooks are installed unconditionally but can be selectively disabled. The 9 specialist reviewers support per-reviewer enable/disable and per-channel configuration.

---

## A1: Can individual coherence hooks be enabled/disabled independently? [VERIFIED]

**Location:** `src/core/PostUpdateMigrator.ts:174-191`, `src/commands/init.ts:3549-3574`

Hooks are installed **unconditionally** during init/migration — there is no per-hook config flag. However, they can be independently removed by editing `.claude/settings.json`:

- `claim-intercept.js` — PostToolUse hook on `['Edit', 'Write', 'Bash']` matchers
- `claim-intercept-response.js` — Stop hook
- `response-review.js` — Stop hook

**No single `coherenceGate: true/false` toggle controls all of them.** Each hook is a separate entry in settings.json. The `response-review.js` hook has its OWN runtime check: it reads `config.responseReview.enabled` and exits silently if false (PostUpdateMigrator.ts:3103-3114).

---

## A2: Can I enable ONLY false-claim-detection without full response-review? [VERIFIED]

**Yes.** The claim-intercept hooks operate independently from response-review:

1. Keep `claim-intercept.js` (PostToolUse) and `claim-intercept-response.js` (Stop) in settings.json
2. Set `responseReview.enabled: false` in config.json — this disables `response-review.js` at runtime
3. Or remove `response-review.js` entry from settings.json entirely

The claim hooks do NOT depend on the response-review pipeline running.

---

## A3: The 9 specialist reviewers [VERIFIED]

**Location:** `src/core/CoherenceGate.ts:537-547`, `src/core/reviewers/` (9 `.ts` files)

The specialists are **separate LLM calls** executed in **parallel** via `Promise.allSettled()` (line 327):

1. `conversational-tone`
2. `claim-provenance`
3. `settling-detection`
4. `context-completeness`
5. `capability-accuracy`
6. `url-validity`
7. `value-alignment`
8. `information-leakage`
9. `escalation-resolution`

**Per-reviewer configuration (types.ts:1559):**
- `reviewers[name].enabled` — disable individual reviewers
- `reviewers[name].mode` — `block` / `warn` / `observe`
- `reviewerModelOverrides[name]` — per-reviewer model override
- `reviewerCriticality[name]` — criticality level

**Per-channel configuration (types.ts:1572):**
- `ChannelReviewConfig.additionalReviewers` — channel-specific reviewers
- `information-leakage` auto-skipped for primary-user channel (line 593)

**You CAN pick which specialists run** via the per-reviewer `enabled` flag.

---

## A4: Full LLM call chain when coherenceGate is ON [VERIFIED]

**Location:** `src/core/CoherenceGate.ts:188-469`, `src/core/SendGateway.ts:108-235`

| Step | LLM Calls | Model | Timeout | Purpose |
|------|-----------|-------|---------|---------|
| 1. Stop hook fires | 0 | — | — | Posts to `/review/evaluate` |
| 2. Gate triage | **1** | `gateModel` (default: haiku) | 5s | "Does this need full review?" |
| 3. If YES → specialists | **9** (parallel) | `reviewerModel` (default: haiku, per-reviewer override) | 8s each | Domain-specific review |
| 4. Verdict aggregation | 0 | — | — | Apply decision matrix |
| **Total worst-case** | **10** | — | ~13s | |

If the gate triage says NO (lines 310-321), it's just **1 LLM call** and response passes through.

---

## A5: Confidence/threshold setting [VERIFIED]

**Location:** `src/core/CoherenceGate.ts:380-396`, `src/core/types.ts:1524-1556`

**No numerical confidence scores.** The system uses discrete verdicts:

- Reviewers return `pass: true/false` (boolean)
- Violations have `severity: 'block' | 'warn'`
- **Warn escalation threshold** (default: 3): if >= 3 warns, escalates to BLOCK
  - Configurable: `warnEscalationThreshold` in `ResponseReviewConfig` (types.ts:1544)
- PEL `hard_block` is absolute — always blocks regardless
- Timeout on high-criticality reviewer → escalates to BLOCK (line 388)

---

## A6: Session/job exemptions from review [INFERRED]

**Location:** `src/core/CoherenceGate.ts:200-209`, `src/core/SendGateway.ts:163-189`

**Built-in exemptions:**
- Messages < 50 chars → skip gate (SendGateway line 189)
- System/bridge messages → PEL-only review (SendGateway line 163)
- `observeOnly: true` → never blocks (types.ts:1530)

**Channel-level config:**
- `skipGate: true` → skip gate triage (types.ts:1566)
- `failOpen: true` → fail-open on review errors (types.ts:1565)

**Per-job/session exemption: NOT directly supported.** No way to whitelist specific job slugs or session IDs. Workaround: set `observeOnly: true` globally (logs but never blocks).
