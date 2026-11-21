# Turning auto-updates off now stops an update that was already waiting — plain-English overview

**What went wrong.** An Instar agent checks for a new version shortly after it starts and then every 30 minutes. When it finds one and auto-updates are on, it does not install right away: it waits five minutes, in case an even newer version is published in the meantime, and then installs. During the Windows test run, auto-updates were turned off about two and a half minutes into that wait. The agent even noticed the setting had changed. It installed the update anyway when the five minutes were up, because nothing told the waiting install to stop and the install step never looked at the setting again. The same was true when the setting was changed through the agent's own settings API.

**What changes.** Three things, all in the agent's update code. When auto-updates are switched off, whether by editing the agent's settings file or through the settings API, any install that is waiting is cancelled on the spot. The install step itself now re-reads the setting just before it installs, and does nothing if auto-updates are off, so even a change it somehow missed still wins. And the regular check, if it finds auto-updates off while an install is waiting, cancels it too and sends the usual "a new version is available, auto-updates are off" notice once.

**What does not change.** Asking the agent to update by hand still works while auto-updates are off; that is a deliberate choice by the person. With auto-updates left on, updates install exactly as before, after the same five-minute wait. The new version stays listed as available, so it can be installed later.

**Safeguards.** The change can only stop an automatic install, never start one. Reverting the one commit restores the old behaviour, with no saved data to repair.

**What you need to decide.** Nothing. This makes "auto-updates off" mean off from the moment it is set, which is what everyone already assumed.
