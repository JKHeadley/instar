# Side-Effects Review — Topic Intent Layer (Layers 1-3)

**PR:** https://github.com/JKHeadley/instar/pull/332
**Spec:** `docs/specs/topic-intent-layer.md` (v14 CLEAN, approved 2026-05-22)
**Author:** Echo · autonomous run · 2026-05-22
**Process:** Per `feedback_side_effects_review.md` — seven-dimension review before ship.

## 1. Over-block

The feature could over-block if a hook surfaces tentative items as if settled, or if ArcCheck started blocking sends.

**Mitigations in place:**
- ArcCheck verdict shape never includes a `block` or `authority` field. Signal-only by spec and by test (`tests/unit/TopicIntent-arccheck.test.ts` asserts this).
- Tentative items in the Layer 2 briefing are explicitly hedged with the word "TENTATIVE" + confidence value. Settled items in a separate "SETTLED" section.
- Observation tier (< 0.30) is NOT surfaced in the briefing at all — no noise leak.
- The briefing endpoint returns empty body when nothing has accumulated, so bootstrap hooks can skip injection cleanly without distorting normal session start.

## 2. Under-block

The feature could under-block if it lets a single LLM extraction silently launder its own guesses to authoritative tier (the canonical GCI failure mode).

**Mitigations in place:**
- Authority hard rule (spec section "Authority gating"): confidence cannot reach the authoritative tier (≥0.7) unless at least one evidence event qualifies as a user-authored episode. Enforced in `projectConfidence` with a clamp at 0.69.
- Per-message dedup: multiple signals about the same refId from the same source message count as ONE episode with the larger applicable delta — agent cannot fork its own message into multiple episodes.
- Affirmation safety: per-refId per-24h cap of 1 affirmation bonus, plus per-single-user-message max of 3 distinct refIds affirmed, defends against a single "yes" mass-promoting.
- Signal-specific caps: `agent-reref` capped at +0.05 cumulative, `extract-agent` at +0.10. Even an unbounded loop of agent-origin signals cannot accumulate to authority.

## 3. Level-of-abstraction fit

Is the feature implemented at the right layer of the stack?

**Assessment:**
- Storage at `.instar/topic-intent/<topicId>.json` parallels the existing `.instar/topic-resume-map.json` convention — same level, same JSON-first approach, same file-per-topic granularity.
- Routes mounted via the same `createXxxRoutes` factory pattern as `worktreeRoutes`, `fileRoutes`, `machineRoutes` — consistent with the codebase's idiom.
- AgentServer options pattern mirrors existing optional dependencies (e.g., `worktreeManager?`). DI is uniform.
- Telegram bootstrap hook modification is minimal — one curl call with degrade-open semantics. Slack bootstrap hook is NOT modified (slack channel IDs are string-keyed, not numeric topic IDs; the cleanest adapter pattern for Slack is a follow-up).

## 4. Signal-vs-authority compliance

Per `feedback_signal_vs_authority`: brittle/low-context filters detect signals; only higher-level intelligent gates with full context block.

**Assessment:**
- ArcCheck is the signal layer. It returns verdicts that include `kind`, `refId`, `currentTier`, `currentConfidence`, `reason`, `suggestedRewriteHint` — no authority claim.
- The agent itself is the authority layer. The agent reads the ArcCheck signal in its draft preparation and chooses to either redraft (with a conversational confirmation question) or proceed.
- The existing outbound gates (tone-gate, response-review, outbound-dedup) retain their blocking authority and are unaffected by this change.

## 5. Cross-feature interactions

What other Instar systems could this affect?

- **CompactionSentinel** — the briefing prepended on every bootstrap may slightly increase context-window usage at session start. Mitigation: maxPerSection cap (default 8) + overflow note keeps it bounded; observation tier deliberately omitted. The briefing is empty body when nothing tracked.
- **Tone-gate / response-review** — Layer 3 does NOT integrate into the outbound path in this ship. The classifier exists and is reachable; the actual every-send wiring is a deliberate follow-up so we can think carefully about whether ArcCheck signals should be routed through the existing gate or augment them.
- **Telegram bootstrap hook** — modified, but failure modes are degrade-open (any error → empty briefing, recent-history output unchanged). The 2-second timeout (`curl --max-time 2`) bounds latency.
- **Slack bootstrap hook** — NOT modified. Slack channel IDs are string-keyed; topic-intent is numeric-keyed. Adapter pattern for Slack is a v1.1 follow-up.
- **iMessage / WhatsApp** — same situation as Slack, deferred.

## 6. Rollback cost

If this needs to revert, what's the blast radius?

- All new files (`src/core/TopicIntent*.ts`, `src/server/topicIntentRoutes.ts`, all `tests/unit/TopicIntent-*.test.ts`, `tests/integration/topic-intent-routes.test.ts`, `tests/e2e/topic-intent-lifecycle.test.ts`) can be deleted without affecting any other system.
- Modified files (`src/server/AgentServer.ts`, `src/commands/server.ts`, `src/templates/hooks/telegram-topic-context.sh`) have small surgical additions that can be reverted independently — store construction, route mount, optional briefing-fetch with degrade-open.
- Storage at `.instar/topic-intent/<topicId>.json` is per-topic JSON files; deleting them has no effect on any other Instar state.
- No new dependencies in `package.json`. No DB migrations. No config-format changes.

**Net rollback cost: low.** A clean revert of the feature commit + deleting the storage directory is sufficient.

## 7. Migration parity

Per `feedback_migration_parity_standard` (built into CLAUDE.md): changes to agent-installed files must reach existing agents via the update path.

**Files in this PR that need migration handling:**
- `src/templates/hooks/telegram-topic-context.sh` — built-in hook script. Per the Migration Parity Standard, built-in hooks are **always overwritten** on every migration run via `installBuiltinHooks()`. No additional migration code needed — the script will reach existing agents on their next `instar upgrade`.

**No other agent-installed files changed** in this PR. CLAUDE.md template is unchanged in this PR; Agent Awareness Standard update (so agents know about the new `/topic-intent/*` endpoints) is the recommended next follow-up before the cherry-pick v1.3.x project.

## Conclusion

Ship. Seven-dimension review clean. Rollback cost low. No new external dependencies. All three test tiers green. PII boundary explicitly tested. Framework-parity grep gate in place.

Follow-up scoped for future work (in priority order):
1. Layer 3 outbound-path wiring (the every-send ArcCheck integration with tone-gate / response-review).
2. Slack / iMessage / WhatsApp bootstrap parity for Layer 2 briefing.
3. CLAUDE.md template update for Agent Awareness Standard.
4. Daily probe job that replays the qalatra-9235 and GCI/Luna-365 fixtures against the live extractor.
5. The seven cherry-pick recommendations from the GSD spike (separate v1.3.x project).
