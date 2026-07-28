# Two more safety nets, satisfied properly

The first net reads the code that wires up the machine-presence poller like a fixed-length page, checking the signed status-call is on it. My new hook (with its explanatory comment) had shoved that call off the page's bottom edge. Since the order of entries in that wiring block makes no difference to how it runs, I moved my hook below the entry the net checks for and shrank its comment to one line — the page reads exactly as the net expects, and my hook still does its job.

The second net is about fairness across agent brains: every capability we teach Claude-based agents must ALSO be mirrored to agents running on Codex or Gemini, or those agents simply never learn it and improvise something weaker. The new "fetch this conversation's files from the machine that made them" ability was registered for Claude agents but not yet in the mirror list — meaning a Codex agent would have told its user "those files aren't on this machine" forever, the very failure this feature kills. It's now in both registries, so every agent brain learns the same move on its next update.

Nothing about runtime behavior changed in this commit: one wiring entry moved within its block, and two tracking lists gained the entries they exist to hold.
