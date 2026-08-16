# Side-effects review — disabledAtBodyHash drift detection

## What changed

New module `src/scheduler/DisabledBodyDrift.ts` ships the runtime helpers the Dashboard needs to surface "instar default has changed since you disabled it — review?" indicators per INSTAR-JOBS-AS-AGENTMD spec §Dashboard UX:

> row per job: status dot, name + description, schedule, last run + bodyHash link, enabled toggle (records disabledAtBodyHash), namespace badge

Three exports:

- `bodyDriftedSinceDisable({ stateDir, slug })` — returns a tagged-union status: `no-drift | drifted | manifest-missing | body-missing | not-disabled | no-disable-record`. The `drifted` case carries both the captured hash AND the current hash so the Dashboard can show a body-diff link.
- `listDriftedDisabledSlugs(stateDir)` — scans every per-slug manifest and returns all slugs whose disabled body has drifted. Used by the future Dashboard status feed.
- `stampDisabledAtBodyHash(stateDir, slug)` — captures the current body hash + flips enabled:false. Used by the Dashboard "disable" action and by a future CLI `instar job disable <slug>` command.
- `clearDisabledAtBodyHash(stateDir, slug)` — drops the field + flips enabled:true. Used by the Dashboard "enable" action.

No new HTTP endpoint yet — the Dashboard UI rewrite will consume these helpers when it lands.

## Side-effects review

### 1. Over-block / under-block

- **Over-block:** none. The helpers are pure reads (drift check, list) or atomic single-file manifest writes (stamp, clear). No new gates, no new refusals.
- **Under-block:** the `body-missing` and `manifest-missing` states are surfaced but not auto-remediated. The future Dashboard Issues-card surface drives operator-decided remediation.

### 2. Level-of-abstraction fit

Pure file-system helpers reusing `hashBody` + `normalize` from `AgentMdLockFile.ts` so the disable-time hash semantics match the lock-file's body-hash semantics exactly. Same hashing function = same body-equivalence rules.

### 3. Signal-vs-authority compliance

The helpers are signals — they report "drifted yes/no" and let the caller decide whether to surface it to the operator. The authority for what the operator should DO about drift lives at the Dashboard layer.

### 4. Interactions

- **Phase 2 installBuiltinJobs** — already preserves `disabledAtBodyHash` across updates (manifest read before overwrite). This PR adds the helpers that USE the field.
- **Phase 4 Dashboard UI rewrite (future)** — will consume `stampDisabledAtBodyHash` on the disable toggle, `clearDisabledAtBodyHash` on the enable toggle, and `listDriftedDisabledSlugs` for the status feed.
- **Phase 6 deprecation warning** — does not depend on this, but the future drift-digest aggregator (test #25 in spec) can use `listDriftedDisabledSlugs` as one of its inputs.

### 5. Rollback cost

Trivial. Single module file + test file.

## Test coverage

15 cases in `tests/unit/scheduler/DisabledBodyDrift.test.ts`:

- `bodyDriftedSinceDisable`: no-drift, drifted, not-disabled, no-disable-record, manifest-missing, body-missing, frontmatter-changes-ignored
- `listDriftedDisabledSlugs`: filters to drifted-only; empty-state safe
- `stampDisabledAtBodyHash`: success path; manifest-missing; body-missing
- `clearDisabledAtBodyHash`: success path; manifest-missing safe
- Roundtrip property: stamp → no-drift → modify → drifted

All 15 pass. Lint + type-check pass.

## What is NOT in this PR

- Dashboard UI consuming the helpers (Phase 4 rewrite).
- `unfork-backup-prune` daily job — depends on the unfork flow shipping (Phase 4 Dashboard). Will be added in a follow-up alongside the unfork action.
- HTTP endpoint surfacing `listDriftedDisabledSlugs` — the consolidated `GET /jobs` endpoint mentioned in §Dashboard UX would carry this; that endpoint is its own multi-feature effort.
