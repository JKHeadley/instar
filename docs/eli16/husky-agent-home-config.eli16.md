# The commit check can now see the setting that turns on report-backed reviews — plain-English overview

**What this is about.** Before Instar's own code is committed, a check runs. One optional part of that check says: "a spec review must be backed by a written convergence report." It is switched on by a setting called `requireConvergenceReport` in the development agent's config file. The commit check cannot read the config by itself, so a small piece of the hook looks for the config file and, if the setting is on, passes it along.

**What went wrong.** The hook looked for the config in the wrong places. It assumed the agent's config sits inside the code checkout. On our machines the agents live somewhere else, in a folder per agent under `~/.instar/agents/`. None of the four places the hook looked had a config file. So if someone switched the setting on, nothing happened, and nothing said so. The check stayed off while it looked like it could be turned on.

**What changes.** Every session an agent starts already carries a pointer to that agent's own folder (`INSTAR_AGENT_HOME`). The hook now looks there first. If the pointer is missing or the file is not there, it falls back to the old places, exactly as before.

**What does not change.** No agent has the setting switched on today, so no commit is treated differently by this change. It only makes the switch work when someone flips it. Any problem reading the file still leaves the check off, which is how it already behaved.

**Safeguards.** It reads one more file and can only turn on a check that an operator asked for. Reverting the one commit restores the old behaviour.

**What you need to decide.** Nothing.
