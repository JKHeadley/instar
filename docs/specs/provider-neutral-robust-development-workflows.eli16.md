# Plain-English Overview: Making Strong Development Habits Portable

Instar has developed a careful way of changing itself. Echo usually works in a
separate worktree, writes a plan before coding, thinks through side effects,
keeps evidence of what changed, and uses gates that refuse rushed or incomplete
work. Those habits have helped Instar improve without turning every fix into a
new problem.

The issue is that some of those habits live in Echo's local workflow, or in
Claude-shaped skill files, instead of in a format every Instar agent and every
provider can discover. Codey, running on Codex, can already be held to the same
git gate in the Instar repo. But Codex does not yet get the same clear
phase-by-phase guidance that Echo gets from the local development skills.

This spec turns that into a two-layer system. The first layer is a general
"robust development" workflow that can help with any serious project. It covers
worktree hygiene, planning first, reviewing side effects, keeping evidence,
tracking work that is intentionally outside the change, and verifying before
delivery. That should not be limited to Instar; it is useful whenever the work
has real risk.

The second layer is special to Instar itself. When the agent is changing Instar,
the workflow adds the stricter Instar rules: the existing pre-commit gate, the
trace file, the side-effects artifact, the ELI16 companion, human approval, and
the repo-local development skills. Those requirements stay Instar-specific
because they are tied to Instar's release process and constitution.

The important principle is "context-gated, not Echo-gated." Echo should not be
the only agent capable of improving Instar. But the Instar-specific workflow also
should not appear everywhere during ordinary user tasks. The agent should see it
when it is actually working in an approved Instar development context.

This also adds a prevention mechanism: a weekly built-in drift-audit job,
disabled by default. Echo should enable it first because Echo is currently the
main Instar developer agent. The job compares what Echo is using locally against
what Instar exposes to all agents and providers. If a useful practice is becoming
Echo-only, the job surfaces it as a migration candidate before the gap grows.

