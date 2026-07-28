---
slug: sentinel-reachability
review-convergence: "internal-adversarial-1"
approved: true
approved-by: justin
approval-basis: >
  Justin greenlit the plan ("yes, please follow through with this, but also
  note that the API rate-limit scenario is still not recovering even though we
  claimed to deploy a fix", topic 2169). The narrowed scope (rate-limit recovery
  only; worktree-clone + socket/silence parts already shipped via #334/#340/#351;
  the sentinelTelegramEscalation default-flip is intentionally dropped as
  superseded by the anti-flood design) was disclosed back to him before build.
eli16-overview: sentinel-reachability.eli16.md
companion-eli16: sentinel-reachability.eli16.md
date: 2026-05-24
---

# Sentinel Reachability — rate-limit recovery for non-topic-bound sessions

## Problem

The RateLimitSentinel detects Anthropic's server-side throttle and schedules its
backoff correctly, but both recovery actions in `server.ts` began with:

```js
const topicId = telegram?.getTopicForSession(sessionName);
if (topicId == null) return;   // ← silent no-op
```

A developer's interactive Claude Code window is **not** bound to any Telegram
topic. So for that session the resume nudge and the user notice both dropped on
the floor — detection + backoff ran, then nothing reached the user. From the
outside this is indistinguishable from the sentinel never existing. v1.2.33
shipped past green tests because every fixture was topic-bound; the
non-topic-bound path was never asserted (the inline logic was also untestable).

## Scope

This spec covers ONLY the rate-limit recovery reachability fix. The two sibling
problems from the original "Sentinel Reachability + Worktree Isolation" spec are
out of scope here because they already shipped or were superseded:

- **Worktree clone-isolation** — shipped via #334 (`WorktreeManager` clone-default).
- **Socket-disconnect / active-silence default** — `sentinelTelegramEscalation`
  intentionally stays default-OFF (the post-2026-05-22 anti-flood design, #351).
  The original spec's Part A3 (flip to default-on) is DROPPED.

## Design

### A1 — Notify reachability

`notifyFn` delivery order, with no silent return at any step:
1. The session's own Telegram topic (unchanged).
2. Else the always-available lifeline (system) topic via `getLifelineTopicId()`.
3. Else a `recovery-unreachable` audit event (so it's greppable, never silent).

### A2 — Resume reachability

`resumeFn`:
- Topic-bound → topic-tagged nudge via `injectMessage` (provenance-checked).
- Non-topic-bound → `SessionManager.injectInternalMessage`, a trusted in-process
  path that bypasses the topic-prefix requirement and logs the injection with
  `source: 'sentinel-recovery'`.

### A3 — Audit trail

Every recovery attempt records `recovery-reached` / `recovery-unreachable` to
`logs/sentinel-events.jsonl`. Unreachable events also append to
`.instar/sentinel-alerts.json` (rolling 200) so the dashboard surfaces them even
without Telegram.

### Testability

The branching is extracted from inline server closures into
`sentinelWiring.buildRateLimitRecoveryDeps()` — the gap (inline + untestable)
that let the bug ship past green tests.

## Security boundary

`injectInternalMessage` bypasses InputGuard's topic-prefix provenance, so it is
in-process only — never wired to an HTTP route. HTTP injection continues through
`injectMessage`. Asserted by a test that `routes.ts` does not reference
`injectInternalMessage`.

## Verification

- **Live reproduction:** real RateLimitSentinel lifecycle + real factory + real
  tmux pane, non-topic-bound. Resume nudge landed in the pane; throttle notice +
  "back online" reached the lifeline; audit recorded `recovery-reached`, zero
  `recovery-unreachable`. Before the fix all silent.
- **Unit:** `rate-limit-recovery-reachability.test.ts` — both sides of every
  reachability boundary.
- **Integration:** `rate-limit-recovery-sentinel-lifecycle.test.ts` — real
  sentinel lifecycle driving the factory to the lifeline for a non-topic-bound
  session + the never-silent unreachable case.
- **Wiring/boundary:** `rate-limit-recovery-wiring.test.ts` — server wires the
  real primitives (not no-ops) + the InputGuard HTTP boundary.

## Migration parity

No agent-installed file changes. Server-side binary code shipped via npm update;
existing agents pick it up automatically. No config default, hook, skill, or
CLAUDE.md template capability added.

## Rollback

`git revert` restores the two inline closures (reintroducing the silent no-op).
`injectInternalMessage` + the factory become dead code; no state to undo.

## Adversarial review log (internal-1)

- **R1 — InputGuard bypass is a trust boundary.** Resolved: `injectInternalMessage`
  is a SessionManager method only, never an HTTP route; logged with a `source`
  label; HTTP path still enforces prefixing. Asserted by test T7.
- **R2 — notifyFn throwing on unreachable.** Resolved: never throws; the audit
  event is the durable record (the sentinel only console.warns on a throw).
- **R3 — lifeline null during setup.** Resolved: the audit-event fallback +
  `.instar/sentinel-alerts.json` cover the no-lifeline case; dashboard surfaces it.
- **R4 — double-notify spam.** Out of scope; RateLimitSentinel's existing
  check-in min-spacing governs notice cadence, unchanged here.
