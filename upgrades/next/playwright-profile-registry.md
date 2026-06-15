# Upgrade Guide — NEXT

<!-- bump: minor -->
<!-- Valid values: patch, minor, major -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->
<!-- minor = new features, new APIs, new capabilities (backwards-compatible) -->
<!-- major = breaking changes to existing APIs or behavior -->

---
user_announcement:
  audience: user
  maturity: experimental
  summary: "Your agent now keeps a structured map of which browser profile is logged into which account — so it can pick the right one and self-unblock instead of asking you to drive the browser."
---

## What Changed

**A durable per-agent registry mapping each Playwright browser profile to the accounts it is logged into — plus boot-time awareness of what browser access the agent actually has.** Until now the agent self-unblocked by driving a real browser (Playwright MCP) logged into real accounts, but there was no authoritative record of *which profile holds which account*. That knowledge lived only as ~21 scattered, partly-contradictory `operationalFacts` — which led the agent to ask the operator to act (or grind a credential treadmill) instead of resolving the right profile itself.

The new `PlaywrightProfileRegistry` (`src/core/PlaywrightProfileRegistry.ts`) is the missing data + awareness + selection + activation layer:

- A durable, machine-local state file `state/playwright-profiles.json` mapping each **profile** (a physical browser user-data-dir on THIS machine) to the **accounts** it is responsible for — by vault-secret NAME only, **never values**.
- A compact boot-awareness pointer injected at session start (`GET /playwright-profiles/session-context`), so the agent knows from message one what browser access it has and **as whom** — operator-owned accounts flagged loud (Know Your Principal), login state rendered as last-asserted staleness (advisory, never a guarantee).
- Routes to list / create / assign / resolve / activate profiles. `resolve` picks the owning profile for a `(service, identity)` and forces disambiguation rather than silently picking a privileged account; `activate` rewrites the MCP config and restarts the session onto the chosen profile.

**Safety posture (the honesty disciplines that keep this from re-creating the scattered-facts problem):** no secret VALUE is ever stored, returned, injected, or resolved (names only). Every write is audited (`logs/playwright-profiles.jsonl`). A corrupt registry file fails CLOSED for writes (never auto-overwritten) and OPEN for the boot block (injects nothing). Caller-supplied profile dirs are path-jailed to the agent home. The seed is metadata-only — it never touches `.mcp.json` / `.claude/settings.json`, so an update can never regress another agent's shared browser login.

**Rollout:** the whole feature is **dev-gated** (`playwrightRegistry.enabled` omitted → live on a development agent, **dark on the fleet** — routes 503, the boot block injects nothing). The only destructive op, `activate` (config rewrite + session restart), additionally ships `dryRun: true` — it LOGS the intended rewrite/refresh and performs NEITHER until a deliberate `dryRun: false`. Existing agents pick it up via full migration parity (state seed, session-start hook, CLAUDE.md awareness section, config default + strip-false migration).

## Evidence

- `PlaywrightProfileRegistry` seeds exactly one `default` profile via the shared `resolvePlaywrightMcpConfig()` resolver (records the real `--user-data-dir` if the canonical config carries one, else `null` = the built-in default — never `.playwright-mcp`, which is the MCP output-dir, not the browser profile).
- New `DEV_GATED_FEATURES` entry `playwrightRegistry` (configPath `playwrightRegistry.enabled`) — picked up automatically by the dual-side wiring test (`tests/unit/devGatedFeatures-wiring.test.ts`): the entry resolves LIVE under a dev-agent config and DARK under a fleet config.
- `ConfigDefaults` adds `playwrightRegistry: { dryRun: true }` and OMITS `enabled` (the dev-gate convention, mirroring `credentialRepointing` / `topicProfiles`).
- Migration parity in `PostUpdateMigrator`: the `/playwright-profiles/session-context` session-start fetch+inject block is modeled byte-for-byte on the existing `/self-knowledge/session-context` block (`curl -sf --max-time 4 --connect-timeout 1`, `python3` parse of `.block`, fail-open on 503/404/empty); a `migrateClaudeMd` content-sniff appends the awareness section; the `playwright-profiles-seed-v1` marker migration seeds the default profile metadata-only (idempotent, marks done either way); a `migrateConfigPlaywrightRegistryDevGate` strip-false migration mirrors the credential-repointing strip so a stale default-shaped `enabled: false` resolves the gate live.
- The CLAUDE.md awareness section is authored ONCE (`PLAYWRIGHT_PROFILE_REGISTRY_CLAUDEMD_SECTION`) and shared by `generateClaudeMd` (new installs) and `migrateClaudeMd` (existing agents) so the two can never drift.

## What to Tell Your User

- ⚗️ **Experimental, development-agent only.** On the fleet this ships dark — the routes 503 and nothing is injected at session start, so a normal agent sees no change. On a development agent it runs live, but the only state-changing operation (switching the browser onto a profile) is held in dry-run by default, so it only LOGS what it would do until that is deliberately turned off.
- **What it gives a dev agent:** instead of asking you to drive the browser or produce a credential, the agent can now look up which browser profile is logged into a given account, pick the right one, and (when activated) restart its session onto that profile. It tracks which accounts are **yours** vs the agent's own, so it won't act as you in a browser unless explicitly authorized — and login state is treated as last-asserted, so it re-verifies in-browser before any privileged action.
- **At-rest honesty:** the registry file is plaintext machine-local. It lists account identities + vault key NAMES — so filesystem access to the machine reveals the agent's access *map*, never the credentials themselves (same posture as the self-knowledge tree and the relationships store).

Side-effects review: upgrades/side-effects/playwright-profile-registry.md

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| See which browser profile holds which account (full detail; vault NAMES only) | `GET /playwright-profiles` |
| Compact boot-awareness pointer (also auto-injected at session start) | `GET /playwright-profiles/session-context` |
| Create a custom profile | `POST /playwright-profiles` `{ id, description?, userDataDir? }` |
| Assign an account to a profile (owner agent\|operator; vault NAMES only) | `POST /playwright-profiles/:id/accounts` `{ service, identity, owner, vaultRefs[], loginMethod?, note? }` |
| Pick the right profile for a task | `GET /playwright-profiles/resolve?service=&identity=` (ambiguous service-only → `{ ambiguous: true, candidates }`) |
| Switch the browser onto a profile (config rewrite + session restart) | `POST /playwright-profiles/:id/activate` (ships `dryRun: true` — logs the intended switch until a deliberate `dryRun: false`; reversible by activating `default`) |
