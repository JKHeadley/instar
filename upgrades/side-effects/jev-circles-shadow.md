# Side-Effects Review — Jev circles shadow (log-only "going in circles" measurement)

**Version / slug:** `jev-circles-shadow`
**Date:** `2026-09-30`
**Author:** `echo`
**Second-pass reviewer:** `independent review subagent (one 80/20 round)`

## Summary of the change

A dark, log-only research instrument (spec `docs/specs/jev-circles-shadow.md`).
Every 5 PostToolUse events per session, the server reads the tail of that
session's own Claude Code transcript, builds the last 15 actions exactly as the
research harness did, secret-scrubs them, asks Jev (`jev-1.13.0`) the measured
five-label question in both option orders, and appends a content-free row
(label, confidence, P(circling) both orders, would-nudge with 30-minute
per-session cooldown accounting) to `logs/jev-circles-shadow.jsonl`.
`GET /jev-circles/summary` reads the log. Files: `src/core/JevCirclesShadow.ts`
(new), `src/server/routes.ts` (one call in the PostToolUse branch of
`/hooks/events`, one read route), `src/commands/server.ts` (construction),
`src/core/PostUpdateMigrator.ts` + `src/commands/init.ts` (the existing
`hook-event-reporter.js` forwards `transcript_path`; awareness card; shadow
marker), `src/config/ConfigDefaults.ts`, `src/core/types.ts`,
`src/core/devGatedFeatures.ts`, `src/scaffold/templates.ts`,
`src/server/CapabilityIndex.ts`.

## Decision-point inventory

No decision-point surface. Nothing is blocked, allowed, filtered, delivered or
routed. No code path reads the log except the summary route, which a person
reads.

---

## 1. Over-block

No block/allow surface — over-block not applicable.

---

## 2. Under-block

No block/allow surface — under-block not applicable. Measurement blind spots,
named in the spec: the review-round (hours-long) loop is out of the 15-action
window; guard-rejection loops were Jev's main research miss; Codex and Gemini
sessions are not measured (Claude Code transcript format only).

---

## 3. Level-of-abstraction fit

Right layer. The input already arrives at `/hooks/events`; the check is detached
from the route; the only new egress is the same TypeSafe endpoint the existing
Jev shadows use, through the same patterns (vault key, scrub, metering, closed
reason enums). It reuses `scrubForStore`, `resolveDevAgentGate` and the feature
metrics recorder rather than re-implementing them. It does not feed a gate
because the research verdict was explicitly "shadow first, not a live nudge".

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic — STOP.

It produces a logged signal that nothing consumes. It holds no authority.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The 0.5
threshold and 30-minute cooldown only label rows in a research log; no action
follows from them.

---

## 5. Interactions

- **Shadowing:** the call sits after `reflectionMetrics.recordToolCall()` in the
  PostToolUse branch and before the commit/advisory-ledger tracking. It is
  synchronous, wrapped in try/catch inside `observe()`, and returns before any
  I/O, so it cannot shadow or delay the checks after it or the response.
- **Double-fire:** none. It is the only consumer of `transcript_path`. The
  existing Jev signal shadow and job-completion audit are separate features with
  separate logs and separate daily bounds; all three meter into feature metrics
  under distinct feature names.
- **Transcript read:** one async read of at most 1 MB per check, then a
  synchronous parse and render of only the last 15 actions (each raw field's
  scrub is bounded to 4,096 characters).
- **Races:** in-memory per-session counters in one process; the log is
  append-only. Two concurrent checks for the same session (possible only if a
  call outlives 5 more actions) can both be over threshold before either sets
  the cooldown; the effect is at most one extra would-nudge row, never a
  delivery. The daily cap is counted before the call, so it cannot be exceeded
  by concurrency.
- **Feedback loops:** none. The instrument reads transcripts; it writes only its
  own log, which no session reads.
- **Hook payload:** the reporter now includes `transcript_path`. The
  HookEventReceiver stores payloads as-is, so stored hook events gain one path
  string. No consumer reads unknown fields.

---

## 6. External surfaces

- **Other agents:** fleet agents get the code, the config block and the hook
  field; the feature stays dark (dev gate) and they hold no TypeSafe key.
- **External systems:** on the development agent, scrubbed 15-action windows go
  to TypeSafe (`api.typesafe.ai`), the vendor already used by the Jev signal
  shadow and job-completion audit. Bounded by the daily cap (default 2000
  calls ≈ $0.20/day), 2 in flight, and a 1.5 s abort.
- **Persistent state:** one append-only JSONL log. No growth bound beyond the
  daily cap (≈2000 rows/day × ~250 bytes ≈ 0.5 MB/day); the summary reads only
  the last 5 MB.
- **Operator surface:** no operator-facing action. The read route is
  informational (Bearer).

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable. No dashboard, approval page or form is
touched.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN: each machine measures the sessions it hosts, from
transcripts on its own disk, and the research question is a rate that
per-machine logs answer. No user-facing notices, no durable state that follows a
topic, no generated URLs.

---

## 8. Rollback cost

Pure code change. Kill switch: `intelligence.jevCirclesShadow.enabled: false`
(read live, no restart). Full back-out: revert and ship a patch; the log file can
be left or deleted. The extra hook field is ignored by every other consumer, so a
partial rollback is safe. No user-visible effect in either direction.

---

## Conclusion

Clear to ship behind the dev gate. The one departure from the brief's literal
wording ("events the hook ALREADY reports") is forced by a verified fact: the
hook sees only tool names, and failed tool calls fire `PostToolUseFailure`,
which it never receives. Forwarding the transcript path from the same hook is
the smallest change that reproduces the measured input: 2,904 of 3,000 real
research windows are reproduced byte-for-byte, and the other 96 differ only
because a secret-shaped span is now redacted before the cut.

---

## Second-pass review (if required)

**Reviewer:** independent review subagent (one 80/20 round, 2026-09-30)
**Independent read of the artifact: concur, after three fix-class findings were fixed**

- Secrets could be cut before the scrub saw them (a private-key body with its
  header cut off reached the window). Fixed: raw fields are scrubbed before any
  cut; tested.
- The path check was looser than the spec. Fixed: UUID id, exact
  `.claude*/projects/<cwd>/<id>.jsonl` shape, re-checked after symlink
  resolution; tested.
- Sessions with a 1 MB tail holding fewer than 15 actions were silently
  unmeasured. Fixed: one `short-window` row per session; tested.

Full record: `docs/specs/reports/jev-circles-shadow-convergence.md`.

---

## Evidence pointers

- `tests/unit/jev-circles-shadow.test.ts`, `tests/integration/jev-circles-shadow-routes.test.ts`, `tests/e2e/jev-circles-shadow-lifecycle.test.ts`.
- Window parity: 3,000/3,000 research windows (`windows.jsonl` in the research session scratchpad) reproduced byte-for-byte by `buildActions` + `renderWindow` before the scrub-before-cut fix; 2,904/3,000 after it, the other 96 differing only by a redaction.
- Live probe (Claude Code 2.1.286): a failing `ls` fired `PostToolUseFailure` only; a passing `echo` fired `PostToolUse` with `transcript_path` in the payload.
- Live smoke through the real module with the vault key: own session `normal` (P 0.04); research circling episodes 73c08c06d3 / 1c0263ea7f / 5da4879374 → 0.93 / 0.71 / 0.88 (research 0.96 / 0.71 / 0.88).

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. Not a self-triggered
controller in the `unbounded-self-action` sense: it never fires a restart,
retry, respawn, spawn, notify or kill; its only action is one bounded,
capped vendor call and a log row per 5 reported actions.
