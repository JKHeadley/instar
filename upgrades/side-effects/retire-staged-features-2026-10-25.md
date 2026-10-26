# Side-Effects Review — Retire five staged features (2026-10-25 maturation review)

**Version / slug:** `retire-staged-features-2026-10-25`
**Date:** `2026-10-25`
**Author:** `Echo`
**Second-pass reviewer:** `not required` — the change removes decision points and
adds none; the only new runtime code is a config/instruction migration step (see §4).
**Tier:** 1 (fully reversible by revert) · ~45 files · ~1,100 LOC removed, ~400 added
(migration + its tests) · spec rounds 3 of a Tier-1 cap of 3 (breadth of consumers,
not a design dispute) · commit/gate attempts: see Evidence.

## Summary of the change

Spec: `docs/specs/retire-staged-features-2026-10-25.md` (converged, approved). The
2026-10-25 feature maturation review had two model families vote on every staged
feature; five got "retire" from both. This PR deletes them: the unread
`cartographer.*.llmEnrichment` / `llmRerank` flags and the call-site-less
`StandardsCoverageEnrichment` component; `JevReviewFlagShadow` + its route; the
never-enabled `ProactiveCompactionSentinel`; the stray `quotaLimits` key; and the
dry-run-only `MoveIntentClassifier` / `ProfileIntentClassifier` with their census
rows, registries, baseline entries and tests. The relocation block in
`server.ts` keeps the `TopicPlacementPinStore` construction (used by ~20 other
sites). One `PostUpdateMigrator` step removes the persisted keys (marker-gated,
`_instar_noMigrate`-aware, scalar-only reporting), strips the review-flag card from
`CLAUDE.md` + `AGENTS.md` / `GEMINI.md` on exact match against a frozen copy, and
rewords two instruction cards (pool transfer, topic profile) that still described
the removed NL path.

**Rider (lint unblock, found during this build):** `scripts/model-registry-freshness.manifest.json`
`lastReviewedAt` 2026-09-10 → 2026-10-25 with a dated review note. The 45-day
staleness window aged out on the calendar (it fails on `main` today too); the
drift tooth reports every pin inside its derived frontier set, and two pins
(`gpt-6-astra`, `claude-fable-5`) answered live calls in this change's own
spec-review. No pin or `topModels` row changed — routing is untouched.

## Decision-point inventory

- `move-intent-classify` (`MoveIntentClassifier`, inbound Telegram dispatch) — **remove** — dry-run LLM "is this a move command?"; never actuated.
- `profile-intent-classify` (`ProfileIntentClassifier`, `handleTopicProfileIngress`) — **remove** — dry-run LLM "is this a framework/model/thinking change?"; never actuated.
- `standards-coverage-enrich` (`StandardsCoverageEnrichment`) — **remove** — pending census entry; no call site.
- `JevReviewFlagShadow` — **remove** — log-only shadow; never a gate.
- `ProactiveCompactionSentinel` — **remove** — opt-in actuator; never enabled.
- `handleTopicProfileIngress` explicit `/topic` trigger path — **pass-through** — unchanged; the `!trigger` branch now returns `false` exactly as the dark/dry-run path did.
- `migrateRetireStagedFeaturesCmt1004` + the `migrateClaudeMd` strip/reword steps — **add** — deterministic config/text migration; no block/allow surface.

---

## 1. Over-block

No block/allow surface is added. The removed classifiers could only ever have
*hijacked* a message (they never did: 1,120 / 1,120 and 1,807 / 1,807 logged
decisions were `pass`); after removal every inbound message reaches the session as
it does today on the fleet. The migration's only "refusal" is leaving a non-junk
`quotaLimits` or a hand-edited card in place — the conservative direction.
**No issue identified.**

## 2. Under-block

Not applicable to a removal. One residue class is accepted: a hand-edited
review-flag card is left in place and reported on every update until removed
(stale text about a route that now answers 404; zero known instances). A peer that
re-syncs an older config can re-introduce a reader-less key on an already-migrated
machine; inert. **No issue identified** beyond these stated residues.

## 3. Level-of-abstraction fit

Right layer. Dead config and dead code are removed where they live; the migration
sits with the other retirement steps in `PostUpdateMigrator` (precedent
`migrateRetireDeadMentorConfig`); the instruction-card strip follows the
Normal-Chrome v1 retirement precedent (frozen constant + exact match). Nothing is
added at a layer that would need a smarter gate.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

The change *removes* two would-be authorities (LLM recognizers that could have
hijacked or actuated on inbound text) that never left dry-run, and adds none. The
explicit levers that remain (`POST /pool/transfer`, `POST /topic-profile/:id/propose`
+ operator confirm) are deterministic planners over structured input — the agent
supplies the judgment, the server validates. The migration is deterministic text
and key handling with no judgment role.

## 4b. Judgment-point check (Judgment Within Floors standard)

No static heuristic is added at a competing-signals decision point. The migration's
exact-match strip and deep-equal `quotaLimits` rule are not decisions among live
signals; they are equality checks whose failure direction is "leave it and say so".
Not applicable.

