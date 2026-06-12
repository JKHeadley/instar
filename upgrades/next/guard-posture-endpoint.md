# Upgrade Guide — Guard-Posture Endpoint (GET /guards)

<!-- bump: minor -->

```yaml user_announcement
- audience: user
  maturity: stable
  text: "You can now see which of your machines' safety systems are GENUINELY working — not just switched on in settings. Ask your agent \"are my guards on?\" or open the Machines tab on the dashboard: each machine shows a guards line (confirmed on / needs attention) with how fresh the report is, even for a machine that's been offline for days. The exact blindness that let one machine's session cleaner stay off for a week unnoticed is closed."
```

## What Changed

Implements `docs/specs/GUARD-POSTURE-ENDPOINT-SPEC.md` (converged 5 iterations, operator-approved 2026-06-12, topic 13481 — GAP-001: the Mac Mini's SessionReaper stayed disabled for a week because no API exposed a machine's guard posture).

- **`GET /guards`** (Bearer-auth, read-only, always-on — deliberately no config gate): the full guard inventory (shared extractor ∪ declared manifest, one definition shared with the boot tripwire) with verification-graded effective states: `on-confirmed` / `on-unverified` / `on-stale` (dead tick loop — `enabled:true, lastTickAt:0` can never read green again) / `on-dry-run` / `off{dark-default | diverged-from-default}` / `diverged-pending-restart` (disk edit not yet live) / `errored` / `missing` (expected runtime never registered) / `off-runtime-divergent` (runtime contradicts an on-config — the in-memory load-shed class). Strict closed-field projection (sensitive guard config values like `alertTopicId` can never leak; Tier-1 leak tests).
- **`GET /guards?scope=pool`**: every registered machine accounted for by name — a posture row or a classified failure row (`timeout | unreachable | unauthorized | route-missing | no-known-url | offline | url-rejected | error`), never a silent omission, never a 500. The Bearer token is only attached to https/allowlisted peer URLs (`src/server/peerUrlGuard.ts`, operator-extensible via `multiMachine.peerUrlAllowlist`); non-recursive; rate-limited.
- **Heartbeat piggyback + durability**: the capacity heartbeat carries a compact posture block, bound to the authenticated sender at ingestion, aged by the RECEIVER's clock, persisted durably (`GuardPostureStore`) and reloaded at boot — a dark peer's last-known posture renders with its real age on the **Machines tab** ("guards: N on (M confirmed) · ⚠ … · as of 2d ago").
- **GuardPostureProbe** (SystemReviewer family): persisting anomalies (deviant offs, runtime divergence, stale, missing, errored, flapping) raise ONE aggregated, episode-deduped Attention item; dark-default offs stay quiet; offline peers evaluated from durable last-known posture, never a doomed fan-out.
- **Runtime self-registration**: SessionReaper, JobScheduler, SessionWatchdog, SocketDisconnect/ActiveWorkSilence/ContextWedge sentinels (+ the wedge's autoRecovery sub-row) register cheap sync `guardStatus()` getters into a boot `GuardRegistry`, reconciled against the declared manifest (`src/monitoring/guardManifest.ts` + `NOT_A_GUARD` classifications).
- **CI ratchet**: `scripts/lint-guard-manifest.js` — every guard-shaped boot component must be classified in the manifest or `NOT_A_GUARD` with a real reason; ships with the complete backfill (a real finding: `WorktreeReaper` is dormant/unwired).
- **Agent awareness + migration parity**: `generateClaudeMd()` Guards block (including the `PATCH /config` full-block warning — the one-level-deep merge erases sibling tuning) + content-sniffed `migrateClaudeMd()` migration; `/guards` registered in CAPABILITY_INDEX.
- Remote guard FLIPPING is deliberately out of scope (authority expansion — tracked follow-up spec `GAP-001-remote-guard-flip`).

## What to Tell Your User

- "You can now see which safety systems are genuinely working on every machine — 'on in the settings' no longer counts as 'working'. The Machines tab shows each machine's guards with honest freshness, and I get one grouped alert if something that should be on stays off."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Honest guard posture, one machine | `GET /guards` (Bearer) — or ask the agent "are my guards on?" |
| Fleet-wide posture sweep | `GET /guards?scope=pool` — every machine accounted by name |
| Dark-peer last-known posture | Machines dashboard tab — posture line with real age |
| Persisting-anomaly alert | Automatic (GuardPostureProbe → one aggregated Attention item per episode) |

## Evidence

- Tier-1: `tests/unit/monitoring/guard-posture-view.test.ts` (29 — every precedence-table edge incl. the `lastTickAt:0 → on-stale` Mini pin + projection/leak allowlists), `guard-posture-snapshot.test.ts` (10 — one-disk-read pin, dev-gate resolution), `guard-posture-probe.test.ts` (18 — episode/flap/data-source rules), `peer-url-guard.test.ts` (7), `lint-guard-manifest.test.ts` (11), `PostUpdateMigrator-guardsCapabilitySection.test.ts`.
- Tier-2: `tests/integration/guards-route.test.ts` (15 — auth pins, classified peer failures over real ephemeral peer servers, token-never-attached on url-rejected, receiver-clock ingestion + durable reload).
- Tier-3: `tests/e2e/guards-endpoint-lifecycle.test.ts` (17 — feature-alive 200 with the runtime-enrichment floor, disk-flip → `diverged-pending-restart` over real files, HTTP-level leak pin, wired source guards on every server.ts registration).
- Side-effects artifact: `upgrades/side-effects/guard-posture-endpoint.md` (second-pass reviewed).
