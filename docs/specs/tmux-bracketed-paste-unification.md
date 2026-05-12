---
title: "Tmux Injection Unification — Bracketed Paste + Post-Inject Verification"
slug: "tmux-bracketed-paste-unification"
author: "echo"
review-iterations: 5
review-convergence: "2026-05-12T00:30:00Z"
review-completed-at: "2026-05-12T00:30:00Z"
review-report: "docs/specs/reports/tmux-bracketed-paste-unification-convergence.md"
approved: true
approved-by: "justin"
approved-at: "2026-05-12T00:45:00Z"
---

# Tmux Injection Unification — Bracketed Paste + Post-Inject Verification

**Status:** spec — round 5 (post cross-model external review)
**Owner:** Echo
**Date:** 2026-05-11
**Incident origin:** Topic 9235 (qalatra), 2026-05-11T23:08:47Z — bootstrap pointer
typed into Claude Code's input but Enter never registered; session sat silent
for 52 minutes until manual Enter sent.

## 1. Problem

`SessionManager.rawInject()` has two code paths:

- **Multi-line (`text.includes('\n')`)**: wraps content in bracketed-paste
  markers (`\x1b[200~ ... \x1b[201~`), sleeps 500 ms, then sends `Enter`.
  Works reliably.
- **Single-line (`else`)**: types the text with `send-keys -l` then immediately
  sends `Enter`. **Fails intermittently under Claude Code 2.1.139**: the TUI
  auto-detects rapid character input as a paste and buffers it; the `Enter`
  keystroke arrives before the paste buffer flushes and is consumed as part
  of the buffered content instead of submitting.

Symptom: the injected text is visible at the `❯` prompt but never submitted.
The session is alive, has all context, but waits forever.

### Reproduction (live, observed)

- 23:08:43Z — context exhaustion recovery respawns session `echo-qalatra`.
- 23:08:46Z — `waitForClaudeReady` returns true (3 s startup).
- 23:08:47Z — `rawInject` types a 217-char single-line bootstrap pointer:
  `[IMPORTANT: Read /tmp/instar-telegram/bootstrap-9235-...txt — ...]`
- 23:08:47Z — `Enter` sent. **Not submitted.**
- Topic 9235 sits silent for 52 minutes. User reports failure.
- 23:59:47Z — manual `tmux send-keys -t echo-qalatra Enter` unsticks it.
  Agent immediately reads the bootstrap and resumes work.

### Why this is upstream of the compaction-recovery fix

The 0.28.66 fix today rewrote the **prompt text** the agent reads after
compaction. That fix was correct but assumed the prompt actually reaches the
agent. This bug is the layer below: the prompt never gets submitted.

The recovery reaper (spec approved 05:36 today, not yet shipped) would notice
~3 minutes after the silent failure and fire a recovery — which would
re-trigger the same single-line `rawInject` path and likely fail the same way.
**This fix is a prerequisite for the reaper to be effective.**

### Why nothing caught it

- The injection returns `true` because `execFileSync` succeeded on both
  `send-keys -l text` and `send-keys Enter`. tmux delivered the bytes; the
  TUI ate one of them.
- No post-injection verification existed. There was no contract between
  "injection succeeded" and "message was actually submitted."
- The idle-session zombie detector skips sessions that received recent
  injections — but here the injection was real, so the zombie detector
  correctly didn't kill it. The session just waited.

## 2. Goal

When `rawInject()` resolves successfully, the injected text must be a single
submission event from the agent's perspective: typed, finalized, and submitted.
The synchronous return is allowed to resolve optimistically; an asynchronous
verifier must detect a stuck submit and re-send `Enter` within ~2 seconds of
the original injection. The verifier MUST minimize and bound duplicate-
submission risk under normal load, concurrent injects, slow TUI redraw, or
short messages (round 5 GPT cross-review: heuristic prevention can reduce
duplicates but does not prove they won't happen; language softened from
"MUST NOT" to "MUST minimize and bound" to match the actual guarantee).

## 3. Non-goals

- Changing the InputGuard or any provenance/coherence checks.
- Changing the bootstrap flow (file vs inline).
- Detecting a session that ate the message AND emptied input (different bug —
  the recovery reaper handles that class).
- Per-user/per-topic stuck-state alerting. The critical DegradationReporter
  event is emitted; the reaper (separate spec, already approved) is the
  systematic user-facing recovery path. Adding a Telegram alert from
  `SessionManager` would require wiring a notifier across module boundaries
  (round 2 integration review flagged this as a critical wiring concern) —
  scope-cut to keep this PR small. Documented residual risk: if both retries
  fail AND the reaper has not yet shipped/run, the session is silent until
  manual intervention. Acceptable for the ~hours-to-days window until reaper
  ships.

## 4. Design

### 4.0 Async-ify the inject path

