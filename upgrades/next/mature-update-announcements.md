---
user_announcement:
  - audience: user
    maturity: stable
    headline: Quieter, more honest update messages
    body: "From now on I'll only message you about an update when it's genuinely relevant and ready for you — and when something is still experimental, I'll say so instead of making it sound finished. Fewer pings, more honesty."
---
# Upgrade Guide — vNEXT

<!-- bump: minor -->

## What Changed

User-facing update announcements are now **opt-in and maturity-tagged**. A new
pure helper (`src/core/upgradeAnnouncement.ts`) parses a `user_announcement`
front-matter block in the release upgrade guide — each notable change carries an
`audience` (`user` or `agent-only`) and a `maturity` (`experimental` / `preview`
/ `stable`).

- **UpgradeNotifyManager** is now silent-by-default: with no `audience: user`
  entry it skips the user message entirely (still updating MEMORY.md and
  acknowledging), and with entries it composes only from them using honest
  maturity framing + badges (⚗️ Experimental / 🧪 Preview). The old "lead with
  the biggest user-visible feature" instruction is gone.
- **UpgradeGuideProcessor** hoists and merges each guide's `user_announcement`
  block to the top of the concatenated pending guide, so the decision survives
  multi-guide batches (a no-op when no guide carries a block).
- **AutoUpdater + the restart handshake** suppress the bare patch-level "Just
  updated… restarting" narration while keeping the restart-hold warnings;
  restart verification is preserved via an empty deferred notification.
- **analyze-release.js** scaffolds the block (defaulting every entry to
  `agent-only`) on `--draft-guide`, and warns at authoring time when a
  user-relevant release carries no block at all.
- Existing agents receive the maturity-honesty guidance through a
  `PostUpdateMigrator` CLAUDE.md migration (new agents get it from the template).

Parent principle: **Near-Silent Notifications**. Spec:
`docs/specs/mature-update-announcements.md`.

## What to Tell Your User

- **Quieter, more honest updates**: "I'll only message you about an update when
  it's genuinely relevant and ready for you, and I'll be upfront when something
  is still experimental instead of making it sound finished. You'll get fewer
  pings and clearer ones."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Maturity-tagged, opt-in update announcements | Authored in the release upgrade guide's `user_announcement` front-matter; the notifier stays silent unless a change is promoted to the user |
| Honest maturity framing | Experimental and preview features are labeled as such, never narrated as finished |
| Quieter restarts | Patch-level "restarting" notices are suppressed; restart-hold warnings still surface |
