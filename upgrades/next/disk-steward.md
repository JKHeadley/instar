# Every machine now watches its own disk space

## What Changed

A disk watcher now runs inside the agent server on every machine, including standbys. Every 15 minutes it checks free space and how fast it is shrinking, then estimates the days left before the 5% line where the app refuses uploads. When space gets low (under 15% or 100 GiB, capped at 30% on small disks), it first clears two tool caches if its cleanup is switched on: the npm cache when it is over 5 GiB, and Xcode build files older than a day. If space is still low after that, it posts in a "Disk space (all machines)" topic. It warns more often under 10% or 60 GiB, or when the disk is on track to fill within 3 days, and an urgent post always gets through at the danger line. Each post names the machine, says what was cleared, what is kept and why, and what you can ask for. Standby machines never post: the awake machine reads their numbers and posts for them.

Cleanup is off by default. The update turns it on for development agents only, and it never touches worktrees, agent state or anything of yours. It runs in a separate, time-limited process.

Two disk leaks are fixed. Local Verify now removes the test copies left behind by runs cut short by a restart or update (only folders it made, registered and not in use, and never forced). The worktree cleaner no longer treats a linked `node_modules`, or a `dist/` whose every file was built from the source in one build, as unsaved work. It now also keeps any worktree that another checkout or pipeline folder links into, or that a running process names.

## Evidence

Built against the 2026-11-07 incident on the Mac Studio (95% full, upload refused). Before any code, six review rounds (internal plus GPT-5.5) found that 189 of Echo's worktrees share one installed `node_modules` through links, and that 2.0 pipeline folders link into worktrees. The cleaner now keeps both.

Unit tests cover:
- the thresholds and the forecast;
- the heal-then-post cycle, the repeat schedule, a restart, and standby/holder delivery;
- the post text and the notification envelopes;
- both cleanup categories (busy tools, age, containment, a relocated DerivedData);
- the worktree rules on real git (chained links, `dist/` provenance and build window, open processes);
- the Local Verify sweep.

An integration test drives the routes over HTTP. An end-to-end test reads a real measurement through the server. It also runs the real cleanup child against a throwaway home with a fake npm cache and fake Xcode folders, and checks that only the allowed items go.

The link scan was run on Echo's real home: it finished in about 90 seconds and found 171 linked-into worktrees. Honest yield: on the Studio today, most worktrees also hold other leftovers this change does not yet classify, so the worktree cleaner frees only a few. Those are tracked as fb-4ee99a20-35b, and worktrees held by old session locks as fb-f564e836-6ca.

## What to Tell Your User

Your machines now keep an eye on their own disk space. If one starts running low, you'll get a message in a "Disk space" topic saying which machine it is, how much is left and what you can do. On a development agent it clears out safe tool caches first, and only messages you if space is still low. These messages go to your quiet feed unless you tell me you want them as notifications. If a disk gets close to full, the warning always comes through. If you want me to clear the safe caches on a machine, just say "clear disk on" and the machine's name.

## Summary of New Capabilities

- Per-machine disk watch with a growth forecast, posting in one "Disk space (all machines)" topic. Only the awake machine posts, for every machine.
- Cleanup of two tool caches, run before any warning, behind its own switch (on for development agents).
- "Clear disk on <machine>" on request, forwarded to the right machine.
- `GET /disk-steward` and `?scope=pool` to read every machine's disk state.
- Local Verify sweeps its own leftover test copies.
- The worktree cleaner can now remove finished worktrees that only hold a linked `node_modules` or provable build output.
