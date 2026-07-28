# Upgrade Notes — NEXT

## What Changed

Fixed a P0 safety gap: the **emergency-stop** ("stop everything" / "cancel" / "halt") detector was not honored for agents that run in lifeline-owned polling mode. The MessageSentinel intercept lived only in the Telegram adapter's own poll loop (`processUpdate`), which lifeline-owned agents never run — their messages arrive through the server's `/internal/telegram-forward` route, which had no sentinel check. As a result, an emergency-stop message was delivered to the session as ordinary text and never structurally halted a running (or wedged, mid-tool-call) session.

The same emergency-stop/pause intercept is now wired into the lifeline forward path, reusing the existing kill/pause/autonomous-clear logic. It is **fail-open**: if the detector ever errors, the message is delivered normally — the safety check can never block message delivery. A wiring-integrity test now asserts that the forward route classifies before routing, so this drift cannot silently recur.

## What to Tell Your User

Saying "stop everything" now reliably halts your agent, no matter how its messages reach it. Before this fix, agents running in the more crash-resistant background mode could miss that command and keep working. Nothing changes for normal messages — only genuine stop and pause signals are intercepted, and if the safety check ever has a hiccup your messages still get through untouched.

## Summary of New Capabilities

- Emergency-stop and pause now fire on the lifeline message-forwarding path, not just the direct-polling path — closing a gap for the most robust class of agents.
- A regression guard (wiring-integrity test) keeps the stop-switch connected to every inbound path going forward.

## Evidence

- **Reproduction (pre-fix):** live classify call returned `emergency-stop` for "stop everything"; a code-path trace confirmed `/internal/telegram-forward` (the live ingress for lifeline-owned agents) contained zero sentinel references, so the message was routed to the session as normal text.
- **Post-fix proof:** new integration suite `tests/integration/telegram-forward-sentinel-intercept.test.ts` — 6/6 green, covering both sides of every boundary: emergency-stop kills the session and is not routed; pause pauses and is not routed; normal messages route untouched; a throwing detector still delivers the message (fail-open); and a no-active-session emergency-stop acknowledges without routing. Plus a wiring-integrity assertion that classification precedes routing.
- **Regression:** forward-route suite green (10/10 on the rebased branch; 23/23 including the full handshake/drift/error set) — no regression. Typecheck clean.
- **Side-effects review:** `upgrades/side-effects/emergency-stop-forward-path-wiring.md`.