Round 1's scalability review correctly flagged that the existing multi-line
path uses `execFileSync('/bin/sleep', ['0.5'])` to block the event loop. Today
that cost applies only to the multi-line minority. After unification, it would
apply to every inject — including HTTP request handlers (`server.ts:4278`,
`server.ts:4537`).

**Required change:** convert `rawInject` from sync-with-blocking-sleep to
`async` with `await new Promise(resolve => setTimeout(resolve, 500))`.
`injectMessage` becomes `async`, returning `Promise<boolean>` instead of
`boolean`.

#### 4.0.1 Call-site audit (exhaustive)

The round 2 integration review enumerated every call site of `injectMessage`
and `rawInject`. The implementation MUST update each of these per the table.
This list is reproduced in the side-effects artifact for traceability.

**Internal callers (`SessionManager.ts`):**
| Line | Site | Action |
|------|------|--------|
| 1230 | `spawnInteractiveSession` reuse-path inject | `await` (caller is already `async`) |
| 1335, 1343 | post-ready inject inside `.then`-callback | wrap as IIFE returning a promise; use `.catch(err => log)` |
| 1466 | `injectPasteNotification` | method becomes `async`; callers `await` |
| 1478 | pointer-style follow-up | `await` |
| 1523 | `injectTelegramMessage` returning `!== false` | **silent-bug fix**: `await` BEFORE the comparison, OR refactor to `return (await injectMessage(...)) !== false`. Round 2 integration review identified this as a runtime regression risk (Promise is never `=== false`). |
| 1534 | `injectTelegramMessage` pointer-style follow-up returning `!== false` (round 4: same silent-bug pattern as 1523) | **silent-bug fix**: identical to 1523 — `(await ...) !== false`. |
| 1569, 1581 | `injectWhatsAppMessage` paths | `async` + `await` |
| 1610, 1623 | `injectIMessageMessage` paths | `async` + `await` |

**External callers:**
| File:line | Site | Action |
|-----------|------|--------|
| `commands/server.ts:3013` | bootstrap message inject | `await` (handler already async) |
| `commands/server.ts:4278` | `/sessions/:name/inject` HTTP route | `await` |
| `commands/server.ts:4537` | HTTP inject path | `await` |
| `monitoring/TriageOrchestrator.ts:724, 746` | recovery inject | `await` |
| `monitoring/TriageOrchestrator.ts:146` | dependency type signature | change `(...) => boolean` → `(...) => Promise<boolean>` |
| `server/routes.ts:6279` (via `injectTelegramMessage`) | consumes `injected` boolean | depends on §1523 fix; verify post-fix `injected` is a boolean (not Promise) |

**Fire-and-forget convention:** any call site that legitimately doesn't need
the result MUST use `injectMessage(...).catch(err => logger.warn(...))` —
NOT a bare `void`. Round 2 security review (S4) correctly noted that a bare
`void` on a rejected promise terminates the process on Node ≥15.

#### 4.0.2 Acceptance: no unhandled promise rejection

Acceptance test: spin up a `rawInject` against a non-existent tmux session
under each caller's pattern; assert no `unhandledRejection` event fires on
the process.

### 4.1 Unified inject path

Replace the if-newline branch in `rawInject()` with a single bracketed-paste
sequence for every non-empty text:

```
1. send-keys '\x1b[200~'              (paste-start marker)
2. send-keys -l <sanitized text>      (literal characters, see §4.1.1)
3. send-keys '\x1b[201~'              (paste-end marker)
4. await sleep(500)                   (TUI processes paste-end, buffers content)
5. send-keys Enter                    (submit)
6. schedule verifyAndRetry            (async, see §4.2)
```

#### 4.1.1 Control-byte sanitization (broadened in round 3)

Round 2 security review (S1) identified that stripping only `\x1b[200~`/
`\x1b[201~` and `\x1b[` was incomplete. C1 controls can be expressed as
8-bit (`\x9b`), UTF-8-encoded C1 (`\xc2\x9b`), or via DCS/OSC/SOS/PM/APC
envelopes (`\x1b]`, `\x1bP`, etc.).

**Mitigation:** sanitize the entire C0/C1 control range plus the UTF-8
C1 prefix.

```
// Operates on the JS string (UTF-16 code units) — U+0080..U+009F are already
// single code units after decoding. The \xc2 prefix would only apply in a
// raw Buffer context. For string inputs this single class covers C0+C1:
const C0_C1_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;
const ALLOWED = new Set(['\t', '\n', '\r']);
```

If the implementation ever sanitizes Buffer (raw bytes), add a
`\xc2[\x80-\x9f]` pre-pass before UTF-8 decode. The unit test covers both
cases.

Anything matching the pattern AND not in `ALLOWED` is replaced with `…`
(single-character ellipsis — non-flaggable, unlikely to trigger downstream
content filters; round 2 adversarial review flagged the verbose sentinel
`[ESC-paste-marker-removed]` as filter-bait).

