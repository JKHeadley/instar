---
title: "Idle-Error Detection: Tail-Gated, Frame-Discriminated Signal (CMT-1785)"
slug: "idle-error-tailgate-corroboration"
author: "echo"
status: "draft"
parent-principle: "Signal vs. Authority"
lessons-engaged: "P2 Signal-vs-Authority (primary); P3 Migration-Parity (declined — no agent-installed file); P5 Agent-Awareness (declined — internal detector, no capability/route); P7 LLM-Supervised-Execution (foundation honesty — names the recovery actuator's tier); P18 Observation-Needs-Structure (structured counters + canary); Scrape/Parser Fixture Realness (the pane-output parser's tests use REAL captured fixtures)"
eli16-overview: "idle-error-tailgate-corroboration.eli16.md"
tracked-followups: "<!-- tracked: topic-28130 --> (1) converge detectRateLimited onto the shared paneTail.liveTail helper [topic-28130]; (2) guardian/log-sweep alert rule consuming the §5 suppressed-counter under-fire canary [topic-28130]; (3) systemic: harness-emitted structured error signal to replace pane-parsing [topic-28130]"
review-convergence: "2026-06-25T17:42:17.053Z"
review-iterations: 4
review-completed-at: "2026-06-25T17:42:17.053Z"
review-report: "docs/specs/reports/idle-error-tailgate-corroboration-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 5
cheap-to-change-tags: 1
contested-then-cleared: 1
approved: true
approved-by: "echo (under Justin's standing 24h autonomous blanket pre-approval, topic 28130, 2026-06-24 21:05 PDT — 'you have my preapproval for any decisions needed; don't wait on me')"
approved-basis: "standing-authorization — recorded transparently, not silently self-granted; convergence ran 4 rounds × (internal reviewers + codex gpt-5.5 + gemini 2.5-pro cross-model + Standards-Conformance Gate), surfacing a CRITICAL under-fire-on-the-common-error-form flaw that would otherwise have shipped; operator may revert by editing this frontmatter"
---

# Idle-Error Detection: Tail-Gated, Frame-Discriminated Signal (CMT-1785)

## Problem statement

When a session goes idle at its prompt, `SessionManager` checks whether the idle was
caused by a transient API error (so it can hand the session to the recovery sentinel
for a fast backoff→verify→escalate recovery instead of waiting out the 15m idle-kill).
The check (today, `SessionManager.ts` ~L1663) is:

```ts
const recentOutput = this.captureOutput(session.tmuxSession, 30); // last 30 pane lines
const hasError = TERMINAL_ERROR_PATTERNS.some(p => recentOutput.includes(p));
if (hasError) { /* emit apiErrorAtIdle → rateLimitSentinel.report(...,'idle-error',{errorClass:'transient-api'}) */ }
```

`TERMINAL_ERROR_PATTERNS` (11 entries: `'API Error:'`, `'invalid_request_error'`,
`'Could not process'`, `'overloaded_error'`, `'rate_limit_error'`, `'Request timed out'`,
`'Internal server error'`, `'ServiceUnavailable'`, `'ECONNREFUSED'`, `'ETIMEDOUT'`,
`'fetch failed'`) is matched with a **bare `.includes()` over the whole 30-line buffer**.

### What's wrong (framing — corrected per review)

This detector is **not an LLM gate** and is correctly a deterministic *signal-emitter*
under **Signal vs Authority** (`docs/signal-vs-authority.md`) — a brittle string detector
is *permitted* as a signal, so the goal here is **precision, not de-brittling an
authority**. (The earlier draft mis-cited a non-existent "An LLM Gate Must Not
String-Match" principle; corrected — there is no LLM gate on this path. The
`liveTail`/prose-discriminator precedent we reuse comes from `StuckSignatureClassifier`
and `detectRateLimited`, both signal-emitters.)

The precision problem: `.includes()` over the whole buffer has two false-positive modes:

1. **Stale scrollback.** The error scrolled up but is still inside the 30-line capture;
   the turn already recovered and sits at a *fresh* idle prompt. The bare match fires a
   spurious `apiErrorAtIdle`, triggering an unnecessary recovery cycle on a healthy
   session — the SAME class `StuckSignatureClassifier` fixed for "conversation too long."
