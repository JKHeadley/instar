# Side-Effects Review — Graduate the Subscription Pool capability (P-graduate)

## Scope of change

- `src/server/CapabilityIndex.ts` — remove `subscription-pool` from `INTERNAL_PREFIXES`; add a `subscriptionPool` entry to `CAPABILITY_INDEX` (key, prefixes, description, build → configured/accounts/quotaPoller/scheduler/enrollmentWizard/endpoints).
- `src/scaffold/templates.ts` (`generateClaudeMd`) — add the Subscription Pool awareness blurb so NEW agents know the capability.
- `src/core/PostUpdateMigrator.ts` (`migrateClaudeMd`) — add a content-sniffed, idempotent migration so EXISTING agents get the same blurb on update (Migration Parity).
- `upgrades/next/subscription-auth-graduate.md` — release-note fragment.

## What this does (and does NOT) change

This is a **classification + awareness** change. It surfaces an already-shipped,
already-tested capability (P1.1 registry, P1.2 poller, P1.3 scheduler + continuity
guarantee, P2.1 enrollment, P2.2 dashboard) to `/capabilities` and to the agent's
CLAUDE.md. It adds **no route, no class, no runtime behavior** — the routes, the
scheduler, the wizard already exist and are wired. The `build()` function is pure
(reads `ctx.subscriptionPool` etc. already on the context) and runs only when
`/capabilities` is probed.

## Why now (maturity honesty)

The original `INTERNAL_PREFIXES` entry explicitly said `subscription-pool`
"graduates to a surfaced CAPABILITY_INDEX entry (+ CLAUDE.md awareness blurb) once
the quota-aware scheduler (P1.3) and mobile enrollment wizard (P2.1) make it
user-usable. Surfacing the bare registry now would overclaim an unfinished
capability." P1.3 + P2.1 (+ P2.2 dashboard) are now merged — the maturity bar the
note set is met, so surfacing it is honest, not overclaiming.

## Authority / autonomy analysis

- **No new authority.** The auto-swap of live sessions remains OFF by default
  (`subscriptionPool.autoSwapOnRateLimit`); the blurb documents it as opt-in. The
  enrollment blurb tells the agent to drive the wizard and NEVER ask the user to
  paste a token — reinforcing the existing credential-safety posture.
- **The migration edits agent-installed CLAUDE.md** — but only appends a doc
  section, content-sniffed on a distinctive marker (idempotent: re-running is a
  no-op), and never touches a custom/user-authored section. This is the standard
  `migrateClaudeMd` append pattern used by ~30 prior sections.

## Failure modes considered

- Capability probed on an agent with no pool wired → `build()` returns
  `{ configured:false, accounts:0, ... }` (no throw; the routes already answer
  `200 { enabled:false }`).
- Migration run twice → content-sniff marker present → skipped (idempotent).
- Migration on an agent whose CLAUDE.md predates the section → appended once.
- The capabilities-discoverability lint: `/subscription-pool` is now claimed by
  exactly one CAPABILITY_INDEX entry and absent from INTERNAL_PREFIXES (verified:
  CapabilityIndex.test.ts green).

## Blast radius

Minimal. Classification metadata + a documentation blurb + an idempotent doc
migration. No behavior path changes; `/capabilities` gains one block; new + existing
agents gain one CLAUDE.md section.

## Framework generality

Framework-agnostic in the surface, Claude-first in the wired mechanism (matching the
standard's scope, Justin's decision 3): the CAPABILITY_INDEX entry + blurb describe
the pool generically (provider/framework-parameterized), and the enrollment + quota
machinery already carry `provider`/`framework` fields. The continuity-guarantee swap
is implemented for `claude-code` today (per-account `CLAUDE_CONFIG_DIR`); other
frameworks slot into the same registry + selector when their per-account config is
wired. Surfacing the capability does not bake in any Claude-only assumption beyond
what the underlying (already-merged) phases already chose.

## Migration / parity

This change IS the parity work: `generateClaudeMd` (new agents) + `migrateClaudeMd`
(existing agents) both get the blurb, satisfying the Agent Awareness + Migration
Parity standards. No config/hook/skill change. Ships via dist.
