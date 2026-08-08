# Denominator Reconciliation

Tree provenance verified first:

- `git log -1`: `2197591 2026-08-05 02:19:20 +0000`
- `package.json` version: `1.3.1126`
- `grep -rl CrashLoopPauser src | wc -l`: `4`

## Membership Rules

### A. B0.2 counter census - 80 rows

Exact rule for this population: the 80 `guard` keys recorded in `.phase-b-census/guard-counter-census.json`.

The census report says the live server refused loopback, so the denominator was reconstructed from the source path for `/guards`: `buildGuardInventory()` uses `buildCompleteGuardPosture()` over the manifest/config union. Source cites:

- `.phase-b-census/guard-counter-census.md:1` reports `Total guards: 80`.
- `.phase-b-census/guard-counter-census.md:7` says the denominator was reconstructed from `buildGuardInventory()` over the manifest/config union.
- `src/monitoring/guardPostureView.ts:371-380` builds `currentPosture` from `buildCompleteGuardPosture(opts.snapshot.resolved)` and iterates those keys.
- `src/monitoring/guardPosture.ts:155-175` defines `buildCompleteGuardPosture()` as generic config extraction union the static manifest.

### B. Phase A runtime guards - 90 rows

Exact rule recovered from the Phase A audit: rows returned by `GET /guards` on the live Mini at `2026-08-04 13:45Z`, explicitly over the "full 90-guard population."

Source cites:

- `docs/audits/phase-a-constitutional-alignment.md:6-11` says the measurement was via `GET /guards` on the live Mini and reports `guards tracked | 90`.
- `docs/audits/phase-a/journals/lint-class-rung3-verification.md:7-11` explicitly separates the lint inventory from the 90 runtime guards on `/guards`.
- Endpoint source rule is the same `/guards` inventory construction cited for A: `buildGuardInventory()` over `buildCompleteGuardPosture()` (`src/monitoring/guardPostureView.ts:371-380`, `src/monitoring/guardPosture.ts:155-175`).

Limit: the Phase A audit gives the rule and count, but I did not find a persisted complete 90-key response body. The advertised local server on `localhost:4042` refused connection from this lane, so the exact B key set is unrecovered. I do not infer it from the count.

### C. GUARD_MANIFEST - 72 entries

Exact rule: entries in the static `GUARD_MANIFEST` array in `src/monitoring/guardManifest.ts`.

Source cites:

- `src/monitoring/guardManifest.ts:1-11` states this is the static declared manifest and explains that the shared extractor covers config-shaped guards generically while this manifest declares the rest.
- `src/monitoring/guardManifest.ts:67-1112` contains the `GUARD_MANIFEST` array.

## Set Differences

### A vs C

Control before trusting the empty direction: `A \ C` returned 8 known differences, proving the comparison can detect a non-empty difference. Only then did I accept `C \ A = 0`.

`A` but not `C` - 8 keys:

- `models.tierEscalation.dryRun`
- `monitoring.a2aRedelivery.enabled`
- `monitoring.autonomousLivenessReconciler.enabled`
- `monitoring.collaborationRedrive.enabled`
- `monitoring.deliveryFailureSentinel.enabled`
- `monitoring.orgIntentLlmJudge.enabled`
- `monitoring.principalCoherence.enabled`
- `monitoring.reportExternalProcesses`

`C` but not `A` - 0 keys.

Interpretation: in this tree's B0.2 census, every manifest key is present in the census, and the census adds 8 config-derived `/guards` keys not statically declared in `GUARD_MANIFEST`.

### A vs B

Unknown. The Phase A audit recovered the rule and count for B, but not the complete 90 keys. The net count differs by 10 (`90` vs `80`), but the actual key-level differences cannot be listed without the missing Phase A response body.

### B vs C

Unknown for the same reason. B is a live `/guards` runtime/config snapshot from the Phase A Mini measurement; C is a static manifest list. The key-level set difference cannot be recovered from the saved Phase A audit text alone.

## Is There One Defensible Total?

No. These are different questions:

- "How many rows did the B0.2 counter census score?" Use denominator `80`.
- "How many runtime `/guards` rows existed on the Phase A live Mini measurement at `2026-08-04 13:45Z`?" Use denominator `90`.
- "How many guards are statically declared in `GUARD_MANIFEST`?" Use denominator `72`.
- "How many guard-shaped components are classified by the manifest lint candidate rule?" Use denominator `87` candidate components in this tree, with 39 classified by `GUARD_MANIFEST.component` and 48 by `NOT_A_GUARD`.

Do not collapse these into one "total guards" number. `/guards` is config/runtime-snapshot dependent because it is the union of config extraction and manifest entries; `GUARD_MANIFEST` is only the static declared subset.

## NOT_A_GUARD and Partition

`NOT_A_GUARD` contains 81 entries.

Source cites:

- `src/monitoring/guardManifest.ts:1114-1119` defines `NOT_A_GUARD` as boot-constructed, guard-shaped components deliberately not in the inventory, with a real reason.
- `src/monitoring/guardManifest.ts:1126-1209` contains the `NOT_A_GUARD` array.
- `scripts/lint-guard-manifest.js:6-24` defines the linter's candidate space and says each candidate must appear in `GUARD_MANIFEST` component fields or in `NOT_A_GUARD`.
- `scripts/lint-guard-manifest.js:30-31` requires no component to appear in both lists.
- `scripts/lint-guard-manifest.js:34-46` states the limits: this is the file-basename suffix pattern plus `ADDITIONAL_CANDIDATES`, not a full semantic proof over all code.

Result:

- `node scripts/lint-guard-manifest.js` returned `lint-guard-manifest: clean`.
- Candidate components by the lint rule: 87.
- Candidate components in `GUARD_MANIFEST.component`: 39.
- Candidate components in `NOT_A_GUARD`: 48.
- Candidate components unclassified: 0.
- Candidate components dual-classified: 0.
- `GUARD_MANIFEST.component` and `NOT_A_GUARD.component` overlap: 0.

So yes, `GUARD_MANIFEST.component` plus `NOT_A_GUARD.component` partitions the linter's explicit guard-shaped candidate space in this tree. It does not partition all possible semantic guards in the universe; the lint source explicitly names its detection limits.
