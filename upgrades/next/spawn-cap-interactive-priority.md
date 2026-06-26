# Interactive Priority Lane for the Host Spawn Cap

**Slug:** `spawn-cap-interactive-priority` · **Maturity:** 🧪 Preview (dark-fleet / live-dev) · **Audience:** agent-only

## What Changed

The host spawn cap (the fork-bomb/OOM safety floor that bounds how many LLM
subprocesses run at once) now reserves a little headroom for the user's reply. Under
load, the user-facing tone gate used to wait in the same undifferentiated line as
background sentinels and could time out (a cause of the 2026-06-25 silent-outbound
incident). The cap now SUBDIVIDES into a small interactive reserve + a small background
reserve, so a synchronous operator reply always has slots and is never starved by
background chatter. The total cap is NEVER raised — only *who gets which slot* changes.
Ships dark on the fleet / live on a development agent (dev-agent gate); byte-identical
to today when off.

## What to Tell Your User

When the machine is busy, your reply's safety check now jumps to a reserved slot instead
of waiting behind background work — fewer slow/held replies under load. The crash
protection is exactly as strong as before. Most setups see no change (it's off on the
fleet for now).

## Summary of New Capabilities

- `attribution.lane:'interactive'` requests reserved headroom — honored ONLY for an
  allowlisted, user-blocking seam (the operator-facing tone gate); everything else stays
  background.
- Symmetric reservation within the existing cap N (`Ri`/`Rb`, default 2/2): interactive
  guaranteed ≥Ri slots, background guaranteed ≥Rb — neither starves the other.
- `/spawn-limiter` reports per-lane live counts + the reservation config.
- Off (the fleet default) ⇒ byte-identical to the all-or-nothing cap (no `lane` written).

## Evidence

- `hostSpawnSemaphore-priority.test.ts` (10): symmetric reserve, OOM floor unconditional,
  garbage-lane→background-never-dropped, clamp (N=1/N=2/oversized/0), off=byte-identical.
- `spawn-cap-provider-lane.test.ts` (7): allowlist downgrade (CoherenceReviewer→background),
  off→background, interactive fast-path, saturated interactive still fails closed,
  membership pinned.
- 25 existing spawn-cap tests + 160 tone-gate tests pass unchanged (no regression; the
  fork-bomb burst-invariant test still green). `tsc --noEmit` clean.
- Side-effects: `upgrades/side-effects/spawn-cap-interactive-priority.md`.
- Spec (converged + approved): `docs/specs/spawn-cap-interactive-priority.md`.
