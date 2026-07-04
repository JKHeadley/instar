# Side-Effects Review — Doorway/Model Knowledge Registry, increment 1 (enriched manifest + derived-frontier lint)

**Version / slug:** `doorway-model-registry-inc1`
**Date:** `2026-07-04`
**Author:** `echo`
**Second-pass reviewer:** `not required` (no messaging/session-lifecycle/gate/sentinel/watchdog surface — see §4/§5)

## Summary of the change

First rollout increment of `DOORWAY-MODEL-KNOWLEDGE-REGISTRY-SPEC.md` (§Rollout step 1), landed dark/inert and backward-compatible. Two source artifacts change:

1. **`scripts/model-registry-freshness.manifest.json`** — enriched into the canonical Doorway/Model Knowledge Registry (`registrySchemaVersion: 2`). Each door gains a `topModels[]` array (exact model id + `role` + `frontier` flag + `pricing:null` + `verifiedAt`), seeded **1:1 from the reviewed `frontierAllowlist`** per spec D4 (`verifiedAt:"carried-over-from-allowlist"`, `frontier:true`, pricing null). The hand-maintained `frontierAllowlist{}` is removed (superseded by derivation).
2. **`scripts/lint-model-registry-freshness.mjs`** — the DRIFT tooth (TOOTH 2) now checks each pin against a **derived** frontier set (`doors[door].topModels[] where frontier===true`) via a new exported `frontierSetForDoor()` helper, instead of the literal `frontierAllowlist`. Backward-compat is preserved: a door with a literal allowlist and NO `topModels` uses the literal list exactly as before; a door with BOTH emits a `TRANSITION` finding so the stale literal can't linger.

Plus the spec docs (spec + ELI16 + convergence report + a follow-ups tracking stub) and the unit test extension. The prober, scan-state, `GET /doorways` route, config knob, CLAUDE.md block, and the scan job are all LATER increments (§Rollout steps 2-3) and are explicitly NOT in this PR.

The lint stays in `enforcement: "report"` (non-gating; always exits 0). No runtime behavior changes: no code under `src/` is touched, no route, no job, no config default.

## Decision-point inventory

- `TOOTH 2 (DRIFT) in lint-model-registry-freshness.mjs` — **modify** — the drift check's frontier set is now derived from `topModels[frontier=true]` rather than the literal `frontierAllowlist`. Same decision (is each pin's id in its door's frontier set?), new one-source-of-truth input. Model-id-agnostic and non-gating under `report`.
- `TRANSITION finding` — **add** — a new non-gating (under report) finding class flagging a door that carries both a literal allowlist and `topModels`. Purely a maintainer nudge to delete the stale literal.
- No runtime decision point (message/dispatch/session/gate) is touched.

---

## 1. Over-block

No block/allow surface at runtime — over-block not applicable. The lint is a build-time CI signal. In `report` mode it always exits 0 (never blocks a build). The only "block" it could ever produce is a CI failure under `strict` enforcement, which is unchanged in this increment (`enforcement: "report"`). A false DRIFT/TRANSITION finding under a future `strict` flip would over-block a build, but: (a) strict is not enabled here, and (b) the derivation is a faithful superset-preserving projection of the prior allowlist (verified: the shipped manifest lints clean).

---

## 2. Under-block

No block/allow surface — under-block not applicable in the runtime sense. As a freshness ratchet, the increment could "under-catch" only in the same ways the pre-existing lint could: a pin whose regex no longer matches, or a door with neither `topModels` nor a literal allowlist (derived set empty → any pin on it drifts, same as before). The derivation does not weaken TOOTH 1 (staleness) or the regex-anchored pin extraction. It strictly removes a second hand-maintained list (a rot vector), so it under-catches strictly less than before, not more.

---

## 3. Level-of-abstraction fit

Correct layer. This is a deterministic, model-id-agnostic build-time consistency lint (a detector/signal), not a runtime authority. The change keeps it there: `frontierSetForDoor()` is a pure function over the manifest; the derivation removes a duplicated data structure so the frontier set is a *view* of `topModels` and cannot diverge by construction (one-source-of-truth). It does not reach up into a smart gate nor down into a runtime primitive — the manifest/lint pair is exactly the right home for "is our model map internally consistent and fresh?".

---

## 4. Signal vs authority compliance

**Required reference:** `docs/signal-vs-authority.md`

- [x] **No — this change produces a signal consumed by an existing smart gate / CI.** The lint prints findings; CI (and a human) consume them. Its authority knob (`report` vs `strict`) is unchanged and stays in non-gating `report`. The change refines the *input* to an existing deterministic check (derived set vs literal list) and adds a non-gating maintainer finding. No new brittle blocking authority over agent behavior, messages, or dispatch is introduced. The derivation is exact/deterministic, not brittle inference.

---

## 5. Interactions

- **Shadowing:** none. The only reader of this manifest is `lint-model-registry-freshness.mjs` and its test (confirmed by grep across `src/`, `scripts/`, `tests/`). No `src/` code reads `frontierAllowlist` or `topModels`, so removing the literal allowlist shadows nothing.
- **Double-fire:** none. No new scheduled/event actor. The TRANSITION finding is deduped per-door (independent of the pins loop).
- **Races:** none. Pure file read at lint time; no shared mutable state.
- **Feedback loops:** none. The lint reads the manifest and prints; it never writes the manifest or any state.

---

## 6. External surfaces

- Other agents on the same machine: none — source-only change, no runtime surface.
- Install base: the manifest + lint ship as instar **source**; they are present only on source-carrying (maintainer/dev/fixture) agents and are absent on pure end-user agents (not scaffolded). No agent-installed file (`.claude/`, `.instar/`, CLAUDE.md template, job template, hook) changes in this increment, so no `PostUpdateMigrator` migration is needed (that arrives with increments 2-3: config knob, CLAUDE.md block, job, PreToolUse guard).
- External systems (Telegram/Slack/GitHub/Cloudflare): none.
- Persistent state: none written. No new state file in this increment (the live scan-state `.instar/state/doorway-scan.json` is increment 2).
- Timing/runtime: none.
- **Operator surface (Mobile-Complete Operator Actions):** no operator-facing actions added or touched — the only human-facing artifact is CI lint output. Not applicable.

## 6b. Operator-surface quality

No operator surface — not applicable. No dashboard renderer, approval page, or grant/revoke/secret-drop form is touched.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN — no, actually: replicated-by-git-tracking (identical on every machine).** The canonical registry (`scripts/model-registry-freshness.manifest.json`) and the lint are **git-tracked instar source**, so they are byte-identical on every machine by construction — there is no per-machine divergence, no replication path to build, and no merge concern. (The *live/observed* per-machine scan-state that IS machine-local by design is a later increment — §1.3 of the spec — and is out of scope here.) This increment emits no user-facing notices (no one-voice gating needed), holds no durable runtime state (nothing to strand on topic transfer), and generates no URLs.

---

## 8. Rollback cost

Pure source/data change — **revert and ship a patch**, zero runtime blast radius.
- Hot-fix: `git revert` the manifest + lint change; the lint returns to reading the literal `frontierAllowlist`. Because the change is backward-compatible in both directions (the reverted lint reads a literal allowlist; the enriched manifest with `topModels` and no `frontierAllowlist` would, under the OLD lint, treat every door's allowlist as empty → DRIFT findings — but only non-gating under `report`), a clean revert restores BOTH files together, so there is no split-brain window.
- Data migration: none — no persistent state produced.
- Agent state repair: none — existing agents pull the source on update; nothing to reset.
- User visibility: none — no user-visible surface; the lint runs in CI only, and stays non-gating (`report`).
