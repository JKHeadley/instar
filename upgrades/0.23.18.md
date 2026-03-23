# Upgrade Guide — vNEXT

## What Changed

### Default Job Configuration Overhaul

The default jobs template that ships with every new agent has been comprehensively reviewed and updated:

- **Removed 4 legacy jobs**: `update-check`, `dispatch-check` (replaced by built-in AutoUpdater/AutoDispatcher), `self-diagnosis` (replaced by overseer pattern), `evolution-review` (split into two paired jobs)
- **Added 9 new jobs**: `evolution-proposal-evaluate` (Sonnet), `evolution-proposal-implement` (Opus), `commitment-detection`, `dashboard-link-refresh`, and 5 category overseers (guardian, learning, maintenance, infrastructure, development)
- **7 jobs migrated to skills**: coherence-audit, degradation-digest, state-integrity-check, memory-hygiene, guardian-pulse, session-continuity-check, git-sync — long inline prompts replaced with `.claude/skills/` files installed during init
- **Priority bumps**: 7 jobs moved from `low` to `medium` or `high` to prevent quota-blocking
- **Model right-sizing**: relationship-maintenance downgraded from opus to haiku (mechanical check), evolution-evaluate uses sonnet instead of opus
- **Tag taxonomy**: All jobs now use standardized `cat:`, `role:`, `exec:` tags

### Quota Threshold Improvements

- **Raised baseline threshold** from 50% to 75% — jobs no longer get blocked at moderate usage
- **Script bypass**: `exec:script` jobs (zero LLM tokens) skip quota gating entirely
- **First-time notifications**: Users notified the first time each quota tier is crossed, with actionable messaging
- **Migration blocking**: Only blocks during migration when there's actual quota pressure (prevents stale migration state from permanently blocking jobs)

### New Built-in Skills

7 new skills are installed automatically during `instar init`:
- coherence-audit, degradation-digest, state-integrity-check, memory-hygiene, guardian-pulse, session-continuity-check, git-sync (with tiered model escalation)

## What to Tell Your User

- Jobs that were previously stuck due to low priority will now run reliably
- Quota thresholds are more permissive — you'll see fewer "quota blocked" skips
- The first time you cross a quota tier, you'll get a notification explaining what's happening
- Five new overseer jobs provide meta-monitoring across job categories

## Summary of New Capabilities

- Paired audit-action job architecture (evaluate then implement)
- Category overseers that spot cross-job patterns and contradictions
- Commitment detection from Telegram messages
- Tiered git-sync: haiku for clean merges, opus subagent only for complex conflicts
- Script jobs bypass quota entirely (zero token cost)
