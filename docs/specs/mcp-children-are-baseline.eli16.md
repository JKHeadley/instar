# MCP helper processes no longer make a conversation look busy forever

## What this change is, in plain words

Every conversation an Instar agent runs is a Claude or Codex process sitting in a terminal window. When that conversation starts, the framework also starts a few helper programs next to it: the agent-network bridge, and whatever "MCP servers" the agent has configured (a Google Workspace helper, a browser helper, a note-taking helper, and so on). Those helpers stay alive for the whole life of the conversation, doing nothing most of the time.

Instar decides whether a conversation is idle by looking at the processes under it. If anything is running there besides the known helpers, the conversation is "doing work" and must be left alone. If only the known helpers remain and the screen shows the idle prompt, the conversation is idle, an idle timer starts, and after a few hours an idle conversation is closed to make room for new ones.

The list of "known helpers" was a short, hand-written list: the browser helper, the agent-network bridge, anything whose name contains "mcp" followed later by "server", and the screen-saver blocker. The Google Workspace helper that every one of Luna's conversations runs is called `workspace-mcp --tool-tier complete`. It is an MCP server, but its command line never says "server", so it was not on the list.

The effect: every one of Luna's conversations counted as busy, all day, every day. The idle timer never started. Nothing idle was ever closed. On 2026-10-22 she hit her limit of 20 conversations, every one of them idle, and refused new ones. People messaging her got silence.

## What already existed

- The known-helper list (`baselineProcessPatterns.ts`), shared by three places: the idle check, the duplicate-session stand-down drain, and the presence-proxy's "is anything real running?" filter.
- A rule that a Bash command the agent itself is running always counts as work, checked before the helper list is consulted.
- The idle timer and the idle-zombie close, which only start once a conversation is judged idle. A separate fix the same day made that timer survive a server restart. That fix is necessary but useless while the timer never starts.

## What is new

One more entry on the known-helper list: any process whose command line carries the word `mcp` as its own token (`workspace-mcp`, `@plaud-ai/mcp@latest`, `mcp-server-anything`). Every MCP server is named that way by convention, so the list no longer depends on someone remembering to add each new helper by hand. Nothing else changes.

## Safeguards, in plain terms

- A command the agent is running itself (a build, a test, a script) is judged first and always counts as work, even if its text mentions "mcp". So a conversation that is actually running something is never mistaken for idle.
- A child process that is not an MCP server (a Python script, a long download) still counts as work.
- Being judged idle only starts a timer. The close itself still goes through every existing check: the idle prompt must be on screen, the four-hour threshold must pass, the reaper's keep-guards and veto backoff still apply, and protected or standing sessions are never closed.
- The stand-down drain uses the same list to know which processes belong to the resident helper stack. Treating one more helper as resident means the drain waits for it less, which is the correct direction: that helper never finishes on its own.

## What you need to decide

Nothing. This is a one-pattern addition with the exact process tree from the incident pinned as a regression test. The only judgment call is whether "mcp as a word in the command line" could wrongly label real work. It cannot label a Bash call the agent made (that rule wins first), and a process the agent spawned some other way that happens to be called something-mcp would, by that very name, be an MCP server.
