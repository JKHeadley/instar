# Convergence report: app conversations move between machines (part 3b)

This took seven review rounds. Each was done by an independent reviewer subagent that read the whole spec against the code. Round 6 ran twice: one pass found no design defects, the other found one (a dropped notice), which was fixed. Round 7 confirms. No cross-model pass ran.

## ELI10 overview

You can move an app conversation to another of your machines, as you can a Telegram one. The design is strict, because the worst failure is two machines answering one conversation:
- A conversation moves only when you move it, and only after its old session has fully stopped. Nothing moves one by itself.
- If its machine goes dark, you can bring it back with one confirmed tap.
- A machine that has just taken charge waits until it's caught up.
- A machine that learns it lost a conversation closes its copy.
- Older machines are kept out until they update.
- Slack conversations stay with their Slack connection (part 3a).

## What the rounds changed

- **Round 1** (part 3, 9 defects). Slack was split out (3a, #2894), and the app design was rewritten around fenced ownership.
- **Round 2** (9 defects). The structure became: one placement path, the drain; no pins, router placement or shed for app keys; a lease gate; a capability flag; the journal's app rows; and the draining owner's last reply.
- **Round 3** (5 defects). Phone sends stay on the lease holder, as today, so there is no machine-to-machine relay. The only takeover is the operator's "bring it back here". Added: a virtual baseline for unmoved conversations, the reconciler skipping app keys, and stop and pause reaching the draining owner.
- **Round 4** (3 defects). A force-claim margin, a "current owner" for stop and pause, and `StaleOwnerReleaseEngine` skipping app keys.
- **Round 5** (3 defects). The reply window lasts as long as the drain, stop and pause get their own epoch rule, and a 1,000,000 margin plus a deterministic app tie rule.
- **Round 6** (0 and 1 defects). `disclose` uses `mayReply`, so the drain's notice survives. Many minors were folded in.
- **Round 7.** No design defects. Its 8 minors were folded in:
  - the crash-between-receipt-and-dispatch marker;
  - held-send words;
  - the lease gate's epoch wording;
  - the local stop while the gate is closed;
  - the route asking the source;
  - the long keeps, accepted as bounded;
  - the enforcement exceptions;
  - the honest wording for unplanned lease loss.

| Round | Design defects |
|---|---|
| 1 | 9 |
| 2 | 9 |
| 3 | 5 |
| 4 | 3 |
| 5 | 3 |
| 6 | 0 / 1 |
| 7 | 0 (8 minors folded in) |