2. **Quoted/structured-in-content.** The token appears as *content*, not as the session's
   terminal failure: the agent discussing an API error, a pasted error log, a failing
   integration test printing `connect ECONNREFUSED`, or — devastatingly — **the agent
   reading this very repo**, whose `TERMINAL_ERROR_PATTERNS` source literally contains
   `invalid_request_error` / `ECONNREFUSED` / `ETIMEDOUT` as string literals (a
   self-collision class instar has hit before). A `grep`/`cat` of `SessionManager.ts`
   puts three structured codes in the live tail of a perfectly healthy session.

Both produce a spurious transient-API recovery (wasted backoff/nudge budget; in the worst
case an unnecessary respawn). This path was on the critical route of the 2026-06-24 stall
(the 21:53 API-error storm), so its precision is a liveness concern for autonomous runs.

## Proposed design

Replace the bare buffer-wide `.includes()` with a **tail-gated, error-frame-discriminated**
signal. The 11 patterns stay (they are the *candidate* set); two precision gates are added
before the signal fires; the signal still feeds the **existing** recovery actuator
(`rateLimitSentinel`) and never gains blocking authority of its own.

### 1. Shared tail helper — extract, do not copy (`src/core/paneTail.ts`)

`liveTail` is currently a **private** function in `StuckSignatureClassifier.ts`, and
`detectRateLimited` carries its own tail-slice. "Reuse the shape" would create a THIRD
divergent copy (observed `tailLines` defaults already drift: 12 / 20 / 8). Instead,
extract ONE shared module:

```ts
// src/core/paneTail.ts
/** The last `tailLines` non-empty (non-whitespace-after-trim) lines of a capture, AS LINES.
 *  ONE definition of "the live tail" for every pane-signal consumer. */
export function liveTail(text: string, tailLines: number): string[]   // returns the lines

/** Strip a leading ANSI SGR run + a leading run of Claude Code line-lead glyphs
 *  (⏺ ⎿ ✻ ● │ · ❯ › ╰ ╭ ✗ and box-drawing U+2500–U+257F) + surrounding whitespace,
 *  in any interleaving, so the first *content* token is exposed. */
export function stripLineLead(line: string): string
```

**Return contract + behavior-preserving migration (review-caught).** The shared `liveTail`
returns `string[]` (the new classifier's whole-window scan needs per-line access). The existing
private `liveTail` in `StuckSignatureClassifier` returns a *joined string* its callers regex
across, so the migration is NOT a silent drop-in: `StuckSignatureClassifier`'s call-site becomes
`liveTail(capture, tailLines).join('\n')`, preserving its byte-identical string-matching, and a
**characterization test** pins its rate-limited / context-too-long / compaction classifications
unchanged before↔after the extraction. `detectRateLimited` is deliberately left as-is — it uses
genuinely DIFFERENT tail semantics (a raw `slice(-n)` over ALL lines incl. blanks + separator
strip, not non-empty-trim), so converging it would itself be a behavior change; it is legitimately
separate scope, tracked (`tracked-followups` (1)), not an orphan deferral. <!-- tracked: topic-28130 -->

### 2. New pure module: `src/core/IdleErrorClassifier.ts`

```ts
export interface IdleErrorClassification {
  isTerminalError: boolean;        // the signal: did the turn END in a transient API error?
  matchedPattern?: string;         // which TERMINAL_ERROR_PATTERN (audit)
  matchedLine?: string;            // the (lead-stripped, length-clamped) line that matched (audit)
  tailDepthFromEnd?: number;       // how near the prompt the match was (audit)
}

/**
 * Classify whether the LIVE TAIL of an idle session's pane shows a Claude-emitted
 * terminal transient-API error (the turn died on it), vs a stale/quoted mention.
 *  - TAIL-GATED: the match must be within the last `tailLines` non-empty lines
 *    (default 20 — see §Decision 1), NOT anywhere in the 30-line capture.
 *  - FRAME-DISCRIMINATED (a precise BEGINS-WITH grammar — see §Decision 2): a line
 *    qualifies ONLY via one of two tiers, evaluated on the line AFTER stripLineLead():
 *      TIER A (strong frame, fires alone): the stripped line BEGINS WITH `API Error:`
 *        (case-insensitive) — Claude Code's canonical own-API-failure render.
 *      TIER B (glyph-led terminal token): the line WAS glyph-led (stripLineLead removed
 *        ≥1 known lead glyph) AND the stripped line BEGINS WITH one of the 11 patterns.
 *    A token merely CONTAINED mid-line (prose, a quoted literal, a tool's own stack
 *    trace) qualifies under NEITHER tier and does NOT fire.
 *  - WHOLE-WINDOW SCAN: every line in the tail window is checked (not just the last),
 *    so a wrapped multi-line error whose lead line sits mid-window still matches.
 */
export function classifyIdleError(
  paneText: string,
  patterns: readonly string[],
  opts?: { tailLines?: number },
): IdleErrorClassification
```

**The begins-with grammar** replaces the earlier two-bucket (begins-with vs match-anywhere)
table — review showed that table was both incomplete (2 of 11 patterns unmapped) and wrong
for structured codes (they DO appear in benign tail content), and that a looser "contains an
error frame" rule self-contradicted (a prose line "…the API Error: 500 you saw…" *contains*
the token yet must suppress). The two-tier BEGINS-WITH rule is exhaustive over all 11 patterns
by construction and precise:
- FIRES on the real render `⏺ API Error: 500 {"type":"overloaded_error",…}` (Tier A: stripped
  line begins `API Error:`; the structured code rides the same framed line as the recorded
  `matchedPattern`).
