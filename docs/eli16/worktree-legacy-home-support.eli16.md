# Worktree creation for legacy-home agents — ELI16

Every agent is supposed to do its coding work in fresh "worktrees" — clean
copies of the codebase — created by one blessed command, `instar worktree
create`. That command is deliberately picky about WHERE it will put them: only
inside the agent's own home folder, because that's the territory the agent is
guaranteed to keep access to. To find that home folder, it checks the path
against a strict rule: the home must live under `~/.instar/agents/`.

Here's the problem: our older agents were set up before that rule existed.
Codey's real, living home — where his config lives, where his server runs,
where his heartbeat registers from — is under `~/Documents/Projects/`. The
strict rule doesn't care that it's genuinely his home; it just sees "not under
the blessed folder" and refuses. So the one agent we most want building fleet
PRs literally cannot use the blessed build command. What happens instead is
exactly what you'd guess: he improvises a checkout by hand, and improvised
checkouts are how we got last night's cascade of wrong-repo, stale-dependency,
and missing-hook failures.

The fix keeps the strictness but fixes WHO gets to vouch for a home. There's
already a single source of truth for "which agents live where": the agent
registry, a file only the agents' own servers write to, where every running
agent records its name, its home path, and a heartbeat. The rule becomes: if
the folder isn't under the blessed root, accept it ONLY if the registry's own
record says "yes, that exact folder is a registered agent's home." Files
planted inside the folder — a fake AGENT.md, a fake config — count for
nothing, because anyone can plant a file, but only a real running agent gets
into the registry. The agent's name is taken from the registry record too,
never from the folder name.

Everything that was refused before is still refused: a planted AGENT.md in a
random folder, an unregistered directory, a registry record whose name has
suspicious characters in it, a record pointing somewhere else. The same test
that has always pinned the "reject planted files" behavior passes unchanged.

The payoff: Codey (and any pre-convention agent) can now run the same one
blessed command as everyone else, his worktrees land inside his own home where
nothing can revoke them, and "rebuild your checkout by hand" — the single
biggest source of his build friction — stops being a thing he ever has to do.