If any replacement occurred, emit a `DegradationReporter` event:
```
{ feature: 'SessionManager.rawInject',
  reason: 'control-byte-sanitized',
  impact: 'Message contained control byte(s) — replaced with ellipsis',
  removedCount: N,
  messagePreview: original.slice(0,80) + '...' }
```

`sanitizeForPaste(text: string): { sanitized: string, removed: number }` is
pure-function, unit-tested in isolation against:
- `\x1b[201~ /clear` → fully stripped
- `\x9b 201~ /clear` → fully stripped
- `\xc2\x9b 201~ /clear` → fully stripped
- `\x1b]0;title\x07` (OSC) → `\x1b` and `\x07` stripped
- normal UTF-8 emoji and accented characters → preserved
- `\t`, `\n`, `\r` → preserved

#### 4.1.2 Empty vs whitespace distinction

- `text === ""` → return `true`, no tmux commands emitted, no verifier
  scheduled.
- `text` consisting only of whitespace or newlines → real submit through
  paste markers + Enter; verifier NOT scheduled (round 2 adversarial review
  H1 noted this leaves a silent-failure window for whitespace-only inputs).
  **Documented residual risk:** whitespace-only injects can stick silently.
  The reaper (separate spec) covers this case at the 3-minute mark.
  Acceptable bound: whitespace-only injects are operator/test-tool flows,
  not user-facing messages.

### 4.2 Post-injection verifier (async, self-healing, seq-guarded)

After the inject sequence resolves, the verifier is scheduled. It MUST NOT
retry under any of: concurrent injection on same session, short-suffix
collision risk, TUI redraw lag, session death.

#### 4.2.1 Per-session inject sequence + incarnation token

`SessionManager` maintains `private injectSeq = new Map<string, {seq:
number, incarnation: string}>()`. The incarnation is read at first-inject
time via `tmux display -p -t <session> '#{session_created}'` — a stable
per-session-creation token. Subsequent injects on the same incarnation
reuse the stored value.

On every `rawInject`, the seq increments **before any tmux command is
emitted** (monotonicity preserved on partial-emit failure). The verifier
captures both `{seq, incarnation}` at schedule time.

**Verifier wake order (round 4, addresses Adv F1):** at EACH capture stage
(capture-1, capture-2, capture-3a, capture-3b), the FIRST step is the
seq+incarnation check. Only if both still match does the verifier emit
the `tmux capture-pane` command. This prevents capturing pane state from
a newer inject or post-respawn session.

**Post-respawn safety (round 4, addresses Adv F4):** if a tmux session
dies and is respawned under the same name, its `session_created` changes.
A still-in-flight verifier from the old incarnation will see an
incarnation mismatch on its next stage check and abort. The new session's
first `rawInject` reads the new incarnation and overwrites the map entry.

**Incarnation acquisition failure (round 5 addresses GPT #5):** if
`tmux display -p '#{session_created}'` fails, times out, or returns an
empty string, the inject proceeds but the verifier is NOT scheduled.
Emit `verifier-disabled-incarnation-unavailable` degradation. The seq
guard alone is insufficient post-respawn safety, so fail-closed:
no verifier rather than a potentially-incorrect one. The reaper covers
the residual stuck-state risk.

**Map cleanup (round 3 + round 4 broadened):**
- On `tmuxSessionExists === false` during any verifier stage → delete entry.
- On successful verifier completion (no retry needed, or retry succeeded
  and final capture is clear) → delete entry. The next inject will
  re-create with a fresh `{seq: 1, incarnation: …}`.
- On SessionManager's existing session-death/cleanup event (wherever the
  zombie reaper kills a session) → delete entry. Coverage even for
  inject-free orphans.

This addresses round 3 Scal F10 (sessions killed after successful verify
left stale entries).

#### 4.2.2 Two-sample confirmatory capture (applied to both retry stages)

Verifier schedule (all delays configurable, defaults shown):

```
schedule capture-1 at +1500 ms
  if stuck-suffix found:
    schedule capture-2 at +200 ms
      if stuck-suffix STILL found:
        send retry Enter (retry-1)
        emit warn degradation
        schedule capture-3a at +1500 ms
          if stuck-suffix found:
            schedule capture-3b at +200 ms
              if stuck-suffix STILL found:
                send retry Enter (retry-2)
                emit critical degradation
              else:
                no-op (cleared between samples)
          else:
            no-op (recovered after retry-1)
      else:
        no-op (verify-flaked)
  else:
    no-op (submit succeeded)
```

Round 2 adversarial M2: retry-2 now also uses two-sample confirmation,
matching retry-1.

#### 4.2.3 Suffix-match (broadened sigil set, ANSI-stripped)

Round 2 adversarial H2 flagged that the bare `❯ ` sigil search misses
styled prompts (`╭─❯`, color-wrapped, etc.).

**Mitigations:**

