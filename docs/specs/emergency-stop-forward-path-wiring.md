---
title: "Emergency-stop on the lifeline forward path — wire MessageSentinel into /internal/telegram-forward (P0 safety)"
slug: emergency-stop-forward-path-wiring
status: draft
approved: true
approved-by: Justin
approved-via: "Telegram topic 12702 (2026-05-24) — Echo reported the verified P0 bug (emergency-stop bypassed for lifeline-owned agents) with the surgical fix and asked 'make this the immediate next thing I build, properly, with tests. Want me to go ahead?'; Justin: 'Please proceed.'"
review-convergence: "internal-verification-and-design-2026-05-24 — data-flow-tier reproduction of the bug (live classifier test + code-path trace + runtime-mode confirmation) plus faithful-port design review. Parent context: feature-activation-coherence.md P0 item, itself surfaced by the topic-12702 four-lens convergence."
date: 2026-05-24
author: echo
related:
  - docs/specs/feature-activation-coherence.md
eli16-overview: emergency-stop-forward-path-wiring.eli16.md
---

# Emergency-stop on the lifeline forward path

## One-paragraph summary

The "stop everything" emergency-stop (`MessageSentinel`) is wired only into `TelegramAdapter.processUpdate()` — the adapter's own Telegram poll loop. Lifeline-owned-polling agents (e.g. Echo, named at `server.ts:1167`) never run `processUpdate`: their inbound messages arrive via the lifeline → `POST /internal/telegram-forward`, which injects directly with no sentinel check. So for those agents, "stop everything" is delivered to the session as a normal message and nothing structurally halts a running (or wedged, mid-tool-call) session. This spec wires the **same** emergency-stop/pause intercept into the forward route, **fail-open** (a sentinel error never blocks message delivery), reusing the existing `ctx.telegram.onSentinelKillSession`/`onSentinelPauseSession` callbacks and `stopAutonomousTopic`. A wiring-integrity test asserts the forward route classifies before injecting, so this drift cannot silently recur.

## Problem (verified to data-flow tier, 2026-05-24)

- **Classifier works** — live test against the running agent: `"stop everything"` → `emergency-stop`, `"stop"` → `emergency-stop`, and a long sentence merely containing "stop" → `normal`.
- **Intercept is in the wrong place** — the only caller of the sentinel on the inbound path is `TelegramAdapter.processUpdate()` (`TelegramAdapter.ts:3532`).
- **Echo is lifeline-owned** — `server.ts:1167` names "echo"; the server adapter does not poll. Inbound goes lifeline → `POST /internal/telegram-forward` (`routes.ts:8391`), which routes via `onTopicMessage`/`injectTelegramMessage`. That route body (8391–8700) contains **zero** sentinel references; `src/lifeline/*` does no classification.
- **Result:** emergency-stop is dark for lifeline-owned agents — exactly the class of agent meant to be most robust. Worst when the agent is wedged and can't read a normal message.

Other stop paths (dashboard, `POST /autonomous/stop-all`, killing tmux) are unaffected; this fixes the conversational path.

## Root cause

The sentinel intercept was wired into the adapter's poll path. Lifeline-owned polling was added later; the forward route was built to behave "identically" for routing/flush but the sentinel intercept was never carried over. A newer architecture routed around an existing safety feature — drift, not a code defect in the sentinel itself.

## Non-goals

- Not changing the classifier (`MessageSentinel.classify`) — it works.
- Not removing the `processUpdate` intercept — it still serves non-lifeline (adapter-poll) agents.
- Not a full DRY refactor unifying both paths into one helper (larger blast radius; `processUpdate` uses `this.*` adapter state, the route uses `ctx.*`). The duplication is bounded and guarded by the wiring test; a future refactor can unify.

## Design

Insert a sentinel intercept in `POST /internal/telegram-forward`, **after** request validation (`if (!topicId || !text)`) and **before** message logging/routing, applying to both the with-adapter and no-adapter branches:

```
if (ctx.sentinel) {
  try {
    const c = await ctx.sentinel.classify(text);
    if (c.category === 'emergency-stop' || c.category === 'pause') {
      const sessionName = ctx.telegram?.getSessionForTopic?.(Number(topicId)) ?? <registry lookup>;
      if (c.category === 'emergency-stop') {
        if (sessionName) {
          if (ctx.telegram?.onSentinelKillSession) ctx.telegram.onSentinelKillSession(sessionName); // saves resume UUID + kills
          else ctx.sessionManager?.killSession(sessionName);
          try { stopAutonomousTopic(ctx.config.stateDir, String(topicId)); } catch {}
        }
        ctx.telegram?.sendToTopic?.(Number(topicId), sessionName
          ? 'Session terminated.\n\nSend a new message to start a fresh session.'
          : 'No active session to stop.').catch(()=>{});
        res.json({ ok: true, sentinel: 'emergency-stop', killed: !!sessionName });
        return;
      } else { // pause
        if (sessionName && ctx.telegram?.onSentinelPauseSession) ctx.telegram.onSentinelPauseSession(sessionName);
        ctx.telegram?.sendToTopic?.(Number(topicId), sessionName
          ? 'Session paused.\n\nSend a message to resume.'
          : 'No active session to pause.').catch(()=>{});
        res.json({ ok: true, sentinel: 'pause', paused: !!sessionName });
        return;
      }
    }
  } catch (err) {
    // FAIL-OPEN — never block message delivery on a sentinel hiccup.
    console.error(`[telegram-forward] sentinel intercept error (fail-open): ${err}`);
  }
}
```

**Design properties:**
- **Fail-open** — mirrors `processUpdate`'s existing behavior; a classifier error falls through to normal routing so message delivery is never blocked by the safety check.
- **Reuses tested logic** — `onSentinelKillSession` (resume-UUID save + kill), `onSentinelPauseSession`, `stopAutonomousTopic` are the exact callbacks/functions the adapter path already uses; no new kill logic.
- **Placed before the version-handshake?** No — after the handshake + validation, so a 426/400 still short-circuits first (an emergency-stop from a version-skewed lifeline still gets the restart handshake; acceptable — the lifeline retries and the next forward lands the stop). Placed before logging/routing so the message is intercepted, not delivered.
- **Both branches** — the with-adapter branch resolves session via `ctx.telegram.getSessionForTopic`; the no-adapter branch resolves via the `topic-session-registry.json` already read there, and falls back to `ctx.sessionManager.killSession`.

## Testing (all tiers — Testing Integrity Standard)

- **Unit:** the classifier already has coverage; add a unit asserting the route-layer intercept helper kills on `emergency-stop`, pauses on `pause`, passes `normal` through, and fails open on a throwing classifier.
- **Integration:** `POST /internal/telegram-forward` with an `emergency-stop` text (sentinel stubbed/real) → asserts the session-kill path fires and the message is NOT routed to the session; with `normal` text → asserts normal routing proceeds; with a throwing sentinel → asserts message still routes (fail-open). Extend the existing `tests/integration/telegram-forward-*.test.ts` harness.
- **Wiring-integrity:** assert that `/internal/telegram-forward` calls `ctx.sentinel.classify` before routing (static/structural check on the handler) — the regression guard that makes this drift impossible to reintroduce silently. This is the test whose absence allowed the original gap.

## Migration parity

Pure server-side route logic in `src/server/routes.ts` — ships to every agent on the normal server update; no agent-installed file (hook/config/template) changes, so no `PostUpdateMigrator` work. Existing lifeline-owned agents get the fix the moment they run the new server build.

## Rollback

Single localized block in one route. Revert = delete the block; behavior returns to current (sentinel dark on the forward path). Fail-open design means even a buggy intercept cannot block message delivery. No state/schema changes.

## Signal-vs-authority compliance

`MessageSentinel` remains the authority that decides emergency-stop/pause (LLM + deterministic patterns). This change only routes its existing verdict to the action on the path that was missing it. No new detector gains blocking authority; the sentinel's authority is unchanged.

## Side-effects review

See `upgrades/side-effects/emergency-stop-forward-path-wiring.md`. Headline: the only behavior change is that emergency-stop/pause now fire on the lifeline forward path; the fail-open guarantee means the worst case of a sentinel bug is "behaves like today" (message routes normally), never "message blocked."

## Success criteria

- An `emergency-stop` message through `/internal/telegram-forward` kills the topic's session + clears its autonomous job (integration test green).
- A `normal` message still routes (no false-positive interception).
- A throwing sentinel still delivers the message (fail-open test green).
- The wiring-integrity test asserts classification-before-routing on the forward path.
- Live reproduction: before = "stop everything" injected as normal text; after = session terminated. Verified on a real session before merge.