- FIRES on `  ⎿  API Error: Internal server error` (Tier A, tool-result render form).
- FIRES on a genuine Claude network-layer drop rendered `⏺ fetch failed` (Tier B: glyph-led,
  begins with the `fetch failed` pattern).
- SUPPRESSES a prose mention `…as I mentioned the API Error: 500 you saw earlier` (not
  glyph-led; the stripped line begins with "as", not `API Error:` — neither tier).
- SUPPRESSES a tool's `Error: connect ECONNREFUSED 127.0.0.1:5432` (even rendered glyph-led
  `  ⎿  Error: connect ECONNREFUSED …`, the stripped line begins with "Error:", which is NOT
  one of the 11 patterns — `ECONNREFUSED` is mid-line — so neither tier fires; the agent's
  tool erroring is correctly not a session-API recovery).
- SUPPRESSES `invalid_request_error` as a quoted string literal when the agent reads the
  source (not glyph-led, mid-line — neither tier).

A line is "glyph-led" iff `stripLineLead()` removed ≥1 known lead glyph. The known-glyph set
is the static contract in §Decision 2, pinned by fixture tests.

### 3. Call-site change (`SessionManager.ts` ~L1663)

```ts
const cls = classifyIdleError(recentOutput, TERMINAL_ERROR_PATTERNS);
const hasError = cls.isTerminalError;
```

