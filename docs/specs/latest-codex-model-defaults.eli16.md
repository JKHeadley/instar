# How Instar chooses a default Codex model

Today, a new Codex conversation can keep using an older model after a newer one has been reviewed. The saved default may contain an exact model name, which stays fixed until someone changes it.

This change lets the default name a model family. On each new launch, Instar looks in the reviewed list shipped with the app and selects the newest release in that family. Sol is the default family. Instar applies that choice when it starts a new conversation or shows the default. The configuration file still reflects the settings you saved. An exact model chosen for a conversation still takes priority, and the agent logs a warning if its own exact default falls behind the reviewed list. An older Codex command-line version may still need a compatible model, so Instar keeps its existing compatibility checks.

A separate change would add a daily check that records what the installed tools can reach. The check would run as a script without starting an AI conversation and keeps its observations on the machine. Those observations cannot change the reviewed list. Existing disabled jobs would keep that setting.

The configuration command applies to the computer that receives it. Conversations already in progress keep their current model. Updating one safely would require Instar to know whether the conversation inherited the moving default, which model the running process is actually using, and whether restarting it would interrupt work or message delivery.
