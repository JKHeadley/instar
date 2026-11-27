# Conversations no longer waits behind start-up checks after a restart (plain overview)

**What happened.** On 2026-11-17 the Studio and the M5 restarted at 14:55 UTC to install an update. For about the next 30 minutes, Justin's "Suggested efforts" page said "Loading suggestions…", then "Your agent did not answer in time. Try again." There was no list and no Accept button. It came back on its own at 15:25.

**Why.** Your agent keeps a shared, checked history of how conversations are organised, and the machines keep it in step with each other. Before answering any Conversations screen, the agent runs an "owner step" that handles one request at a time. That same queue also does regular upkeep: it checks the other machines and re-confirms the history is ready. After a restart that upkeep is slow. The M5 could not reliably reach the Studio, so the "ready" state kept lapsing, and each upkeep round waited on a full re-check. Every page request queued behind it and ran past the page's 20-second limit.

**What changes.**
- Once the shared history has been opened, a request that only reads (like loading suggestions) waits at most about 1.5 seconds for the owner step. After that it is answered from the history that is already open, and the owner step finishes in the background.
- Saving a change still waits for the owner step and all its checks, exactly as before.
- When the page still cannot get an answer (for example right after a restart, before anything is open), it says in plain words "Your agent is still getting your conversations ready. This can take a few minutes after it restarts. Trying again by itself in 15 seconds." It then retries by itself for about 5 minutes. Nobody has to keep tapping.
- The agent's log now records which step it was busy with when a read did not wait, and it records "ready" after a restart (before, that line never appeared, so the log looked stuck when it was not).

**What stays the same.** Who may see the page (owner only), every check on saving, and how the machines share history.

**Not fixed here.** The M5's server sometimes cannot reach the Studio over Tailscale, though a terminal on the M5 can. That is a separate network fault and is filed as its own report. With this change it no longer blocks the page.

**Decision needed.** None. It is a code change that a revert fully undoes.
