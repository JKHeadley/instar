# Grok 4.1 Fast Review: MESSAGE-INJECTION-DELIVERY-GUARANTEE-SPEC.md

**Model**: grok-4-1-fast
**Date**: 2026-04-18
**Focus**: concurrency, signature precision, races

---

## Raw Model Response

### 1. Overall Assessment
- **Score**: 8/10 — Excellent problem diagnosis, precise repair mechanisms, strong testing/rollback plans; deducts for incomplete concurrency modeling (e.g., overlapping rawInject calls) and signature collision risks.
- **Status**: CONDITIONAL

### 2. Critical Issues (Must Fix)
1. Watchdog `Map<tmuxSession, NodeJS.Timeout>` clearing races under concurrent bursts (<3.5s apart) — can orphan the first stuck message. Fix: per-session queue with unique injectionIds, track all pending signatures, check all on fire.
2. Single-line prefix match on first 40 chars has collision risk (shared system-prompt preambles). Fix: CRC32 hash of full text + prefix; store per-injection in `pendingInjections`; require both match.
3. Fixed 200ms sleep + "last 5 lines" capture with no retry bound and sync sleeps blocking event loop. Fix: 2-retry cap, adaptive 100ms polling up to 500ms total, capture 20 lines, async Promise-based exec.

### 3. Strengths
Precise failure-mode enumeration; signature-scoped detection respects signal-vs-authority; structured grep-friendly logging; comprehensive test suite; zero-risk rollback.

### 4. Gaps
Concurrent injection bursts; partial-paste tmux line truncation; non-Claude TUIs; watchdog firing during user typing; pane-capture failures on detached tmux; output delayed >3.5s causing false watchdog fire. Missing: concurrency model, security (sig spoofing), observability (stuck-rate metrics), migration for `pendingInjections`.

### 5. Industry Comparison
Mirrors Kafka/RabbitMQ at-least-once semantics with idempotent retries; simpler than NATS JetStream ACKs. Close analog: Playwright `waitForSelector` after `type()`. Avoids Selenium-style fixed-sleep flakiness anti-pattern.

### 6. Scalability
- 10–50 users: negligible.
- 50–500: fine, but concurrent bursts >10/sec/session risk event-loop backlog from sync sleeps.
- 500–5000: ~5k timers + tmux poll CPU; offload to worker queue, rate-limit 1/sec/session.

### 7. Recommendations (Prioritized)
1. Per-session PQueue(1) + atomic signature storage.
2. Hash-based (CRC32/full-text) signature replacing 40-char prefix.
3. Adaptive polling verify (100ms, 500ms cap, 2 retries); async exec.
4. User-input guard: check pane-tail timestamp vs. inject time (<3s) before watchdog repair.
5. Expand acceptance: concurrency burst test, false-positive user-typing test, prod stuck-rate metric.

---

## Subagent Analysis

- Strong industry-analog framing (Kafka/Playwright) that internal reviewers didn't surface.
- Uniquely recommends CRC32 hash + prefix dual-match for signature precision — a concrete mechanism not proposed by other reviewers.
- Reinforces adversarial/scalability themes around concurrent bursts and event-loop blocking.
