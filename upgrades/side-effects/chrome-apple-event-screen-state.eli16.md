# In plain words: why a browser sign-in repair failed

Echo keeps subscription accounts signed in by driving a normal Chrome window on each Mac. It talks to Chrome through macOS "Apple Events". On November 26 that channel failed on two Macs, and the only message was "apple-event-failed". That message could mean a missing permission, a page that did not answer in time, a missing window or a closed browser, and there was no way to tell which.

What changes:

- **The browser script names the reason.** It now says which of those it was. It reads macOS's own error code, which the old script threw away. The obvious way to read that code crashes the macOS script runner, so the script uses the form that is safe; this was tested on the M5.
- **It also says when the screen is locked or asleep.** That night both Macs were locked with their displays asleep, and Chrome did not answer even the simplest question. When the agent's own lock reading shows a locked or sleeping screen, the error message says so in plain words. When the reading is unsure, it says "not confirmed". It never claims a lock it cannot see.
- **Failed repairs keep a note of the screen state.** Each failed sign-in repair now records the screen state at that moment beside its failure. Until now no machine kept any record of the screen state, so nobody could say how often a locked screen was the hidden cause. From now on that question has data.

What does not change: no repair outcome, no retry, no permission and no account. These are notes and clearer messages only. Undoing it is one revert.