`recentOutput`'s capture is **widened 30 → 45 rows** (`RATE_LIMIT_SETTLED_CAPTURE_LINES`,
the value `detectRateLimited`/`SessionWatchdog` already use — see §Decision 3 for why 30 is
insufficient); the classifier reads its tail. (Widening the shared capture is safe for the
`detectRateLimited` branch above: it internally slices only the last ~20 lines, so the extra
rows it now sees are never reached — no behavior change there.) The downstream
`apiErrorAtIdle` emit → `rateLimitSentinel` handoff → bounded fallback nudge are unchanged.
The `detectRateLimited` branch above it is untouched and **still runs first** (a server
throttle correctly routes to `rateLimitedAtIdle` and never reaches the classifier — pinned
by a test in §Testing so the precedence can't silently regress).

### 4. The recovery actuator this signal feeds — foundation honesty

Signal-vs-Authority requires that a *signal* feed a real decision-maker. The honest
account: `apiErrorAtIdle` → `rateLimitSentinel.report(name,'idle-error',{errorClass:'transient-api'})`
is a **deterministic Tier-0 self-heal ACTUATOR**, not an LLM/context-rich authority. It is
NOT an information-flow gate (it blocks/leaks nothing); Signal-vs-Authority's block/allow
clause does not strictly govern a recovery loop — but the brittle signal is still safe to feed
it, for a reason STRONGER than the earlier draft claimed:

- **The actuator performs NO destructive action — there is no respawn in it.** Its real
  lifecycle (`RateLimitSentinel`) is **backoff → inject an internal nudge (`resumeFn`) → verify
  (JSONL size/mtime growth) → on exhaustion, `finalize('escalated')` = one user-facing notice**;
  separately it VETOES the SessionManager zombie-kill while a recovery is in flight
  (`isRecoveryActive`). The respawn the earlier draft invoked belongs to the SEPARATE 15m
  idle-kill path — the very path this recovery exists to AVOID — not to this actuator. So the
  worst case of a *forged or stale* error line reaching the actuator is **one wasted nudge that
  the verify step proves was a no-op, plus possibly one bounded "still can't get through"
  notice** — nothing irreversible, nothing destructive.
- **The change is monotonic-suppressing** (see Decision points), so it can only *reduce* those
  spurious nudge cycles and downstream `rateLimitSentinel.notify` notices, never add one.

Named explicitly (not asserted as "an authority") so the posture is informed: the idle-error
path has no LLM in it by design — it is a non-destructive deterministic self-heal (nudge +
verify + notice), the correct tier for "nudge a stuck session back to life" (P7: a recovery
loop declares its tier; this one is Tier-0, justified by performing no destructive action at
all and verifying before each retry).

### 5. Observability — structured counters + an under-fire canary (not a bare log)

Per P18 (Observation Needs Structure), replace the single per-suppression `console.log` with
**both-direction structured counters**, emitted **once per idle episode** (not per ~5s tick —
review caught that the suppression path does not arm `errorNudgedSessions`, so a bare log
would re-fire every tick until the 15m kill, hundreds of lines):

- A per-session `idleErrorClassified` set, armed on the first classify of an episode and
  cleared in **BOTH** places `errorNudgedSessions` is cleared — the active-session re-arm
  block AND the `sessionComplete` handler (`SessionManager.ts:743`) — guarantees one record
  per episode AND no leak on the session-death path (a session that goes idle-with-error and is
  then reaped never re-enters the active branch, so clearing only at re-arm would leak its entry
  unboundedly; full `errorNudgedSessions` lifecycle parity closes that). A test asserts the set
  is empty after such a session is killed without recovering.
- The record (to `logs/server.log`, structured fields): `{ event:'idle-error-classify',
  result:'fired'|'suppressed', matchedPattern?, reason?:'no-frame'|'outside-tail',
  tailDepthFromEnd? }`. `matchedLine` is length-clamped and newline-stripped (no log-forging).
- **Under-fire canary:** `result:'suppressed'` is the drift signal for the design's named
  real risk (a genuine error mis-suppressed by the frame gate). The counters ship in THIS
  change; the guardian/log-sweep rule that ALERTS on a *wave* of suppressions is a TRACKED
  high-priority follow-up <!-- tracked: topic-28130 --> (`tracked-followups` (2)) — the observation artifact must exist
  first (it does, here), and the alerting consumer is a separate, named commitment, not a
  vague possibility. <!-- tracked: topic-28130 -->

- **Rollout measurement criterion (the false-negative budget — codex/gemini round 2).** This
  detector couples to Claude Code's proprietary error-render glyphs, so a future UI change
  could silently weaken it. Two structural defenses: (a) the §Testing **drift test** pins the
  discriminator against the REAL captured render fixtures, so a glyph-set drift fails CI loudly
  rather than silently disabling recovery; (b) post-rollout, the §5 `fired` vs `suppressed`
  counters are the measurement — a healthy rollout shows `fired` tracking real API-error
  episodes and `suppressed` dominated by genuine stale/quoted cases. A rise in `suppressed`
  co-occurring with sessions that then hit the 15m idle-kill is the under-fire alarm the
  tracked guardian rule will watch. The accepted posture: false-negatives are the primary
  operational risk (not "merely safe degradation"). Two things bound the exposure: (i) a missed
  error degrades to the PRE-EXISTING 15m idle-kill safety net — the worst case is exactly the
  behavior before this fast-recovery path existed, never new harm; (ii) the **immediate operator
  action** if a render change is suspected is the one-commit rollback (§Rollback) — reverting to
  the bare `.includes()` restores the looser (more false-positive, never-under-firing) behavior
  in one deploy. So production exposure between a UI change and CI/drift-test detection is capped
  at "recovery is as slow as it used to be," reversible immediately.

- **Accepted residual false-positive (codex round 3).** Because Tier B fires on a glyph-led line
  beginning with a pattern, a *tool* result rendered glyph-led whose line begins with e.g.
  `fetch failed` / `ServiceUnavailable` would fire — a residual the frame discriminator cannot
  distinguish from a Claude-owned error without a render contract we don't control. This is
  ACCEPTED, not a gap: per §4 the actuator is non-destructive (the worst case is one wasted nudge
  the verify step proves a no-op), and the case is rare (a tool emitting exactly a leading
  terminal-error token under a Claude glyph). Documented so the residual is a known, bounded
  choice rather than an unexamined hole.

## Decision points touched

- **No new blocking authority; monotonic-suppressing.** The classifier returns a boolean
  SIGNAL consumed by the existing actuator. Every fire still requires the token to be in the
  tail AND on a frame line — a strict subset of "token anywhere in the 30-line buffer" — so
  the change can only SUPPRESS spurious fires, never create a NEW recovery the old code
  wouldn't also have caused. The only behavioral delta is fewer false actuations — fewer
  spurious nudge cycles and fewer downstream `rateLimitSentinel.notify` Telegram notices (a
  reduction, never an addition). (The actuator performs no respawn — see §4; the earlier
  "fewer respawns" framing was inaccurate and is corrected.)
- **Under-fire is the one real cost, treated as first-class.** A genuine error whose line is
  not frame-recognized, or that scrolled past the tail window, is missed → the session falls
  through to the 15m idle-kill + respawn instead of fast nudge-recovery. This is SAFE
  (nothing corrupted) but is precisely the liveness regression the feature fights, so it is
  mitigated head-on: (a) the frame discriminator + whole-window scan + raised tail (15) are
  pinned against REAL captured error panes (§Testing) so the common forms are NOT missed;
  (b) the §5 suppression canary makes a wave of real-error misses observable; (c) a missed
  error still recovers via the slower path — degraded liveness, never silent loss.

## Frontloaded Decisions

1. **Tail window = 20 non-empty lines (raised from 8; bumped 15→20 at build time for chrome margin — within this cheap-to-change tag), fixed; whole-window scanned.**
   Review showed Claude Code's post-error render (wrapped error box + usage line + multi-row
   prompt box) can push the `API Error:` lead line ~9–10 non-empty lines above the prompt;
   8 would under-fire. 20 has solid margin over realistic non-empty chrome (~6-12 lines after empties are filtered) yet stays well inside the 30-line capture, so the
   stale-scrollback case (error at the TOP of a 30-line buffer) is still excluded. "Non-empty
   line" = non-empty after `trim()`, via the shared `liveTail` (one definition). *Alternative
   considered:* anchor on the detected idle-prompt region (the "last turn") instead of a fixed
   count — more robust but couples the classifier to prompt detection; the fixed window +
   whole-window scan + fixture tests is chosen for simplicity and testability. (Cheap-to-
   change-after: an internal constant behind no published interface, no durable state, no
   external effect — monotonic-suppressing envelope unchanged.)
