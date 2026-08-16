# Gemini 3.1 Pro Review: MESSAGE-INJECTION-DELIVERY-GUARANTEE-SPEC.md

**Model**: gemini-3.1-pro-preview
**Date**: 2026-04-18
**Focus**: concurrency, signature precision, races

---

## Raw Model Response

**Score**: 6/10 — **CONDITIONAL**

**Summary**: Addresses a real UX issue with a sound multi-layered approach (immediate verify + watchdog + logging), but has a critical concurrency flaw (sync sleeps blocking Node event loop), a watchdog cancellation race, and signature-match false-positive risk.

**Critical issues**:
1. **Event loop blocking via synchronous sleeps** — Spec says "retain synchronous path" but adds 200–400ms sleeps per message. Will block Node event loop. Fix: `await setTimeout()` even if tmux exec stays sync.
2. **Watchdog cancellation race** — Message B clearing A's watchdog corrupts stuck state. Fix: strict per-session FIFO queue.
3. **Signature-match false positives** — `/\[Pasted text #\d+\]/` across last 5 lines can match LLM-echoed text mid-generation, triggering Enter = interrupt/cancel. Fix: anchor to last non-empty line only, use `capture-pane -p`, handle <40-char strings.

**Gaps**: ANSI stripping unspecified; short-string (<40 char) behavior undefined; no cap on repeated Enter floods when session frozen.

**Industry comparison**: Fixed sleeps are an anti-pattern vs. state-polling (expect/pexpect/Playwright). Watchdog pattern aligns well with actor-model delivery guarantees.

**Scalability**: Fine at 10–50 users. At 50–500, 6 tmux forks per inject causes CPU/PID churn. At 500+, need tmux control mode (`tmux -C`) or direct PTY writes.

**Top 5 recommendations** (prioritized):
1. Async verification (`await setTimeout`) — don't block event loop.
2. Per-session FIFO injection queue.
3. Strip ANSI, anchor regex to last non-empty line, handle <40-char inputs.
4. Bump immediate verify delay 200ms → 300ms.
5. Cap watchdog retries (1–2 max) to prevent Enter floods on dead sessions.

---

## Subagent Analysis

- Substantive review with concrete recommendations, mirrors concerns raised by internal adversarial + scalability reviewers.
- Unique angle: explicit call-out of state-polling pattern from Playwright/expect as industry-standard alternative to fixed sleeps.
- Also unique: scalability projection at 500+ sessions suggests tmux control mode / direct PTY writes — out of scope for this fix but worth noting for future work.
