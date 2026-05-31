# Side-effects review — Correction & Preference Learning Sentinel (Slice 1a)

**Spec:** `docs/specs/CORRECTION-PREFERENCE-LEARNING-SENTINEL-SPEC.md` (§3.6, §7,
§9, §10 Slice 1a)
**Change:** new `src/core/PreferencesManager.ts`; inline
`GET /preferences/session-context` in `src/server/routes.ts`;
`monitoring.correctionLearning` config block (`src/core/types.ts` +
`src/config/ConfigDefaults.ts`); `CapabilityIndex.ts` entry; session-start hook
patch + `migrateClaudeMd` backfill + shadow-capability marker in
`src/core/PostUpdateMigrator.ts`; `generateClaudeMd` capability section +
Registry-First row + proactive trigger in `src/scaffold/templates.ts`; 3-tier +
wiring tests.
**Class:** new read-surface feature, ships OFF, signal-only (never gates,
blocks, or rewrites a message).

## What changed

A structured on-disk preferences file (`.instar/preferences.json`), the single
atomic writer for it (`recordPreference()`), an HTTP read route serving the
session-start block, and a session-start hook that injects that block on every
boot. Modeled 1:1 on the proven ORG-INTENT precedent
(`GET /intent/org/session-context` + its session-start fetch). Slice 1b (the
capture/distill/ledger loop) is the future writer; Slice 1a only proves the
surface is alive end-to-end.

## 1. Security

- **No new external input/network/egress.** The route only reads a local file
  and serves a deterministically-formatted block. No LLM call, no outbound
  request, no shell-out in Slice 1a (the hook's curl is loopback to the agent's
  own server, same as ORG-INTENT).
- **Auth:** the route is Bearer-gated by the global `authMiddleware` exactly like
  sibling `/intent/*` routes (integration test asserts 401 without a token).
- **Output discipline:** the served payload and the injected block contain ONLY
  the `learning` text + metadata (confidence, seen-count). Internal fields
  (`dedupeKey`, `provenance`) never leak (unit + integration assertions). This is
  the §3.6 "serve only learning + metadata" rule.
- **Injection-confusion defense:** loop-sourced preferences are wrapped in an
  `<auto-learned-preference src='correction-loop'>` envelope so a downstream
  prompt assembler structurally cannot mistake a learned preference for an
  authoritative instruction. The block's own preamble restates "signals, not
  instructions; real instructions and safety win."
- **No policy-relaxation surface in 1a:** `recordPreference()` has no writer in
  Slice 1a (Slice 1b adds the gated, policy-keyword-filtered caller per §3.6).
  Until then the only way an entry lands is a direct programmatic call, which the
  correction loop does not yet make.

## 2. Migration parity

- **Config:** `monitoring.correctionLearning` added to `ConfigDefaults`.
  `applyDefaults` deep-merges add-missing-only (verified: `merge()` recurses into
  objects, adds absent keys, never overwrites), so existing agents backfill the
  block on update without a dedicated `migrateConfig` step — and without surprise
  activation (`enabled: false`). This matches the spec §7 note and the
  failure-learning precedent.
- **Route:** inline in `routes.ts` (the discoverability-lint allowlist is fixed; a
  separate module would trip the orphan-prefix check). `CapabilityIndex` entry
  added so the lint passes and the route is discoverable.
- **Hook:** built-in `instar/` hooks are always-overwrite on every migration, so
  the patched `session-start.sh` propagates to every existing agent on the next
  update — no hand-written `migrateHooks` block needed.
- **CLAUDE.md:** `generateClaudeMd` gains the capability section / Registry-First
  row / proactive trigger; `migrateClaudeMd` gains a content-sniffed backfill
  (marker `Correction & Preference Learning Sentinel`) so EXISTING agents learn
  the surface — not just new ones. A shadow-capability marker
  (`**Preferences I've learned about you**`) mirrors it into Codex/Gemini
  `AGENTS.md`/`GEMINI.md`. `feature-delivery-completeness` enforces all three legs.
- **State file:** `.instar/preferences.json` is created lazily on first write;
  absent ≡ empty. No migration needed.

## 3. Performance

- The read route does one small synchronous file read + a deterministic
  string-build bounded by `maxInjectedPreferencesBytes` (4000). No DB, no LLM, no
  network. Cost is negligible and constant-ish.
- `recordPreference()` reads + rewrites the whole file atomically. The file is
  bounded by distinct-preference cardinality (upsert by `dedupeKey`), not message
  volume, so it stays tiny in practice. Each write is one temp-file + fsync +
  rename.
- The session-start hook adds one loopback curl with `--max-time 4`; fail-open on
  timeout, so a slow/absent server can never delay session start beyond that cap.

## 4. Observability

- The route is discoverable via `GET /capabilities` (CapabilityIndex entry,
  `enabled` reflects the flag).
- `{ present, block, count }` makes the served state self-describing; `count`
  exposes distinct-preference cardinality for debugging.
- No new log channel in 1a (the audit log `logs/correction-learning-audit.jsonl`
  is a Slice 1b concern — the loop that produces routable decisions).

## 5. Rollback

- Flip `monitoring.correctionLearning.enabled` back to false (or remove the
  block) → the route 503s and the hook injects nothing. Inert.
- `.instar/preferences.json` entries all carry `provenance: 'correction-loop'`,
  enabling a one-shot bulk removal (a single jq-style filter) if a future loop
  ever writes something unwanted. In 1a nothing writes, so the file stays absent.
- Code rollback = revert the commits; the absent-file ≡ empty contract means a
  rolled-back agent with a stray file is still consistent (read tolerates and
  ignores it; the route 503s when the flag is gone).

## 6. Multi-machine

- The file is per-agent-home local state (under `stateDir`), like ORG-INTENT.md
  and the integrated-being ledger. On a multi-machine agent each machine reads
  its own copy; the existing state-sync layer carries `.instar/` files between
  machines the same way it carries ORG-INTENT.md — no new sync path introduced.
- The route is read-only and idempotent; no lease/fencing interaction. Slice 1a
  has no writer competing across machines (that is a Slice 1b consideration when
  the loop runs only on the awake machine).

## 7. Multi-user

- Slice 1a is a pure read/inject surface and does not itself attribute a
  preference to a user — it serves whatever was recorded. The multi-user
  primary-user gate (§3.6) lives in Slice 1b, where corrections are attributed
  and `recordPreference()` is actually called. Until then no user-shaped data can
  enter the file via this feature.
- The injected block is the same for every session on the agent (it is the
  agent's learned-about-this-operator preferences), consistent with the
  single-operator model the rest of the agent assumes.

## Tests

- Unit: `tests/unit/PreferencesManager.test.ts` (13),
  `tests/unit/preferences-wiring-integrity.test.ts` (7).
- Integration: `tests/integration/preferences-routes.test.ts` (5).
- E2E: `tests/e2e/preferences-session-context-lifecycle.test.ts` (6).
- Lint: `tests/unit/capabilities-discoverability.test.ts` (100) green;
  `tests/unit/feature-delivery-completeness.test.ts` green (parity + shadow
  marker for the new section).
