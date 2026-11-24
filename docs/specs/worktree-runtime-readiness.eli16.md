# Which Node runs the checks for a new worktree?

A worktree gives an engineer a separate copy of the source code. Some of its dependencies contain machine code that Node loads directly. SQLite is one example. A dependency built for Node 24 can be present on disk and still fail when a Git hook starts it with Node 22. The failure used to surface during a commit or push, long after the checkout appeared ready.

When creating a worktree, the provisioner now tries to open and close an empty in-memory database with its own Node executable. This exercises the installed binding without touching a project database. New hook scripts use that same executable. If the runtime goes away or the binding stops loading, the hook reports the failure. Older branches keep their own hook scripts.

Before pushing, a developer also needs to know whether the affected tests ran. When the listing process times out, the push check now exits unsuccessfully and says that verification is required. An engineer can retry under a lighter load and see the result directly. The complete verification run still belongs to the shared verification coordinator.
