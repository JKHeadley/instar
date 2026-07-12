# Quiet-Settings Follow the Agent — Design Brief (decision document)

**Status:** DESIGN BRIEF for operator decision — not a spec. The chosen direction becomes a spec through `/spec-converge` before any build.

**The problem (from the 2026-07-11 incident):** when you tell me "quiet these alerts," that decision lands in ONE machine's config file. Two days later the Laptop rejoined the mesh with the OLD settings and re-flooded the Attention topic — the quieting never followed the agent, only the machine. The same class of divergence (the `developmentAgent` flag, dry-run flags, alert tuning) has bitten repeatedly: any operator intent expressed as per-machine config silently forks across machines.

**What "quiet-settings" covers (scope):** operator-intent knobs that shape narration/noise — `monitoring.*` enable/dryRun/threshold flags, alert routing, burn-detection toggles, the calm-alerting levers from the converged spec. NOT covered: machine-genuine locality (ports, paths, hardware tuning), secrets, or structural flags with blast radius (`developmentAgent` — that one stays a deliberate per-machine decision surfaced by the coherence guard).

## The three honest options

### Option A — Config overlay as a replicated store (the structural fix)

A new `stateSync` store kind: an **operator-settings overlay** — a small, replicated key-value record ("quiet machine-coherence alerts", "burn alerts off") that every machine merges over its local config file at the guard-construction seam. Set once conversationally, replicated with the same hardened machinery as preferences/learnings (type-clamped, tombstoned, conflict-surfaced), consulted by guards on every machine.

- **Pros:** one decision → whole agent, forever; survives machines joining/rejoining (the exact incident); the conflict story (two machines set different values during a partition) inherits the foundation's no-clobber + surface-for-resolution semantics; auditable ("who set what, when" — one place).
- **Cons:** the biggest build (a new store kind + an overlay-resolution seam in config loading); boot-read guards still need restart-to-apply on each machine (the overlay can carry a "restart wanted" marker, but restart coordination is its own care); a second source of config truth (overlay vs file) needs a crisp precedence rule and a `GET /guards`-style read showing effective-value + source.

### Option B — Desired-state through the coherence guard (extend what exists)

The machine-coherence guard already detects config divergence and already carries an operator-approved fix path (`approveFix` — "switch feature to value on machine X"). Option B makes your quiet-decision a **desired-state record**: when you set a quiet-setting, the agent records it as the desired value; the coherence guard treats any machine diverging from desired state as a skew row and proposes (or, for pre-ratified quiet-settings, auto-applies) the fix on the lagging machine.

- **Pros:** builds on live, already-reviewed machinery (detection, participant awareness, operator-consent flow, audit); no new store kind; the "rejoining machine with stale settings" case is exactly a skew the guard already sees.
- **Cons:** the guard becomes a config-management actor (today it only detects + proposes — auto-apply is new authority needing its own gates); cadence is the guard's tick + episode flow, so convergence is minutes-not-instant; desired state still needs SOME replicated home (a mini version of Option A's record), so it's partly A with extra moving parts.

### Option C — Broadcast write at decision time (the pragmatic lever)

No new state. When you set a quiet-setting conversationally, the agent writes it to EVERY machine right then — over the existing authenticated mesh (each machine's config file edited via its own API/agent, then guards restarted). A rejoining machine that was offline at decision time gets caught the next time by… nothing — that's the hole.

- **Pros:** smallest build; instant convergence when all machines are up; no new config-precedence semantics.
- **Cons:** does NOT fix the incident class — the Laptop was OFFLINE when the quieting happened; a broadcast can't reach a machine that isn't there, and nothing replays it on rejoin. Broadcast + a durable replay ledger ≈ Option A anyway. Honest verdict: C alone re-creates the bug it's meant to fix.

## Recommendation

**Option A, scoped tight** — a replicated operator-settings overlay limited to an allowlisted set of narration/noise keys — with **Option B's guard as the safety net** (the coherence guard keeps flagging any divergence between a machine's EFFECTIVE values and the overlay, catching bugs in the overlay itself). Option C's instant-write becomes A's delivery optimization (push on set; the store replay covers the offline-rejoin case).

Why: the incident's defining feature was the offline machine rejoining stale — only a durable, replicated record fixes that; the stateSync foundation was built for exactly this shape and already answers the hard questions (identity, conflicts, tombstones, at-rest honesty); and the allowlist keeps the blast radius to noise-knobs, never structural flags.

**Cost honesty:** Option A scoped this way is roughly the size of one of the WS2 store rollouts (preferences/learnings) plus a config-resolution seam — a real multi-day build, shipped dark per the usual ladder. Options B-net and C-push are additive increments after A lands.

## What I need from you (the actual decision)

1. **Direction:** A-scoped-tight (recommended) / B / C / "don't build this — quiet-settings stay per-machine and I accept re-quieting each machine."
2. **The allowlist boundary:** noise/narration knobs only (recommended), or also dry-run/enable flags for guards (more power, more blast radius)?
3. **Auto-apply vs propose:** when a machine diverges from the overlay, fix it silently (recommended for allowlisted noise knobs — that's the point) or propose-and-ask like the coherence guard's fix flow?

Nothing is built until you pick; the chosen direction then runs `/spec-converge` like the calm-alerting spec did.
