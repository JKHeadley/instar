# Side-effects review — Time Awareness Component 4 (signal-only reporting nudge)

**Spec:** `docs/specs/ROBUST-SESSION-TIME-AWARENESS-SPEC.md` §Component 4 (converged + approved, merged as #681; Component 4 was deferred to v1.1, tracked #682 — now built). **Tracks:** #682.

**Change:** one new check (signal-only) appended to the pre-messaging `convergence-check.sh` gate (`src/templates/scripts/convergence-check.sh`). If an outbound message asserts the **session/run is done/over** (or "winding down" / "wrapping up the session/run") while a **live autonomous record** (`.instar/autonomous/*.local.md`, `active: true`) still has **>10% of its time-box remaining**, it emits a one-line SIGNAL to `logs/time-awareness-signals.jsonl` + stderr. This guards the exact wind-down-early incident class that started the time-tracking work.

## What it touches
- `src/templates/scripts/convergence-check.sh` ONLY (the pre-messaging quality gate, run by `grounding-before-messaging.sh`). One appended block + nothing else changed.
- Reaches existing agents automatically: convergence-check.sh is **always-overwritten on migration** (`PostUpdateMigrator` line ~4122, "Convergence check — always overwrite") + installed by `init`. No new migration code needed. New agents get it via the same install path.

## Side effects & blast radius (deliberately minimal — P2 Signal vs Authority)
- **SIGNAL-ONLY: it NEVER blocks or rewrites the message.** The block does NOT touch `ISSUE_COUNT` or the exit code — the existing checks 1-8 and the gate's exit logic are untouched. A premature-completion assertion still SENDS; the operator just gets a side-channel signal. (Verified: exit 0 in all test scenarios, including when the signal fires.)
- **Never quotes the agent's phrase.** The signal carries the computed fact (`≈NN% of the time-box remains`) only — never the "done/over" wording — so it can't be re-read as self-confirming evidence the run is finished (the adversarial-round-2 sink requirement).
- **Signal sink = operator log + stderr, never the agent's injected context.** On exit 0 the grounding hook does not surface convergence-check output to the agent, so the signal does not pollute context. The JSONL log is the durable operator record.
- **Targeted regex** (session/run/sprint-level completion + winding-down/wrapping-up-the-session) — chosen to avoid false-positives on subtask reports ("this PR's tasks are complete"). Even a false positive is low-cost (one log line; never blocks). Only fires when an `active: true` record with >10% remaining exists, so non-autonomous messaging is never touched.
- **Portable date math** via the python3 already used by the script's URL-provenance check (no new dependency). Reads the record directly — no server call (the convergence-check host is pure-bash by design).
- **Inline fallback NOT modified:** `getConvergenceCheckInline()` is a degraded "template-missing" safety net already divergent from the template (it lacks check 8 too); newer checks live in the template only by established pattern, and there is no template==inline drift test. The template is the canonical always-used source.

## Tests (golden, 5; all green; 66 convergence-check tests total green — no regression)
`tests/unit/convergence-check-time-awareness.test.ts` — runs the REAL template script: (1) done-assertion + >10% remaining → SIGNAL in log + stderr, computed %, no phrase-quote, exit 0 (not blocked); (2) no assertion → silent; (3) <10% remaining (genuine near-end wrap-up) → silent; (4) record not active → silent; (5) no record at all → silent. `bash -n` + `tsc` clean.
