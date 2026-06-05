# ELI16 — Make topic floods structurally impossible (Bounded Notification Surface)

This morning the user's Telegram group got spammed again — the THIRD time a feature flooded it with topics. A boot-time checker misread a shared state file (a race made it briefly forget this agent exists), decided 110 perfectly-placed worktrees were "misplaced," and raised one notification PER worktree. Each notification carried a unique source label, which neutralized the per-source budget the previous flood fix (2026-05-28) had added. Only a global ceiling caught it — after 8 junk topics had already been created, plus a 103-ping "coalesced" topic.

The operator's direction was explicit: don't just patch this feature — make it so a feature with this failure mode CANNOT ship. This change does that in four layers:

1. **Fix the source.** The worktree checker now reads agent homes directly off the disk (the ground truth) instead of the racy shared registry file, and it emits ONE summary notification ("110 worktrees misplaced, list inside") instead of one per worktree. N findings → 1 item, always.

2. **A budget no feature can dodge.** The hard ceiling now lives INSIDE the one function that creates Telegram topics. Every automatic topic creation is budgeted BY DEFAULT — a future feature that has never heard of the budget is still bounded, because not declaring an origin means you're budgeted. Only human-initiated topics and fixed create-once system topics (Lifeline, Dashboard, Updates) are exempt. Past the budget, creation fails the same way a Telegram rate limit fails — a shape every caller already survives.

3. **A test that fails the build.** A burst-invariant test fires 1,000 notifications through the real pipeline with shipped-default budgets — unique source labels, the exact dodge from this incident — and fails CI if more than ~9 topics get created. It also proves no notification is ever dropped (they all land in the attention store) and that genuine emergencies (HIGH/URGENT) still get their own topic even mid-flood.

4. **A lint that closes the side door.** No code outside the budgeted funnel may call Telegram's topic-creation API directly. Same pattern as our safe-git/safe-fs funnels.

Cleanup ships with it: a migration purges the 110 stale false-positive items from every flooded agent's attention store on update. And the rule is written into the constitution as "Bounded Notification Surface" (P17) so every future notification channel — email, Slack, whatever — ships with a chokepoint budget and a burst test, or doesn't ship.

What does NOT change: critical (HIGH/URGENT) notifications always get their own topic; no notification is ever dropped (overflow is coalesced or stored topic-less); user-created topics are never budgeted; the existing 2026-05-28 attention guard keeps working exactly as before — the new ceiling sits BEHIND it as the layer of last resort.
