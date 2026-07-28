# tmux Event-Loop Resilience — ELI16

**Status:** Converged (2-round multi-reviewer + cross-model) and approved 2026-06-22.
Increment 1 (this build) = the async, non-blocking hot path + the block-vs-sleep
marker + the signal-only degraded-tmux guard, all dev-gated (live on development
agents, dark on the fleet). Per-agent tmux socket isolation is Increment 2.

Your AI agents on one computer all share a single behind-the-scenes "session manager" program called
tmux — it's what runs each agent's terminal sessions. Think of it like one shared receptionist
handling phone calls for several offices in the same building.

The agent's server constantly asks tmux questions: "is this session still alive? what's on its
screen?" The problem: it asks those questions in a way that makes the WHOLE server freeze until tmux
answers. When the shared tmux gets slow — because it's been running a long time, or the machine is
busy, or another agent is starting up — every question takes ~15 seconds, and the server is frozen
for those 15 seconds. During the freeze, the dashboard shows "Disconnected," sessions show as zero,
and the agent can't reply to anyone. (That's the exact thing that broke for ~17 hours, and made the
agent wrongly think the computer had gone to sleep — because a frozen-waiting program looks the same
as a sleeping one.)

This change fixes it in three coordinated parts that ship together:

1. **Don't freeze.** The server stops asking tmux questions in the freezing way. The dashboard and
   status pages read from a recently-saved snapshot instead of asking tmux live, so they always
   answer instantly. Only one careful background loop asks tmux live, and it does so without freezing
   the server. Crucially, if tmux is slow and a question times out, the server treats that as "I
   don't know" and KEEPS the session — it never mistakes a slow answer for "the session is dead and
   should be killed." That safety direction is the most important rule in the whole change.

2. **Tell sleep from stuck.** The agent gets a reliable way to know "I'm frozen waiting on tmux"
   versus "the computer actually slept." It sets a little flag whenever it's about to do one of these
   freezing calls; if time jumps while that flag is up, it knows it was stuck, not asleep. The flag
   auto-expires so a bug can never leave it stuck "on" forever and permanently blind sleep detection.

3. **Say something — quietly but loudly enough.** When tmux is genuinely degrading, the agent raises
   ONE calm heads-up (not a flood), only after it's sure it's tmux that's slow and not just a busy
   machine. It will NEVER automatically restart the shared tmux, because doing that would knock out
   every other agent on the machine (we learned that the hard way). Restarting tmux is always a
   human decision.

A later, separate step gives each agent its OWN private tmux instead of one shared one — so one
agent's slowness can never affect the others again. That's the real root fix; the three parts above
are the safety net that ships first.

Everything is off by default and turns on for the test agent first. When off, the agent behaves
exactly as it does today. Nothing about your conversations changes except that the dashboard stops
dropping its connection.
