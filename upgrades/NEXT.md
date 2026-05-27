# Instar Upgrade Guide — NEXT

<!-- bump: minor -->

## What Changed

**Built-in scheduled jobs are loading again (fleet-wide fix).** Every built-in agentmd job
(health-check, reflection-trigger, insight-harvest, the evolution pipeline, the overseers,
identity-review, memory-hygiene, …) had silently stopped loading — the per-slug manifest files the
scheduler reads were generated WITHOUT the `priority` / `expectedDurationMinutes` / `model` fields the
loader requires, so every built-in job was rejected as invalid (job count zero). Both manifest
producers (`InstallBuiltinJobs` and the legacy `jobMigrate` path, which had the same defect and
permanently broke migrated *user* jobs) now build manifests through a single typed
`buildPerSlugManifest()` — so a dropped required field is a compile error, not a silent fleet-wide
outage — plus a producer-side self-check that validates its own output and fails loud. Existing
broken manifests self-heal on the next update (the installer always-overwrites them).

## What to Tell Your User

- Your agent's automatic background jobs (health checks, reflection, evolution, the overseers) were
  quietly not running; this brings them back, and they'll repair themselves on update — nothing to do.
- It's now structurally impossible to ship this class of break again silently: it would fail to
  compile, or fail loudly at install, rather than disappearing into the logs.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Built-in jobs load again | Automatic on update — manifests self-heal; `GET /jobs` shows the full set |
| `buildPerSlugManifest()` | Single typed manifest constructor used by both producers (compile-time safety) |

## Evidence

Found by deploying to a real server (`jobCount: 0`, 1200+ `manifest-invalid` log lines since
~2026-05-20). Proven by: a unit test that **round-trips the producer's output through the loader's
validator** (the assertion that actually prevents recurrence — a snapshot of the broken shape is what
let it ship); a test that **every real shipped template** produces a loader-valid manifest
(`installed >= 10`, all pass `validateManifest`); a fail-loud test (missing duration → error + no
manifest written); and a live before/after on the affected server (jobCount 0 → ≥shipped-count, no
new `manifest-invalid` lines). 3745 affected tests green vs canonical main.
