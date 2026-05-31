# Side effects — stated-continuation stop guard

## What changes at runtime

The built-in `stop-gate-router.js` Stop hook gains a local, mode-independent
guard. On every Stop, if the agent's final message states an imminent this-turn
action ("I'll build X now", "starting now", "next phase: ...", "on it ... now")
the hook returns `{decision:'block'}` (exit 2) ONCE, re-feeding the agent to
either do the work or tell the user plainly it is stopping and why.

## Who is affected

- **Every Instar agent on update.** Built-in `instar/` hooks are always
  overwritten on migration, so the guard deploys automatically — no opt-in,
  no per-agent migration. New agents get it via `init`.

## Behavioral side effects (intended)

- An agent that ends a turn right after saying "I'll do X now" will be blocked
  once and pushed to either act or send an explicit stop message. This is the
  intended fix; it converts silent stalls into either real work or an honest
  "I'm stopping because…" message.
- Borderline matches (e.g. a summary heading "Next phase: …") cost exactly one
  extra nudge and force an explicit sign-off — acceptable and desirable.

## What is NOT affected

- The server-side Unjustified Stop Gate, its mode (shadow/enforce), its telemetry,
  and its circuit breaker are all untouched.
- The autonomous-stop-hook and hook-event-reporter Stop hooks are untouched.
- The loop-prevention contract is preserved: the existing `stop_hook_active` guard
  still short-circuits on the re-fire, so the guard fires at most once per stop —
  no infinite continuation loop is possible.
- "Report-back-later" / scheduled commitments (no imminence marker) are NOT
  caught — those remain the commitment tracker's domain.

## Rollback

Revert the `getStopGateRouterHook()` change; the next migration overwrites the
installed hook back to the prior content. No state, config, or schema changes are
involved.
