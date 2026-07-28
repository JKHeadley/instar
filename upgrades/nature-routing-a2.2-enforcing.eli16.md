# ELI16 — Nature-Axis Routing, Increment A2.2 (enforcing selection)

## The one-sentence version

We took the nature-routing resolver that has been silently watching ("here's the model+door
I *would* pick") and wired it so that, when an operator deliberately flips it on, it *actually*
picks — the resolved model and access door become the real selection, and its fallback list
drives the real failover.

## Why

Increment A2.1 shipped a resolver: given an internal check, it works out the *kind* of thinking
the check does (a quick sort, a careful judgment, open-ended writing), walks an ordered list of
`(door, model)` candidates, and returns the winner plus a fallback tail. But it was a spectator —
it computed the plan, logged it, and then still did exactly today's routing. That was the honest,
observe-first step. A2.2 is the step where the plan becomes the decision. Nothing about the
resolver's *choice* changes; what changes is that the choice is now applied.

## What already exists (and stays exactly as-is)

- **The resolver** (`resolveRoute`) — the pure, side-effect-free fold with four honest outcomes:
  a resolved route; "fall through to today's routing" (for an unmapped component); "no route —
  use your own backup heuristic" (for a low-stakes sorter when every door is down); or **throw a
  distinct fail-closed error** (for a safety gate when every door is down — a gate must fail shut).
- **The safety clamps** — the deny-by-default allowlist that pins any Claude-door bounded/judgment
  call to the single sanctioned Sonnet reserve id (so the measured-banned Opus-via-Claude-CLI route
  can never open), the FD4 chain validators, and A1's always-on degrade clamp. None of these change.
- **The failure-swap loop** — the existing machinery that, on a runtime failure, tries the next
  door with per-target timeouts, a total budget, a rate-limit backoff, and honest degrade notes.

## What this adds

When the feature is enabled AND the operator has deliberately turned off dryRun, the resolved plan
**replaces** today's selection: the primary `(door, model)` becomes the door and model the call runs
on, and the resolved fallback tail feeds the *existing* failure-swap loop verbatim — each fallback
position carrying its own concrete model. The four outcomes are honored on this real path: a fail-
closed gate now actually throws (its caller blocks/denies, never falls open); a low-stakes empty set
raises the ordinary "use your heuristic" error the caller already catches (never today's category
routing, so the harness door can't sneak back in); an unmapped component falls through to today's
routing unchanged. The old one-time "enforcing not yet wired" warning is retired — it is now real.

## The safety promise

When the feature is **off or unset** (the fleet default), the router is **bit-for-bit like today** —
same door, same model, same options object passed through untouched. The named byte-identical test
still guards this. In **dryRun** (the dev-agent default) it is still a spectator: it observes and logs,
changes nothing. Only a deliberate operator flip of `dryRun:false` — after reviewing the dryRun plan —
ever activates the re-routing. No defaults changed; the fleet stays dark; the metered paid doors stay
skipped (that is Increment B, still deferred and PIN-gated). This change makes the switch *real*, but
leaves it *off*.
