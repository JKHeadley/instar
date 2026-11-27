# The Instar threat map: the plain version

**What this is.** A single document, `docs/security/threat-map.md`, that lists every way into an Instar agent: the HTTP API and its public tunnel, the dashboard, agent-to-agent messaging, the multi-machine mesh, inbound messages and the files and pages an agent reads, how sessions run, secrets, the update path, and so on. For each one it says who is meant to use it, what checks the identity, what protections already exist, and how much damage getting past it would do. It ranks them by that damage.

**Why it exists.** Justin started a standing security program for Instar on November 15, 2026, because capable AI models are getting good at finding system weaknesses, and Instar's whole point is trust. The threat map is the program's map: a recurring review reads one group of areas at a time, three times a day, so the whole map is covered about once a day, using every frontier model that can be reached.

**What changes for a user.** Nothing. This is documentation. It changes nothing an agent does at runtime.

**The careful part.** The repository is public. So the map is written to describe the shape of each area and what a reviewer should check, without naming any specific unfixed weakness. Real findings, with the detail needed to reproduce them, stay in the agent's private records until a fix is merged and installed. The map says this rule plainly at the top.

**What a reader needs to decide.** Nothing to approve: it is a description of the system's own surfaces, kept in step with the code. If a reader wants to change how often areas are reviewed, or add an area, that is an edit to this file.
