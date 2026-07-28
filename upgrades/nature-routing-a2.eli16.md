# ELI16 — Nature-Axis Routing, Increment A2.1 (the dark/dryRun mechanism)

## The one-sentence version

We taught the internal LLM router how to pick *which model, on which access door* a
background check should run on — based on the **kind** of thinking the check does — but
we shipped it **turned off** everywhere except as a silent "here's what I *would* pick"
observer on a development agent.

## Why

Different internal jobs need different brains. A quick "is this a STOP command?" sort is a
different task than a careful "should this message be blocked?" judgment. The bench (INSTAR
v3) measured which model+door combo is best for each kind — and found one combo that's
actively *dangerous* for careful judgments: Opus running through the Claude Code CLI (the
CLI wraps every prompt in ~20k tokens of "helpful assistant" framing, which makes a skeptical
judge go soft — it missed real STOP commands 27% of the time). So routing has to be able to
say "for a judgment call, NEVER land on that door."

## What this increment actually adds (and what it deliberately doesn't)

**Adds (all pure, all dark):**
- A **resolver** — a small, side-effect-free function: given a component, it works out the
  task *nature*, walks an ordered list of `(door, model)` candidates, skips the ones that
  aren't reachable, and returns the winner + the fallback tail. It has exactly four honest
  outcomes: a route, "fall through to today's routing" (for a component we haven't mapped),
  "no route — use your own backup" (for a low-stakes sorter when everything's down), or
  **throw a distinct fail-closed error** (for a safety gate when everything's down — a gate
  must fail shut, never open).
- **FD4.1 — the concrete pin.** A2 finishes the job A1 left: the sanctioned Claude reserve
  now pins to a *concrete* model id (`claude-sonnet-4-6`), not a tier nickname that could
  drift. And a **deny-by-default allowlist** clamp: on the Claude door, a judgment/sort call
  may ONLY use that one reserve id — anything else gets clamped down to it. (Open-ended
  *writing* is exempt — that's where Opus-via-CLI is legitimately the best tool.)
- The `sessions.natureRouting` **config knob** (seeded dark on update), the wiring, and the
  full test suite.

**Doesn't (tracked, not dropped):** the actual *re-routing* (enforcing mode), the injection
map, the build-time lint, the live-config validator, the durable audit log + dashboard read
surface, the critical-gate drift notice, and the Fable→Opus migration — those are the ordered
A2.2 remainder. And **nothing** about the paid metered doors or the money/PIN go-live — that
is Increment B, deferred and PIN-gated.

## The safety promise

When the feature is **off** (which is everywhere on the fleet), the router behaves **bit-for-bit
like today** — same door, same model, same everything. That's the whole safety case, and there's
a named test that asserts it (`natureRouting UNSET ⇒ selection unchanged`). On a dev agent it runs
in **dryRun**: it computes and logs what it *would* pick, then still does exactly today's thing.
Flipping it to actually re-route is a later, operator-driven step.
