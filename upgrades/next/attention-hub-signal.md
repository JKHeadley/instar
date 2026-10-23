<!-- bump: patch -->
## What Changed

- **The "🔔 Attention" topic now carries only items that need the user.** A filter at the single point where items and notices enter the topic (`src/messaging/attentionHubPolicy.ts`) admits: URGENT items, agent-raised items (`source: "agent"`), items from sources that ask the user to decide or tap (sign-in repair at HIGH, duplicate-conversation escalations, the feedback-triage action list, account enrollment checks, credential identity drift, lifeline-secret and passkey-revoke security events), and notices with user impact (possible message loss, a reverted setting, an SSH host-key change, exhausted quota). Routine automated status (passkey health, worktree scans, machine-coherence episode lines, self-healing repairs, health-check failures, degradation summaries) stays in the attention store and dashboard and is logged to `logs/attention-hub-held.jsonl` instead.
- Follow-up lines on a withheld item (machine-coherence "back"/"healed"/"restored", rope dedupe counts) are withheld too — including for items created before this change.
- An upserted item is reposted to the topic at most once per 6 hours unless its priority rises (passkey health was reposting on every refresh).
- Hub posts are shorter: title and body only; the "category | Priority" line and the "Source:" line are gone.
- Agents' CLAUDE.md (template + migration) explains what reaches the topic and replaces the old "queue every failed job / CI failure" guidance.
- Rollback: `messaging[].config.attentionHubFilter: "all"`.

## What to Tell Your User

Your Attention topic should now be quiet unless something genuinely needs you: a decision, a tap, a security event, or a sign that your messages may have been lost. The routine background status that used to flood it is still kept on the dashboard, just not posted to you. If you ever want everything back, I can switch that on.

## Summary of New Capabilities

- Attention topic signal filter, on by default; withheld posts listed in `logs/attention-hub-held.jsonl`; `attentionHubFilter: "all"` restores the old behavior.

## Evidence

- Operator report 2026-10-23 (Echo Bugs topic 10000000715) with screenshot: Attention topic at 52,303 messages.
- Echo's own Telegram log, hub topic 48154, 2026-10-16 → 2026-10-23: ~560 posts; top first lines: "Passkey health" 264, "Stale worktrees detected" 60, "Worktree activity detected after session" ~35, machine-coherence episode lines ~70, "Something went wrong with the … check" 8.
- Tests: `tests/unit/attentionHubPolicy.test.ts`, `tests/unit/attention-single-topic-routing.test.ts` (filter block), `tests/unit/machine-coherence-calm-narration.test.ts`, `tests/unit/PostUpdateMigrator-attentionHubFilter.test.ts`.