2. **Two-tier BEGINS-WITH discriminator over ALL 11 patterns** (replaces the two-bucket
   table). `stripLineLead()` removes a leading ANSI SGR run (`/^\x1b\[[0-9;]*m/`) + a leading
   run of known lead glyphs `⏺ ⎿ ✻ ● │ · ❯ › ╰ ╭ ✗` + box-drawing U+2500–U+257F + whitespace,
   in any interleaving. Then: **Tier A** — the stripped line begins with `API Error:`
   (case-insensitive) → fire (Claude's canonical own-API-failure frame). **Tier B** — the line
   was glyph-led (≥1 glyph stripped) AND the stripped line begins with one of the 11 patterns
   → fire. Begins-with (not contains) is the precision lever that kills mid-line prose/quoted
   mentions; the Tier-A/Tier-B split is what distinguishes Claude's own `API Error:` (fires
   anywhere in the tail) from glyph-led terminal tokens (fire only when Claude rendered them as
   a line lead), and correctly suppresses a tool's own `Error: …ECONNREFUSED` (begins with
   `Error:`, not a pattern). Exhaustive over the 11 patterns by construction — no per-pattern
   mapping to leave incomplete.
3. **Capture width raised 30 → 45 rows** (`RATE_LIMIT_SETTLED_CAPTURE_LINES`). Review caught a
   real, repo-evidenced flaw: `captureOutput(…, 30)` returns 30 *physical* rows, but Claude
   Code's input box + footer + tips render **15-25 rows BELOW** the `API Error:` line
   (`rateLimitDetection.ts:51` + the 2026-05-30 incident; `detectRateLimited` and
   `SessionWatchdog.checkRateLimited` both capture 45 rows for exactly this reason). That chrome
   is mostly NON-empty rows, so raising the non-empty tail to 15 does nothing if the error sits
   beyond physical row 30 — it would never be captured. Matching the proven 45-row budget clears
   the chrome; the 15-non-empty-line tail-gate then operates within it. The capture is one
   `execFileSync` either way (no new spawn — only the row count changes). A fixture test (§Testing)
   drives a full input-box+footer+tips chrome block below an `⏺ API Error:` lead and asserts the
   classifier still fires from the 45-row capture (it fails at 30 — pinning the fix).
