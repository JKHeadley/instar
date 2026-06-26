# Verify-After Topic Reachability — core components (F7)

**Slug:** `verify-after-reachability` · **Maturity:** 🧪 Preview (core components; not yet wired) · **Audience:** agent-only

## What Changed

Lands postmortem fix F7 (Blast-Radius / Verify-After), dark on the fleet / live on a dev
agent. Two parts: (1) the live inbound spawn-guard is now a token-tagged
`SpawningTopicsRegistry` — a hung session start no longer silently wedges a topic forever
(ABA-safe; the `.finally` stays the sole clearer, no risky auto-clear). (2) a pure-signal
`TopicReachabilityVerifier`: after a session is killed/reaped, it checks (after a grace
window) that the conversation can still receive your next message, and if a genuine
orphan (e.g. a wedged start-up) it surfaces ONE calm NORMAL heads-up. It mutates nothing —
never kills, spawns, or clears. The probe is conservative + fail-safe (uncertain ⇒
treated as reachable), so it never cries wolf on a normal idle kill.

## What to Tell Your User

If I ever shut down a conversation's session and it genuinely can't be reached again
(e.g. a start-up that hung), you now get one calm "this conversation may be unreachable"
heads-up instead of your messages silently vanishing. Most of the time you see nothing,
because most kills self-heal on your next message. It only watches — it never tries to
auto-fix the stuck state (that proved too risky); the mechanical repair stays a tracked
follow-up. Off on the fleet for now.

## Summary of New Capabilities

- A hung session start-up can no longer permanently jam a conversation's inbound path
  (token-tagged spawn guard; ABA-safe).
- After a destructive session/routing op, a dev agent verifies the topic is still
  reachable and surfaces a genuine orphan as ONE NORMAL attention item (deduped,
  flap-backoff-capped, burst-rolled-up, pressure/emergency-stop aware with a re-sweep).
- Visible in `/guards` (registered). Dark on the fleet (dev-agent gate). Mutates nothing.

## Evidence

- `spawningTopicsRegistry.test.ts` (5): ABA token-guard; `.finally` sole clearer (no
  timeout/sweep); stuck-age seam.
- `topicReachabilityVerifier.test.ts` (8): grace; reachable-honesty (no false orphan on a
  topic that self-heals); orphan→one NORMAL item; pressure/halt skip + re-sweep; flap
  backoff; burst roll-up; coalescing.
- `tsc --noEmit` clean.
- Side-effects: `upgrades/side-effects/verify-after-reachability.md`.
- Spec (converged + approved): `docs/specs/verify-after-reachability.md`.
