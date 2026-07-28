# ELI16: Project Map Related Worktrees

The Project Map is supposed to help an agent understand the shape of the place it is working in. That matters because an agent can easily make a wrong edit if it thinks it is in one project while the real work is happening somewhere nearby.

When I tested the map from this topic, the endpoint itself worked: the compact view loaded, and refresh produced a fresh map. But the content was only partly useful. It described the small Codey wrapper project, which has a few files and two visible top-level directories. That was technically true, but it missed the important part of this topic's workspace: the Instar source worktrees under Codey's agent home. Those worktrees are where the real development PRs are happening.

The fix is to keep the existing project map and add a small related-worktrees section. This is deliberately not a general file crawler. It does not scan the whole home directory and it does not try to map every possible repository on the machine. It only looks in the conventional per-agent worktree area for this project, plus any explicit roots passed by code or tests. For each direct child that is actually a git worktree, it records the worktree name, path, branch, remote, and a short list of high-signal directories such as source, tests, docs, dashboard, scripts, upgrades, skills, and packages.

The compact map then becomes more useful without becoming noisy. It can still say what project the agent is bound to, but it can also say "there are related worktrees" and name the most relevant ones. That is enough for spatial awareness: the agent can see that the tiny wrapper project is not the whole working surface.

This change is read-only. It does not create worktrees, clean worktrees, or enforce placement rules. Those jobs belong to the worktree manager and worktree detector. Project Map only reports the nearby worktree context so the user and agent can orient themselves quickly.

While testing this area, we also found that the headline file count could count hidden state or worktree directories even though the visible top-level directory list hides those directories. That creates confusing output: the map can say there are hundreds of thousands of files while only showing a few normal project directories. The same PR makes the total count follow the same hidden-directory rule as the breakdown, so the headline number and the visible list describe the same project surface.