4. **No new config / route / store.** Internal detector precision change. Migration-Parity
   (P3) and Agent-Awareness (P5) are explicitly N/A: no agent-installed file changes, no
   user-facing capability/route. Observability is the structured `logs/server.log` counters
   in §5.
5. **Multi-machine posture: machine-local BY DESIGN, monotonic-suppressing.** The classifier
   reads one local tmux pane on the host that runs the session — no cross-machine state, no
   generated URL. The actuator it feeds (`rateLimitSentinel`) DOES have a downstream
   Telegram-notify surface, but the change is monotonic-suppressing, so it can only *reduce*
   user-facing cross-machine notices, never add one. A session's pane is inherently local to
   its host; the correct posture is machine-local, declared explicitly per the Cross-Machine
   Coherence check.

## Systemic note (out of scope, acknowledged debt)

The robust long-term fix is for the harness to emit *structured* error signals (exit code /
sidecar / IPC / JSONL event) rather than every consumer parsing the terminal pane. **Why
pane-parsing now and not that:** the failure mode this addresses is an *idle-but-alive*
session — the Claude Code process is still running (no exit code to read) and the API error
is rendered into the TUI, which is the only signal available today without a harness change
we do not own. Adding a structured channel means changing Claude Code's output contract (a
cross-cutting, out-of-our-tree redesign), whereas this is a one-module precision fix to the
signal we already consume. The structured-signal redesign is a separate, larger architectural
item (`tracked-followups` (3)), named here so the debt is visible. <!-- tracked: topic-28130 -->

## Testing

**Scrape/Parser Fixture Realness engaged.** `classifyIdleError` is a new parser of terminal
pane output, so per that standard its test corpus is built from REAL captured pane fixtures
(the exact `⏺ API Error:` / `  ⎿  API Error:` constants already in the repo's fixtures —
`tests/unit/presence-proxy-honest-receipts.test.ts:21`, `StuckSignatureClassifier.test.ts:27,35`),
never hand-invented "clean" strings. There is no scrape/HTTP parser registry to enroll in (it
parses a local tmux pane, not a remote document), so the standard is satisfied by the
real-fixture corpus, not a registry entry.

