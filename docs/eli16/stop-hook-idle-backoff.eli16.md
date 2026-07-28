# ELI16 — Stop poking the model every 4 seconds while it's waiting

## The problem, like you're 16

The autonomous loop works like this: the agent finishes a turn, a "stop hook"
catches the stop and re-feeds the ENTIRE mission briefing (the frame) plus all
context back to the model so it keeps going. That's the right move when there's
work to do.

But when the agent is *waiting* — holding for the operator to wake up, for a
budget window to reset, for another agent to finish — each turn is just "still
holding." The turn takes ~4 seconds, stops, and the hook instantly re-injects
the full briefing again. ~15 times a minute. All night. Thousands of tokens per
poke, for an agent that has nothing to do. That's the rapid-idle-refire waste
Justin flagged on 2026-06-06: an operator's 6–8 hour sleep = thousands of
token-heavy no-op re-injections.

## The fix

The hook now *paces itself* when the loop looks idle:

- **It measures the agent's ACTIVE time** between re-injections (stop arrival
  minus the last resume — sleep time never counts, so a long wait can't
  masquerade as work). A short gap = the agent did basically nothing = an idle
  cycle.
- **Consecutive idle cycles back off**: 3 in a row → wait 30s before the next
  re-injection; 6 → 2 minutes; 10+ → 5 minutes. One real burst of work makes
  the gap long and resets the counter to zero instantly — a productive loop
  never waits at all.
- **It stays responsive**: during the wait it checks every 5 seconds for a new
  inbound message on its topic, the emergency-stop flag, or its job being
  stopped — any of those cuts the wait short immediately. A user message gets
  through in ≤5s, not 5 minutes.
- **It can never strand the loop**: the wait self-clamps to a third of the
  hook's own registered timeout (read live from settings.json; unreadable →
  conservative 20s). A timed-out Stop hook fails OPEN — the session would just
  exit and the loop would die silently — so the clamp guarantees we always err
  toward a little noise rather than a dead loop.

State lives in a tiny per-topic sidecar (`<topic>.local.backoff.json`) next to
the job's state file — invisible to the server (which only reads `*.local.md`),
reset automatically when a new run starts.

## What did NOT change

- A busy loop is untouched: real work = long gaps = counter stays 0 = zero
  added latency.
- The frame content, iteration counting, progress-report cadence, completion /
  duration / emergency handling — all identical. The backoff only inserts a
  wait BEFORE the re-injection when the recent history is all idle cycles.
- Existing agents get the paced hook automatically via the migration marker
  bump (`RESTART_NOTE_SILENT` → `IDLE_BACKOFF`); customized hooks are left
  untouched, as always.
- `INSTAR_HOOK_BACKOFF_DISABLE=1` (or the env tier/clamp seams) gives tests and
  operators an instant off-switch.
