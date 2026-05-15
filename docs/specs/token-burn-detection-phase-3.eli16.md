# Token-Burn Detection — Phase 3 ELI16

## What this ships

The actual watcher. This is the first phase you can see working — when a single piece of the agent is using more than its fair share of the token budget, this phase notices and writes the finding into the existing degradation log.

There are still no Telegram alerts and no automatic throttling — those come in phases four and five. What ships now is the eyes: a small background process that wakes every sixty seconds, queries the token ledger, computes the per-component spend share, and raises a flag when a single component crosses one of two thresholds.

The two thresholds (from the spec you approved):

1. **Absolute share** — one component took more than a quarter of the 24-hour budget. This is the trigger that would have caught the 2026-05-15 incident (the InputDetector had 73% of spend; the threshold is 25%).

2. **Baseline divergence** — a component's last-hour rate is more than double its trailing-seven-day median, AND the hour was big enough in absolute terms to be worth alerting on (over ten million tokens per hour, so we don't fire on tiny spikes). This catches the slow build — something that was fine yesterday and quadrupled today.

The baseline-divergence trigger needs seven days of history to compute. On a fresh agent that history doesn't exist yet. So for the first seven days of any component's life, only the absolute-share trigger fires. That's the trigger that catches the 2026-05-15 case, so a brand-new agent is still protected against the worst pattern — it just doesn't yet have the second, more subtle trigger.

A few safety details, all of them from the spec audit:

- A per-component one-hour cooldown so a flapping component doesn't spam the degradation log.
- The runbook's own component name is exempt by design at the detector (defence-in-depth; the rate gate also exempts it).
- The detector can be disabled with one config flag if needed.
- It uses pure inference, no LLM calls of its own.

## What you'd notice

Today: every minute, the agent quietly checks itself. When nothing crosses a threshold, you see nothing. When something does cross, an entry appears in the existing degradation log (visible on the dashboard, the same way every other degradation event already surfaces).

If a legitimate sustained burst — a long debugging session, a one-time bulk operation — crosses the threshold, you would see the entry but nothing changes about how the agent runs. Phase four is when the auto-throttle wires in; phase five is when Telegram alerts wire in. Until then, the dashboard's degradation tab is where these signals land.

## How we know it works

Sixteen tests in `tests/unit/burn-detection-phase-3.test.ts`. They cover: the absolute-share trigger firing at the right share, baseline-divergence firing when both the rate-ratio and the absolute-rate-floor conditions hold, cold-start behavior (the seven-day window correctly blocks baseline-divergence but absolute-share still fires), the per-key cooldown, the runbook-self exempt prefix, the disabled-config path, the empty-ledger path, the start/stop idempotency, the new ledger query method, and the shape of the emitted signal.

The existing token-ledger tests (sixteen of them) still pass — the new column-aggregation query was added without touching the existing ones.

## What's next

Phase four is the Tier-2 runbook that subscribes to these signals via the existing Remediator dispatch and decides what to do — alert only, throttle, or both. That phase brings in the HMAC-signed throttle-override file and the rate-gate enforcement.

Phase five adds the Telegram alerts with principal-bound buttons (the audit found that buttons need to be signed and tied to your user ID so an unauthorized chat cannot tap them).

Phase six is the verification step — five minutes after a throttle, the agent re-samples and confirms the rate actually dropped, then sends the before-and-after follow-up.