- **Unit (`tests/unit/IdleErrorClassifier.test.ts`)** — both sides of every boundary, pinned
  to REAL captured render forms (reuse the exact fixture constants already in
  `tests/unit/presence-proxy-honest-receipts.test.ts`, `StuckSignatureClassifier.test.ts`,
  `context-wedge-sentinel-wiring.test.ts`, `SessionWatchdog-rate-limit-settle.test.ts`):
  - `⏺ API Error: overloaded_error` as a tail frame line → `true`.
  - `  ⎿  API Error: Internal server error` (tool-result render) → `true`.
  - a wrapped multi-row error whose `API Error:` lead line sits at depth ~12, followed by a
    realistic usage line + multi-row prompt box → still `true` (whole-window scan + tail=15).
  - **input-box-chrome capture test:** an `⏺ API Error:` lead followed by a FULL Claude input
    box + footer + tips chrome block (the `paneWithInputBox()`-style fixture from
    `rate-limit-detection.test.ts`) → fires from the 45-row capture, and is shown to MISS at a
    30-row capture (pins the §Decision-3 capture-width fix).
  - the SAME `API Error:` string scrolled to the TOP of a 30-line buffer with a clean prompt
    tail → `false` (stale-scrollback killed).
  - `"as I mentioned, the API Error: 500 you saw earlier"` mid-prose in the tail → `false`.
  - a tail quoting `TERMINAL_ERROR_PATTERNS` source (three structured codes as string
    literals) → `false` (self-collision killed).
  - a tool's `Error: connect ECONNREFUSED 127.0.0.1:5432` (not a Claude API frame) → `false`.
  - empty/null-ish pane → `false` (no crash).
  - parametrized over ALL 11 patterns: a framed line fires, a bare content line does not.
  - **Drift test:** a dedicated case asserts the discriminator fires on each REAL captured
    render fixture; if Claude Code's error-render glyphs change and a fixture stops matching,
    THIS test fails loudly in CI (the structural defense against the coupling-to-proprietary-
    render risk — a render change can never silently disable recovery).
- **Unit (call-site / `SessionManager`)** — a stale-scrollback pane drives NO `apiErrorAtIdle`
  emit; an emitted-frame-error pane drives exactly one. A pane satisfying BOTH
  `detectRateLimited` AND a terminal pattern emits `rateLimitedAtIdle` (throttle), NOT
  `apiErrorAtIdle` (pins branch precedence). The suppression record is emitted at most once
  per episode (armed/cleared with the existing re-arm block).
- **Characterization (`tests/unit/monitoring/StuckSignatureClassifier.test.ts`)** — the
  existing rate-limited / context-too-long / compaction-suppression classifications are asserted
  byte-identical after `StuckSignatureClassifier` migrates to the shared `liveTail(...).join('\n')`
  — the guard that the helper extraction is behavior-preserving (§1).
- **Integration (`tests/integration/`)** — the `apiErrorAtIdle` → `rateLimitSentinel` wiring
  still fires end-to-end on a REAL glyph-prefixed emitted-error pane (no regression), and does
  NOT fire on a stale-scrollback pane.
- **E2E (`tests/e2e/idle-error-classifier-lifecycle.test.ts`)** — the Tier-3 lifecycle proof,
  mirroring the production init path: construct `SessionManager` the way `server.ts` does (with
  the real `apiErrorAtIdle` → `rateLimitSentinel.report(...,'transient-api')` listener wired),
  drive the monitor loop against a stubbed `captureOutput` returning a REAL glyph-prefixed
  emitted-error pane, and assert the sentinel actually receives one `idle-error`/`transient-api`
  report — and that a stale-scrollback pane drives ZERO. This is the "is the feature alive on
  the real wiring, not just the unit" proof the Testing-Integrity standard requires; there is no
  HTTP route so the assertion is on the wired emit, not a 200 (the standard's intent — a
  production-path lifecycle test — is met, the literal "returns 200" is the inapplicable form).

## Rollback

Single-commit revert: restore the bare `.some(includes)` line (and the 30-row capture), delete
`IdleErrorClassifier.ts` + tests + the suppression counters + the `idleErrorClassified` clears,
and revert the `StuckSignatureClassifier` import of the shared `liveTail` (the `paneTail.ts`
extraction is behavior-preserving, so its revert is mechanical). No migration, no durable state,
no config. Purely a precision-narrowing of an existing in-process detector — and, per §5, the
revert IS the immediate operator action if a Claude-render change is ever suspected of
under-firing.

## Open questions

*(none)*
