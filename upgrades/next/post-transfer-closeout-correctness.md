---
audience: agent-only
maturity: experimental
---

# Post-Transfer Closeout Correctness (liveness-gate the stale-ownership kill)

## What Changed

On a multi-machine setup, the SessionReaper's post-transfer closeout could terminate the LIVE local session for a topic when the local ownership record was STALE — it acted on "the registry says another machine owns this topic" without ever verifying that the other machine ACTUALLY has a live session for it, so a stale label could get the only live worker killed (and the operator-visible symptom was a `closeout-breaker` "the old session won't close" alert, escalating the wrong thing). This change (dev-gated dark behind `monitoring.sessionReaper.closeoutLivenessGate`, LIVE on a development agent) makes the closeout verify remote liveness first via a machine-local snapshot of each peer's `GET /sessions`: it proceeds ONLY when the owning machine genuinely has a live session (a real duplicate), and WITHHOLDS — never killing the sole live worker — on a no-live-remote-session reading, an unknown/unreachable peer, or any uncertainty (fail-closed everywhere). It also re-keys the closeout breaker counters on the stable topic id so a session-id churn across respawn no longer resets the veto count, and adds a narrow audited keep-reason bypass so a genuine move's leftover with a stale pre-move "recent" message can actually shed. Ships dark on the fleet (the dark stage of the maturation ladder, with explicit fleet-promotion criteria); when off, the closeout's behavior is byte-identical to today.

## What to Tell Your User

If you run me across more than one machine, I will never close the one session still doing real work just because a stale "who owns this conversation" record points at another machine. Before this, a record that went stale (the other machine already finished) could make my cleanup robot keep trying to kill the live worker in a loop. Now I first confirm the other machine actually has a live session before closing the leftover; if I can't confirm it, I hold off rather than risk killing live work. This is off everywhere except this development agent while it soaks.

## Summary of New Capabilities

- The post-transfer closeout now liveness-gates the kill: it terminates a topic's leftover session ONLY when the owning machine is confirmed to have a live session, and WITHHOLDS (fail-closed) when the owner has no live session, is unreachable, or liveness is unknown — so a stale ownership record can never get the sole live local worker killed.
- A narrow, audited `recent-user-message` bypass lets a genuinely-moved leftover finally shed, but only after re-checking every OTHER keep-guard (active-subagent, open-commitment, …), so a live-working session is never killed by the bypass.
- The closeout veto breaker is re-keyed on the stable topic id (not the churning session id), and the whole behavior ships dark behind `monitoring.sessionReaper.closeoutLivenessGate` (default OFF; dev-gated live-on-dev / dark-on-fleet) — flag off is byte-identical to today.