---

## 5. Interactions

- **Shadowing:** the `!trigger` branch of `handleTopicProfileIngress` previously ran
  the classifier before returning `false`; removing it changes nothing downstream
  (dark/dry-run returned `false` already). `/pool/transfer`'s drain leg and the
  reaper's topic-moved sweep are untouched and remain the only closeout paths.
- **Double-fire:** none. The strip runs once per file per update; the marker gates
  the config step; both are idempotent (second run no-op, tested).
- **Races:** the migrator runs single-threaded at boot before sessions spawn;
  `migrateClaudeMd` precedes `migrateFrameworkShadowCapabilities` (run() order
  verified), so a stripped card is never re-mirrored.
- **Feedback loops:** none. Removing LLM callsites reduces load on the internal
  provider chain; nothing feeds back.

## 6. External surfaces

- **Other agents / install base:** every agent's config loses up to seven keys on
  its next update and its instruction file loses one paragraph and gains two
  corrected bullets. All five features were dark/dry-run fleet-wide; no agent
  behavior changes except on a development agent, where two background LLM calls
  per matching message stop (messages reach the session sooner).
- **External systems:** none. The removed route `GET /jev-review-flag/summary` now
  404s; no external caller existed (internal prefix row removed).
- **Persistent state:** `config.json` keys deleted (marker recorded); instruction
  files edited; old soak logs and old decision-quality rows left untouched (the
  meter iterates the live census, so removed points drop out of the read).
- **Timing:** none.
- **Operator surface (Mobile-Complete Operator Actions):** no operator action is
  added. The `REVIEW:` lines land in the update Telegram notice (`UpdateChecker`
  folds `upgraded` into it) and the console; they carry only known scalar fields,
  never an undefined key's value or free text.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No dashboard renderer, operator route, or operator-facing message template is
touched. The update-notice lines are plain English with no raw internals beyond
the config key path. Not applicable beyond that.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Posture: unified — nothing new is introduced.** Each machine's `config.json` and
instruction files are machine-local already (`physical-credential-locality`: the
config holds that machine's tokens and is git-ignored); each machine's own update
cleans them. The removed classifiers were per-machine inbound recognizers with no
replicated state; the `moveIntent` coherence-manifest exclusion row is removed and
the manifest is derived per machine, so the removal is order-independent in a
rolling update. No user-facing notice is emitted (no one-voice gating needed); no
durable state strands on topic transfer (nothing new is stored); no URLs are
generated. Mixed-version pools: the old version's paths were dark/dry-run with no
cross-machine effects.

---

## 8. Rollback cost

- **Hot-fix release:** revert the PR; code, route, registrations and tests return.
- **Data migration:** `ConfigDefaults` re-adds the default blocks on the next
  `migrateConfig()`; the review-flag card is re-appended by the restored
  `migrateClaudeMd` step and re-mirrored. The `-v1` marker survives a revert, so a
  re-land must ship the config step as `-v2`.
- **Agent state repair:** none required. Honest limit: an operator-set value
  (`enabled: true`, a custom timeout) is not restored automatically — it survives in
  the `REVIEW:` line of the update output.
- **User visibility:** none; all removed paths were dark.

---

## Conclusion

The review confirmed the change is a pure removal plus a conservative migration.
Spec-converge (3 rounds, Codex + clean-door + internal panel + constitution gate)
turned up the consumers the first draft missed — the pin-store construction inside
the deleted block, the mirrors, three registries, the orphan component, two
instruction cards — and hardened the migration (marker, deep-equal junk rule,
scalar-only reporting, exact-match strip against a frozen copy, honest residue).
No concern remains open; the two accepted residues are stated above. Second-pass
review is not required: no block/allow, session-lifecycle, compaction, or gate
behavior is added — only removed.

---

## Second-pass review (if required)

Not required (see Conclusion).

---

## Evidence pointers

- Spec + convergence report: `docs/specs/retire-staged-features-2026-10-25.md`,
  `docs/specs/reports/retire-staged-features-2026-10-25-convergence.md`.
- Migration tests: `tests/unit/PostUpdateMigrator-retire-staged-features.test.ts`.
- Acceptance grep (spec criterion 1): only the migration step's key literals and
  the frozen card text. `npx tsc --noEmit` exit 0; `npm run lint` exit 0.
- Full suite in this worktree, 2026-10-25 17:41–18:29 PDT, one run per lane through
  the host limiter: unit 2,754 files / 50,613 tests, 0 failed; integration 594 files
  passed, 1 failed (`subscription-relogin-runtime`, 7 tests — `seat-busy` from the
  host-wide helper-seat lease held by another process; file identical to `main`;
  re-run alone 8/8 green; feedback fb-b3077b91-592); e2e 432 files passed, 1 failed
  (`subscription-relogin-lifecycle`, 2 tests, same cause; re-run alone 8/8 green;
  feedback fb-e5420f59-6f6). Neither failing file is on this change's surface.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect is fixed and no self-triggered controller is
added or modified — not applicable. (`defectClass: not applicable`, `closure: not
applicable`.)
