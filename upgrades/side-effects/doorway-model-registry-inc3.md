# Side-Effects Review — Doorway/Model Knowledge Registry, increment 3 (GET /doorways route + CLAUDE.md awareness + maintenance.doorwayScan config-knob migration)

**Version / slug:** `doorway-model-registry-inc3`
**Date:** `2026-07-04`
**Author:** `echo`
**Spec:** `docs/specs/DOORWAY-MODEL-KNOWLEDGE-REGISTRY-SPEC.md` (approved:true, review-convergence tagged) — §Rollout step 3, §D5, §D6, §Agent Awareness, §Migration Parity.
**Second-pass reviewer:** `not-required` — this increment adds NO block/allow authority. The one new HTTP surface (`GET /doorways`) is READ-ONLY (it never gates a message, dispatch, session, or action); the other two pieces are a data-model seed (`migrateConfig`) and a documentation append (`generateClaudeMd`/`migrateClaudeMd`). Nothing here touches messaging/dispatch block-allow, session lifecycle, compaction/respawn, coherence/idempotency/trust, or anything named sentinel/guard/gate/watchdog. See §4.

## Summary of the change

Third rollout increment of `DOORWAY-MODEL-KNOWLEDGE-REGISTRY-SPEC.md` (§Rollout step 3). Increments 1 (enriched manifest + lint, #1364) and 2 (deterministic prober + scan-state + dark job + §2.7 guard, #1373) are merged. This increment ships the READ + AWARENESS layer:

1. **`GET /doorways` route** (`src/server/routes.ts` + new `src/core/DoorwayRegistryReader.ts`) — a read-only, Bearer-authed (global middleware), always-mounted route returning the merged doorway→model view: canonical `topModels` (git-tracked, authoritative — §1.1) overlaid with this machine's read-validated live reachability. Honors the **D5 two-state contract**: `200` with `scanState:"never-run"` when the canonical manifest is present but no scan has run (each door `reachable:null`/`probeStatus:"never-scanned"`/`lastScannedAt:null`), `200` merged once a scan-state exists, and `503` with a stable machine-readable `code` (`registry-unavailable-no-instar-source` when the manifest is absent — a non-instar-source install; `registry-corrupt` when present-but-unparseable). It never fabricates an empty map.
2. **CLAUDE.md awareness block** — a new shared section function `DOORWAY_REGISTRY_CLAUDEMD_SECTION(port)` in `PostUpdateMigrator.ts`, interpolated into `generateClaudeMd()` (`src/scaffold/templates.ts`, new agents via init) AND appended by a content-sniffed `migrateClaudeMd()` block (existing agents via update — Migration Parity). Pointer-style (not an inlined door/model table) per §Agent Awareness.
3. **`maintenance.doorwayScan` config-knob migration** — seeded via the canonical `SHARED_DEFAULTS`/`applyDefaults` path in `ConfigDefaults.ts` (runs inside `migrateConfig()` on both init AND migration), with the D6 fail-closed defaults `scope:"free-probes"`, `cadence:"0 4 * * 1"`, `digestTopicId:null`, `budgetCapUsd:0` — and seeding **every field EXCEPT `enabled`** (the round-2/round-5 deny-wins bug: a seeded `false` would make `config.enabled !== false` false and permanently block the scan). Typed on `InstarConfig` (`src/core/types.ts`). Plus classification wiring: the `/doorways` prefix added to `CAPABILITY_INDEX` (discoverability lint) and the CLAUDE.md section added to `feature-delivery-completeness`'s tracked `legacyMigratorSections`.

The scan job itself remains DARK (inc2's `enabled:false` job manifest); this increment adds no cadence, no probing, no spend. Increment 5 (reconcile `flaggedStale` → flip lint to strict → ratify the standard) is companion-gated and explicitly NOT in this PR.

## Decision-point inventory

- **`GET /doorways` (NEW read route)** — `add` — read-only observability. Returns 200/503 by an OBJECTIVE, decidable file-presence/parse check (manifest present+parseable? scan-state present+scanned?). No behavioural gate, no message/dispatch/session decision. Bearer-auth is applied globally by `authMiddleware` (like every other `/`-mounted route); an un-authed request 401s (proven in the Tier-3 e2e).
- **`maintenance.doorwayScan` config seed** — `add` — a pure additive data-model default (add-missing-only; never clobbers an operator value; seeds `0`/`null` correctly). NOT a decision point.
- **CLAUDE.md awareness block** — `add` — documentation. NOT a decision point.
- No message/dispatch/tone-gate/session-lifecycle/coherence/trust decision point is touched.

---

## 1. Over-block

Not applicable in the blocking sense — this increment adds no block authority. The nearest analogue is the route's 503 branch: it "withholds" a payload only when there is genuinely no registry to serve (manifest absent or unparseable). That is the honest D5 answer, not an over-block — the `code` field distinguishes "this feature isn't present on this install" (`registry-unavailable-no-instar-source`) from "the manifest is corrupt" (`registry-corrupt`) so a client never mistakes either for a transient server failure. A present-but-empty `doors{}` still returns 200 with an empty `doorways[]` (honest), not 503.

## 2. Under-block

Also not applicable. Two correctness risks were considered and closed:
- **Trusting poisoned machine-local scan-state.** The scan-state file is plaintext + machine-local; a local writer can plant well-formed poison after a clamped write (§1.3). The reader re-validates EVERY scan-state field it uses on read: door ids are charset/length-clamped AND cross-checked against the manifest's known-candidate set (unknown/metachar ids dropped), `probeStatus` is coerced to the fixed enum (out-of-enum → `malformed-response`), timestamps are ISO-or-null, and `reachable` is DERIVED from the clamped `probeStatus` (never the stored boolean — so a poisoned `reachable:"yes"` is never trusted, and P20 unknown≠down holds). Nothing raw-passes into the response. Honest scope: containment, not tamper-proofing a plaintext file (the accepted at-rest posture of every machine-local registry).
- **A crash on a corrupt scan-state.** The reader degrades a corrupt/unparseable scan-state to never-run and never throws — a bad machine-local file can only make the live half honest-empty, never break the read.

## 3. Level-of-abstraction fit

Correct layers. The merged-view composition lives in a dedicated `src/core/DoorwayRegistryReader.ts` (a pure reader — no I/O beyond two small file reads, no runtime authority), the route is a thin handler that maps the reader's discriminated result to the D5 status codes, the config default lives in the single-source-of-truth `ConfigDefaults.SHARED_DEFAULTS` (so init AND migration seed it identically), and the awareness text lives in the shared `*_CLAUDEMD_SECTION` function used by BOTH `generateClaudeMd` and `migrateClaudeMd` (so new-install and update text can never drift). The route reads the canonical manifest via `ctx.config.projectDir` (the source-tree idiom already used for `STANDARDS-REGISTRY.md`), matching the prober's dark posture (§2.9): a non-instar-source install honestly 503s.

## 4. Signal vs authority compliance

**Required reference:** `docs/signal-vs-authority.md`

Fully compliant — this increment adds **only SIGNAL / read surfaces**, no authority:
- `GET /doorways` is a read. It surfaces the merged map; it never blocks, gates, delays, or rewrites anything. Routing continues to read the canonical layer only (§1.1) — the route is observability over the same data, never a routing input.
- The config seed and CLAUDE.md block are data/documentation, not decisions.
- No brittle logic carries blocking authority (there is no blocking authority here at all). The only binary in the change — the 200-vs-503 branch — rests on an objective, decidable check (file present + parseable), the same shape as the sibling read routes (`/cartographer/health`, `/codex/usage`, `/guards`).

## 5. Interactions

- **Shadowing:** none. `GET /doorways` is a brand-new top-level prefix (no collision — verified by the discoverability lint, which now classifies `/doorways` in `CAPABILITY_INDEX`). The `migrateClaudeMd` block is content-sniffed on a unique heading substring (`Doorway/Model Knowledge Registry`) → idempotent, never double-appends, never shadows another section's sniff. The `SHARED_DEFAULTS` seed is add-missing-only → never overwrites another feature's config or an operator value.
- **Double-fire / races:** none. The route is a pure read (two `readFileSync` of small files per request, no shared mutable state). It reads the same machine-local scan-state the inc2 prober writes atomically (temp+rename) — a concurrent write can never produce a torn read that crashes the route (corrupt-parse → degrades to never-run).
- **Feedback loops:** none. Reading `/doorways` has no side effect on the scan-state or manifest.

## 6. External surfaces

- **Other agents / users:** the CLAUDE.md awareness block teaches every agent (new via init, existing via update) that `GET /doorways` exists and when to use it — the intended Agent-Awareness surface. The route is new but read-only + Bearer-gated; a pure end-user install (no manifest) gets an honest 503 rather than a fabricated payload.
- **Install base:** the config seed reaches existing agents via `migrateConfig`→`applyDefaults` on update (Migration Parity), new agents via `init`; the CLAUDE.md block via `migrateClaudeMd`/`generateClaudeMd`; the route via the compiled `dist` (always-mounted). No new job, no new hook — the scan job + guard already shipped in inc2.
- **External systems (Telegram/Slack/GitHub/Cloudflare):** none. This increment performs no network I/O and no messaging.
- **Persistent state:** none written. The route only READS the (inc2) machine-local scan-state + the git-tracked manifest.
- **Timing / runtime conditions:** none — the route's answer is a pure function of two files on disk at request time.

## 6b. Operator-surface quality

`GET /doorways` is an agent/API read surface, not an operator-tap surface (Mobile-Complete Operator Actions is N/A — there is no operator DECISION or credential collection here). The read is exposed to the agent (via the CLAUDE.md awareness block + `CAPABILITY_INDEX`) so the agent answers "what models can I reach?" conversationally, without the operator running a CLI. No config edit is asked of the operator in this increment.

## 7. Multi-machine posture (Cross-Machine Coherence)

- **`GET /doorways` is machine-local-by-design on its live half, and that is the correct posture.** The canonical `topModels` half is git-tracked source → byte-identical on every machine. The live `reachable`/`probeStatus`/`lastScannedAt` half is read from THIS machine's scan-state (`.instar/state/doorway-scan.json`) — machine-local because a door's reachability is a physical fact of that machine's disk (installed CLIs, per-disk logins), the same justification inc2 recorded (`machine-local-justification: physical-credential-locality`). A machine correctly answers `/doorways` about ITS OWN reachability. A pool-scope read (merge each machine's live half, tagged by machine) is the DECLINED/tracked follow-up the spec already names (§Multi-machine) — deliberately not built here (more conservative than adding a half-baked merge).
- **`maintenance.doorwayScan` config** is a normal config field; it is not a replicated store and carries no cross-machine coherence hazard (each machine reads its own config, as with every other `maintenance.*`/`monitoring.*` knob).
- **CLAUDE.md awareness** is per-agent local documentation. No cross-machine action.
- No feature here silently assumes a single machine; the one live surface is machine-local on purpose with the reason stated, and the pool-scope merge is explicitly deferred, not assumed-away.

## 8. Rollback cost

Low and clean. The route is read-only and additive — reverting the PR removes the `/doorways` route, the reader module, the config seed, the type, the CLAUDE.md block, and the two classification entries with no data migration and no state repair (nothing durable was written). An operator's already-seeded `maintenance.doorwayScan` block would remain in their config as inert (unread) keys — harmless, and re-added identically on the next update. No hot-fix urgency: the scan job stays dark regardless, so a route bug can only affect a read response, never behaviour, spend, or routing.

## Second-pass review

Not required (see the header rationale): no block/allow authority on messaging/inbound/dispatch, no session-lifecycle/compaction/respawn change, no coherence/idempotency/trust gate, and nothing named sentinel/guard/gate/watchdog is touched. The change is a read-only route + a data-model seed + a documentation block. The signal-vs-authority answer (§4) is unambiguous: signal only.