- **Bounded pane capture (round 5 addresses Gemini #1 + GPT #3).** The
  verifier invokes `tmux capture-pane -p -S -30 -t <session>` — visible
  pane plus 30 lines of scrollback only. NO unbounded `-S -` or full-
  history capture. The 30-line scrollback bounds memory at
  `pane_width * 30 ≈ 6 KB` per capture and accommodates worst-case wrap
  (250-char input at 80 cols = 4 wrapped lines) plus surrounding context.
  Alternate-screen mode: not used by Claude Code per observation; if a
  TUI ever enables it, `capture-pane -p` returns the alternate buffer
  which is the correct surface for our match.
- **ANSI strip before search.** Apply `stripAnsi(captured)` before any
  regex/substring match. Standard implementation pattern; available in
  the codebase via existing utilities (or vendored 4-line implementation).
- **Broadened sigil regex, anchored (round 4 addresses Adv F2).** Match
  `/^[╭│└─]?\s*❯\s/m` (multiline flag, anchored to start of physical
  line) — covers Claude Code 2.1.x styled prompts AND prevents false-match
  on inline `❯` inside scrollback content (code blocks, quoted shell
  output, markdown). The wrap-walking logic operates on logical-lines
  reconstructed from physical-lines; the anchor applies to physical
  line starts.
- **Minimum suffix length: 24 characters, measured on the sanitized
  text (round 4 addresses Adv F6).** Texts shorter than 24 chars
  post-sanitize skip verification. When sanitization shrinks the text
  below the threshold, emit an info-level degradation event
  `verifier-skipped-short-after-sanitize` so the rate is observable.
- **Pane-width wrap walking.** Read pane width via
  `tmux display -p '#{pane_width}'`. Reconstruct logical lines by joining
  physical lines that lack a prompt sigil.
- **Last-prompt-block constraint.** Find the LAST prompt sigil in the
  reconstructed logical lines; the suffix match runs only on that block
  forward.
- **No-sigil-found = inconclusive (round 5 addresses GPT #4).** Round 4
  treated "no prompt sigil in pane" as "submitted." Round 5 refines:
  - If pane shows agent output below the original input area (i.e., the
    captured pane has content past where the prompt would be) → treat as
    "submitted, prompt scrolled," no retry.
  - If pane is empty or shows only blank/whitespace AND no sigil found →
    treat as "inconclusive." Emit `verifier-inconclusive-no-sigil` info
    degradation. Do NOT retry — the cost of retrying on a fresh pane is
    a stray Enter; the cost of skipping a real stuck-state is bounded
    by the reaper at 3 min. Inconclusive cases are observable via the
    degradation event so we can tune the rule from production data.
- **Literal paste-marker detected in pane (round 5 addresses GPT #2).**
  If the captured pane contains the literal string `^[[200~` or `^[[201~`
  (bracketed-paste markers rendered as text, indicating the TUI does NOT
  understand bracketed paste), DISABLE the verifier for this session
  permanently and emit a critical degradation:
  `verifier-disabled-bracketed-paste-not-supported`. This prevents
  loop-spinning when bracketed paste isn't honored — extremely unlikely
  for Claude Code on macOS/Linux per the existing multi-line path's
  history of working — but the failure mode is identifiable.

#### 4.2.4 Retry logic and degradation events (Telegram alert removed)

If both retry-1 and retry-2 confirm stuck:

1. After retry-1 send, emit:
   ```
   { feature: 'SessionManager.rawInject',
     reason: 'submit-stuck-recovered',
     severity: 'warn',
     impact: 'Initial Enter eaten by TUI paste-buffer; auto-retry attempted' }
   ```
2. After retry-2 send (both-sample confirmed), emit:
   ```
   { feature: 'SessionManager.rawInject',
     reason: 'submit-stuck-unrecovered',
     severity: 'critical',
     impact: 'Two retries failed to dislodge a stuck Enter — recovery reaper or manual intervention required' }
   ```

No user-facing Telegram alert from `SessionManager` in this PR. The reaper
(separately-approved spec) is the cross-cutting recovery path that runs in
the server process with access to the telegram adapter. Wiring a notifier
through `SessionManager` was flagged by round 2 integration review as
requiring a new constructor parameter and a cross-module contract — scope
deferred.

**Critical-degradation detection latency (round 4 addresses Sec N1):**
the `submit-stuck-unrecovered` event flows through DegradationReporter to
the existing daily digest path. For real-time security/incident detection
of an adversarial sustained-stuck attack, the existing degradation alarm
path (`init.ts:2283` digest consumer) bounds latency to one digest cycle.
This is the same latency contract as all other critical degradations;
no special path is required for this event class.

**Observability for skip classes (round 4 addresses Adv F5):** the
verifier-skipped paths each emit an info-level degradation event so the
rate of skipped-verifies is observable in production:
- `verifier-skipped-empty` (text === "")
- `verifier-skipped-whitespace` (whitespace-only)
- `verifier-skipped-short` (text < 24 chars pre-sanitize)
- `verifier-skipped-short-after-sanitize` (text < 24 chars post-sanitize)

These are info-level (not warn or critical) and counted in DegradationReporter's
existing rate buckets.

#### 4.2.5 Verifier cancellation on session death

Before each capture, the verifier calls `tmuxSessionExists`. If the session
is gone, it returns silently AND deletes `injectSeq` for that session
(addresses round 2 S3 + F2).

### 4.3 Edge cases table

| Input | Behavior |
|-------|----------|
| `""` | No-op, return `true`, no verifier scheduled. |
| `"   "` or `"\n\n"` (whitespace-only) | Real submit through paste markers + Enter; verifier NOT scheduled. Documented residual risk (§3, §4.1.2). |
| Text < 24 chars | Real submit; verifier NOT scheduled. Residual risk same as whitespace. |
| Text containing `\x1b[201~` or equivalents | Sanitized to `…` before paste. Degradation logged. |
| Text containing other C0/C1 controls | Sanitized similarly (whitelist for `\t`, `\n`, `\r`). |
| Session dies before/during verify | Verifier returns silently; `injectSeq` entry deleted. |
| Two `rawInject` calls within verifier window on same session | Earlier verifier's seq check fails; aborts silently. |
| TUI mid-redraw at capture-1 | capture-2 (200 ms later) catches up; if still stuck, retry; if cleared, no retry. |
| Pane has no prompt sigil at all (full redraw) | Treated as "submitted"; no retry. |
| Styled prompt (`╭─❯`, color-wrapped) | Broadened sigil regex catches it; ANSI strip ensures match. |

### 4.4 Latency impact

| Path | Before | After |
|------|--------|-------|
| `injectMessage` happy path (single-line) | ~50 ms sync-blocking | ~550 ms async-awaited |
| `injectMessage` happy path (multi-line) | ~550 ms sync-blocking | ~550 ms async-awaited |
| Async verifier (happy) | n/a | +1500 ms wallclock, non-blocking |
| Async verifier (stuck, recovered) | n/a | +1700–3200 ms recovery, non-blocking |
| Async verifier (stuck, unrecovered) | n/a | +3200–3400 ms before give-up, non-blocking |
| Event-loop block duration per inject | 500 ms (multi-line) / 0 ms (single) | 0 ms (all) |

**Multi-line behavior change:** multi-line injects ALSO gain the verifier
in this change (round 2 integration review correctly flagged the table
was misleading in round 1). The latency itself is unchanged, but the
post-inject verifier is new for multi-line too — improving stuck-detection
across the board.

`NotificationBatcher` already batches notifications into a single payload
before injection. Per-channel paths (iMessage, WhatsApp) see +500 ms per
message but operate at human-keystroke cadence anyway.

### 4.5 Signal vs authority compliance

The verifier produces a **signal** (`submit-stuck-recovered` /
`submit-stuck-unrecovered`) that feeds DegradationReporter. It does NOT
make a block/allow judgment about message content. The retry action is a
deterministic transport-layer correction (resend Enter), equivalent to
TCP retransmit. Question 4 of the side-effects review reflects this.

### 4.6 Configuration

Config knobs, all defaulted, namespaced under the existing `sessions:`
plural key to match `SessionManagerConfig` convention.

```jsonc
// .instar/config.json
{
  "sessions": {
    "injectVerifyEnabled": true,        // default: true
    // Round 5 addresses Gemini rec #2: TUI sigil hot-fixable via config.
    // If Claude Code changes its prompt rendering, operators can adjust
    // without a code deploy. Default matches Claude Code 2.1.x.
    "promptSigilRegex": "^[╭│└─]?\\s*❯\\s"
  }
}
```

`loadConfig` reads with `?? <default>`. Existing configs without the
fields behave as defaults. No migration script needed.

The unified bracketed-paste sync path is NOT flagged off — rollback for
that is git-revert only.

### 4.7 Deferred / accepted residuals (round 5 cross-review)

The following findings were raised by external reviewers and explicitly
deferred or accepted as residual:

- **OS process exhaustion under spike load (Gemini #2):** at current
  observed load (~5–10 injects/min, single-digit concurrent sessions),
  the 3–5 tmux subprocesses per inject pose no risk. A global p-limit
  style concurrency throttle on tmux shell-outs is a worthwhile
  architectural improvement for Phase 3 scale (500+ concurrent sessions)
  but is OUT OF SCOPE for this PR. Captured as follow-up: `tmux-spawn-
  concurrency-throttle` (file via Echo's evolution tracker after merge).
- **Migration to node-pty / tmux control mode `-CC` (Gemini rec #5):**
  recognized as the strategically-correct long-term direction. Out of
  scope for this PR; same follow-up bucket.
- **Sigil poisoning via user-injected `❯` in scrollback (Grok #1):** the
  anchored sigil regex `^...❯\s` requires start-of-physical-line match
  AND last-block constraint. A user-typed `❯` in the middle of a message
  body cannot satisfy the anchor. Accepted as mitigated.
- **Event loop lag stretching 200 ms timers (Gemini #4):** two-sample
  logic is already lag-tolerant by design (no minimum gap enforced; the
  gap is opportunistic). Documented as not-a-concern.
- **messagePreview redaction policy (GPT bonus):** the 80-char preview
  cap is a soft bound. Implementation MUST scrub tokens matching
  `/sk-[A-Za-z0-9_-]{20,}/` and `/Bearer\s+\S+/` from previews before
  logging. Added as implementation contract.
- **Risk matrix consolidation (Grok rec #5):** nice-to-have. Inline
  references throughout the spec already serve the same purpose for
  this PR; a standalone matrix can be added in a follow-up cleanup pass.

## 5. Acceptance criteria

1. **Single-line submit succeeds.** A 217-char single-line `rawInject`
   reliably submits on the first Enter.
2. **Multi-line behavior unchanged for sync path.** Existing multi-line
   tests pass with regex/test updates per §7.
3. **Verifier retries when stuck.** Pane mock shows stuck text after both
   capture-1 and capture-2 → exactly one retry-1 Enter. Then capture-3a +
   capture-3b stuck → exactly one retry-2 Enter. Then give-up with
   critical degradation event.
4. **Verifier does NOT retry when submitted.** Pane mock shows input empty
   after Enter → zero retries.
5. **Suffix-match precision (scrollback).** Suffix in scrollback above an
   empty prompt → no false retry.
6. **Wrap-around handling.** Text wrapping across 2+ physical lines is
   correctly identified as stuck. Includes a styled-prompt fixture
   (`╭─❯` or color-wrapped) per round 2 adversarial H2.
7. **Short text skips verifier.** Text of 12 chars → no verifier scheduled.
8. **Empty text is full no-op.** `rawInject("")` returns true and emits
   zero tmux commands.
9. **Whitespace-only submits without verify.** `rawInject("\n")` emits
   paste + Enter; verifier NOT scheduled.
10. **Concurrent inject cancels prior verifier (seq guard).** Two injects
    within 1000 ms → only the latest verifier fires its retry logic.
11. **Session death silences verifier and cleans map.** Dead session at
    capture time → no error, no degradation, `injectSeq` entry deleted.
12. **Control-byte sanitization works.** Inputs containing `\x1b[201~`,
    `\x9b201~`, `\xc2\x9b201~`, and OSC envelopes are all sanitized to
    `…`; degradation event emitted.
13. **Async conversion has no unhandled rejection.** All listed call
    sites either `await` or `.catch`; non-existent tmux session under each
    pattern → zero unhandled rejections.
14. **`injectTelegramMessage` boolean return preserved.** Caller at
    `server/routes.ts:6279` receives a boolean, not a Promise. Asserted
    by integration test.
15. **CI uses fake timers.** New test file uses `vi.useFakeTimers()`;
    existing `paste-stuck-detection.test.ts` regex updated away from
    `/bin/sleep` literal.
16. **Capture-pane bounded.** All verifier captures use
    `capture-pane -p -S -30`. Unit test asserts the command shape.
17. **Bracketed-paste fallback detected.** Pane mock containing literal
    `^[[200~` triggers `verifier-disabled-bracketed-paste-not-supported`
    AND disables future verifiers for that session.
18. **No-sigil-inconclusive distinguished from submitted.** Pane mock
    showing only blank lines + no sigil emits
    `verifier-inconclusive-no-sigil`; does NOT retry.
19. **Incarnation acquisition failure fails closed.** Mock `tmux display`
    returning empty/timeout: inject succeeds, verifier NOT scheduled,
    `verifier-disabled-incarnation-unavailable` emitted.
20. **Credential redaction in messagePreview.** Sanitized text containing
    `Bearer ABC123XYZ...` is redacted in degradation event preview.

## 6. Rollback

- `sessions.injectVerifyEnabled: false` disables the verifier without
  revert.
- The unified bracketed-paste sync path itself is revert-only. One-commit
  revert; no migration, no state cleanup.
- The async conversion is structural; partial revert is risky. If
  rollback is needed, revert the entire commit.

## 7. Files touched

- `src/core/SessionManager.ts` — unify rawInject paths, add
  `verifyAndRetryInjection`, add `sanitizeForPaste`, add `injectSeq` map,
  convert to async, ANSI-strip + broadened sigil regex.
- `src/core/types.ts` — `SessionManagerConfig` gets
  `injectVerifyEnabled?: boolean`.
- `src/core/Config.ts` (or `ConfigDefaults.ts`) — default to `true`.
- `src/monitoring/TriageOrchestrator.ts` — update dependency type
  signature for `injectMessage` from `(...) => boolean` to
  `(...) => Promise<boolean>`; `await` both call sites.
- `src/commands/server.ts` — `await` the 3 inject sites.
- `src/server/routes.ts` — confirm `injected` boolean consumption
  remains correct after `injectTelegramMessage` returns `Promise<boolean>`
  is awaited internally.
- `tests/unit/SessionManager-rawInject.test.ts` — NEW file covering all
  15 acceptance criteria with `vi.useFakeTimers()`.
- `tests/unit/paste-stuck-detection.test.ts` — UPDATE: regex anchored on
  `/bin/sleep` literal needs to match the new async `setTimeout` pattern.
- `tests/unit/SessionManager-injection.test.ts` — confirm structural
  tokens (`maxAttempts`, `DegradationReporter`) survive refactor.
- **Async-mock contract audit (round 4 addresses Int-R3-1).** The
  following test files reference `injectMessage` / `injectTelegramMessage`
  / `rawInject` and need explicit review for the async semantic change.
  Mocks must return `Promise<boolean>` instead of `undefined`; tests
  must `await` calls:
    - `tests/unit/session-telegram-inject.test.ts` (line 57 call site)
    - `tests/unit/TriageOrchestrator.test.ts` (line 28 mock)
    - `tests/unit/TriageOrchestrator-validation.test.ts` (line 28 mock)
    - `tests/unit/telegram-message-injection.test.ts`
    - `tests/unit/bootstrap-file-threshold.test.ts`
    - `tests/integration/triage-orchestrator-integration.test.ts`
    - `tests/e2e/input-guard-e2e.test.ts`
    - `tests/e2e/session-management-e2e.test.ts`
    - `tests/e2e/whatsapp-message-routing-e2e.test.ts`
  Implementation MUST grep-confirm no other test files reference these
  symbols before declaring done. Acceptance criterion #13 covers the
  no-unhandled-rejection assertion.
- `upgrades/NEXT.md` — release note entry.
- `upgrades/side-effects/<next-version>.md` — side-effects artifact.

## 8. Open questions

None at spec time. Final round (cross-model external) may surface new
items.

## Appendix A — Round 1 review findings and resolutions

(unchanged from round 2 — see git history)

## Appendix D — Round 5 cross-model external review (GPT, Gemini, Grok)

### Scores
- **GPT 5.4**: 8/10 CONDITIONAL — 7 critical findings, mostly addressed below; bounded-risk language and capture-pane scoping called out.
- **Gemini 3.1 Pro**: 9/10 CONDITIONAL — 2 critical findings (capture-pane bounds, OS process exhaustion). First addressed; second deferred with explicit follow-up.
- **Grok 4.1 Fast**: 9/10 APPROVE — no must-fix items; 5 polish recommendations of which the sigil-into-config one is adopted.

### Material findings, resolutions
- **GPT #1 + goal language** RESOLVED §2 softened from "MUST NOT" to
  "MUST minimize and bound."
- **GPT #2 + bracketed-paste compatibility** RESOLVED §4.2.3 literal-
  marker detection emits `verifier-disabled-bracketed-paste-not-supported`.
- **GPT #3 + Gemini #1 capture-pane scoping** RESOLVED §4.2.3 bounded to
  `-p -S -30`.
- **GPT #4 no-sigil too optimistic** RESOLVED §4.2.3 distinguishes
  output-advanced vs inconclusive; emits `verifier-inconclusive-no-sigil`.
- **GPT #5 incarnation fetch failure** RESOLVED §4.2.1 fails closed +
  `verifier-disabled-incarnation-unavailable` event.
- **GPT #6 sanitization examples consistency** RESOLVED §4.1.1 already
  clarified Buffer-vs-string mode. OSC envelope payload retention is
  documented as accepted: ESC strip prevents the dangerous escape; the
  remaining text `]0;title` is not interpretable as a paste-exit.
- **Gemini #1 capture-pane bounds** RESOLVED (see above).
- **Gemini #2 OS process exhaustion** DEFERRED §4.7 as follow-up
  `tmux-spawn-concurrency-throttle` with documented load envelope.
- **Gemini rec #2 sigil regex into config** RESOLVED §4.6
  `promptSigilRegex` knob added.
- **Gemini rec #5 node-pty migration** DEFERRED §4.7 as follow-up.
- **Grok #1 sigil poisoning** ACCEPTED §4.7 as mitigated by anchor
  regex + last-block constraint.
- **Grok rec #5 risk matrix** DEFERRED §4.7 as nice-to-have.
- **GPT bonus credential redaction in messagePreview** RESOLVED §4.7
  implementation contract added.

### Accepted residuals
- Phase 3 scalability (500+ concurrent sessions) requires architectural
  changes (process throttling + node-pty migration). Current load
  envelope is Phase 1 (single-digit concurrent). Follow-up tracked.
- TUI prompt-sigil drift mitigated by config knob hot-fix path.

## Appendix C — Round 3 review findings and resolutions

### Security
- **N1 LOW** Critical-degradation detection latency — RESOLVED §4.2.4
  notes the existing digest path bounds latency for this event class.
- **\xc2 regex clause clarification** — RESOLVED §4.1.1 comment plus
  Buffer-mode note.

### Scalability
- **F6 MEDIUM** Call-site audit may miss DI/test doubles — RESOLVED §7
  test-file audit list. TriageOrchestrator dependency type explicitly
  updated.
- **F7 LOW** Verifier timer count — accepted (bounded).
- **F8 LOW** Regex DoS — accepted (linear pattern, no backtracking).
- **F9 LOW** Capture-pane cost — accepted.
- **F10 MEDIUM** Map cleanup conditional on verifier firing — RESOLVED
  §4.2.1 cleanup-on-success + session-death-hook.

### Adversarial
- **F1 HIGH** Seq-check ordering inside capture stages — RESOLVED §4.2.1
  states seq+incarnation check is FIRST step of every capture stage.
- **F2 HIGH** Unanchored sigil regex — RESOLVED §4.2.3 uses
  `/^…❯\s/m` anchored.
- **F3 LOW** pane_width TOCTOU on resize — accepted as residual; rare.
- **F4 HIGH** Post-respawn seq collision — RESOLVED §4.2.1 adds
  incarnation token via `session_created`.
- **F5 MEDIUM** No counter for residual-risk classes — RESOLVED §4.2.4
  observability events for verifier-skipped paths.
- **F6 MEDIUM** Sanitization shrinks past 24-char — RESOLVED §4.2.3
  threshold measured on sanitized text + new info event.

### Integration
- **INT-R3-1 HIGH** §7 missing test files — RESOLVED §7 explicit audit
  list of 9 additional test files.
- **INT-R3-2 LOW** Line 1534 implicit treatment — RESOLVED §4.0.1 row
  1534 now explicit silent-bug fix.
- **INT-R3-3 LOW** pre-push smoke tier — accepted (no action needed).

## Appendix B — Round 2 review findings and resolutions

### Security
- **S1 HIGH** Sanitization incomplete (C1/UTF-8/OSC) — RESOLVED §4.1.1
  via full C0/C1 control range strip + UTF-8 C1 prefix.
- **S2 MEDIUM** Telegram alert spam vector — RESOLVED via §3 scope cut
  (no Telegram alert from SessionManager in this PR).
- **S3 MEDIUM** injectSeq map stale on respawn — RESOLVED §4.2.5 map
  cleanup on session death.
- **S4 LOW** Fire-and-forget unhandled rejection — RESOLVED §4.0.1
  mandates `.catch(err => log)` wrapper, not bare `void`.

### Scalability
- **F1 HIGH** Async conversion silent concurrency shift — RESOLVED
  §4.0.1 exhaustive call-site table.
- **F2 MEDIUM** injectSeq map leak — RESOLVED §4.2.5 cleanup.
- **F3 LOW** Two-sample capture spawn cost — accepted as bounded.
- **F4 MEDIUM** Telegram alert storm — RESOLVED via §3 scope cut.
- **F5 informational** Steady-state footprint — accepted.

### Adversarial
- **H1 HIGH** Whitespace-only silent failure — RESOLVED §4.1.2 as
  documented residual risk (reaper backstop).
- **H2 HIGH** Styled-prompt sigil miss — RESOLVED §4.2.3 broadened
  sigil regex + ANSI strip.
- **M1 MEDIUM** Sentinel triggers content filters — RESOLVED §4.1.1
  uses `…` instead of verbose sentinel.
- **M2 MEDIUM** Third-capture retry without two-sample — RESOLVED
  §4.2.2 retry-2 now also uses two-sample.
- **M3 MEDIUM** False-positive Telegram alert duplicate — RESOLVED via
  §3 scope cut.
- **#5 LOW** Seq advance on partial-emit failure — accepted (monotonicity
  preserved).

### Integration
- **CRITICAL** Telegram alert path not callable from SessionManager —
  RESOLVED via §3 scope cut.
- **HIGH** Floating-promise audit incomplete — RESOLVED §4.0.1 explicit
  table.
- **HIGH** `injectTelegramMessage` `!== false` on Promise silent bug —
  RESOLVED §4.0.1 row 1523 + §5 acceptance #14.
- **MEDIUM** TriageOrchestrator type — RESOLVED §4.0.1 row.
- **MEDIUM** Config key naming — RESOLVED §4.6 uses `sessions.` plural.
- **MEDIUM** CI fake timers — RESOLVED §5 acceptance #15.
- **MEDIUM** paste-stuck-detection.test.ts regex update — RESOLVED §7
  explicit file + §5 #15.
- **LOW** SessionManager-injection.test.ts likely-passes — accepted.
- **CONFIRMED** Multi-machine zero state impact — accepted.
