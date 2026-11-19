# Removing an agent no longer stops other agents' sessions

<!-- bump: patch -->

## What Changed

`instar nuke <name>` used to stop every session whose name started with the agent's name. So removing `echo` also stopped the sessions of agents named `echo-wt-...`.

It now keeps that name rule, then also checks where each session started:
- **inside the agent's own home:** stopped, as before;
- **inside another agent's home:** left running, and listed;
- **anywhere else:** nuke stops before changing anything and lists those sessions. `--also-stop <ids>` stops exactly the listed ones.

It also:
- removes the auto-start entry first, and only when that entry points at this agent's folder;
- checks every planned delete before anything is taken down;
- reports every failure honestly with a non-zero exit, instead of always saying "removed".

## What to Tell Your User

- **Safer agent removal:** "Removing one agent can no longer stop another agent whose name starts the same way. If anything about the removal is unclear, it stops before changing anything and tells you why."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Stop listed ambiguous sessions during removal | `instar nuke <name> --also-stop <session-id...>` |

## Evidence

**Reproduced first.** On the old code, removing `zz-echo` killed `zz-echo-wt-1-server`; with this change it keeps running. Shown in both a sandboxed unit test and a real, isolated tmux run.

**Tests:** 111 targeted unit tests plus integration. The second-pass review checked the spec's five round-5 fixes by name.
